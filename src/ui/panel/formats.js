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
// 请人去报一声的地址，与 CLI、包里那份说明共用同一个常量——同一个地址写三遍必然漂，
// 而漂掉的那一份会把人送到一个空页面。
import { FEEDBACK_URL } from '../../vendor/export-adapters/targets/neodb-ndjson.js';

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
// 导出出去只为一件事：测试能**跑** `summary()`，而不是拿正则去源码里找那句话。
// 静态检查在这个文件里是常态（真正的失败要在装好的扩展里点开标签页才发生），
// 但凡能跑就别只是找——实测过：把 `r.restricted?.length` 改成
// `false && r.restricted?.length`，找字符串的那版测试一条都不红。
export const FORMATS = {
  neodb: {
    button: 'export-neodb',
    name: 'NeoDB 导入包',
    dir: 'doubak-neodb',
    // `unknownVisibility` 由卡片上那个选项框决定，见 runExport。**这里不许兜一个
    // 默认值**：默认值只住在共用那份实现里（`UNKNOWN_VISIBILITY_DEFAULT`），
    // 宿主各兜一个的话，改的时候必然漏掉一个，而漏掉是静默的——一边收着、
    // 一边发出去，两边都不报错。
    build: (data, o) => buildNeodb(data, o),
    summary: (r) => [
      `标记 ${r.marks} 条`,
      `评分 ${r.ratings} · 短评 ${r.comments} · 标签 ${r.tags}`,
      `书评影评 ${r.reviews} · 日记 ${r.notes + r.articles} · 豆列 ${r.collections}`,
      r.shelfLogs ? `状态历史 ${r.shelfLogs} 条（从广播还原，豆瓣自己已经不显示了）` : null,
      // **这一条必须出现在卡片上，不能只写进包里那份「怎么导入.md」。**
      // 按下「导出」的人下一步就是把 zip 传上去，而那份说明要解压才看得到——
      // 一句正确的话出现在做决定的人读不到的地方，等于没说。
      //
      // **两栏分开，因为处置正好相反。** 豆瓣锁掉的按公开导入（它本来就是公开的，
      // 是豆瓣把它关掉的），作者自己藏的收成仅提及者可见。合成一句话就是拿豆瓣的
      // 审查冒充用户的意愿——而这一版里，那还会让人以为自己没在往联邦上发东西。
      //
      // **三栏，不是两栏。** 「说不准」那一栏与作者自己藏的处置看着一样（都收起来），
      // 但成因和下一步完全不同：那是我们没读出来，多半是豆瓣改了页面结构，而它是
      // 唯一一栏用户能自己拨回去的。混进作者那一栏，用户会以为是自己当年设的。
      // 用户把日记收紧了就说一句。默认那一档不占行——卡片上每多一行常驻的字，
      // 真正要紧的那几行 ⚠ 就少一分被读到的机会。
      r.notesVisibility
        ? `日记按${r.notesVisibility === 1 ? '「仅关注者可见」' : '私密（仅自己可见）'}导出，影评书评不在内`
        : null,
      ...(r.restricted?.length ? (() => {
        const 锁 = r.restricted.filter((x) => x.by === 'platform');
        const 藏 = r.restricted.filter((x) => x.by === 'author');
        const 说不准 = r.restricted.filter((x) => x.by === 'unsure');
        const 收成 = r.unknownVisibility === 0 ? '跟其它记录一样' : '「仅提及者可见」';
        return [
          // **这一句必须跟着上面那组单选走。** 写死「按公开导入」的话，用户选了
          // 「私密」之后它就成了假话——而这张卡片的全部作用就是让他知道自己正在
          // 把什么重新发出去。已经收起来了就不必再吓一次「撤不回来」。
          锁.length
            ? `⚠ ${锁.length} 篇日记是被豆瓣锁成「仅自己可见」的，`
              + (r.notesVisibility
                ? '这一份跟日记那一档一起收起来了（它本来是公开的，是豆瓣把它关掉的——'
                  + '想重新公开它，上面选「公开」）'
                : '这一份按公开导入（它本来就是公开的）——注意会联邦出去，撤不回来')
            : null,
          藏.length
            ? `⚠ ${藏.length} 篇日记你自己在豆瓣上设成了「仅自己可见」，`
              + '写成「仅提及者可见」——东西照样在你账号里，只是不对外'
            : null,
          说不准.length
            ? `⚠ ${说不准.length} 篇日记读不出在豆瓣上公不公开，这一份写成${收成}`
            : null,
          // **碰上的人是唯一能告诉我们的人**，而那几页已经如实躺在他的档案里——
          // 改好抽取器重跑就救得回来，不用重新抓豆瓣。不请的话它会一直安静地
          // 按不公开处理下去，而「安静」正是这一条最贵的地方。
          说不准.some((x) => x.why === 'unrecognized')
            ? `🙏 其中有读不出来的，多半是豆瓣改了日记页的结构。麻烦到 ${FEEDBACK_URL} `
              + '报一声（把日志里那条 note_visibility 告警贴上），改好之后重新导出就能救回来'
            : null,
        ];
      })() : []),
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
    // ── 解析。**每次都重来**，不留中间产物（见文件头①）。
    //
    // **先解析，再建目录。** 反过来的话，一次半路失败会在用户的文件夹里留下一个空的
    // `doubak-xxx/`，而一个空目录看起来像「导出过了，只是东西不见了」。
    const { data, sources } = await parseLibrary({
      entries,
      openStore: (entry) => new WorkerFileStore({ worker: getOpfsWorker(), dir: entry.dir }),
      onProgress: (p) => {
        if (p.phase === 'open') progress('正在打开档案', p.done, p.total);
        else progress('正在解析页面', p.done, p.total);
      },
    });

    const root = await picked.getDirectoryHandle(format.dir, { create: true });
    const write = writerFor(root);

    progress('正在生成文件');
    const built = await format.build(data, {
      sources, write,
      // **两个开关都只在「非默认」那一边才传值**，默认那一边整个不传，让共用那份
      // 实现里的常量说了算。在这里兜一个数字的话，它与 `NOTES_VISIBILITY_DEFAULT` /
      // `UNKNOWN_VISIBILITY_DEFAULT` 就是两处各自为政的默认值，改一处不改另一处
      // 不会有任何东西报错——而后果是一个宿主收着、另一个发出去。
      ...($('export-neodb-notes-private')?.checked ? { notesVisibility: 2 } : {}),
      // 禁用时一律当没勾——`disabled` 的元素 `checked` 仍可能是 true（选「私密」
      // 之前勾过），而那时它不该有任何影响。判据不靠「界面碰巧是什么样」。
      ...($('export-neodb-unknown')?.checked && !$('export-neodb-unknown')?.disabled
        ? { unknownVisibility: 0 } : {}),
    });

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
  el.replaceChildren();

  // 一条记录都没有的时候**照样写**——用户点了导出，那就给他文件。但卡片不能是
  // 绿的：一张写着「已导出：6 个文件」的绿卡片，与一份真有内容的导出长得一模一样，
  // 而空在哪儿要等他传到 NeoDB、看到「导入 0 条」才知道——**失败发生在别人的
  // 服务器上，离原因最远的地方**。
  //
  // 判据是「五类全空」，不是「标记为 0」：只抓了广播、或者只有几篇日记的档案，
  // 都是完全正当的导出。
  const records = data.marks.length + data.subjects.length + data.broadcasts.length
    + data.longform.length + data.doulists.length;
  const empty = records === 0;

  el.className = `card tone-${empty ? 'warn' : 'ok'}`;

  const b = document.createElement('b');
  const total = built.files.reduce((n, f) => n + f.bytes.length, 0);
  b.textContent = empty
    ? `导出的是一份空档案：${built.files.length} 个文件，里面一条记录都没有`
    : `${format.name} 已导出：${built.files.length} 个文件，${fmtBytes(total)}`;
  el.append(b);

  if (empty) {
    const why = document.createElement('div');
    why.className = 'cap-sub';
    why.textContent = `读了 ${bundles} 份档案，但一条记录都没解析出来。`
      + '多半是这几份只有 manifest（抓了一下就被打断），或者只装着图片。';
    const how = document.createElement('p');
    how.className = 'small';
    how.textContent = '文件已经写出去了，只是内容是空的。到「概览」页跑一次抓取，'
      + '或者在「档案」页用「查看内容」确认这几份里到底有没有东西。';
    el.append(why, how);
    return;
  }

  const where = document.createElement('div');
  where.className = 'cap-sub';
  where.textContent = account
    ? `写进了 ${format.dir}/，读的是账号 ${account} 的 ${bundles} 份档案。`
    : `写进了 ${format.dir}/，读的是扩展里全部 ${bundles} 份档案。`;
  el.append(where);

  // 那个「读不出来的也公开」选项框**常驻**，这里不做任何显隐。
  // 曾经的写法是「上一次导出发现了这种日记才露面」，那是错的：**`unsure` 是抽取器
  // 在解析那一刻的判断，不是档案的属性**——同一批冻住的 bundle，扩展升级换了抽取器
  // 就可能不再是 unsure。那个条件描述的是「档案 × 抽取器版本」这个组合，
  // 于是升级一次，控件就会在用户可能正需要它的时候消失。
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

  // **选了「私密」，那个「读不出来的也公开」就没有意义了，所以把它禁掉。**
  //
  // 判据链是「每一级只收紧、不放松」：读不出公私状态的日记，绝不该比**读得出来的**
  // 日记还公开。所以选「私密」时勾不勾都是私密——行为是对的，问题在于那个勾
  // **什么都没做，而标签写着「导出成公开状态」**。一个说了要做某事、实际什么也不做、
  // 还不吭声的控件，正是这个项目反复栽的那一类（封面回退、`remote` 数封面、
  // 「有 5 张图没取到」）。禁用把「不起作用」变成看得见的。
  //
  // 只禁不清：勾选状态留着，用户拨回「公开」就还在——替他把勾清掉是又一次替他
  // 拿主意，而他并没有改变那个意愿。
  const syncUnknownEnabled = () => {
    const box = $('export-neodb-unknown');
    if (box) box.disabled = !!$('export-neodb-notes-private')?.checked;
  };
  for (const id of ['export-neodb-notes-public', 'export-neodb-notes-private']) {
    $(id)?.addEventListener('change', syncUnknownEnabled);
  }
  syncUnknownEnabled();

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
