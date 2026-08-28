/* 【自动同步，请勿手改】来自 doubak-data-parser 的 src/extract-longform.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/**
 * 从正文页抽出日记与评论。
 *
 * ## 为什么必须抓正文页，列表页不够
 *
 * 列表页上的正文是**截断的摘要**——真实页面上以 `number=xxx...` 和
 * `我之前标记了，然后跑很...` 结尾。全文只在正文页里。
 *
 * ## 日记与评论的结构差得很远
 *
 * |  | 日记 | 评论 |
 * |---|---|---|
 * | 身份 | `<div id="note-<id>">` | `<div id="review-<id>-content">` |
 * | 标题 | `<h1>` 直接是文字 | `<h1><span property="v:summary">` |
 * | 时间 | `<span class="pub-date">` | `<div class="main-meta"><span content=…>` |
 * | 评分 | 没有 | `main-title-hide` |
 * | 关联作品 | 没有 | JSON-LD 的 `itemReviewed.sameAs` |
 *
 * **这些是从真实抓取的字节里量出来的，不是从浏览器另存的页面。** 两者不一样：
 * 浏览器另存的那份跑过 JS，`<h1>` 里已经是纯文字；而抓取拿到的原始 HTML 里
 * `<h1>` 套着 `<span property="v:summary">`。照浏览器那份写选择器会在真实数据上落空。
 *
 * ## 与广播相反：长文**可以编辑**
 *
 * 所以多条修订是正常的，正是要留住的东西。广播那边多一条修订是警报。
 */

import { decodeEntities } from './html-entities.js';

/**
 * 从某个 `<div …>` 起，取出**与之配对**的那个 `</div>` 之前的内容。
 *
 * ## 为什么不能用正则
 *
 * 正文里嵌着别的 div（图片是 `<div class="image-container">…</div>`）。
 * `([\s\S]*?)<\/div>` 会停在**第一个**闭合标签上——实测那篇带图日记因此只抽到
 * 32 个字，正文剩下的两段全丢了。而贪婪匹配又会冲过头，把页脚的浏览计数吞进来
 * （那会让每次抓取都多出一条假修订）。
 *
 * 两个方向都错过一次，所以老老实实数嵌套。这不优雅，但它是对的，而且不到十行。
 *
 * @param {string} html
 * @param {number} openAt  起始 `<div` 的下标
 * @returns {string|null}
 */
function sliceDiv(html, openAt) {
  const bodyStart = html.indexOf('>', openAt);
  if (bodyStart < 0) return null;
  let depth = 1;
  let i = bodyStart + 1;
  const tag = /<\/?div\b/g;
  tag.lastIndex = i;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(bodyStart + 1, m.index);
  }
  return null; // 标签没配平——宁可返回 null，也不返回半截正文
}

/**
 * 在 `#link-report` 与页脚之间，再往里收一层到 `<div class="note">`。
 *
 * 那一段里除了正文，还夹着**豆瓣自己的东西**：`div.mod-tags`（频道标签）、
 * `div#link-report_note`（投诉按钮）、`div.copyright-claim`。不收的话，用户那篇
 * 日记的正文末尾会挂上
 *
 *     科技
 *     生活
 *     本文版权归 MewX 所有，任何形式转载请联系作者。
 *     了解版权计划
 *
 * ——而这几行**不是用户写的字**。与「未知作品」「1740人浏览」「（全文）」同一条规则：
 * 页面装潢不是内容。它们不像浏览计数那样会变，所以不会伪造修订；但它会进正文摘要，
 * 也会印在生成的站点上。
 *
 * **找不到就退回整段，绝不返回 null。** 实测手上只有 2 篇 `/note/` 有这个容器
 * （另有 1 篇 `/topic/` 走 `.rich-content`、2 篇评论两者都没有）——n=2 推不出一个
 * 封闭的形状集合，这个项目已经在这上面栽过四次。收紧只在认得出结构时生效，
 * 认不出就维持原样：多几行页面装潢是难看，丢掉整篇正文是灾难。
 *
 * @param {string} seg `#link-report` 到页脚之间的那一段
 */
function noteBody(seg) {
  const at = /<div class="note"[^>]*>/.exec(seg)?.index ?? -1;
  if (at < 0) return seg;
  return sliceDiv(seg, at) ?? seg;
}

/** 剥标签，保留文字与换行。正文里的 `<br>` 是内容的一部分。 */
function bodyText(html) {
  // 实体在**剥完标签之后**才解。反过来的话 `&lt;script&gt;` 会先变成
  // `<script>`，然后被上面那条规则当作标签删掉——用户写的一段字就此消失。
  return decodeEntities(html
    // **先把 script / style 连内容一起去掉。** 剥标签的正则只吃 `<...>`，
    // 留下的是标签之间的东西——而 `<script>` 之间的东西是 JS 源码。
    //
    // 实测两篇日记因此在正文里带上了：
    //
    //     Do.add('html5_video', { path: '…/note/html5_video.48d02.js' })
    //
    // 这不只是脏。那串 `48d02` 是豆瓣前端资源的哈希，**豆瓣重新发布一次前端，
    // 它就变一次**——于是用户那篇一个字没动的日记会凭空多出一条修订。
    // 与「浏览数」「作品元信息」是同一类错：把上游的易变量算进了用户内容的摘要里。
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    // **图片要留下来。** 正文里插的图是内容的一部分，剥成纯文本会让它彻底消失——
    // 而字节明明已经抓进档案了，只是 canonical 里再没有任何东西指向它们，于是
    // 站点生成器也无从摆放。实测那篇带图日记：两张图在 assets 段里，正文里却
    // 一点痕迹都没有。
    //
    // 转成 Markdown 的图片语法：canonical 的正文本来就是要喂给 Markdown 的，
    // 而这一步是**保留**不是**解释**——URL 原样，不改尺寸、不换 CDN。
    .replace(/<img[^>]+src="(https:\/\/[^"]+)"[^>]*>/gi, '\n![]($1)\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // **段之间要空一行。** 只给一个 `\n` 的话，CommonMark 把它当作段内的软换行，
    // 渲染出来是一个空格——实测那篇日记的三段在页面上并成了一整段。
    .replace(/<\/p>/gi, '\n\n')
    // **列表项要留成列表项。** 只剥标签的话五个 `<li>` 会粘成一行，而且最后一项
    // 会接着粘上后面那一段：实测那篇讲绑定手机号的日记，
    //
    //     - ck=JBf5
    //     - old_phone=+86xxxxxxxxxxx
    //     - area_code=+86 (这里错了…)
    //
    // 变成了 `ck=JBf5old_phone=+86xxxxxxxxxxxarea_code=+86 (这里错了…)`——
    // 与「图注和下一段黏成一句」是同一个错：**那已经不是用户写的字了**，
    // 而且它不报错，只是读起来像乱码。
    //
    // 一律写成 `- `。**不去区分 `<ol>`**：真实档案里 5 篇长文共 10 个列表全是
    // `<ul>`，一个 `<ol>` 都没有，而按 n=0 去猜有序列表该怎么编号，猜错的方向是
    // 把用户没写的序号写进档案。真遇到再按实测加。
    //
    // 没有对应的 `</li>` 规则：下一个 `<li>` 自己带着换行来。两边都加的话每项之间
    // 会空一行，而 CommonMark 把那叫「松散列表」——每一项都被包进 `<p>`，行距大一倍。
    // 用户写的是一串挨着的条目，就该渲染成一串挨着的条目。
    .replace(/<li\b[^>]*>/gi, '\n- ')
    // 列表结束要空一行，否则后面那一段会被当成最后一项的续行吞进去
    // （CommonMark 的 lazy continuation）。
    .replace(/<\/(ul|ol)>/gi, '\n\n')
    // `</div>` 也算断开。不加这一条，图注会和下一段黏成一句——实测那篇带图日记
    // 变成了「长这样咯就是然后备份下来的数据…」。**那已经不是用户写的字了。**
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim() || null;
}

/**
 * @typedef {object} RawLongform
 * @property {string} id
 * @property {'note'|'review'} kind
 * @property {string|null} title
 * @property {string|null} publishedAt  秒级
 * @property {string|null} body         **全文**，不是摘要
 * @property {string|null} url
 * @property {number|null} rating       只有评论有
 * @property {string|null} subjectUrl   只有评论有
 * @property {string|null} location     只有日记有（发布地）
 */

/**
 * @param {string} html
 * @param {'note'|'review'} kind
 * @returns {RawLongform|null} 认不出来就返回 null —— **不猜**
 */
export function extractLongform(html, kind) {
  if (typeof html !== 'string') return null;
  return kind === 'note' ? note(html) : review(html);
}

function note(html) {
  // **日记有两种页面结构，都要认。** 不是豆瓣改版——两种同时存在，发日记时用哪个
  // 编辑器就得到哪一种（`/note/<id>/` 与 `/topic/<id>/`）。
  //
  // 这一条是从真实档案里学到的：写第一版时手上只有两篇日记、恰好都是旧那种，于是
  // 从 n=2 推出了一个封闭的形状集合。抓取那边同样的错误已经犯过一次。
  if (/id="topic-content"|class="topic-title"/.test(html)) return topicNote(html);

  const id = /<div id="note-(\d+)"/.exec(html)?.[1];
  if (!id) return null;

  // 正文的**两端都要钉死**：从 `#link-report` 起，到 `#note_<id>_footer` 止。
  //
  // 第一版没钉右端（只写「到下一个 <div class="">」），结果溢出到了页脚，把
  //
  //     1740人浏览
  //
  // 一起吞了进去。那是**浏览计数**——它每次抓取都在涨，于是同一篇日记在三次抓取里
  // 产出了三条修订，看起来像用户在 24 小时内改了两次。
  //
  // 这是这套系统最坏的一种错：**凭空捏造编辑历史**，而且它不会报错。canonical 存在
  // 的全部理由就是「这条什么时候改的」，一个溢出的正则足以让那个答案全是噪音。
  //
  // 也不要退到只抓 `<p data-page>`：那太紧了，日记里的列表与代码块会被丢掉
  // （实测 2788 字缩到 237 字）。
  //
  // 顺带：**不要抓 `#note_<id>_short`**，它在正文页上是空的、display:none——
  // 摘要那一份只在列表页渲染。
  const full = new RegExp(`id="link-report"[^>]*>([\\s\\S]*?)<div[^>]*id="note_${id}_footer"`).exec(html);

  const pub = /class="pub-date">\s*([\d-]{10}[\s\d:]{0,9})\s*([^<]*)/.exec(html);
  const body = full ? bodyText(noteBody(full[1])) : null;
  return {
    id,
    kind: 'note',
    title: decodeEntities(/<h1>\s*([^<]+?)\s*<\/h1>/.exec(html)?.[1] ?? '') || null,
    publishedAt: pub?.[1]?.trim() ?? null,
    // 发布地（「澳大利亚」）。豆瓣 2022 年后才有，早年的日记没有。
    location: pub?.[2]?.trim() || null,
    body,
    url: /data-url="(https:\/\/[^"]*\/note\/\d+\/?)"/.exec(html)?.[1] ?? null,
    rating: null,
    subjectUrl: null,
  };
}

function review(html) {
  const id = /id="review-(\d+)-content"/.exec(html)?.[1]
    ?? /id="link-report-(\d+)"/.exec(html)?.[1];
  if (!id) return null;

  const content = new RegExp(`id="link-report-${id}"[^>]*>([\\s\\S]*?)(?=<link|<style)`).exec(html);
  const rating = /main-title-hide">(\d)/.exec(html)?.[1];

  return {
    id,
    kind: 'review',
    // **原始 HTML 里 `<h1>` 套着 `<span property="v:summary">`**，不是纯文字。
    title: decodeEntities(/property="v:summary"[^>]*>\s*([^<]+)/.exec(html)?.[1]?.trim() ?? '') || null,
    publishedAt: /class="main-meta">\s*<span content="[\d-]+">\s*([\d:\- ]{10,19})/.exec(html)?.[1]?.trim() ?? null,
    location: null,
    body: content ? bodyText(content[1]) : null,
    url: /data-url="(https:\/\/[^"]*\/review\/\d+\/?)"/.exec(html)?.[1] ?? null,
    rating: rating ? Number(rating) : null,
    // 关联作品来自 JSON-LD。**取 `sameAs` 而不是 `url`**——后者是相对路径
    // `/subject/26425271/`，而这条评论其实是给游戏写的（`/game/26425271/`），
    // 相对路径会把媒介弄错。
    subjectUrl: /"sameAs":\s*"(https:\/\/[^"]*douban\.com\/[^"]+)"/.exec(html)?.[1] ?? null,
  };
}

/**
 * `/topic/<id>/` 那种日记。
 *
 * 与 `/note/` 那种结构完全不同：
 *
 *     标题   <h1 class="topic-title">
 *     时间   <span class="create-time">2026-08-07 16:25:36</span>
 *     发布地 <span class="ip-location">澳大利亚</span>
 *     正文   <div class="rich-content topic-richtext">
 *
 * **正文右端同样要钉死。** 旁边就是 `<span class="create-visit-count">4浏览</span>`
 * ——浏览计数每次抓取都在涨，吞进正文就会让同一篇日记每抓一次多出一条修订，
 * 也就是凭空捏造编辑历史。`/note/` 那种上面已经栽过一次，这里不能再栽。
 *
 * 好在这种结构里计数在 `.topic-meta` 里、在正文容器**外面**，所以把正文锚在
 * `.rich-content` 上就自然避开了。
 */
function topicNote(html) {
  const id = /\/topic\/(\d+)\/?/.exec(html)?.[1]
    ?? /data-tid="(\d+)"/.exec(html)?.[1];
  if (!id) return null;

  const at = /<div class="rich-content[^"]*"/.exec(html)?.index ?? -1;
  const body = at >= 0 ? sliceDiv(html, at) : null;
  return {
    id,
    kind: 'note',
    title: decodeEntities(/<h1 class="topic-title">\s*([^<]+?)\s*<\/h1>/.exec(html)?.[1] ?? '') || null,
    publishedAt: /class="create-time">\s*([\d:\- ]{10,19})/.exec(html)?.[1]?.trim() ?? null,
    location: /class="ip-location">\s*([^<]+)/.exec(html)?.[1]?.trim() || null,
    body: body ? bodyText(body) : null,
    url: /https:\/\/www\.douban\.com\/topic\/\d+\//.exec(html)?.[0] ?? null,
    rating: null,
    subjectUrl: null,
  };
}
