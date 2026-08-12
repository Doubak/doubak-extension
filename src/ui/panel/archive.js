/**
 * 档案预览页：挑一份档案，读它的 manifest、索引、单条捕获。
 *
 * **只读，不建缓存。** 档案本身就是真相；再存一份派生状态就会有两个可能不一致的
 * 来源（见 panel.js 开头的第三条约束）。
 */

import { BundleReader } from '../../bundle/bundle-reader.js';
import { WorkerFileStore } from '../../storage/worker-file-store.js';
import { bundleDirName } from '../../core/ids.js';
import { captureTitle, captureSubtitle, subjectLabel } from '../capture-label.js';
import { bundlePicker } from '../components.js';
import { routeName } from '../route-names.js';
import {
  $, send, bytes, table, verdictName, STATUS_NAMES, VERDICT_NAMES,
  getOpfsWorker, getLastStatus, scanBundleDirs,
} from './shared.js';

/** @type {BundleReader | null} */
export let reader = null;
/** @type {object[]} */
export let entries = [];

/**
 * 当前在看哪份档案，以及它的摘要缓存。
 *
 * ## 为什么要一个共同的所有者
 *
 * 覆盖率原来有**两条渲染路径**：档案页 `openBundle()` 的副作用，以及覆盖率页自己的
 * 加载器。两个真相来源，于是：
 *
 * - 没去过档案页时，覆盖率页看到的和档案页可能不是同一份档案
 * - 删掉档案之后，`currentBundleId` 还指着一个已经不存在的目录
 * - 抓完一次之后，缓存没人让它失效
 *
 * 现在只有这里一处知道「在看哪份、它的摘要是什么」，两个标签页都从这里读；任何会改变
 * 存储的动作都调 `invalidateBundles()`。
 */
export let currentBundleId = null;
/** @type {{id: string, summary: object} | null} 摘要缓存，避免两个标签页各读一次 */
let summaryCache = null;

/**
 * 存储变了：删了档案、抓完一次、清空。
 *
 * 缓存作废，并且**如果当前选中的那份已经不在了就取消选中**——不取消的话，下一次读取
 * 会去开一个不存在的目录然后报「读不出来」，而真实情况只是它被删了。
 *
 * @param {string[]} [remainingIds]  还剩哪些；不给就只作废缓存
 */
export function invalidateBundles(remainingIds) {
  summaryCache = null;
  if (remainingIds && currentBundleId && !remainingIds.includes(currentBundleId)) {
    currentBundleId = null;
  }
  // 已经渲染出来的内容立刻标记为过期，免得用户看着旧数字以为还在
  for (const id of ['coverage', 'archive-summary', 'captures']) {
    const el = $(id);
    if (el) el.dataset.stale = '1';
  }
}

/**
 * 读当前档案的摘要。**两个标签页共用这一处**。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force]
 * @returns {Promise<{id: string, summary: object} | null>}  没有档案时返回 null
 */
export async function loadBundleSummary({ force = false } = {}) {
  const ids = (await scanBundleDirs()).map((d) => d.bundleId);

  // 选中的那份没了（被删了）就退回最新的一份
  if (currentBundleId && !ids.includes(currentBundleId)) currentBundleId = null;
  const id = currentBundleId ?? ids[0];
  if (!id) {
    summaryCache = null;
    return null;
  }

  if (!force && summaryCache?.id === id) return summaryCache;

  const store = new WorkerFileStore({ worker: getOpfsWorker(), dir: bundleDirName(id) });
  const summary = await new BundleReader({ store, bundleId: id }).summary();
  summaryCache = { id, summary };
  return summaryCache;
}

export async function loadArchive() {
  // 抓取跑完之后 checkpoint 与指针都不再指向那份档案——所以不能只看状态，
  // 得直接去 OPFS 里数目录。否则「跑完了」恰好等于「再也导不出来」。
  let scan = [];
  try {
    scan = await scanBundleDirs();
  } catch (e) {
    $('archive-summary').className = 'card err';
    $('archive-summary').textContent = `读不出存储：${e.message}`;
    return;
  }

  const active = getLastStatus()?.runner?.bundleId ?? getLastStatus()?.checkpoint?.bundle_id ?? null;
  const ids = scan.map((d) => d.bundleId);

  renderBundlePicker(await describeBundles(scan, active));
  if (ids.length === 0) {
    currentBundleId = null;
    $('archive-summary').className = 'muted';
    $('archive-summary').textContent = '还没有档案。开始一次抓取之后这里会显示内容。';
    setArchiveButtons(false);
    $('captures').className = 'muted';
    $('captures').textContent = '选一个档案后显示';
    return;
  }

  await openBundle(currentBundleId && ids.includes(currentBundleId)
    ? currentBundleId
    : (active ?? ids[0]));
}

/**
 * 档案选择器。
 *
 * ## 原来是个下拉框，装的是档案编号
 *
 * 八份 `20260801T005010Z-3eef52` 这样的字符串，人只能靠后六位分辨，而后六位
 * 不携带任何意义。更别扭的是**必须先选一份才看得见它有什么，而选择本身正需要
 * 那些信息**——鸡生蛋。
 *
 * 现在每一行自己说清楚：什么时候抓的、接在谁后面、多大、多少条、导出了没有。
 * 这些数字**本来就都在**（manifest 与文件大小），只是从没被拿出来给人看。
 *
 * ## 读 manifest 失败不影响选择
 *
 * 拿不到就只显示编号——**一份读不出 manifest 的档案恰恰最需要能被选中**
 * （用户要去看它出了什么事）。因元数据缺失而让它从列表里消失是最糟的处理。
 *
 * @param {Array<{id: string, at?: string|null, bytes?: number|null, captures?: number|null,
 *   previous?: string|null, live?: boolean, exported?: boolean|null}>} items
 */
function renderBundlePicker(items) {
  const el = $('bundle-pick');
  el.replaceChildren();
  if (items.length <= 1) return;
  el.append(bundlePicker({
    items,
    selected: currentBundleId,
    onPick: (id) => { if (id !== currentBundleId) openBundle(id); },
    fmtBytes: bytes,
  }));
}

/**
 * 把每份档案的元数据读出来，供选择器显示。
 *
 * 目录清单与 manifest 由 `scanBundleDirs()` 统一读一遍（存储占用那一行也用同一份）
 * ——同一次打开页面扫两遍盘是没有理由的，而两处扫描还意味着两处要各自记得失效。
 *
 * @param {Awaited<ReturnType<typeof scanBundleDirs>>} scan @param {string|null} active
 */
async function describeBundles(scan, active) {
  /** @type {Record<string, string|null>} */
  let exportedAt = {};
  try {
    const rec = await send({ type: 'exportRecords', bundleIds: scan.map((d) => d.bundleId) });
    // 记录读不出来时不许显示成「未导出」——那是替用户下一个我们没资格下的判断。
    if (rec?.ok) exportedAt = rec.exportedAt ?? {};
    else exportedAt = null;
  } catch { exportedAt = null; }

  const out = [];
  for (const { bundleId: id, files, manifest } of scan) {
    const item = {
      id,
      live: id === active,
      exported: exportedAt ? Boolean(exportedAt[id]) : null,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
    };
    if (manifest) {
      item.at = manifest.created_at ?? manifest.started_at ?? null;
      item.previous = manifest.previous_bundle_id ?? null;
      item.captures = manifest.index?.line_count ?? manifest.counts?.captures ?? null;
    }
    out.push(item);
  }
  // 新的在上。**按时间排，不按目录名排**——目录名恰好也是时间序，但那是巧合，
  // 不是可以依赖的性质。
  out.sort((a, b) => ((a.at ?? '') < (b.at ?? '') ? 1 : -1));
  return out;
}

/** @param {boolean} on */
export function setArchiveButtons(on) {
  $('export').disabled = !on;
  $('export-chain').disabled = !on;
  $('verify').disabled = !on;
  $('delete-this').disabled = !on;
}

/**
 * 把左边列表里的高亮挪到某一份上。
 *
 * ## 为什么不是画列表时一次定好
 *
 * `loadArchive()` 里画列表在**决定开哪一份之前**：那时 `currentBundleId` 还是
 * null（首次打开、或者刚删过），于是整张列表一行都不高亮，而右边明明已经显示着
 * 某一份的内容。用户看到的是「右边有东西，左边看不出是哪一行」——点回那一行还
 * 没有任何反应（它本来就是当前那份），于是像坏了。
 *
 * 换个顺序也能修，但把高亮交给 `openBundle()` 更稳：**选中状态跟着「真的开了
 * 哪一份」走**，而不是跟着某一次渲染的时序走。点击那条路径（`onPick` → 直接
 * `openBundle`，根本不重画列表）也就一起对了。
 *
 * @param {string} bundleId
 */
function markPicked(bundleId) {
  for (const row of $('bundle-pick').querySelectorAll('.picker-row')) {
    row.setAttribute('aria-selected', String(row.dataset.id === bundleId));
  }
}

/** @param {string} bundleId */
export async function openBundle(bundleId) {
  currentBundleId = bundleId;
  markPicked(bundleId);
  // **上一份档案的操作结果要清干净，class 也要清。**
  //
  // 只清 textContent 的话会留下一个**空的红框**——比留着错误信息更糟：它看起来
  // 像出了事，却什么都不说。（删「正在抓的那份」被拒之后切换档案，就是这个样子。）
  for (const id of ['export-result', 'verify-result', 'archive-incremental']) {
    const el = $(id);
    el.className = '';
    el.replaceChildren();
  }
  const summaryEl = $('archive-summary');
  $('export-result').replaceChildren();
  $('verify-result').replaceChildren();

  try {
    const store = new WorkerFileStore({ worker: getOpfsWorker(), dir: bundleDirName(bundleId) });
    reader = new BundleReader({ store, bundleId });
    const cur = await loadBundleSummary({ force: true });
    const s = cur?.summary ?? (await reader.summary());
    entries = await reader.index();

    summaryEl.className = '';
    summaryEl.replaceChildren(
      table(
        ['项', '值'],
        [
          ['档案编号', s.bundleId],
          ['账号', s.account
            ? `${s.account.username ?? ''}（${s.account.user_id ?? ''}）`
            : { text: '要等收尾时写进 manifest', muted: true }],
          ['状态', STATUS_NAMES[s.status] ?? s.status],
          ['捕获条数', String(s.captures)],
          // 没有 manifest 时体积是从 index 累加的下界（段文件里还有 gzip 头尾），
          // 说清楚它是估的——否则界面只能猜着说。
          ['体积', s.totalBytesExact ? bytes(s.totalBytes) : `约 ${bytes(s.totalBytes)}（不含压缩头尾）`],
          ['判定分布', Object.entries(s.byVerdict).map(([k, v]) => `${VERDICT_NAMES[k] ?? k} ${v}`).join(' · ') || '—'],
        ],
      ),
    );

    // **全量还是增量**，单独一块。增量档案的「捕获条数」看起来会小得离谱
    // （只有新增的那些），不说清的话像是抓漏了。
    //
    // 渲染进**它自己的容器**，不是 `summaryEl.after()`。后者是往兄弟节点里插，
    // 没人负责清——切一次档案就多留一张，而留下的那张说的还是**上一份**档案的
    // 上游。真实现象：打开一份 05:13 的全量档案，上面挂着两张一模一样的卡片，
    // 都写着「接在 11:21 那份后面」——一份 05:13 的档案不可能接在 11:21 后面。
    const incEl = $('archive-incremental');
    incEl.replaceChildren();
    if (s.previousBundleId) {
      const c = document.createElement('div');
      c.className = 'card idle';
      const b = document.createElement('b');
      b.textContent = '这是一次增量抓取';
      c.append(b, document.createTextNode(
        `接续档案 ${s.previousBundleId}，仅抓取了上次之后新增的部分。`
        + '因此「捕获条数」少于全量抓取属于正常现象；完整性请查看覆盖率页的「合起来」视图。',
      ));
      incEl.append(c);
    }

    // 进行中的档案要主动解释一句。**「还没收尾」不是「坏了」**——它没有
    // manifest，所以校验只能验字节数、覆盖率证据也还没攒。不说清楚的话，用户看到
    // 一堆空字段会以为几小时的抓取白费了。
    if (!s.hasManifest) {
      const note = document.createElement('div');
      note.className = 'card idle';
      const b = document.createElement('b');
      b.textContent = '这次抓取还没收尾';
      note.append(b, document.createTextNode(
        'manifest.json 于收尾时写入，因此账号、体积、覆盖率证据目前尚不可见。'
        + '这并不表示档案损坏：已抓取的每一页均已落盘，此时导出亦可正常进行，'
        + '只是校验只能核对字节数（尚无摘要可比对）。抓取完成后重新查看本页即可看到完整信息。',
      ));
      summaryEl.append(note);
    }
    setArchiveButtons(true);
    // **不在这里渲染覆盖率。** 那会是第二条路径，也就是第二个真相来源——覆盖率页
    // 自己有加载器，切过去时会从同一处读。
    renderCaptures();
  } catch (e) {
    summaryEl.className = 'card err';
    summaryEl.textContent = `读不出这个档案：${e.message}`;
    // 读不出摘要不代表导不出去——字节还在，照样该让用户把它搬走。
    setArchiveButtons(true);
  }
}

/**
 * 这一份在链上的位置、哪些是新增的、以及跨链的版本历史。
 *
 * 增量档案里混着两种东西：这次新出现的条目，和边界上被重抓的那几条（下界比较是
 * 闭区间，宁可重复不可遗漏）。捕获列表里它们长得一模一样，而用户想知道的恰恰是
 * 「这次到底新得到了什么」。
 *
 * **只读 index，不解压任何记录**——这两个问题的答案全在 index 里。
 */
async function loadChainDiff() {
  const el = $('archive-chain');
  const vEl = $('versions');
  el.replaceChildren();
  vEl.replaceChildren();
  if (!currentBundleId) return;

  const r = await send({ type: 'chainDiff', bundleId: currentBundleId });
  if (!r?.ok || !r.diff) return;
  // 用户可能在这期间切了档案
  if (!currentBundleId) return;

  const repeated = new Set(r.diff.repeated ?? []);
  if (repeated.size) {
    const c = document.createElement('div');
    c.className = 'card idle';
    const b = document.createElement('b');
    const fresh = entries.length - repeated.size;
    b.textContent = `本次新增 ${fresh} 条，已抓取多次 ${repeated.size} 条`;
    c.append(b, document.createTextNode(
      '重复抓取属于预期行为：增量抓取的下界采用闭区间比较（宁可重复，不可遗漏），'
      + '因此边界处会有重叠。同一网址的多次捕获记录的是不同时刻的版本，并非冗余数据。',
    ));
    el.append(c);
    // 就地给列表补标
    markRepeated(repeated);
  }

  renderVersions(r.diff.versionCount ?? 0);
}

/** 给捕获列表里「又抓了一次」的那些行补一个标记。 */
function markRepeated(repeated) {
  for (const [i, e] of entries.slice(0, 500).entries()) {
    if (!repeated.has(e.url_key)) continue;
    const row = $('captures').children[i];
    const tag = row?.querySelector?.('span');
    if (tag && !tag.textContent.includes('已抓取多次')) tag.textContent += '　·　已抓取多次';
  }
}

/**
 * 版本历史：链上有多少个网址被抓到过不止一次。
 *
 * **只报个数，不列清单。** 第一版把每个网址连同各版本的日期都列出来，几百行——
 * 而这一页的读者想知道的只是「有没有、有多少」。真要看某一条的历史，那属于
 * parser 之后的事（canonical 的 revision 模型），不是档案页该扛的。
 *
 * **这不是重复数据，是版本**——评分变了、短评改了、条目被删了。
 *
 * @param {number} count
 */
function renderVersions(count) {
  const el = $('versions');
  if (!count) return;

  const card = document.createElement('div');
  card.className = 'card idle';
  const b = document.createElement('b');
  b.textContent = `${count} 个网址在链上有多个版本`;
  card.append(b, document.createTextNode(
    '同一网址在不同时间抓取到的内容可能不同：评分变动、短评修改、条目被删除。'
    + '各个版本均予保留。',
  ));
  el.append(card);
}

/**
 * 「豆瓣上已经没有了」的那几条，单独列出来。
 *
 * ## 为什么值得占一块地方
 *
 * 这是**整份档案里最不可替代的信息**。一份 3347 条的真实档案里有 8 条 `gone`——
 * 那 8 部电影豆瓣已经删了，网上再也查不到，而你的档案里存着它们当时的样子。
 * 这正是这个项目存在的理由本身。
 *
 * 而它原来只以「判定分布：正常 3339 · 已不存在 8」这一个数字出现，**没有任何地方
 * 说得出是哪 8 条**。捕获列表里能看到，但要在 3347 行里翻。
 *
 * 顺带也列 `blocked` / `challenge` / 判不出来的：它们是风控留下的痕迹，同样稀少
 * 同样要紧。
 */
function renderVanished() {
  const el = $('vanished');
  if (!el) return;
  el.replaceChildren();

  const bad = entries.filter((e) => e.verdict !== 'ok');
  if (bad.length === 0) return;

  const card = document.createElement('div');
  card.className = 'card warn';
  const b = document.createElement('b');
  const goneCount = bad.filter((e) => e.verdict === 'gone').length;
  b.textContent = goneCount
    ? `有 ${goneCount} 条在豆瓣上已经没有了`
    : `有 ${bad.length} 条不是正常抓到的`;
  card.append(b, document.createTextNode(
    goneCount
      ? '豆瓣已删除这些条目，公开渠道已无法查到；档案中保留了它们当时的内容。'
      : '这些页面未能正常抓取，其原始响应已存入档案，可打开查看具体内容。',
  ));
  el.append(card);

  const list = document.createElement('div');
  list.className = 'caps';
  for (const e of bad) {
    const row = document.createElement('div');
    row.className = 'cap';
    const left = document.createElement('span');
    left.textContent = captureTitle(e, routeName);
    const right = document.createElement('span');
    right.className = 'v warn-text';
    right.textContent = verdictName(e);
    row.append(left, right);

    const url = document.createElement('div');
    url.className = 'muted cap-sub';
    url.className = url.className ? `${url.className} breakable` : 'breakable';
    // URL 与时间之间要有明显的分隔——挤在一起时 URL 的结尾会被读成时间的一部分。
    url.textContent = `${e.url}\n抓于 ${String(e.observed_at ?? '').slice(0, 19).replace('T', ' ')}`;

    row.append(url);
    list.append(row);
  }
  el.append(list);
}

/**
 * 捕获列表。
 *
 * ## 为什么每行要说这么多
 *
 * 原来一行只有路线名与判定，于是列表长成一串「广播 正常 / 广播 正常 / 广播 正常」
 * ——除了顺序之外什么信息都没有，而档案页存在的意义恰恰是**在档案里找东西**。
 *
 * 现在每行给四样，都是不解压任何记录就能拿到的（全在 index 里）：
 *
 * | | 从哪来 | 回答什么 |
 * |---|---|---|
 * | 路线 · 第几页 | `route_key` / `cursor` | 这是哪条线的第几页 |
 * | 条目数 | `item_count` | 这一页有多少条（0 是终点的正常形态） |
 * | 时间区间 | `item_time_range` | **这一页是哪段时间** ← 找东西时的第一个问题 |
 * | 判定 · 体积 | `verdict` / `length` | 正常吗、多大 |
 *
 * 时间区间是这次专门为此加进规范的可选字段（bundle/v1 §6.1.2）：抓取时本来就算过，
 * 扔掉之后再想知道就得把记录取出来解压、再跑一遍选择器——而豆瓣改版之后那些选择器
 * 可能已经对不上了。
 */
function renderCaptures() {
  // 「已经没有了」的那几条单独列一块。**捕获列表只渲染前 500 行**，而真实档案有
  // 3347 条——那 8 条 gone 排在后面，在列表里根本画不出来。
  renderVanished();
  // 链上的差异（新增 / 又抓了一次）与版本历史。异步，拿到之后就地补标。
  void loadChainDiff();

  const el = $('captures');
  el.replaceChildren();
  el.className = '';
  if (!entries.length) {
    el.className = 'muted';
    el.textContent = '这个档案里还没有捕获';
    return;
  }

  for (const e of entries.slice(0, 500)) {
    const row = document.createElement('div');
    row.dataset.id = e.capture_id;

    const main = document.createElement('div');
    main.className = 'cap-main';

    const left = document.createElement('span');
    left.textContent = captureTitle(e, routeName);
    const right = document.createElement('span');
    right.className = 'v';
    // 判定只在**不是 ok** 的时候才显示。一整列「正常」是纯噪音，而那正好淹没了
    // 真正要看见的那几行。
    right.textContent = e.verdict === 'ok'
      ? bytes(e.length ?? 0)
      : `${verdictName(e)} · ${bytes(e.length ?? 0)}`;
    if (e.verdict !== 'ok') right.classList.add('warn-text');
    main.append(left, right);

    const sub = document.createElement('div');
    sub.className = 'cap-sub';
    sub.textContent = captureSubtitle(e);

    row.append(main, sub);
    row.onclick = () => showCapture(e);
    el.append(row);
  }

  if (entries.length > 500) {
    const more = document.createElement('div');
    more.className = 'muted';
    more.textContent = `另有 ${entries.length - 500} 条未列出`;
    el.append(more);
  }
}

/** @param {object} entry */
async function showCapture(entry) {
  for (const d of $('captures').querySelectorAll('div[data-id]')) {
    d.setAttribute('aria-selected', String(d.dataset.id === entry.capture_id));
  }

  const el = $('preview');
  el.className = '';
  el.replaceChildren(document.createTextNode('正在读取…'));

  try {
    const r = await reader.readEntry(entry);
    el.replaceChildren();

    el.append(
      table(
        ['项', '值'],
        [
          ['URL', entry.url],
          ...(entry.final_url ? [['跟随跳转后', entry.final_url]] : []),
          ['判定', verdictName(entry)],
          ['抓取原因', entry.intent],
          ['保真度', entry.capture_fidelity],
          ['抓取时间', entry.observed_at],
          ['所在段', `${entry.segment} @${entry.offset}+${entry.length}`],
        ],
      ),
    );

    const ct = (entry.content_type ?? '').toLowerCase();
    if (ct.startsWith('image/')) {
      // 图片直接显示。用 blob URL，不往 DOM 里塞 data URI。
      const img = document.createElement('img');
      img.src = URL.createObjectURL(new Blob([r.body], { type: entry.content_type }));
      img.onload = () => URL.revokeObjectURL(img.src);
      el.append(img);
    } else {
      // HTML 与 JSON 都以**源码**显示，不渲染。
      //
      // 这是刻意的：渲染存档下来的豆瓣页面会让它去加载外部资源，既破坏
      // 「离线可读」的前提，也把第三方请求带回来了——而这个项目的整个立场
      // 就是不依赖外部服务。
      const pre = document.createElement('pre');
      pre.textContent = r.bodyText.slice(0, 200_000);
      el.append(pre);
      if (r.bodyText.length > 200_000) {
        const note = document.createElement('div');
        note.className = 'muted';
        note.textContent = `（只显示前 200 KB，共 ${bytes(r.body.length)}）`;
        el.append(note);
      }
    }
  } catch (e) {
    el.className = 'card err';
    el.textContent = `读不出这条捕获：${e.message}`;
  }
}

/**
 * 把「当前档案的摘要」标记为过期。
 *
 * 拆分之前，别的标签页是**直接给 `summaryCache` 赋 null** 的——那时它们同在一个
 * 文件里，看不出这是跨界。给它一个名字之后，「谁会让这份缓存失效」在 import 里
 * 就是可数的。
 */
export function invalidateSummary() {
  summaryCache = null;
}

/**
 * 清掉「正在看哪一份档案」。删档案之后用。
 *
 * 同上：原来是存储页直接改 `currentBundleId` 与 `entries` 两个变量。
 */
export function clearSelection() {
  currentBundleId = null;
  entries = [];
}

/**
 * 把这一页的视图状态清回「刚打开面板」的样子。
 *
 * 拆分之前这件事是**隐式**的：整个面板就是一个模块，模块被加载 = 面板被打开，
 * 于是模块级变量天然是新的。拆成十个模块之后这个等号不再成立——壳可以重新跑，
 * 而各页的模块实例还在，上一次的 `preflightShown` 之类会跟着留下来。
 *
 * 所以现在由 `panel.js` 的启动段显式调用。生产环境里它每次都作用在全新的状态上，
 * 是个空操作；而测试里同一个进程要反复开面板，靠的就是它。
 */
export function resetArchive() {
  reader = null;
  entries = [];
  currentBundleId = null;
  summaryCache = null;
}
