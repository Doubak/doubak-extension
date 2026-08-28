/**
 * 「导出」页：把档案算成可以交出去的三种东西。
 *
 * ## 与「档案」页的分工
 *
 * 档案页搬的是 **WARC 本身**——不可替代的那份，删了就没有第二处。这一页出的是
 * **从它算出来的东西**，随时可以重算。两件事性质不同，所以是两页；档案页那句
 * 「导出之前，档案并不真正属于你」也就只在那一页成立。
 *
 * ## 三条选择，各有理由
 *
 * **① 中间产物不落盘。** canonical 只活在内存里。理由见 `pipeline/run.js`：
 * 派生数据落了盘就是第二个真相来源，而它本来就可重算。
 *
 * **② 一次只跑一个。** 三种产出共用同一次解析，同时跑两个等于把最慢的那步做两遍；
 * 而且进度条只有一条，两个一起跑就说不清是谁的进度。所以跑起来之后其余按钮全禁掉。
 *
 * **③ 直接写进用户选的文件夹，不在扩展里中转。** `createWritable()` 写的是临时
 * 文件，只在 `close()` 那一刻整体换上去——所以中断留下的是「没有这个文件」，
 * 而不是「半个文件」。中转一趟只会让派生数据在 OPFS 里再占一份，而那正是 ① 要
 * 躲开的事。
 *
 * ## 库里混了两个账号：让你选一个，而不是让你删东西
 *
 * 解析器拒绝把两个账号合进同一份 canonical，理由是合过之后拆不开。命令行那边的出路
 * 是 `--ignore-warnings`，但**这一侧不该照搬那个出路**，有两个原因：
 *
 * **① 合并出来的东西会说谎。** 实测：两个账号一起解析时，产出的 `account` 只有其中
 * 一个（第一条标记那个），而 marks 里两个账号的记录都在。NeoDB 的包会因此在文件头
 * 写着 A 的用户名，里面装着 B 的记录。
 *
 * **② 这一侧有命令行没有的东西：每份档案的 manifest 就在手上。** 所以不必在「合并」
 * 与「删掉一批」之间二选一——直接按账号分开导就行，两个账号各导一次，一条都不丢，
 * 而且每份产出的 `account` 都是对的。
 *
 * 导入那边早就让用户回答过「这确实是我另一个账号」（`allowOtherAccounts`），
 * 而导出这边原来只会说「去把它们删了」。两条路互相矛盾，这一版把它抹平。
 *
 * 认不出账号的档案（没有 manifest，多半是抓到一半被打断的）**跟着一起导，并且说出来**
 * ——INGESTION.md §2.3：该受限的是「凭它能下什么结论」，不是数据本身。
 *
 * ## 进度条有百分比，而抓取那边没有
 *
 * 看起来跟面板的第②条约束（「进度不用百分比」）冲突，其实不是：那一条说的是
 * **豆瓣的计数不可信，拿它当分母会给出一个看起来特别可信的假数字**。这里的分母是
 * 本地 index 的行数与本地文件数，是我们自己数出来的，可信。档案导出那边的字节
 * 百分比是同一个道理。
 */

import {
  $, bytes as fmtBytes, getOpfsWorker, scanBundleDirs,
} from './shared.js';
import { WorkerFileStore } from '../../storage/worker-file-store.js';
import { parseLibrary } from '../../pipeline/run.js';
import { buildCanonical, buildNeodb, buildMarkdown } from '../../pipeline/targets.js';

/** 正在跑的那一个。非 null 时其余按钮禁用。 */
let running = null;

/** 选中要导哪个账号（`user_id`）。库里只有一个账号时是 null。 */
let account = null;

/**
 * 按账号把档案分组。
 *
 * @param {Array<{bundleId: string, manifest: object|null}>} entries
 * @returns {{groups: Array<{userId: string, username: string|null, entries: object[]}>,
 *            unattributed: object[]}}
 *   `groups` 按档案数从多到少排；`unattributed` 是认不出账号的那些。
 */
export function groupByAccount(entries) {
  /** @type {Map<string, {userId: string, username: string|null, entries: object[]}>} */
  const by = new Map();
  const unattributed = [];
  for (const e of entries) {
    // **只按数字 id 分。** 改过名（id 相同、用户名不同）不是另一个人——
    // 导入那边是同一条判据（`isOtherAccount`），两处必须一致。
    const id = e.manifest?.account?.user_id;
    if (!id) { unattributed.push(e); continue; }
    const key = String(id);
    if (!by.has(key)) {
      by.set(key, { userId: key, username: e.manifest?.account?.username ?? null, entries: [] });
    }
    by.get(key).entries.push(e);
  }
  return {
    groups: [...by.values()].sort((a, b) => b.entries.length - a.entries.length),
    unattributed,
  };
}

/**
 * 这次要导哪些档案。
 *
 * 认不出账号的**总是跟着一起导**：一份没有 manifest 的档案多半是抓到一半被打断的，
 * 把它扔掉等于因为它残缺而惩罚它，而残缺恰恰是它最需要被带走的理由。
 */
function entriesFor(all) {
  const { groups, unattributed } = groupByAccount(all);
  if (groups.length <= 1) return all;
  const pick = groups.find((g) => g.userId === account) ?? groups[0];
  return [...pick.entries, ...unattributed];
}

/**
 * 三种产出。**顺序按「多数人要哪个」排**，与 HTML 里的卡片一致。
 *
 * `dir` 是写进用户所选文件夹里的子目录名。**必须各占一个子目录**：平铺的话
 * 三种产出的 `README` 之类会互相覆盖，而档案页早就为这件事付过一次代价
 * （用户的下载目录里只剩最后一次导出的 manifest）。
 */
const FORMATS = {
  neodb: {
    button: 'export-neodb',
    name: 'NeoDB 导入包',
    dir: 'doubak-neodb',
    build: (data) => buildNeodb(data),
    summary: (r) => [
      `标记 ${r.marks} 条`,
      `评分 ${r.ratings} · 短评 ${r.comments} · 标签 ${r.tags}`,
      `书评影评 ${r.reviews} · 日记 ${r.notes + r.articles} · 豆列 ${r.collections}`,
      r.shelfLogs ? `状态历史 ${r.shelfLogs} 条（从广播还原，豆瓣自己已经不显示了）` : null,
    ].filter(Boolean),
    next: '把 neodb-ndjson-import.zip 传到 NeoDB 的「设置 → 数据 → 导入 NeoDB 备份」。'
      + '旁边那几个文件是给你看的，不用上传。',
  },
  canonical: {
    button: 'export-canonical',
    name: '结构化数据',
    dir: 'doubak-canonical',
    build: (data) => buildCanonical(data),
    summary: (r) => [
      `标记 ${r.marks} 条（共 ${r.revisions} 次观测）`,
      `作品 ${r.subjects} · 广播 ${r.broadcasts}`,
      `日记与评论 ${r.longform} · 豆列 ${r.doulists}`,
    ],
    next: '这五个 ndjson 就是下游工具的输入。用 jq 直接读，或者交给导出适配器 / 站点生成器。',
  },
  markdown: {
    button: 'export-markdown',
    name: 'Markdown 站点',
    dir: 'doubak-markdown',
    build: (data, ctx) => buildMarkdown(data, {
      sources: ctx.sources,
      write: ctx.write,
      onImageProgress: (p) => progress('正在导出图片', p.done, p.total),
    }),
    summary: (r) => [
      `${r.pages} 个页面 · ${r.images} 张图`,
      `标记 ${r.marks} · 广播 ${r.broadcasts}（分 ${r.broadcastMonths} 个月）· 长文 ${r.longform}`,
      `搜索索引 ${r.searchRows} 条`,
      // **「还指着豆瓣」与「缺了」不是一回事，必须分开说。** 前者页面上有图，
      // 但要豆瓣还活着才看得见——那正是这个项目存在的理由要消掉的前提。
      r.remote.length ? `⚠ ${r.remote.length} 张图没导出成本地，页面上仍然指向豆瓣` : null,
      r.missing.length ? `⚠ ${r.missing.length} 张图档案里没有` : null,
    ].filter(Boolean),
    next: '把这个文件夹交给 Hugo / Astro / Eleventy / Jekyll。'
      + '站点生成器仓库里有一个五个文件的 Hugo 骨架，拷进去就能跑。',
  },
};

/**
 * 进度。
 *
 * **没有分母时不写 `value`**，原生 `<progress>` 于是进入「不确定」状态（来回扫）。
 * 那正好对应「正在生成文件」这种算不出总数的阶段——显示一个 0% 会看起来像卡住了，
 * 而卡住与「在动但不知道还有多久」是两件必须分清的事。
 */
function progress(text, done = 0, total = 0) {
  $('formats-progress').hidden = false;
  const bar = $('formats-bar');
  if (total) bar.value = Math.round((done / total) * 100);
  else bar.removeAttribute('value');
  $('formats-progress-text').textContent = total ? `${text} ${done} / ${total}` : text;
}

function hideProgress() {
  $('formats-progress').hidden = true;
  $('formats-bar').removeAttribute('value');
}

/** 跑起来之后其余按钮全禁掉。见文件头第②条。 */
function setBusy(on, exceptId = null) {
  for (const f of Object.values(FORMATS)) {
    const btn = $(f.button);
    btn.disabled = on;
    if (on && f.button === exceptId) btn.textContent = '正在导出…';
    else if (!on) btn.textContent = '导出…';
  }
}

/**
 * 往一个目录句柄里写文件，路径里的 `/` 当子目录。
 *
 * @param {FileSystemDirectoryHandle} root
 * @returns {(rel: string, data: Uint8Array) => Promise<void>}
 */
function writerFor(root) {
  /** @type {Map<string, Promise<FileSystemDirectoryHandle>>} 子目录只建一次 */
  const dirs = new Map();

  const dirFor = (parts) => {
    const key = parts.join('/');
    if (!dirs.has(key)) {
      dirs.set(key, parts.reduce(
        async (parent, name) => (await parent).getDirectoryHandle(name, { create: true }),
        Promise.resolve(root),
      ));
    }
    return dirs.get(key);
  };

  return async (rel, data) => {
    const parts = rel.split('/');
    const name = parts.pop();
    const dir = parts.length ? await dirFor(parts) : root;
    const fh = await dir.getFileHandle(name, { create: true });
    // **走 createWritable，不是先攒后写。** 它写的是临时文件，只在 close() 那一刻
    // 整体换上去——中断留下的是「没有这个文件」，而不是「半个文件」。
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  };
}

/** @param {string} kind */
async function runExport(kind) {
  const format = FORMATS[kind];
  const el = $('formats-result');

  if (typeof window.showDirectoryPicker !== 'function') {
    el.className = 'card tone-error';
    el.textContent = '这个浏览器不支持选择文件夹（File System Access API）。请使用 Chrome 或 Edge。';
    return;
  }

  const all = await scanBundleDirs();
  if (!all.length) {
    el.className = 'card tone-error';
    el.textContent = '扩展里一份档案都没有。先抓一次，或者到「档案」页导入一份。';
    return;
  }
  // 混了账号时只导选中的那个。见文件头「库里混了两个账号」。
  const entries = entriesFor(all);

  /** @type {FileSystemDirectoryHandle} */
  let picked;
  try {
    picked = await window.showDirectoryPicker({ mode: 'readwrite', id: 'doubak-export' });
  } catch {
    return; // 用户取消了，什么都不用说
  }

  running = kind;
  setBusy(true, format.button);
  el.className = 'card tone-busy';
  el.textContent = `正在解析 ${entries.length} 份档案…`;

  try {
    const root = await picked.getDirectoryHandle(format.dir, { create: true });
    const write = writerFor(root);

    // ── 解析。**每次都重来**，不留中间产物（见文件头①）。
    const { data, sources } = await parseLibrary({
      entries,
      openStore: (entry) => new WorkerFileStore({ worker: getOpfsWorker(), dir: entry.dir }),
      onProgress: (p) => {
        if (p.phase === 'open') progress('正在打开档案', p.done, p.total);
        else progress('正在解析页面', p.done, p.total);
      },
    });

    progress('正在生成文件');
    const built = await format.build(data, { sources, write });

    for (const [i, f] of built.files.entries()) {
      progress('正在写文件', i + 1, built.files.length);
      await write(f.name, f.bytes);
    }

    hideProgress();
    showResult(format, built, data, entries.length);
  } catch (e) {
    hideProgress();
    el.className = 'card tone-error';
    el.replaceChildren();
    const b = document.createElement('b');
    b.textContent = '导出失败';
    el.append(b, document.createTextNode(e.message));

    // **解析器那条消息的结尾是给命令行写的**（「加 --ignore-warnings」），
    // 而这里没有命令行。原样印出来等于让人去找一个不存在的开关，
    // 所以补一句这一侧真的能做的事。
    //
    // 不在界面上做一个「照样合并」的按钮：那道拦截存在的理由是合并过的
    // canonical 事后拆不开，而一个就在旁边的按钮会把「停下来」变成一次点击。
    // 真的是同一个人的两个账号时，命令行那条路还在。
    if (/混着 \d+ 个账号/.test(e.message)) {
      // 正常路径下走不到这里——上面已经按账号筛过了。走到这里意味着筛完之后
      // **还是**有两个账号，也就是那几份认不出账号的档案里其实带着别人的记录。
      const how = document.createElement('p');
      how.className = 'small';
      how.textContent = '上面已经按账号分开了，所以走到这一步说明有档案的 manifest 认不出账号、'
        + '而它里面又是别人的记录。到「档案」页把那几份挑出来删掉（或先导出来另存），再试一次。';
      el.append(how);
    }
  } finally {
    running = null;
    setBusy(false);
  }
}

/** @param {object} format @param {object} built @param {object} data @param {number} bundles */
function showResult(format, built, data, bundles) {
  const el = $('formats-result');
  el.className = 'card tone-ok';
  el.replaceChildren();

  const b = document.createElement('b');
  const total = built.files.reduce((n, f) => n + f.bytes.length, 0);
  b.textContent = `${format.name} 已导出：${built.files.length} 个文件，${fmtBytes(total)}`;
  el.append(b);

  const where = document.createElement('div');
  where.className = 'cap-sub';
  where.textContent = account
    ? `写进了 ${format.dir}/，读的是账号 ${account} 的 ${bundles} 份档案。`
    : `写进了 ${format.dir}/，读的是扩展里全部 ${bundles} 份档案。`;
  el.append(where);

  for (const line of format.summary(built.report)) {
    const d = document.createElement('div');
    d.className = 'cap-sub';
    d.textContent = line;
    el.append(d);
  }

  // 解析过程中的告警要露面。**静静吞掉会让这一页看起来比实际可靠。**
  for (const line of warningLines(data.warnings ?? [])) {
    const d = document.createElement('div');
    d.className = 'cap-sub warn';
    d.textContent = `⚠ ${line}`;
    el.append(d);
  }

  const next = document.createElement('p');
  next.className = 'small muted';
  next.textContent = format.next;
  el.append(next);
}

/**
 * 把解析告警说成人话，并且**按类别合并**。
 *
 * ## 为什么必须合并，不能一条一行
 *
 * 实测：一次真实导出出了 **41 条 `implausible_full`**，每条一行原始 JSON。
 * 而这 41 条是**永久性的**——那几份档案在生产者的两个 bug 修好之前就写下了
 * 假的 `enumeration: full`，而 bundle 是冻结的，永远修不掉。也就是说以后
 * **每一次导出**都会看到这 41 行。
 *
 * 这正是这个项目已经踩过两次的那条：**一个永远有内容的失败清单，就是一个没人看的
 * 失败清单。** 之前是「那条没有链接的记录」挪进了 zip 外的旁注，以及 8 条没有日期
 * 的标记收成了一行。41 行足够盖住第 42 行真的问题。
 *
 * 所以按类别数出来，每类一行。
 *
 * ## 认不出来的仍然一条一行、原样印出去
 *
 * 上游加一个新类型时，这里**不能**把它折叠进「其它」——那等于把一条我们还不理解的
 * 告警藏起来。原样印出 JSON 很难看，但难看的东西会被人看见，然后被处理掉。
 *
 * @param {object[]} warnings
 * @returns {string[]}
 */
export function warningLines(warnings) {
  /** @type {Map<string, object[]>} */
  const by = new Map();
  for (const w of warnings) {
    const k = String(w.type ?? '(无类型)');
    by.set(k, [...(by.get(k) ?? []), w]);
  }

  const lines = [];
  for (const [type, list] of by) {
    const n = list.length;
    const bundles = new Set(list.map((w) => w.bundle).filter(Boolean)).size;

    if (type === 'multiple_accounts') {
      const w = list[0];
      lines.push(`档案里混了 ${w.accounts?.length ?? 2} 个账号（${(w.accounts ?? []).join('、')}），`
        + '合并之后拆不开');
    } else if (type === 'implausible_full') {
      // **说清楚它不代表这次导出少了东西。** 它说的是某一份档案自己那句
      // 「这条路线我走全了」不成立——而完整性是整条链的属性，不是单份档案的。
      lines.push(`${n} 处「抓全了」的声明说不通（涉及 ${bundles} 份档案），已经不采信。`
        + '这是早期几份档案里的一个生产者 bug 留下的，而档案是冻结的，改不了；'
        + '它不代表这次导出少了东西——完整性看的是整条链。');
    } else if (type === 'missing_floor_bundle') {
      // 这一条相反：它是**真的覆盖空洞**，而且看起来一切正常。
      lines.push(`${n} 处增量的起点档案不在库里（涉及 ${bundles} 份档案）——`
        + '那一段谁也没看过，是真的缺了一块。到「档案」页把缺的那几份导入进来再导一次。');
    } else if (type === 'unreadable') {
      lines.push(`${n} 条捕获读不出来（索引与段文件可能对不上），这些页面没有进入产出`);
    } else if (type === 'extractor_stale') {
      const kinds = [...new Set(list.map((w) => w.kind ?? w.medium).filter(Boolean))];
      lines.push(`${n} 个页面抽不出条目${kinds.length ? `（${kinds.join('、')}）` : ''}——`
        + '多半是豆瓣改了页面结构，原始字节仍然在档案里');
    } else if (type === 'unknown_verdict') {
      const vs = [...new Set(list.map((w) => w.verdict))];
      lines.push(`${n} 条捕获带着这个版本不认识的判定（${vs.join('、')}），已跳过`);
    } else if (type === 'no_owner') {
      lines.push(`${n} 条广播分不出是谁发的，已跳过（转发进来的别人的内容就是这样）`);
    } else {
      // **认不出来的一条一行、原样印。** 折叠进「其它」等于把还不理解的东西藏起来。
      for (const w of list) lines.push(JSON.stringify(w));
    }
  }
  return lines;
}

/**
 * 库里不止一个账号时，画一排账号让人选。只有一个账号时**什么都不画**——
 * 一个只有一个选项的选择器只是噪音。
 */
export async function loadFormats() {
  const box = $('formats-accounts');
  box.replaceChildren();
  box.hidden = true;

  let entries;
  try {
    entries = await scanBundleDirs();
  } catch {
    return; // 存储读不出来时，导出按钮自己会报
  }
  const { groups, unattributed } = groupByAccount(entries);
  if (groups.length <= 1) { account = null; return; }

  // 默认选档案最多的那个。**不记住上次选的**：库变了（导入、删除）之后，
  // 一个记着的选择会让人以为导的是全部。
  if (!groups.some((g) => g.userId === account)) account = groups[0].userId;

  box.hidden = false;
  const hint = document.createElement('div');
  hint.className = 'small';
  hint.textContent = `扩展里有 ${groups.length} 个账号的档案。一次导一个——`
    + '两个账号合进同一份数据之后就拆不开了，而分开导一条也不会少。';
  box.append(hint);

  const row = document.createElement('div');
  row.className = 'btn-row';
  for (const g of groups) {
    const b = document.createElement('button');
    b.className = 'act';
    b.textContent = `${g.username ?? g.userId}（${g.entries.length} 份）`;
    b.setAttribute('aria-selected', String(g.userId === account));
    b.addEventListener('click', () => {
      if (running) return;
      account = g.userId;
      for (const other of row.querySelectorAll('button')) {
        other.setAttribute('aria-selected', String(other === b));
      }
    });
    row.append(b);
  }
  box.append(row);

  if (unattributed.length) {
    // **说出来。** 这几份跟着一起导，而「跟着谁」是没法知道的。
    const note = document.createElement('div');
    note.className = 'small muted';
    note.textContent = `另有 ${unattributed.length} 份档案认不出属于哪个账号`
      + '（多半是抓到一半被打断、没写 manifest 的），它们会跟着一起导。';
    box.append(note);
  }
}

/** 绑事件。**由 panel.js 显式调用**，不靠 import 的副作用。 */
export function initFormats() {
  for (const [kind, f] of Object.entries(FORMATS)) {
    $(f.button).addEventListener('click', () => {
      if (running) return;
      void runExport(kind);
    });
  }

  // 「去档案页」——**点那个标签按钮，不自己复制一遍切换逻辑**。那段逻辑还负责
  // 按需加载（`loadArchive()` / `loadStorage()`），另写一份迟早会分叉。
  $('go-archive').addEventListener('click', (e) => {
    e.preventDefault();
    $('tabs').querySelector('button[data-tab="archive"]')?.click();
  });
}

/** 视图状态清回「刚打开面板」的样子。见 panel.js 里那段说明。 */
export function resetFormats() {
  running = null;
  account = null;
  hideProgress();
  $('formats-result').className = '';
  $('formats-result').replaceChildren();
}
