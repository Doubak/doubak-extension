/* 【自动同步，请勿手改】来自 doubak-site-generator 的 src/pages.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/**
 * 投影 → 一整棵 Markdown 树。**纯函数，一个内建模块都不碰。**
 *
 * ## 为什么从 generate.js 里拆出来
 *
 * 那个文件干三件事：把图片从 WARC 里搬出来（I/O）、把投影排成一棵页面树（纯计算）、
 * 把树写到盘上（I/O）。中间那件事**浏览器扩展也要做**——它的导出页要在本地出同一棵
 * 树——而只要还夹在 `node:fs` 中间，扩展就 import 不了。
 *
 * 这跟解析器那边的划法是同一条：**「字节从哪儿来、往哪儿去」各写各的，「内容长什么
 * 样」只能有一份。** 后者错了两边一起错，而且错得看不出来：少一页、多一页、次序不同
 * 的页面树，打开都很正常。
 *
 * 图片路径是**传进来的**（`images` / `covers` 两张表），所以这一层不需要知道图片是
 * 从文件系统来的还是从 OPFS 来的。
 */

import { groupMarks } from './projection.js';
import {
  markPage, longformPage, markPath, longformPath, doulistPage, doulistPath, verb,
  broadcastMonthPage, broadcastMonthPath, monthOf,
  markFilterPath, markFilterPage, broadcastBlock, plainText, coverStripItem,
  sectionIndexPath, sectionIndexPage,
} from './markdown.js';
import { buildSearchIndex } from './search.js';
import { frontMatter } from './yaml.js';

/** 页面都放在 `content/` 底下。**不用 node:path**——这个文件要能在浏览器里跑，
 * 而 zip 内与站点里的分隔符本来就只有 `/` 一种。 */
const content = (rel) => `content/${rel}`;


/** 媒介的中文名。**唯一的一份**，与扩展那边同源。 */
const MEDIUM_NAMES = {
  movie: '影视', book: '书', music: '音乐', game: '游戏', drama: '舞台剧',
  // 首页把广播与长文也当成小节来排，所以这三个名字也在这儿。
  // 主题那边 `hugo.toml` 的 `[params.mediumNames]` 是同一份，测试钉着两处相等。
  broadcast: '广播', note: '日记', review: '评论', doulist: '豆列',
};


/**
 * 排出整棵树。
 *
 * @param {object} p 投影（`project()` 的产出）
 * @param {object} [opts]
 * @param {Record<string, string>} [opts.images]  图片 URL → 站内路径
 * @param {Record<string, string>} [opts.coverBySubject] 作品 id → 站内封面路径
 * @returns {{files: [string, string][], stats: object, remote: string[]}}
 *   `files` 是 [相对路径, 文本]；`remote` 是最后仍然指向 doubanio 的图。
 */
export function buildPages(p, { images = {}, coverBySubject = {} } = {}) {
  const paths = images;

  const files = [];

  /**
   * 最后仍然指向 doubanio 的图。
   *
   * **这是这份档案唯一会悄悄失去「离线可看」的地方。** 没导出到本地的图，页面上
   * 保留的是原始 URL——那条选择本身是有理由的（留一个 URL 至少说明「这儿本来有
   * 张图」，比悄悄删掉一张图好），但它的代价必须**说出来**：那一张图从此需要豆瓣
   * 还活着才看得见，而这个项目存在的全部理由就是不再需要那个前提。
   *
   * 原来这件事完全不报。CLI 只说「档案里没有的图 N 张（页面上会缺）」——**而那句
   * 话是错的**：它们不会缺，它们会去豆瓣取。两种结果的性质差得远，说错了的那句
   * 反而让人以为已经知道后果了。
   * @type {string[]}
   */
  const remote = [];
  /** @param {string|null|undefined} url */
  const stillRemote = (url) => { if (url && !paths[url]) remote.push(url); };

  for (const m of p.marks) {
    // 按作品 id 找到的优先——那是档案里真的有的那一张。按 URL 找到的作为退路。
    const cover = coverBySubject[m.subjectId] ?? paths[m.coverUrl] ?? null;
    if (!cover) stillRemote(m.coverUrl);
    files.push([content(markPath(m)), markPage(m, { coverPath: cover })]);
  }
  for (const r of p.longform) {
    for (const m of (r.body ?? '').matchAll(/https:\/\/[a-z0-9.]*doubanio\.com\/[^\s"'<>)）]+/g)) {
      stillRemote(m[0]);
    }
    files.push([content(longformPath(r)), longformPage(r, { images: paths })]);
  }

  /** @type {Map<string, object[]>} 月份 → 该月的广播 */
  const byMonth = new Map();
  for (const b of p.broadcasts) {
    const k = monthOf(b);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(b);
    for (const u of b.images) stillRemote(u);
  }
  // 作品 id → 本地封面路径。广播里「看过 X」那一行要配一张小封面，与豆瓣一样。
  // **用的是标记页那套同一个查法**（先按作品 id，再按 URL 退一步），不另写一份：
  // 两份查法迟早会分叉，而分叉的样子是「有些广播有封面、有些没有」，看起来像数据缺。
  /** @type {Record<string, string>} */
  const covers = {};
  for (const m of p.marks) {
    const c = coverBySubject[m.subjectId] ?? paths[m.coverUrl] ?? null;
    if (c) covers[m.subjectId] = c;
  }

  for (const [month, list] of byMonth) {
    files.push([content(broadcastMonthPath(month)), broadcastMonthPage(month, list, { images: paths, covers })]);
  }

  // 每个媒介的每个状态一页（`movie/done/`）。**只给真有条目的状态出页**——
  // 一个「在读 0」的空页会让人以为是页面坏了，而不是「本来就没有」。
  for (const [medium, byStatus] of groupMarks(p.marks)) {
    for (const [status, list] of byStatus) {
      files.push([content(markFilterPath(medium, status)), markFilterPage(medium, status, list.length)]);
    }
  }

  // 广播 / 日记 / 评论各自的小节页。**首页那句「看全部 →」要有文件可链**——
  // 没有这个文件时 Hugo 会造一个空小节页，而 Markdown 里链不到一个不存在的文件。
  // 豆列。私密的照常渲染，但页面上带锁——见 markdown.js 的 doulistPage。
  for (const r of p.doulists ?? []) {
    files.push([content(doulistPath(r)), doulistPage(r)]);
  }

  for (const [section, has] of [
    ['broadcast', p.broadcasts.length > 0],
    ['note', p.longform.some((r) => r.kind === 'note')],
    ['review', p.longform.some((r) => r.kind === 'review')],
    ['doulist', (p.doulists ?? []).length > 0],
  ]) {
    if (has) {
      files.push([content(sectionIndexPath(section)),
        sectionIndexPage(section, MEDIUM_NAMES[section] ?? section)]);
    }
  }

  files.push(['content/_index.md', homePage(p, { covers, previewImages: paths })]);

  // ── 搜索索引
  //
  // **总是产出，即使不带骨架。** 它是从 canonical 派生的数据，任何 SSG 都能用；
  // 搜索框与结果页才是骨架的事。
  const search = buildSearchIndex(p);
  files.push(['static/search-index.js', search.js]);
  // 搜索页本身要有个 content 文件，Hugo 才会渲染它。
  files.push(['content/search.md', searchPage(search.rows.length)]);

  return {
    files,
    remote: [...new Set(remote)],
    covers,
    stats: {
      pages: files.length,
      marks: p.marks.length,
      longform: p.longform.length,
      doulists: (p.doulists ?? []).length,
      broadcasts: p.broadcasts.length,
      broadcastMonths: byMonth.size,
      searchRows: search.rows.length,
    },
    search,
  };
}


/**
 * 首页。
 *
 * **只给数字，不给百分比，也不写「完整」。** 完整性的证据在 bundle 的 `crawl_state`
 * 里，投影这一层没有资格复述一个可能已经过期的结论——那与「coverage 不是完整性
 * 判据」是同一条规则。
 */
/**
 * 首页各小节的顺序。**与页眉导航同一份顺序**（主题那边是 `hugo.toml` 的
 * `sectionOrder`），两处对不上比顺序不对更难发现。`test/pages.test.js` 钉着它们相等。
 *
 * 不按字母序：广播是这份存档里最不可替代的一条（发布即冻结、可被静默删除），排第一；
 * 日记与评论只有个位数，排后面。
 */
const SECTION_ORDER = ['broadcast', 'book', 'movie', 'game', 'music', 'drama', 'note', 'review', 'doulist'];

/**
 * 标记状态在页面上的先后。
 *
 * **想看 → 在看 → 看过**，跟着事情本身的次序走。字母序（doing/done/wish）读出来是
 * 「在看、看过、想看」，那是把内部标识的排序当成了人的顺序。
 */
const STATUS_ORDER = ['wish', 'doing', 'done'];

/** 首页每一行摆几张封面。摆不下的由主题裁掉——一行就是一行。 */
const STRIP = 12;

/** 广播、日记、评论各给几条预览。 */
const PREVIEW = 2;

/** 长文预览截多少字。 */
const EXCERPT = 80;

/**
 * 首页。
 *
 * ## 它是一份概览，不是一张目录
 *
 * 原来这里只有一列数字（「读过 45」），点进去才看得到东西。而这份存档的价值恰恰在
 * 那些封面、那些话——首页一张图都没有的话，它看起来像个后台管理界面。
 *
 * 所以每个状态给一行封面加一个「看全部」的出口；广播与长文各给两条真实的预览。
 *
 * ## 还是纯 Markdown
 *
 * 一行封面就是若干个 `[![标题](封面)](作品页.md)` 排在同一行里——与广播附图同一个
 * 写法。**版式交给主题**：一行放得下几张、多出来的怎么裁，都是 CSS 的事。
 * 正文里不塞 HTML（塞了就得开 `unsafe`，那等于让用户文本里的 HTML 在 Pages 上执行）。
 *
 * ## 只给数字，不给百分比，也不写「完整」
 *
 * 完整性的证据在 bundle 的 `crawl_state` 里，而豆瓣的计数有时算在它的审查层之前、
 * 有时之后。投影这一层没有资格复述一个可能已经过期的结论。
 *
 * @param {object} p 投影
 * @param {{covers?: Record<string, string>}} [opts] 作品 id → 本地封面路径
 */
function homePage(p, { covers = {}, previewImages = {} } = {}) {
  const groups = groupMarks(p.marks);
  const lines = [];

  /**
   * 一行封面，写成一个 **Markdown 列表**。
   *
   * 不写成一段并排的图片：广播预览那一行也是「一个 `<p>` 里有 `<a><img>`」，
   * 两者在 CSS 里就分不开了——而它们该有的大小差着一倍。列表给了一个纯 Markdown
   * 的结构区分（`<ul><li>` vs `<p>`），任何 SSG 下都成立，也不用往正文里塞 HTML。
   *
   * 没有封面的作品不占位——占位符不是内容。
   */
  const strip = (list) => list
    .filter((m) => covers[m.subjectId])
    .slice(0, STRIP)
    .map((m) => coverStripItem(m, covers[m.subjectId]));

  /** 按想要的顺序排，**名单之外的接在后面**——一个都不许丢。 */
  const order = (keys, want) => [
    ...want.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !want.includes(k)).sort(),
  ];

  /** 一个媒介：标题 + 每个状态一行封面 + 出口。 */
  const mediumSection = (medium) => {
    const byStatus = groups.get(medium);
    const total = [...byStatus.values()].reduce((n, l) => n + l.length, 0);
    const out = [`## ${MEDIUM_NAMES[medium] ?? medium} ${total}`, ''];
    for (const status of order([...byStatus.keys()], STATUS_ORDER)) {
      const list = byStatus.get(status);
      out.push(`### ${verb(medium, status)} ${list.length}`, '');
      const row = strip(list);
      if (row.length) out.push(...row, '');
      // **链到文件，不写死固定链接。** 与正文里的作品交叉链接同一条规则：
      // 生成器只说「那份内容在这个文件里」，最终 URL 由 SSG 决定——第一版写死
      // `/movie/123/` 的那次，打开 uglyURLs 就全断了。
      out.push(`[看全部 ${list.length} →](${markFilterPath(medium, status)})`, '');
    }
    return out;
  };

  /** 广播：两条真实的预览。只写「共 3401 条」等于把这份档案最值钱的东西藏起来。 */
  const broadcastSection = () => {
    const recent = [...p.broadcasts]
      .sort((a, b) => ((a.postedAt ?? '') < (b.postedAt ?? '') ? 1 : -1))
      .slice(0, PREVIEW);
    const withText = p.broadcasts.filter((b) => b.text).length;
    return [
      `## ${MEDIUM_NAMES.broadcast} ${p.broadcasts.length}`, '',
      `其中 ${withText} 条带正文。广播发布后不可编辑，所以每条都是那一刻的原话。`, '',
      // **首页就在根上，前缀是空**；月页在 broadcast/ 底下才要 `../`。
      ...recent.map((b) => broadcastBlock(b, { images: previewImages, covers, linkPrefix: '' })),
      '',
      `[看全部 ${p.broadcasts.length} 条 →](${sectionIndexPath('broadcast')})`, '',
    ];
  };

  /** 日记 / 评论：两篇预览，正文只给开头。 */
  const longformSection = (kind) => {
    const list = p.longform.filter((r) => r.kind === kind);
    const recent = [...list]
      .sort((a, b) => ((a.publishedAt ?? '') < (b.publishedAt ?? '') ? 1 : -1))
      .slice(0, PREVIEW);
    const out = [`## ${MEDIUM_NAMES[kind]} ${list.length}`, ''];
    for (const r of recent) {
      out.push(`### [${plainText(r.title ?? '(无标题)')}](${longformPath(r)})`, '');
      const when = r.publishedAtRaw ?? (r.publishedAt ?? '').slice(0, 10);
      if (when) out.push(`*${when}*`, '');
      // 正文只给开头一小段，**并且把截断说出来**。不说的话读者无从分辨这是全文还是
      // 摘要——而「半截当全文」在这份档案里是明令禁止的（见广播的 text_truncated）。
      // 图片标记去掉，空白压成一个空格：摘要是一段话，不是一小块排版。
      const flat = (r.body ?? '').replace(/!\[\]\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
      const chars = [...flat];
      if (chars.length) {
        out.push(plainText(chars.slice(0, EXCERPT).join('')) + (chars.length > EXCERPT ? '……' : ''), '');
      }
    }
    out.push(`[看全部 ${list.length} 篇 →](${sectionIndexPath(kind)})`, '');
    return out;
  };

  // **所有小节排在同一个顺序里**，不是「先媒介、再把广播长文接在后面」——
  // 那样广播永远垫底，而它恰恰是这份档案里最不可替代的一条。
  const present = [
    ...(p.broadcasts.length ? ['broadcast'] : []),
    ...groups.keys(),
    ...(p.longform.some((r) => r.kind === 'note') ? ['note'] : []),
    ...(p.longform.some((r) => r.kind === 'review') ? ['review'] : []),
  ];
  for (const section of order(present, SECTION_ORDER)) {
    if (section === 'broadcast') lines.push(...broadcastSection());
    else if (section === 'note' || section === 'review') lines.push(...longformSection(section));
    else lines.push(...mediumSection(section));
  }

  const deleted = p.marks.filter((m) => m.upstreamDeleted).length;
  if (deleted) {
    lines.push(
      '## 上游已删除', '',
      `有 ${deleted} 条标记指向豆瓣已经删掉的作品。标记本身还在——评分、标签、`
      + '短评都是你自己写的，它们没有跟着消失。', '',
    );
  }

  return frontMatter({ title: '我的豆瓣存档', douban_kind: 'index' }) + '\n' + lines.join('\n');
}

/**
 * 搜索页。正文是空的——结果由骨架里的脚本填。
 *
 * `layout: search` 让 Hugo 去找 `layouts/_default/search.html`。别的 SSG 认不认
 * 这个键无所谓：认不出来它就是一个空页面，而索引文件仍然在那儿可以自己用。
 */
function searchPage(n) {
  return frontMatter({
    title: '搜索',
    layout: 'search',
    douban_kind: 'search',
    douban_count: n,
  });
}
