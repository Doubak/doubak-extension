/* 【自动同步，请勿手改】来自 doubak-data-parser 的 src/extract.js
 * 改动请在解析器仓库里做，然后运行 node tools/sync-extractors.mjs。
 * 理由见 tools/sync-extractors.mjs：两份实现对同一段 HTML 得出不同结论，只是早晚的事。
 */
/**
 * 从标记列表页抽出一条条标记。
 *
 * 依据：canonical/FIELDS.md。**每一个选择器都是对着真实档案量出来的**，不是照着
 * 页面「看起来该是这样」写的。改这里之前先去量。
 *
 * ## 每种媒介一套，这不是可以统一的东西
 *
 * 用一套通用选择器量出来的结果是「游戏 0% 有评分、0% 有短评」——而真值是 51% 与
 * 72%。306 个评分、433 条短评差一点被静默丢掉，而所有指标看起来都正常。
 *
 * ## 成对抽，不是分别扫两遍
 *
 * 按条目容器切片，每片取第一个 id、第一个时间。分别整页扫两遍再按下标配对，
 * **没有任何机制保证两个数组等长**——实测两个方向都发生过：用户短评里贴的电影
 * 链接让书的列表多出一个 id；作品被删的孤儿游戏抽不到 id。一旦不等长，从分歧
 * 那一处起每条记录都配到了别人的日期。
 */

import { decodeEntities } from './html-entities.js';

/** 条目容器。每种媒介不同——2023 年中电影的容器 class 变过一次，两种都要认。 */
const CONTAINER = {
  movie: /<div class="item[ "][^>]*>/g,
  music: /<div class="item[ "][^>]*>/g,
  drama: /<div class="item[ "][^>]*>/g,
  book: /<li class="subject-item">/g,
  game: /<div class="common-item">/g,
};

/**
 * 作品 id。**走 URL 形状，不走 class**——URL 是豆瓣十五年不敢动的东西（改了会让
 * 所有贴出去的链接失效），class 是表现层，说改就改。
 *
 * `/j/ilmen/thing/N/interest` 是游戏在作品被删之后唯一还剩的 id 来源：那时标题变成
 * 「未知游戏」，连 `<a>` 都没有了，而删除按钮的 data-url 还在。实测 601 条游戏
 * 标记全都有这个属性。
 */
const SUBJECT_ID = /(?:\/subject\/|douban\.com\/(?:game|app)\/|\/location\/drama\/|\/j\/ilmen\/thing\/)(\d+)/;

/** 每种媒介各自的字段选择器。只有 tags 是通用的。 */
const FIELD = {
  date: { _: /class="date"[^>]*>\s*([\d-]{8,10})/ },
  tags: { _: /class="tags">\s*标签:\s*([^<]+)/ },
  rating: {
    movie: /class="rating(\d)-t"/, music: /class="rating(\d)-t"/,
    book: /class="rating(\d)-t"/, drama: /class="rating(\d)-t"/,
    game: /data-rating="(\d)"/,
  },
  comment: {
    // 影视 / 音乐 / 舞台剧共用一个**结构**判据，不是三个各写各的 class。
    // 见 listComment() 里的说明：`<span class="comment">` 只有影视有。
    movie: listComment, music: listComment, drama: listComment,
    book: /<p class="comment[^"]*"[^>]*>\s*([^<]+)/,
    // 游戏的短评在一个**没有 class 的裸 div** 里，只能靠它在 user-operation 前面定位。
    game: /<\/div>\s*<div>([^<]{2,})<\/div>\s*<div class="user-operation"/,
  },
  raw_meta: {
    movie: /<li class="intro">([^<]+)/, music: /<li class="intro">([^<]+)/,
    drama: /<li class="intro">([^<]+)/,
    book: /<div class="pub">\s*([^<]+)/,
    game: /class="desc">\s*([^<\n]+)/,
  },
  /** 豆瓣自己的标记记录 id。游戏走 ilmen，其余走 data-cid。 */
  upstream_id: {
    movie: /data-cid="(\d+)"/, music: /data-cid="(\d+)"/,
    book: /data-cid="(\d+)"/, drama: /data-cid="(\d+)"/,
    game: /\/j\/ilmen\/thing\/(\d+)\/interest/,
  },
  title: {
    movie: /<li class="title">\s*<a[^>]*>\s*<em>([^<]+)/,
    music: /<li class="title">\s*<a[^>]*>\s*<em>([^<]+)/,
    drama: /<li class="title">\s*<a[^>]*>\s*<em>([^<]+)/,
    book: /<h2>\s*<a[^>]*title="([^"]+)"/,
    game: /class="title">\s*<a[^>]*>([^<]+)/,
  },
  cover_url: { _: /<img[^>]+src="(https:\/\/[^"]+)"/ },
  subject_url: { _: /href="(https:\/\/[^"]*(?:\/subject\/|\/game\/|\/app\/|\/location\/drama\/)\d+\/?)"/ },
};

/**
 * 影视 / 音乐 / 舞台剧列表页上的短评。
 *
 * ## `<span class="comment">` 是影视独有的
 *
 * 第一版三种媒介共用 `/<span class="comment">([^<]+)/`，看起来天经地义——影视上
 * 它确实在。而实测：**音乐 84 条标记 0 条有短评，舞台剧 5 条标记 0 条有短评**，
 * 两个整齐的零，一句告警都没有。它们的短评就裸在 `<li>` 里：
 *
 * ```html
 * 影视  <li><span class="comment">这讲的是个啥故事…</span></li>
 * 音乐  <li>\n    欢乐\n  </li>
 * 舞台剧 <li>团建选了看舞台剧/音乐剧的项目…</li>
 * ```
 *
 * CLAUDE.md 里那条「每种媒介一套，这不是可以统一的东西」讲的正是这个形状，
 * 而当时的例子是游戏的评分与短评。**这是第二次**，所以这回不按 class 找，
 * 按位置找。
 *
 * ## 判据是位置：紧挨在操作栏前面的那个 `<li>`
 *
 * 三种媒介的条目结构是一样的：
 *
 * ```
 * <li class="title">   作品名
 * <li class="intro">   元信息
 * <li>                 评分 + 日期 + 标签      ← 有 class="date"
 * <li>                 短评                    ← 就是它，没有短评时整个不存在
 * <li class="clearfix opt-ln">  修改 / 删除
 * ```
 *
 * 所以取操作栏前面那一个 `<li>`，再排掉「它其实是评分那一行」的情况——没有短评时
 * 前面那个正是评分行。**排除靠的是里面有没有 `class="date"`**，而用户写不出这个：
 * 短评在页面上是转义过的，`<span` 根本不会以标签的形式出现在里面。
 *
 * ## 那个 `<span class="pl">(N 有用)</span>` 必须先扔掉
 *
 * 影视的短评 `<li>` 里还挂着**点赞计数**：
 *
 * ```html
 * <li>
 *   <span class="comment">很不错的主意…</span>
 *   <span class="pl">(1 有用)</span>
 * </li>
 * ```
 *
 * 它是**上游的易变量**。实测同一条标记在两次抓取之间从 `(5 有用)` 变成
 * `(1 有用)`，短评一个字没动——把它算进短评，那条标记就凭空多出一条修订，
 * 看起来像用户改过短评。与「1740人浏览」进日记正文是同一个错，而
 * canonical 存在的全部理由就是「这条什么时候改的」。
 *
 * 这一条不是想出来的：改成按结构取之后，端到端那条断言立刻从「3 条多修订」
 * 变成 4 条，多出来的正是它。
 *
 * @param {string} seg 一个条目容器的切片
 * @returns {string|null}
 */
function listComment(seg) {
  const opt = seg.indexOf('<li class="clearfix opt-ln"');
  if (opt < 0) return null;
  // `opt - 1`：lastIndexOf 的第二个参数是**含**该下标的，写 opt 会找到操作栏自己。
  const head = seg.lastIndexOf('<li', opt - 1);
  if (head < 0) return null;
  const open = seg.indexOf('>', head);
  if (open < 0 || open > opt) return null;

  // **带 class 的 `<li>` 一律不是短评那一行。** 短评那格是个裸 `<li>`；
  // `title` / `intro` / `opt-ln` 都带 class。
  //
  // 这一条是被真实数据逼出来的：有些标记只有标题，没有评分、日期、标签、短评
  // （`<li class="title">` 后面直接就是操作栏）。判据只看 `<li>` **里面**有什么的话，
  // 那个 `<li class="title">` 的 class 已经在切片之外了——于是 8 部电影的短评
  // 变成了自己的片名：「V字仇杀队」「铁西区第一部分：工厂」。
  //
  // 这是最坏的一种错：**它产出的是像样的中文**，看一眼像用户真写过。
  if (/\sclass\s*=/.test(seg.slice(head, open))) return null;

  const inner = seg.slice(open + 1, opt)
    .replace(/<\/li>\s*$/, '')
    // 点赞计数，见上。**先扔掉再判断**——它在哪种媒介上都不该进短评。
    .replace(/<span class="pl">[\s\S]*?<\/span>/g, '');
  // 评分那一行（没有短评时它就在操作栏前面，而它同样是个裸 `<li>`）。
  if (/class="(date|tags|intro|title)"|rating\d-t/.test(inner)) return null;
  // 影视把短评包在 `<span class="comment">` 里。**有这个锚点就用它**——
  // 越紧的锚点越不容易把旁边的东西捎带进来；音乐与舞台剧没有它，才退回整段。
  return /<span class="comment">([\s\S]*?)<\/span>/.exec(inner)?.[1] ?? inner;
}

/** 页面上 `rel="<id>:P|F|N"` 的状态编码 —— 状态的第二份来源，用于交叉校验。 */
const REL_STATUS = { P: 'done', F: 'wish', N: 'doing' };

/**
 * 取一个字段，**并把 HTML 实体解开**。
 *
 * 这一句 `decodeEntities` 是补上的：这个文件原来一个实体都不解，而它正是标题与
 * 短评的来源。于是 `&#34;` `&#39;` `&lt;` 原样进了 canonical，站点生成器再照规矩
 * 把 `&` 转义成 `&amp;`，页面上就显示成 `&#34;`。两边各自都没错，合起来是错的。
 *
 * 解码对每一种字段都是对的：URL 里的 `&amp;` 本来就该是 `&`，而评分和 id 是纯数字，
 * 解不解都一样。所以放在 `pick` 里，而不是逐个字段挑——挑的那种迟早会漏掉新加的
 * 字段，且漏掉的样子是「页面上多了几个 `&#34;`」，没人会当成 bug 报上来。
 *
 * @param {string} seg @param {string} medium @param {string} field
 */
function pick(seg, medium, field) {
  const sel = FIELD[field];
  const re = sel._ ?? sel[medium];
  if (!re) return null;
  // 选择器可以是一个函数——有些字段没有一个能靠 class 认出来的锚点，只能按结构找
  // （见 listComment）。函数返回的是**还带着标签的那一段**，所以这里剥一次；
  // 正则那条返回的是捕获组，本来就没有标签，剥了也是空操作。
  const raw = typeof re === 'function' ? re(seg) : re.exec(seg)?.[1];
  if (raw == null) return null;
  return decodeEntities(raw.replace(/<[^>]+>/g, '')).trim() || null;
}

/**
 * @typedef {object} RawMark
 * @property {string} subjectId
 * @property {string|null} upstreamId
 * @property {string|null} title
 * @property {string|null} date
 * @property {number|null} rating
 * @property {string|null} comment
 * @property {string[]|null} tags
 * @property {string|null} rawMeta
 * @property {string|null} coverUrl
 * @property {string|null} subjectUrl
 * @property {string|null} relStatus  页面自己说的状态，用于与路线交叉校验
 * @property {boolean} upstreamDeleted
 */

/**
 * @param {string} html
 * @param {string} medium
 * @returns {{marks: RawMark[], containers: number, idless: number}}
 *   `idless`：有时间却抽不到 id 的容器数。**非 0 说明抽取器跟不上页面了**——
 *   静默跳过等于宣布「这一页就这么多」，而那是不可检测的丢失。
 */
export function extractMarks(html, medium) {
  const cont = CONTAINER[medium];
  if (!cont || typeof html !== 'string') return { marks: [], containers: 0, idless: 0 };

  const at = [];
  const re = new RegExp(cont.source, 'g');
  for (let m = re.exec(html); m; m = re.exec(html)) at.push(m.index);

  /** @type {RawMark[]} */
  const marks = [];
  const seen = new Set();
  let idless = 0;

  for (let i = 0; i < at.length; i++) {
    const seg = html.slice(at[i], i + 1 < at.length ? at[i + 1] : undefined);
    const idm = SUBJECT_ID.exec(seg);
    const date = pick(seg, medium, 'date');

    if (!idm) {
      // 有时间没有 id：这一片是个真条目，只是我们认不出它。要数出来。
      // 没时间也没 id 的是模板/装饰——游戏页上有约 100 个 `<div class="item item-tags">`
      // 是编辑表单的 JS 模板，静静丢掉即可。
      if (date) idless += 1;
      continue;
    }
    const subjectId = idm[1];
    if (seen.has(subjectId)) continue;
    seen.add(subjectId);

    const rating = pick(seg, medium, 'rating');
    const tags = pick(seg, medium, 'tags');
    const rel = /rel="\d+:(\w)"/.exec(seg);

    marks.push({
      subjectId,
      upstreamId: pick(seg, medium, 'upstream_id'),
      title: pick(seg, medium, 'title'),
      date,
      rating: rating ? Number(rating) : null,
      comment: pick(seg, medium, 'comment'),
      tags: tags ? tags.split(/\s+/).filter(Boolean) : null,
      rawMeta: pick(seg, medium, 'raw_meta'),
      coverUrl: pick(seg, medium, 'cover_url'),
      subjectUrl: pick(seg, medium, 'subject_url'),
      relStatus: rel ? (REL_STATUS[rel[1]] ?? null) : null,
      upstreamDeleted: isTombstone(seg),
    });
  }

  return { marks, containers: at.length, idless };
}

/**
 * 这条标记的作品被豆瓣删了吗。
 *
 * ## 单看任何一个信号都不行，这是量出来的
 *
 * 拿 2933 条真实标记逐条数（占位图 / 标题「未知…」/ 没有作品链接）：
 *
 * | 占位图 | 未知… | 无链接 | 条目数 | 是什么 |
 * |---|---|---|---|---|
 * | ✗ | ✗ | ✗ | 2911 | 正常 |
 * | ✓ | ✗ | ✗ | **14** | **只是没上传海报** —— 不是墓碑 |
 * | ✓ | ✓ | ✓ | 7 | 游戏，条目被删（链接也没了） |
 * | ✓ | ✓ | ✗ | 1 | 电影，条目被删（**链接还在**） |
 *
 * 两个诱人的单一判据都错：
 *
 * - **只看占位图** → 误判 14 条只是没海报的作品
 * - **只看没有链接** → 漏掉全部电影墓碑，它们的 `/subject/N/` 链接还在
 *
 * 所以取两者的合取。代价是要匹配中文「未知…」，语言相关——但一个假阳性需要同时
 * 满足两个条件，而漏判的方向是安全的（当成普通作品，只是多存一个占位标题）。
 *
 * 原始 HTML 永远在 WARC 里，判据改了随时能重跑——这正是把捕获与解释分开的意义。
 *
 * @param {string} seg 条目容器的那一片 HTML
 */
function isTombstone(seg) {
  const img = /<img[^>]+src="(https:\/\/[^"]+)"/.exec(seg);
  // `/cuphead/` 与 `/f/` 是豆瓣的前端静态资源目录——真封面不会走那里。
  const placeholder = Boolean(img && /\/(cuphead|f)\//.test(img[1]));
  return placeholder && /未知(电影|游戏|图书|音乐|剧)/.test(seg);
}
