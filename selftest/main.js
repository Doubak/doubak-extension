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
function addCase(c) {
  const el = groupEl(c.group);
  const line = document.createElement('div');
  line.className = `case ${c.ok ? 'ok' : 'no'}`;
  line.textContent = c.name;
  el.append(line);
  if (!c.ok) {
    const err = document.createElement('div');
    err.className = 'err';
    err.textContent = c.error ?? '(无错误信息)';
    el.append(err);
  }
  c.ok ? passed++ : failed++;
  updateSummary(false);
}

/** @param {string} text */
function addNote(text) {
  const el = document.createElement('div');
  el.className = 'note';
  el.textContent = text;
  results.append(el);
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
  }
  $('env').replaceChildren(table);
}

$('run').addEventListener('click', async () => {
  $('run').disabled = true;
  results.replaceChildren();
  groups.clear();
  passed = failed = 0;

  await probeEnvironment();

  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'case') addCase(m);
    else if (m.type === 'note') addNote(m.text);
    else if (m.type === 'done') {
      updateSummary(true);
      $('run').disabled = false;
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
      worker.terminate();
    }
  };
  worker.onerror = (e) => {
    failed++;
    addNote(`Worker 出错：${e.message}`);
    updateSummary(true);
    $('run').disabled = false;
  };
  worker.postMessage('run');
});
