/**
 * 档案预览页：挑一份档案，读它的 manifest、索引、单条捕获。
 *
 * **只读，不建缓存。** 档案本身就是真相；再存一份派生状态就会有两个可能不一致的
 * 来源（见 panel.js 开头的第三条约束）。
 */

import { renderContent, resetContent } from './content.js';
import { BundleReader } from '../../bundle/bundle-reader.js';
import { WorkerFileStore } from '../../storage/worker-file-store.js';
import { bundleDirName, bundleIdTime } from '../../core/ids.js';
import { captureTitle, captureSubtitle, subjectLabel } from '../capture-label.js';
import { bundlePicker } from '../components.js';
import { routeName } from '../route-names.js';
import {
  $, send, bytes, table, verdictName, STATUS_NAMES, VERDICT_NAMES,
  getOpfsWorker, getLastStatus, scanBundleDirs,
} from './shared.js';

/**
 * 捕获检查器是不是展开着。
 *
 * **跨档案保留**：逐条核对字节的人一定会连着看好几份，每换一份都收回去，就等于
 * 每换一份都要再点一次。模块级变量而不是每次渲染重算——它是用户的选择，不是
 * 从数据推出来的状态。
 */
/**
 * 这一对小标签现在开着哪个：`null`（都收着）/ `'captures'` / `'content'`。
 *
 * **允许都不选**，这与顶上那排主标签不同。档案页已经装着导入、导出、校验、删除、
 * 用量，默认再摊开一大块会没法看；而且「查看内容」一展开就要解析，点一下档案就白
 * 干一次活。
 */
let openPane = null;

/** @type {BundleReader | null} */
export let reader = null;
/** @type {object[]} */
export let entries = [];

/** 这份档案属于谁（数字 uid）。广播抽取要用它滤掉转发进来的别人的内容。 */
let accountUserId = null;

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
    $('archive-summary').className = 'card tone-error';
    $('archive-summary').textContent = `读不出存储：${e.message}`;
    return;
  }

  const st = getLastStatus();
  const active = st?.runner?.bundleId ?? st?.checkpoint?.bundle_id ?? null;
  const ids = scan.map((d) => d.bundleId);

  // 正在抓的那一份没有 manifest，上游只能从 runner 的状态里拿。
  // runner 不在（只有 checkpoint、offscreen 还没起来）时它是 undefined ——
  // **那是「还不知道」，不是「没有上游」**，两者在选择器里长得不一样。
  renderBundlePicker(await describeBundles(scan, active, st?.runner?.previousBundleId));
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
 * @param {Awaited<ReturnType<typeof scanBundleDirs>>} scan
 * @param {string|null} active
 * @param {string|null|undefined} livePrevious  正在抓的那一份的上游（manifest 还没写）
 */
async function describeBundles(scan, active, livePrevious) {
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
    } else if (item.live) {
      // 抓着的那一份：上游从 runner 拿。`undefined` 留着不动 —— 见 components.js，
      // 「还不知道」与「全量」是两行不同的字。
      item.previous = livePrevious;
    }
    // **manifest 是收尾时才写的，所以正在抓的那一份没有时间。**
    //
    // 少了它，下面那句排序会把它当成空字符串——比任何真实时间都小，于是**新的
    // 那一份沉到最底下**。当时侧栏还是 70vh 带滚动条（现在不是了，见 panel.css
    // 里那段），十七份档案排下来它就落在看不见的地方；而右边偏偏默认打开的就是
    // 它（`loadArchive()` 优先选 active）。
    // 用户看到的是「右边显示着一份抓取中的档案，左边整张列表里找不到它」，
    // 于是合理地判断成「列表没刷新」——而列表其实是新的，只是顺序把它藏了。
    //
    // 退路不是猜，是**同一个时刻的另一种写法**：`bundle_id` 的前缀就是创建时刻
    // （`newBundleId(now)` 生成），而 `bundle-writer.js` 写 `created_at` 时用的
    // 也正是 `bundleIdTime(bundleId)`。所以这两条路给出的是同一个数。
    item.at ??= bundleIdTime(id)?.toISOString() ?? null;
    out.push(item);
  }
  // 新的在上。**按时间排，不按目录名排**——目录名恰好也是时间序，但那是巧合，
  // 不是可以依赖的性质。
  //
  // **比的是时刻，不是字符串。** RFC 3339 允许带时区偏移，而 manifest 里写的正是
  // 本地偏移（实测一份真档案：`2026-08-02T22:48:02+10:00`）。按字符串比，
  // 那一刻会被判成晚于 `2026-08-02T13:00:00Z`——而它其实早了 12 分钟。
  // 同一台机器上换个时区、或者跨一次夏令时，列表顺序就会悄悄错乱。
  // 认不出来的排在最后：没有时间是一种未知，不是「很早以前」。
  const ms = (x) => { const t = Date.parse(x?.at ?? ''); return Number.isNaN(t) ? -Infinity : t; };
  out.sort((a, b) => ms(b) - ms(a));
  return out;
}

/**
 * 让「翻看捕获」这个按钮说出它现在是什么状态。
 *
 * 按钮上带条数：**收起来的东西也要能被数出来**——否则「这份档案里有多少条」
 * 就只能靠展开一次才知道，而那正是这个按钮想省掉的动作。
 */
function syncCapturesToggle() {
  const n = entries.length ? `（${entries.length.toLocaleString('zh-CN')} 条）` : '';
  for (const [key, id, sec, label] of [
    ['captures', 'captures-toggle', 'captures-section', `翻看捕获${n}`],
    ['content', 'content-toggle', 'content-section', '查看内容'],
  ]) {
    const btn = $(id);
    const on = openPane === key;
    btn.disabled = !entries.length;
    btn.setAttribute('aria-selected', String(on));
    btn.textContent = label;
    // 标签的名字不跟着状态变（那是按钮的做法，标签靠选中态本身说话）。但「再点一下
    // 能收起来」是标签通常没有的行为，所以用 title 说一句——不写的话没人会去试。
    // 用 setAttribute 而不是 `btn.title =`：属性与特性只在真实 DOM 里互相反射，
    // 而上面那行 aria-selected 本来就走 setAttribute，两行保持一致也少一处例外。
    if (on) btn.setAttribute('title', '再点一下收起');
    else btn.removeAttribute('title');
    $(sec).hidden = !on;
  }
}

/**
 * 绑那一对小标签。
 *
 * **互斥**：点一个就关掉另一个。再点自己则收起来——两块都收着是合法状态，
 * 见 `openPane` 上的说明。
 *
 * 展开时才第一次渲染。捕获列表收起来不清空（再展开是免费的）；内容那一块每次
 * 展开都重新解析——它不缓存，理由见 `content.js`。
 */
export function initCapturesToggle() {
  const panes = {
    captures: () => renderCaptureList(),
    content: () => renderContent({ entries, reader, userId: accountUserId }),
  };
  for (const [key, id] of [['captures', 'captures-toggle'], ['content', 'content-toggle']]) {
    $(id).addEventListener('click', () => {
      openPane = openPane === key ? null : key;
      syncCapturesToggle();
      if (openPane === key) void panes[key]();
    });
  }
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
    // 广播抽取要按 `data-uid` 滤掉转发进来的别人的广播（实测 149 个附图条目里有 30
    // 个是别人的），所以「我是谁」得从 manifest 里取出来传下去。取不到就传 null——
    // 那时抽取器会一条都不认，这比把第三方内容当成你的显示出来要好。
    accountUserId = s?.account?.user_id ?? null;

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
      c.className = 'card tone-idle';
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
      note.className = 'card tone-idle';
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
    //
    // 「已经没有了」的那几条与链上的差异**不跟着捕获列表收起来**。
    //
    // 它们原来长在 `renderCaptures()` 里，而那个函数其实在做三件互不相干的事。
    // 一起收起来的话，整份档案里最不可替代的那点信息（豆瓣上已经删掉的条目）
    // 就只剩「判定分布」里的一个数字——而 panel.html 里那条注释写的正是它不该
    // 只以一个数字出现。
    renderVanished();
    void loadChainDiff();

    // 捕获列表本身收起来时不画：那是五百个 DOM 节点，每换一份档案重画一遍。
    // **收起来的东西不该继续付钱。**
    syncCapturesToggle();
    if (openPane === 'captures') renderCaptureList();
    else if (openPane === 'content') void renderContent({ entries, reader, userId: accountUserId });
  } catch (e) {
    summaryEl.className = 'card tone-error';
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
    c.className = 'card tone-idle';
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
  card.className = 'card tone-idle';
  const b = document.createElement('b');
  b.textContent = `${count} 个网址在链上有多个版本`;
  card.append(b, document.createTextNode(
    '同一网址在不同时间抓取到的内容可能不同：评分变动、短评修改、条目被删除。'
    + '各个版本均予保留。',
  ));
  el.append(card);
}

/** 折起来之后最多还是只画这么多行。展开一次画上千行会把这一页卡住。 */
const BAD_ROWS = 100;

/** 非正常捕获的一行：路线 · 判定 / 网址 + 抓取时刻。 */
function badRow(e) {
  const row = document.createElement('div');
  row.className = 'cap';
  const left = document.createElement('span');
  left.textContent = captureTitle(e, routeName);
  const right = document.createElement('span');
  right.className = 'v warn-text';
  right.textContent = verdictName(e);
  row.append(left, right);

  const url = document.createElement('div');
  url.className = 'muted cap-sub breakable';
  // URL 与时间之间要有明显的分隔——挤在一起时 URL 的结尾会被读成时间的一部分。
  url.textContent = `${e.url}\n抓于 ${String(e.observed_at ?? '').slice(0, 19).replace('T', ' ')}`;
  row.append(url);
  return row;
}

/** @param {object[]} rows */
function badList(rows) {
  const list = document.createElement('div');
  list.className = 'caps';
  for (const e of rows.slice(0, BAD_ROWS)) list.append(badRow(e));
  if (rows.length > BAD_ROWS) {
    const more = document.createElement('div');
    more.className = 'muted cap-sub';
    more.textContent = `另有 ${rows.length - BAD_ROWS} 条同类，可在「翻看捕获」中逐条查看。`;
    list.append(more);
  }
  return list;
}

/**
 * 「已不存在 8 · 判不出来 43」——按判定归类数一遍。
 *
 * 用 `verdictName` 的**前半段**：它会把原因缀在后面（「判不出来 · 选择器该校准了」），
 * 那对单独一行有用，对一句概括只会把三五个类别摊成十几个。
 */
function verdictTally(rows) {
  /** @type {Map<string, number>} */
  const by = new Map();
  for (const e of rows) {
    const k = verdictName(e).split(' · ')[0];
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  return [...by].map(([k, n]) => `${k} ${n}`).join(' · ');
}

/** 超过这么多行就默认收起来。三五行不算长，为它折一次只是让人多点一下。 */
const FOLD_AT = 5;

/**
 * 一块可折叠的清单：标题 + 一句说明 + 若干行。
 *
 * **标题永远看得见**，折起来的只是清单。`<details>` 用原生的，不写一行展开逻辑
 * ——键盘、读屏、浏览器自带的页内查找也就都照旧能用。
 *
 * @param {{title: string, why: string, rows: object[]}} o
 */
function foldSection({ title, why, rows }) {
  const fold = document.createElement('details');
  fold.className = 'fold';
  fold.open = rows.length <= FOLD_AT;

  const sum = document.createElement('summary');
  sum.textContent = title;
  const note = document.createElement('div');
  note.className = 'muted small';
  note.textContent = why;
  fold.append(sum, note, badList(rows));
  return fold;
}

/**
 * 没能正常抓到的那些捕获。
 *
 * ## 为什么值得占一块地方
 *
 * `gone` 是**整份档案里最不可替代的信息**。一份 3347 条的真实档案里有 8 条——
 * 那 8 部电影豆瓣已经删了，网上再也查不到，而你的档案里存着它们当时的样子。
 * 这正是这个项目存在的理由本身。
 *
 * 而它原来只以「判定分布：正常 3339 · 已不存在 8」这一个数字出现，**没有任何地方
 * 说得出是哪 8 条**。捕获列表里能看到，但要在 3347 行里翻。
 *
 * ## 折叠没有把这件事收回去
 *
 * 两块都能折，但**折起来的是清单，不是事实**：条数与分类留在折叠标题上，
 * 「有 8 条在豆瓣上已经没有了」照旧一眼可见——上面那段反对的是「只剩一个数字、
 * 没有任何地方说得出是哪 8 条」，而这里点一下就摊开，说得出。
 *
 * ## 为什么仍然分成两块
 *
 * 因为它们是两回事，混成一张表就分不出轻重了。`gone` 是**豆瓣上已经没有的东西**，
 * 少、且没有别处可查；`blocked` / `要验证` / `判不出来` 是这次抓取的**过程**留下的
 * 痕迹，页面多半还在、下次能重抓，而且**数量由出错的程度决定**——一条路线的选择器
 * 对不上，几十上百条一起进来，同一个网址还会因为重试出现好几遍。
 */
function renderVanished() {
  const el = $('vanished');
  if (!el) return;
  el.replaceChildren();

  const bad = entries.filter((e) => e.verdict !== 'ok');
  if (bad.length === 0) return;

  const gone = bad.filter((e) => e.verdict === 'gone');
  const failed = bad.filter((e) => e.verdict !== 'gone');

  if (gone.length) {
    el.append(foldSection({
      title: `有 ${gone.length} 条在豆瓣上已经没有了`,
      why: '豆瓣已删除这些条目，公开渠道已无法查到；档案中保留了它们当时的内容。',
      rows: gone,
    }));
  }

  if (failed.length) {
    el.append(foldSection({
      title: `有 ${failed.length} 条没能正常抓到（${verdictTally(failed)}）`,
      why: '这些页面未能正常抓取，其原始响应已存入档案，可在「翻看捕获」中打开查看。'
        + '判定为「判不出来」的通常是抽取规则需要校准，重抓无济于事。',
      rows: failed,
    }));
  }
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
function renderCaptureList() {
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
    el.className = 'card tone-error';
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
  openPane = null;
  accountUserId = null;
  resetContent();
}
