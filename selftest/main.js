/**
 * 自检页的主线程部分。
 *
 * 负责两件 Worker 里做不了或不该做的事：
 * 1. 环境探测——持久化存储许可、配额、API 可用性（M0 的 spike ③）
 * 2. 展示 Worker 报上来的结果
 *
 * TODO(开发期): selftest/ 是开发工具，正式发布前从打包产物里排除。
 */

const $ = (id) => document.getElementById(id);
const results = $('results');
/** @type {Map<string, HTMLElement>} */
const groups = new Map();
let passed = 0;
let failed = 0;

/** @param {string} name */
function groupEl(name) {
  let el = groups.get(name);
  if (!el) {
    const h = document.createElement('h2');
    h.textContent = name;
    results.append(h);
    el = document.createElement('div');
    results.append(el);
    groups.set(name, el);
  }
  return el;
}

/** @param {{group: string, name: string, ok: boolean, error?: string}} c */
/**
 * 所有结果的结构化记录，用来生成可复制的报告。
 *
 * 从**数据**生成而不是从 DOM 里扒：扒 DOM 会把 CSS 伪元素、缩进、按钮文字一起
 * 带进去，而且一改样式就坏。
 *
 * @type {Array<{kind: 'env' | 'note' | 'case', group?: string, name?: string, ok?: boolean, error?: string, text?: string, value?: string}>}
 */
const report = [];

function addCase(c) {
  const el = groupEl(c.group);
  const line = document.createElement('div');
  line.className = `case ${c.ok ? 'ok' : 'no'}`;
  // 记号写进 **textContent**，不用 ::before。伪元素复制不出来——复制走的报告里
  // 每一行都长得一样，看不出哪条失败了，而那正是要把结果贴给别人看的时候。
  line.textContent = `${c.ok ? '✔' : '✖'} ${c.name}`;
  el.append(line);
  if (!c.ok) {
    const err = document.createElement('div');
    err.className = 'err';
    err.textContent = c.error ?? '(无错误信息)';
    el.append(err);
  }
  report.push({ kind: 'case', group: c.group, name: c.name, ok: c.ok, error: c.error });
  c.ok ? passed++ : failed++;
  updateSummary(false);
}

/** @param {string} text */
function addNote(text) {
  const el = document.createElement('div');
  el.className = 'note';
  el.textContent = text;
  results.append(el);
  report.push({ kind: 'note', text });
}

/**
 * 生成纯文本报告。
 *
 * 每条用例前缀 `[PASS]` / `[FAIL]`，**不靠符号**：`✔` 与 `✖` 在等宽字体和某些
 * 终端里长得很像，而这份报告的用途就是贴给别人看。失败的那几条另外汇总到开头，
 * 免得在几十行通过里找。
 */
function buildReport() {
  const lines = [];
  const fails = report.filter((r) => r.kind === 'case' && !r.ok);

  lines.push('豆备自检报告');
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push(`结果：${failed} 项失败，${passed} 项通过`);
  lines.push('');

  if (fails.length) {
    lines.push(`失败汇总（${fails.length} 项）—— 详情见下方对应分组`);
    for (const f of fails) lines.push(`  [FAIL] ${f.group} / ${f.name}: ${f.error ?? '(无错误信息)'}`);
    lines.push('');
  }

  lines.push('── 环境 ──');
  for (const r of report.filter((x) => x.kind === 'env')) lines.push(`${r.name}: ${r.value}`);
  lines.push('');

  /** @type {string | null} */
  let group = null;
  lines.push('── 检查项 ──');
  for (const r of report) {
    if (r.kind === 'note') {
      lines.push(`(note) ${r.text}`);
      continue;
    }
    if (r.kind !== 'case') continue;
    if (r.group !== group) {
      group = r.group;
      lines.push('');
      lines.push(`[${group}]`);
    }
    lines.push(`  ${r.ok ? '[PASS]' : '[FAIL]'} ${r.name}`);
    if (!r.ok) lines.push(`         → ${r.error ?? '(无错误信息)'}`);
  }

  return lines.join('\n');
}

/** @param {boolean} done */
function updateSummary(done) {
  const s = $('summary');
  s.hidden = false;
  if (!done) {
    s.className = 'run';
    s.textContent = `进行中… 通过 ${passed}，失败 ${failed}`;
  } else if (failed === 0) {
    s.className = 'pass';
    s.textContent = `全部通过：${passed} 项`;
  } else {
    s.className = 'fail';
    s.textContent = `${failed} 项失败，${passed} 项通过`;
  }
}

/** 环境探测。这几项正是 DESIGN.md M0 spike ③ 要回答的问题。 */
async function probeEnvironment() {
  const rows = [];
  const add = (k, v) => rows.push([k, v]);

  add('User-Agent', navigator.userAgent);
  add('OPFS', navigator.storage?.getDirectory ? '可用' : '不可用（致命）');
  add('CompressionStream', typeof CompressionStream === 'function' ? '可用' : '不可用（致命）');
  add('crypto.subtle', crypto?.subtle ? '可用' : '不可用（致命）');
  add('File System Access', typeof window.showDirectoryPicker === 'function'
    ? '可用（导出用得上）' : '不可用——导出需要换方案');

  // 持久化存储。
  //
  // 【重要】在扩展里 persist() 返回 false 是**预期行为**，不代表数据有风险。
  // 扩展防驱逐靠的是 manifest 里的 unlimitedStorage 权限，而不是这个 API；
  // Chrome 从不为持久化存储弹窗询问，所以 persist() 对扩展基本恒为 false。
  //
  // 也就是说这一项**不是可靠的风险信号**，别照着它去吓用户。
  if (navigator.storage?.persisted) {
    const already = await navigator.storage.persisted();
    const granted = !already && navigator.storage.persist ? await navigator.storage.persist() : already;
    add(
      'persist()',
      granted
        ? '已获批'
        : 'false —— 扩展里这是预期行为，不是风险信号（防驱逐靠 unlimitedStorage 权限）',
    );
  }
  add('unlimitedStorage 权限', '见 manifest；这才是扩展防驱逐的实际机制');

  if (navigator.storage?.estimate) {
    const { usage, quota } = await navigator.storage.estimate();
    const gb = (n) => (n / 1024 ** 3).toFixed(2) + ' GB';
    add('配额', `已用 ${gb(usage ?? 0)} / 可用 ${gb(quota ?? 0)}`);
    add('配额是否够用', (quota ?? 0) > 5 * 1024 ** 3
      ? '够（真实档案实测约 0.8 GB，含作品详情页）'
      : '**偏小** —— 开抓前的空间预检必须拦住');
  }

  const table = document.createElement('table');
  for (const [k, v] of rows) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.textContent = k;
    const td2 = document.createElement('td');
    td2.textContent = v;
    tr.append(td1, td2);
    table.append(tr);
    // 环境信息也要进报告：几乎每次排查都要先问一句「什么浏览器、配额多少」。
    report.push({ kind: 'env', name: k, value: v });
  }
  $('env').replaceChildren(table);
}

/**
 * 后台连通性：确认 service worker 醒着、能应答、持久化真的能用。
 *
 * 这是 Node 里测不到的一环——RunStore 在测试里用的是内存实现，这里用的是
 * 真的 chrome.storage + OPFS。
 */
async function probeBackground() {
  const chrome = globalThis.chrome;
  if (!chrome?.runtime?.sendMessage) {
    addNote('不在扩展环境里，跳过后台连通性检查（请从 chrome-extension:// 打开本页）');
    return;
  }

  const send = (msg) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (r) =>
        resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r),
      );
    });

  const G = '后台 service worker';

  const status = await send({ type: 'status' });
  addCase({
    group: G,
    name: 'service worker 能被唤醒并应答',
    ok: !!status?.ok,
    error: status?.error,
  });

  if (status?.ok) {
    addNote(
      `当前状态：${status.running ? '抓取中' : '空闲'} · ` +
        `${status.checkpoint ? `有未完成的抓取（${status.checkpoint.pause_reason}）` : '没有未完成的抓取'}`,
    );
  }

  const tick = await send({ type: 'tick' });
  addCase({
    group: G,
    name: '心跳可以手动触发（tick 幂等）',
    ok: !!tick?.ok,
    error: tick?.error,
  });
  if (tick?.ok) {
    addNote(`tick 结果：${tick.result.acted ? '已恢复' : '未恢复'}——${tick.result.decision.reason}`);
  }

  // 闹钟是唯一一个「worker 死了它还在」的东西，值得单独确认
  if (chrome.alarms?.getAll) {
    const alarms = await chrome.alarms.getAll();
    addCase({
      group: G,
      name: 'chrome.alarms 可用（自恢复靠它）',
      ok: true,
    });
    addNote(
      alarms.length
        ? `当前闹钟：${alarms.map((a) => `${a.name}（每 ${a.periodInMinutes} 分钟）`).join('、')}`
        : '当前没有闹钟——没有未完成的抓取时这是正常的',
    );
  }
}

$('run').addEventListener('click', async () => {
  $('run').disabled = true;
  results.replaceChildren();
  groups.clear();
  passed = failed = 0;

  report.length = 0;
  $('copy').disabled = true;
  $('report-fallback').hidden = true;

  await probeEnvironment();
  await probeBackground();

  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'case') addCase(m);
    else if (m.type === 'note') addNote(m.text);
    else if (m.type === 'done') {
      updateSummary(true);
      $('run').disabled = false;
      $('copy').disabled = false;
      worker.terminate();
    } else if (m.type === 'fatal') {
      failed++;
      addNote('自检中断：');
      const err = document.createElement('div');
      err.className = 'err';
      err.textContent = m.error;
      results.append(err);
      updateSummary(true);
      $('run').disabled = false;
      // 中断了也要能复制——那时候报告**最有用**。
      $('copy').disabled = false;
      worker.terminate();
    }
  };
  /**
   * Worker 出错。
   *
   * ## 为什么这里要写得这么啰嗦
   *
   * 模块 Worker **加载失败**时（比如某个 import 在浏览器里解析不了），
   * `ErrorEvent` 上的字段全是空的——`message` 是 `undefined`、`filename` 是空串。
   * 于是页面只会显示一句「Worker 出错：undefined」，没有文件名、没有行号、
   * 没有原因。
   *
   * 那件事真的发生过：某个共享的契约文件里加了一行 `import 'node:assert'`，
   * 整个 Worker 挂掉，唯一的线索是 `undefined`。代价是一整轮往返。
   *
   * 所以：字段有就显示，**没有就说出「没有」意味着什么**，并直接给出下一步该看
   * 哪里。一条报不出原因的错误信息，比没有错误信息更浪费时间——它让人以为自己
   * 已经知道了些什么。
   */
  worker.onerror = (e) => {
    failed++;

    const bits = [];
    if (e.message) bits.push(e.message);
    if (e.filename) bits.push(`${e.filename}:${e.lineno ?? '?'}:${e.colno ?? '?'}`);

    if (bits.length) {
      addNote(`Worker 出错：${bits.join('　')}`);
    } else {
      addNote('Worker 起不来：模块加载就失败了（ErrorEvent 上没有任何细节）。');
      const hint = document.createElement('div');
      hint.className = 'err';
      hint.textContent =
        '最常见的原因是某个 import 在浏览器里解析不了——比如 `node:assert` 这类 ' +
        'Node 内置模块，或者路径写错了。' +
        '打开 DevTools 的 Console，那里会有真正的解析错误与出错的文件名。' +
        '（`npm test` 里的 no-node-builtins 那条测试专门拦这一类，可以先跑一遍。）';
      results.append(hint);
    }

    updateSummary(true);
    $('run').disabled = false;
    $('copy').disabled = false;
  };

  // 结构化克隆失败会走这里，而不是 onerror。不接住的话表现为「Worker 没反应」。
  worker.onmessageerror = (e) => {
    failed++;
    addNote(`Worker 的消息解不开（结构化克隆失败）：${JSON.stringify(e.data ?? null)}`);
    updateSummary(true);
    $('run').disabled = false;
    $('copy').disabled = false;
  };

  worker.postMessage('run');
});

$('copy').addEventListener('click', async () => {
  const text = buildReport();
  try {
    await navigator.clipboard.writeText(text);
    const b = $('copy');
    const was = b.textContent;
    b.textContent = '已复制 ✔';
    setTimeout(() => { b.textContent = was; }, 1500);
  } catch {
    // 剪贴板可能被策略挡住。**必须有退路**——「复制失败」而没有别的办法，
    // 等于这个功能不存在。
    $('report-fallback').hidden = false;
    $('report-text').value = text;
    $('report-text').select();
  }
});
