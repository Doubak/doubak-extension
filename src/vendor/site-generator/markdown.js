/* 【自动同步，请勿手改】来自 doubak-site-generator 的 src/markdown.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/**
 * 投影 → Markdown + YAML front matter。
 *
 * ## 不做模板引擎
 *
 * CLAUDE.md 里定死的：产出 Markdown，交给 Hugo / Astro / Eleventy / Jekyll 渲染，
 * **每一个现成的主题生态都变成模板库**。自己写一个模板引擎意味着要重新发明布局、
 * 分页、RSS、搜索——而那些东西早就有人做得比我们好。
 *
 * 代价是 front matter 的字段名要在几个 SSG 之间取个公约数。取法是：
 * **用它们都认的那几个（title / date / tags / draft），其余一律加 `douban_` 前缀**，
 * 免得撞上主题自己的约定。
 */

import { frontMatter } from './yaml.js';

/** 豆瓣的动词跟着媒介走。「看过一本书」是错的说法，所以这个映射不能省。 */
const VERB = {
  movie: { done: '看过', doing: '在看', wish: '想看' },
  book: { done: '读过', doing: '在读', wish: '想读' },
  music: { done: '听过', doing: '在听', wish: '想听' },
  game: { done: '玩过', doing: '在玩', wish: '想玩' },
  drama: { done: '看过', doing: '在看', wish: '想看' },
};

/**
 * 上游条目被删时页面上写什么。
 *
 * **不是存进档案的名字**——canonical 里那儿是 null，因为「未知作品」是豆瓣的占位符，
 * 而占位符不是内容。这只是页面上的一个说法，所以作品页与广播行**必须用同一个函数**：
 * 两处各写一份的话，同一个条目在两个地方会叫两个名字。
 *
 * @param {string} medium
 */
export function placeholderTitle(medium) {
  return `未知${medium === 'book' ? '图书' : '作品'}`;
}

/** @param {string} medium @param {string} status */
export function verb(medium, status) {
  return VERB[medium]?.[status] ?? status;
}

/**
 * 一条标记 → 一个 md 文件。
 *
 * @param {object} m 投影后的标记
 * @param {{coverPath?: string|null}} [opts] `coverPath` 是导出到本地之后的路径
 */
export function markPage(m, { coverPath = null } = {}) {
  const fm = {
    // ── SSG 通用的几个
    //
    // 作品名可能是 null（上游条目被删）。**不拿占位符顶替**，而是如实写成
    // 「未知作品」加上 douban_upstream_deleted=true，让主题自己决定怎么显示。
    title: m.title ?? placeholderTitle(m.medium),
    date: m.markedAt ?? null,
    tags: m.tags ?? [],

    // ── 其余全部加前缀，免得撞上主题的约定
    douban_kind: 'mark',
    douban_medium: m.medium,
    douban_status: m.status,
    douban_verb: verb(m.medium, m.status),
    douban_rating: m.rating,
    // 无语言标注——豆瓣的又名里混着粤语、台湾译名、英文与各种转写，一个标记
    // 都没有。猜语言属于 enricher（它的产出带 source 与置信度、可以重跑）。
    douban_aliases: m.aliases ?? [],
    douban_subject_id: m.subjectId,
    douban_url: m.url,
    douban_marked_at_raw: m.markedAtRaw,
    douban_upstream_deleted: m.upstreamDeleted,
    // 那一行无标签的元信息，原样带过来。**不在这里拆**——理由见 canonical/FIELDS.md：
    // 实测电影 2090 条里出现过 43 种段数，按位置拆多数行都是错的；按内容猜属于
    // enricher，它的产出带 source 与置信度、可以重跑。
    douban_meta: m.rawMeta,
    douban_cover: coverPath ?? m.coverUrl,
    // 留一条通往 canonical 的线索：投影是有损的，这两个数说明「还有更多」。
    douban_revisions: m.revisionCount,
    douban_last_seen: m.lastSeenAt,
  };

  // 正文只放用户自己写的短评。**没有短评就是空正文**，不编一句「暂无短评」——
  // 那会让「没写」和「写了但抓不到」在页面上长得一样。
  const body = m.comment ? `${plainText(m.comment)}\n` : '';
  return frontMatter(fm) + (body ? `\n${body}` : '') + infoSection(m) + timelineSection(m);
}

/**
 * 详情页上那一块作品信息（导演、主演、出版社、ISBN…）。
 *
 * ## 为什么渲染成正文，不塞进 front matter
 *
 * 键是豆瓣自己的标签：中文、还带斜杠（`制片国家/地区`）。塞进 YAML 要么得
 * 全部加引号、要么得改名，而**改名就是翻译**——那是 enricher 的事。
 * 渲染成一张表则原样保留，读者看到的就是豆瓣当时写的那几个字。
 *
 * front matter 里已经有 `douban_meta`（列表页那一行原样记录）。两者不重复也
 * 不互相替代：一个来自列表页、一个来自详情页，而「页面当时就是这么说的」
 * 两边都算数。
 *
 * @param {object} m
 */
function infoSection(m) {
  const info = m.info;
  if (!info || !Object.keys(info).length) return '';

  const rows = Object.entries(info)
    // 又名已经单独显示在上面了，不重复列。
    .filter(([k]) => k !== '又名')
    .map(([k, v]) => `| ${plainText(k)} | ${plainText(v.join(' / '))} |`);
  if (!rows.length) return '';

  return ['', '## 作品信息', '', '| | |', '|---|---|', ...rows, ''].join('\n');
}

/**
 * 「什么时候 → 说了什么」。
 *
 * ## 为什么这一段值得单独存在
 *
 * 标记页上只剩**最新**那条短评——改一次覆盖一次，豆瓣不留历史。而广播是冻结的，
 * 带秒级时间戳，所以它保住了标记页上早就没有的话。实测：标记自己的修订历史只
 * 覆盖 3 条，广播里却有 342 条与当前短评不同的发言，涉及 305 个作品。
 *
 * ## 每一条都标出处，不只在「拿不准」的时候
 *
 * 因为两个来源的性质本来就不同，而这个差别是读者该知道的：
 *
 *     广播   发布即冻结，秒级 —— 「那一刻这句话就是这样」
 *     标记   可编辑，只到天   —— 「我们某次抓取时看到的样子」
 *
 * ## 不说「改过」
 *
 * 实测那 342 条里 305 条是**状态推进**（想看时说一句，看过之后又说一句），
 * 只有 15 条是同一状态下说了别的。把它们呈现成「检测到编辑」，89% 都是冤枉的
 * ——那就是档案在说假话。所以这里只按时间列出来，判断留给读者。
 *
 * @param {object} m
 */
function timelineSection(m) {
  const rows = m.timeline ?? [];
  // 什么时候这一段没有信息量：**只有一条，而且它是标记自己那条**——
  // 正文里已经有短评，front matter 里已经有日期，再列一遍是噪音。
  //
  // 但只要那一条来自广播，它就带来了正文里没有的东西：**准确到秒的时间**。
  // 标记页上只有天（`douban_marked_at_raw`），而「2026-07-19 19:18:39」这种
  // 精度只有广播给得出——丢掉它，就等于把广播这条路线最值钱的性质扔了。
  if (rows.length === 0) return '';
  if (rows.length === 1 && rows[0].source !== 'broadcast') return '';

  const out = ['', '## 说过什么', ''];
  for (const r of rows) {
    const when = r.atRaw ?? (r.at ?? '').slice(0, 10) ?? '时间不详';
    // 动作可能没有（纯发言的广播就没有）。**没有就不要留一个悬着的「·」**——
    // 那看起来像少了点什么，而其实是本来就没有。
    const act = r.source === 'broadcast'
      ? (r.action || (r.status ? verb(m.medium, r.status) : ''))
      : verb(m.medium, r.status);
    const label = r.source === 'broadcast' ? '广播' : '标记';
    // 时间与短评来自不同来源时要说清楚。不说的话，「广播 · 玩过」加一段短评
    // 会被读成「那条广播里写着这句话」——而广播里其实什么都没写，那句短评
    // 在标记页上。
    const mixed = r.text && r.textSource && r.textSource !== r.source;
    const what = mixed
      ? `${act || label} · 时间来自${label}，短评来自${r.textSource === 'mark' ? '标记页' : '广播'}`
      : (act ? `${label} · ${act}` : label);
    // **那一天给了几颗星。** 这是这一段最值钱的一列：标记页只留最新那个分
    // （改一次覆盖一次，豆瓣不留历史），而广播是冻结的。实测这份档案里有 17 部
    // 作品的分变过——那份变化史豆瓣自己都没有，只有把它逐条列出来才看得见。
    //
    // 画满五颗、空的用 ☆：只写「4 星」的话，读者得自己记住满分是几。
    const stars = r.rating ? ` · ${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}` : '';
    out.push(`### ${when}`, '', `*${what}${stars}*`, '');
    // 没有短评就只有这一行——**不编一句「无短评」**，那会让「没写」和
    // 「写了但抓不到」在页面上长得一样。
    if (r.text) out.push(plainText(r.text), '');
    if (r.truncated) out.push('*（豆瓣在这里截断了）*', '');
  }
  return out.join('\n');
}

/**
 * 一篇日记或评论 → 一个 md 文件。
 *
 * @param {object} r 投影后的长文
 * @param {{images?: Record<string, string>}} [opts] 内嵌图 URL → 本地路径
 */
export function longformPage(r, { images = {} } = {}) {
  const fm = {
    title: r.title ?? '(无标题)',
    date: r.publishedAt ?? null,
    douban_kind: r.kind,
    douban_id: r.id,
    douban_url: r.url,
    douban_published_at_raw: r.publishedAtRaw,
    douban_location: r.location,
    douban_rating: r.rating,
    douban_subject_url: r.subjectUrl,
    douban_revisions: r.revisionCount,
    douban_last_seen: r.lastSeenAt,
  };

  let body = r.body ?? '';
  // 正文里提到的图，换成本地路径。**没导出的就保持原样**——留一个指向 doubanio
  // 的 URL，总比悄悄删掉一张图好：前者至少说明「这儿本来有张图」。
  for (const [url, path] of Object.entries(images)) {
    if (body.includes(url)) body = body.split(url).join(path);
  }
  // 正文里**混着两种东西**：用户写的字，和解析器从页面结构转出来的记号
  // （`![](url)` 图片、`- ` 列表项）。只能转义前者——把结构记号也转义掉，
  // 图会变成一行字面文本，点列表会变成五行字面的 `- xxx`。
  //
  // 图片按标记切开；列表记号在行首，交给 plainText 自己认（见那边的说明）。
  body = body
    .split(/(!\[\]\([^)]*\))/)
    .map((seg, i) => (i % 2 === 1 ? seg : plainText(seg, { preserveListMarkers: true })))
    .join('');
  return frontMatter(fm) + (body ? `\n${body}\n` : '');
}

/**
 * 文件名。
 *
 * 用作品 id 而不是标题：**标题会变，也可能是 null，还可能撞名**。id 稳定，
 * 而且让固定链接在重新生成之后不变——那是「有固定链接的个人存档站」的前提。
 *
 * @param {object} m
 */
export function markPath(m) {
  return `${m.medium}/${m.subjectId}.md`;
}

/**
 * 「影视 · 看过」这样一页：某个媒介里某个状态的全部标记。
 *
 * ## 为什么是**真的一页**，不是页面上的一个开关
 *
 * 前端过滤只能过滤当前这一页——影视有 2102 条、每页 48 条，点「看过」会得到
 * 「这 48 条里的看过」，而那是个看起来在工作、其实在骗人的按钮。
 *
 * 做成真页面则：能收藏、能分享、能在 file:// 下打开、不需要 JS，翻页也照常。
 * 这与「广播是可以一直翻下去的时间线，不是 152 个月份的目录」是同一条取舍——
 * **能直接看到东西的那种结构，胜过需要再点一次的那种。**
 *
 * ## 路径是 `<媒介>/<状态>/`，不是 `<媒介>-<状态>/`
 *
 * 放在媒介底下，顶层小节表就不会多出十几项（首页的「浏览」那一行读的是顶层）。
 * 与作品页 `movie/1292052.md` 不会撞：状态只有 `done|wish|doing` 三个词，
 * 而作品 id 全是数字。
 *
 * @param {string} medium
 * @param {string} status
 */
export function markFilterPath(medium, status) {
  return `${medium}/${status}/_index.md`;
}

/**
 * @param {string} medium
 * @param {string} status
 * @param {number} count 这一格有多少条。**是数出来的，不是声称的**
 */
export function markFilterPage(medium, status, count) {
  return frontMatter({
    title: verb(medium, status),
    douban_kind: 'mark-filter',
    douban_medium: medium,
    douban_status: status,
    douban_verb: verb(medium, status),
    douban_count: count,
  });
}

/** @param {object} r */
/**
 * 一份豆列的页面。
 *
 * ## 锁形图标：把「我们知道它是私密的」显示出来
 *
 * 私密豆列**照常渲染**（档案主人的决定），但标题前挂一个 🔒。理由不是装饰：
 * 一份私密豆列渲染得跟公开的一模一样，等于把用户在豆瓣上明确做过的那个选择从
 * 档案里抹掉了——而这份站点是可以发布到 GitHub Pages 的。
 *
 * `unknown`（连 `<h1>` 都没找到，抽取器可能坏了）**也挂锁**，措辞另说。把
 * 「不知道」显示成「公开」是这一档上唯一不可逆的错法。
 *
 * 图标进 front matter 也进正文标题：主题可能只用其中一处，两处都给才不会漏。
 */
export function doulistPage(r) {
  const locked = r.visibility !== 'public';
  const fm = {
    title: r.title ?? '(无标题)',
    douban_id: r.id,
    douban_url: r.url,
    douban_visibility: r.visibility,
    douban_private: locked,
    douban_item_count: r.items.length,
    douban_revisions: r.revisionCount,
    douban_last_seen: r.lastSeenAt,
  };

  const out = [];
  if (locked) {
    out.push(r.visibility === 'private'
      ? '🔒 **这是一份私密豆列** —— 在豆瓣上只有你自己看得见。'
      : '🔒 **不确定这份豆列是不是公开的** —— 抓取时没能读出可见性，'
        + '这里按私密显示。（说成公开是这一档上唯一不可逆的错法。）');
    out.push('');
  }
  // 简介是用户写的字，必须转义。
  if (r.description) out.push(plainText(r.description), '');

  for (const it of r.items) {
    // 目标页**不在档案里**（豆列条目的目标不跟进去抓），所以这是个站外链接，
    // 不是站内链接——不能用 `../movie/123.md` 那套。
    const title = plainText(it.title ?? '(未命名条目)');
    out.push(it.url ? `### [${title}](${it.url})` : `### ${title}`);
    // 豆瓣的评分与简介是目录数据，和用户写的评语必须分开显示，否则读的人分不出
    // 哪句话是自己写的。
    if (it.rating) out.push('', `评分：${plainText(it.rating)}`);
    if (it.comment) out.push('', `> ${plainText(it.comment).split('\n').join('\n> ')}`);
    out.push('');
  }
  return frontMatter(fm) + '\n' + out.join('\n');
}

/** @param {{id: string}} r */
export function doulistPath(r) {
  return `doulist/${r.id}.md`;
}

export function longformPath(r) {
  return `${r.kind}/${r.id}.md`;
}

/**
 * 一条广播渲染成一段 Markdown：时间、`[封面] 动作 作品名 ★★★★☆`、正文、附图。
 *
 * **月页与首页预览共用这一个**。两处各写一份的话迟早会长歪——而歪掉的样子是
 * 「首页上的广播和点进去看到的不一样」，那正是最不该发生在一份存档上的事。
 *
 * @param {object} b 投影后的广播
 * @param {{images?: Record<string, string>, covers?: Record<string, string>, linkPrefix?: string}} [opts]
 *   `linkPrefix` 是到作品页的相对前缀：月页在 `broadcast/` 底下，要退一级（`../`）；
 *   首页就在根上，前缀是空。**两处都显式传**——默认值对一处是对的、对另一处就是
 *   一整页的死链，而死链在 file:// 下打开是一个目录列表，看起来还挺正常。
 * @returns {string}
 */
export function broadcastBlock(b, { images = {}, covers = {}, linkPrefix = '../' } = {}) {
  const out = [`### ${b.postedAtRaw ?? b.postedAt ?? '时间未知'}`, ''];

  // 动作那一行：「想看 《某电影》」。接得回本地作品页就接，接不回来就只留文字
  // ——**不回退到豆瓣的 URL**，那会让一份号称离线可看的档案去联网。
  //
  // 链接指向**那个 .md 文件的相对路径**，不是某种 URL。
  //
  // 第一版写的是 `/movie/123/`，也就是把一种固定链接方案硬编码进了 Markdown
  // 里——而那个方案是 SSG 的，不是我们的。实测的后果：Hugo 开了 uglyURLs 之后
  // 页面是 `movie/123.html`，那些链接全部指向不存在的目录；在 file:// 下更糟，
  // 浏览器会显示一个目录列表。
  //
  // 相对文件路径没有这个问题：它说的是「那份文件在这儿」，由 SSG 自己去决定
  // 它最终的 URL 长什么样（Hugo 的 link render hook 会把 `.md` 换成实际后缀）。
  // **动作可以没有，链接不该跟着没有。** 第一版把作品链接挂在 `if (b.action)`
  // 里面，于是一条没有动作词、却明确指着某个作品的广播（转发、纯发言）在页面上
  // 与那个作品完全断开——而它的 target_id 就在数据里。实测只影响 1 条，
  // 但断开的理由是「代码结构」而不是「数据没有」，那就是个 bug。
  const t = b.target;

  /**
   * 那一刻给的星数。**三种拼法都要带上它**——星与作品接不接得回来没有关系。
   * 原来它只写在「接得回本地页」那一支里，于是条目被删的广播连星都不见了。
   */
  const stars = b.rating ? `${'★'.repeat(b.rating)}${'☆'.repeat(5 - b.rating)}` : null;

  /**
   * 动作与后面那个名字之间要不要空格。
   *
   * 「关注榜单：」这类动作自带一个冒号，再加空格就成了「关注榜单： 高分无厘头电影榜」。
   */
  const join = (x, y) => (x && /[：:]$/.test(x) ? `${x}${y}` : [x, y].filter(Boolean).join(' '));

  /** @type {string|null} 「[封面] 玩过 作品名 ★★★★☆」那一行 */
  let line = [b.action, stars].filter(Boolean).join(' ') || null;

  if (t) {
    const href = `${linkPrefix}${t.medium}/${t.subjectId}.md`;
    // **标题要转义。** 它是豆瓣给的字，而这里正把它塞进 Markdown 的链接文字里。
    // 实测这份档案里 6 个标题带方括号（`Fate/stay night [Heaven's Feel]`）、
    // 5 个带下划线（`SAC_2045`）——今天它们恰好都是平衡的、恰好都在词中间，
    // 所以侥幸没出事。**「恰好没事」不是判据。**
    //
    // **作品名可能是 null**：条目被豆瓣删了，而占位符「未知作品」不进档案。页面上
    // 仍然要有个说法，用的是作品页自己那一页的标题（同一个函数），两处不会长歪。
    // 链接照给——那一页在本地是有的，上面还有用户自己写的短评与评分。
    const label = plainText(t.title ?? placeholderTitle(t.medium));
    const cover = covers[t.subjectId];
    // **封面必须排在这一行的最前面。**
    //
    // 主题让它 `float: left`，而浮动**跳不到同一行里排在它前面的文字前面**去：
    // 写成「玩过 [封面]作品名」的话，页面上就真的是那个样子——封面卡在动作词与
    // 作品名之间。CSS 那边怎么调都没用，顺序得在这里定。
    //
    // 这也是为什么封面自己一个链接、标题另一个：要让封面排在最前，同时又不能
    // 把「玩过」两个字吞进链接里（那是动作，不是作品名的一部分）。两个相邻的
    // 同目标链接对读屏器略有重复，所以封面的 alt 用作品名——图片链接必须有个
    // 说得出口的名字，alt 留空会让它变成一个念不出名字的链接。
    //
    // 封面来自档案里已经存下的那张（`static/covers/`），不是去豆瓣现取的。
    // 没有封面就只剩文字，不放占位图：占位符不是内容。
    const parts = [];
    if (cover) parts.push(`[![${label}](${cover})](${href})`);
    parts.push(join(b.action, `[${label}](${href})`));
    if (stars) parts.push(stars);
    line = parts.filter(Boolean).join(' ');
  } else if (b.targetTitle) {
    // **接不回本地作品页，也要把名字说出来。**
    //
    // 条目被豆瓣删掉之后标记列表里就没有它了，而这条广播还在——页面上原来只剩
    // 「想看」两个字后面空着，看起来像抓漏了。而名字一直就在广播的卡片里
    // （广播发布即冻结，所以那是**那一刻**的名字）。
    //
    // 不给链接：本地没有那一页。**也绝不回退到豆瓣的 URL**——那会让一份号称
    // 离线可看的档案为了一个链接去联网。
    line = [join(b.action, plainText(b.targetTitle)), stars].filter(Boolean).join(' ');
  }
  if (line) {
    out.push(line, '');
  }

  if (b.text) out.push(plainText(b.text), '');
  // **被截断就说出来。** 显示半截正文而不声明，站点就在替档案说假话。
  // 接得回本地长文页就给个链接（同样用 .md 相对路径，不硬编码 URL 方案）；
  // 接不上就只说被截断了——不回退到豆瓣。
  if (b.textTruncated) {
    out.push(b.fullText
      ? `*（豆瓣在这里截断了，[全文在这篇${b.fullText.kind === 'review' ? '评论' : '日记'}里](${linkPrefix}${b.fullText.kind}/${b.fullText.id}.md)）*`
      : '*（豆瓣在这里截断了，全文不在档案里）*', '');
  }
  if (b.images.length) {
    // **一条广播的附图写在同一行里，不是一张一段。**
    //
    // 一张一段的话每张图各占一个 `<p>`，在页面上就是一列铺满宽度的大图——
    // 实测这份档案里一条广播最多带 18 张，那是十八屏。写在同一行则渲染成一个
    // `<p>` 里的若干 `<img>`，主题给它们一个高度上限就自动排成会换行的一排。
    //
    // 每张都链到自己：缩略之后要能点开看原图。这仍然是**纯 Markdown**，
    // 换任何一个 SSG 都成立——版式交给主题，不往正文里塞 HTML
    // （塞了就得开 unsafe，而那等于让用户文本里的 HTML 在 GitHub Pages 上执行）。
    //
    // 没导出的图保持原样：留一个指向 doubanio 的 URL，总比悄悄删掉一张图好
    // ——前者至少说明「这儿本来有图」。
    out.push(b.images.map((url) => {
      const p = images[url] ?? url;
      return `[![](${p})](${p})`;
    }).join(' '), '');
  }
  return out.join('\n');
}

/**
 * 广播按月归档，一个月一页。
 *
 * ## 为什么不是一条一页
 *
 * 3394 条广播里只有 23% 带正文，其余是纯标记动作（「想看 X」）。一条一页会产出
 * 三千多个只有一行字的文件，把真正有内容的那七百多条埋掉。按月归档保留了广播
 * 本来的形状——**它是一条时间线，不是一堆条目**。
 *
 * 固定链接不丢：每条都有自己的时间戳小标题，SSG 会给它生成锚点，
 * `/broadcast/2021-11/#2021-11-28-202521` 就是那条广播的地址。
 *
 * ## 顺序是倒序的，与豆瓣一致
 *
 * 头插列表，新的在上。这不只是习惯问题：抓取本身就是新→旧走的，倒序让页面
 * 与抓取顺序、与「上面的都抓到了」那个不变量方向一致。
 *
 * @param {string} month  `2021-11`
 * @param {object[]} list 该月的广播，未排序
 * @param {{images?: Record<string, string>}} [opts] 附图 URL → 本地路径
 */
export function broadcastMonthPage(month, list, { images = {}, covers = {} } = {}) {
  const sorted = [...list].sort((a, b) => (a.postedAt < b.postedAt ? 1 : -1));
  const [y, m] = month.split('-');

  const fm = {
    title: `${y}年${Number(m)}月`,
    // 月首，不是月内某条的时间——这一页代表的是整个月。
    date: `${month}-01`,
    douban_kind: 'broadcast_month',
    douban_month: month,
    douban_count: sorted.length,
    // 带正文的有几条。**这个数才是「这一页有多少自己写的东西」**——
    // 总数里大部分是纯标记动作。
    douban_with_text: sorted.filter((b) => b.text).length,
    douban_images: sorted.reduce((n, b) => n + b.images.length, 0),
  };

  // 月页在 `broadcast/` 底下，到作品页要退一级。
  const blocks = sorted.map((b) => broadcastBlock(b, { images, covers, linkPrefix: '../' }));

  return frontMatter(fm) + '\n' + blocks.join('\n');
}

/** @param {string} month `2021-11` */
export function broadcastMonthPath(month) {
  return `broadcast/${month}.md`;
}

/**
 * 一条广播属于哪个月。
 *
 * 按**本地时间**切，不按 UTC。canonical 里的时间戳带 `+08:00`，用 UTC 切的话
 * 每月头几个小时的广播会掉到上一个月去——一个不会报错、只会让归档悄悄错位的 bug。
 *
 * @param {object} b
 */
export function monthOf(b) {
  return (b.postedAtRaw ?? b.postedAt ?? '').slice(0, 7) || '未知';
}

/**
 * 把**用户自己写的字**转义成 Markdown 里的字面文本。
 *
 * ## 为什么非有不可
 *
 * 正文是交给 Markdown 渲染的，而用户写的字里满是 Markdown 的活字符。实测那份
 * 真实档案的 2831 段自撰文本，有 62 段会被悄悄改写，其中两类是真的丢东西：
 *
 *     _(:з」∠)_          → <em>(:з」∠)</em>   下划线被吃掉，整句变斜体（实测 24 处）
 *     From <May December> → From              **整个片名消失**（goldmark 当它是裸 HTML）
 *
 * 第二类尤其严重：页面上什么都不剩，看不出这儿本来有字。**一份会悄悄改写你写过
 * 的话的存档，比没有存档更糟**——它看起来是可信的。
 *
 * ## 为什么不是打开 `unsafe = true`
 *
 * 那会让用户文本里的 HTML 真的执行。广播和日记里到处是别人的名字和内容，而这个
 * 项目还要往 GitHub Pages 上推——把任意 HTML 当标记渲染是往外发布路径上开的口子。
 * 何况那也不对：豆瓣的广播是纯文本，任何 Markdown 解释都是失真。
 *
 * ## 转义策略是量出来的
 *
 * 尖括号与 `&` 用 HTML 实体（反斜杠对它们无效），其余行内记号用反斜杠，块首记号
 * 只在行首转义——`a-b` 里的连字符不该被动，`- item` 里的必须被动。
 *
 * ## `preserveListMarkers`：谁写的那个 `-`
 *
 * 长文正文里的 `- ` **不是用户敲的**，是解析器从页面上的 `<ul><li>` 转出来的
 * （与它插进去的 `![](url)` 同一回事）。把它转义掉，用户那份点列表就在页面上
 * 变成五行字面的 `- xxx`。
 *
 * 而广播里的 `- ` 恰恰相反：豆瓣的广播是纯文本，那儿的连字符就是用户自己敲的
 * 五个字符，必须原样显示。**页面自己告诉了我们是哪一种**——有 `<ul>` 标记的是
 * 结构，没有的是字面。所以这个开关只对长文正文打开，广播与短评一律照旧转义。
 *
 * 长文正文里同时出现「解析器转出来的列表」与「用户自己敲的行首连字符」时，
 * 两者无从分辨。实测这份真实档案的 2898 段自撰文本里，行首带列表记号的只有 1 段，
 * 而它是广播（走的是转义那条路）——长文那边一例都没有。
 *
 * @param {string|null|undefined} s
 * @param {{preserveListMarkers?: boolean}} [opts]
 * @returns {string} 渲染之后与输入逐字相同的 Markdown
 */
export function plainText(s, { preserveListMarkers = false } = {}) {
  if (!s) return '';
  // **先按行拆，再逐行转义。** 在下面那串整串 replace 之后才动手是不行的：
  // 那时反斜杠、实体、行内记号都已经转过一遍，再调一次就是转两遍
  // （实测得到 `\\\\\\_` 与 `&amp;lt;`）。
  if (preserveListMarkers && /^- \S/m.test(s)) {
    return s.split('\n')
      .map((line) => (/^- \S/.test(line)
        // 解析器写的列表记号原样留下，**这一行剩下的字照常转义**。
        ? `- ${plainText(line.slice(2))}`
        : plainText(line)))
      .join('\n');
  }
  return s
    // 反斜杠必须第一个处理，否则会把后面加的反斜杠又转义一遍。
    .replace(/\\/g, '\\\\')
    // `&` `<` `>` 反斜杠转义无效（CommonMark 只允许转义 ASCII 标点里的特定几个，
    // 而裸 HTML 的识别发生在更早的阶段），必须用实体。
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([`*_[\]~])/g, '\\$1')
    // 块首记号只在行首有意义。全局转义会把 `a-b` 写成 `a\-b`，源码难看，
    // 而且那个连字符本来就不会被解释成列表。
    .split('\n')
    .map((line) => line
      .replace(/^(\s*)([#+=|-])(\s|$)/, '$1\\$2$3')
      // 有序列表要转义的是**那个点**，不是数字。CommonMark 不允许转义数字，
      // `\1.` 会原样渲染成一个反斜杠加 1 —— 实测确认过。
      .replace(/^(\s*)(\d+)([.)])(\s|$)/, '$1$2\\$3$4'))
    .join('\n');
}

/**
 * 小节自己的 `_index.md`。
 *
 * 广播、日记、评论这几节原来没有这个文件——Hugo 会替它们造一个空的小节页，
 * 于是首页那句「看全部 →」**没有文件可链**。而这个项目的规矩是链到文件、
 * 由 SSG 决定最终 URL，所以文件得真的存在。
 *
 * 正文留空：那一页要显示什么由主题决定，这里只负责给它一个名字和一个落点。
 *
 * @param {string} section
 * @param {string} title
 */
export function sectionIndexPage(section, title) {
  return frontMatter({ title, douban_kind: 'section', douban_section: section });
}

/** @param {string} section */
export function sectionIndexPath(section) {
  return `${section}/_index.md`;
}

/**
 * 把一段文字放进 Markdown 图片的 title 里（`![alt](url "title")`）。
 *
 * **只转义反斜杠与双引号。** title 不是正文——里面的 `*` `_` `[` 不会被当成标记，
 * 转义它们只会让页面上真的多出几个反斜杠。会坏事的只有那个用来收尾的引号：
 * 实测这份档案里 112 个标题带引号或圆括号（`Sophie's World`、
 * `Core Java, Volume II (10th Edition)`），其中带双引号的一旦不转义，
 * 链接会从那儿断掉。
 *
 * @param {string} s
 */
export function mdTitleAttr(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 首页封面条里的一项：`- [![名字](封面 "名字")](作品页.md)`。
 *
 * **`alt` 与 `title` 内容一样，用途不一样**：前者给读屏器，后者是鼠标停上去时的提示。
 * 首页那一行只有封面没有字，不给 title 的话，想知道是哪一部就只能点进去。
 *
 * 单独一个函数是为了能直接测：这一行里有两处转义规则不同的地方（正文用
 * `plainText`，title 用 `mdTitleAttr`），而写错了不会报错——只会在页面上多出几个
 * 反斜杠，或者让链接从名字里的引号处断掉。
 *
 * @param {object} m 投影后的标记
 * @param {string} coverPath 本地封面路径
 */
export function coverStripItem(m, coverPath) {
  const name = m.title ?? '';
  return `- [![${plainText(name)}](${coverPath} "${mdTitleAttr(name)}")](${markPath(m)})`;
}
