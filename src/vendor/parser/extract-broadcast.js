/* 【自动同步，请勿手改】来自 doubak-data-parser 的 src/extract-broadcast.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/**
 * 从广播时间线抽出一条条广播。
 *
 * ## 广播与标记是两种东西
 *
 * | | 标记 | 广播 |
 * |---|---|---|
 * | 可编辑 | **可以** —— 状态、评分、短评都会变 | **不可以**，发布即冻结 |
 * | 可删除 | 可以 | 可以，而且**不留痕迹** |
 * | 时间精度 | 只到天 | **到秒** |
 * | 身份 | data-cid（半数历史档案里没有） | `data-sid`，实测 100% 有 |
 *
 * 「发布后不可编辑」是实测确认过的，也是这条路线排在最优先的理由：每条广播都是
 * 「那一刻这句话是什么样」的带日期快照，而那是**首次抓取之前发生的编辑**唯一可能
 * 的证据来源。
 *
 * 真实例子：某条标记的「想看」短评在标记页上已经被「看过」的短评覆盖了，而广播里
 * 还在，还带着秒级时间戳。
 *
 * ## 转发进来的不是自己的
 *
 * 转发别人的广播，会把对方那条整个渲染在自己的时间线上，`data-uid` 是**原作者**。
 * 实测 3394 个 wrapper 里有 8 个是别人的。它们不该进档案主人的 canonical——
 * 与广播附图那条规则同一个判据、同一个理由。
 */

import { stripTagsAndDecode, decodeEntities } from './html-entities.js';

/** 一条广播的外壳。转发不是嵌套结构：豆瓣把原作者那条整个渲染成一个顶层 wrapper。 */
const WRAPPER = /<div class="new-status status-wrapper[^"]*"[^>]*>/g;

/**
 * 动作词 → 状态。
 *
 * 只映射明确对应三种标记状态的那些；其余（收藏到豆列、转发、说）**保持 null**，
 * 动作原文照存。实测分布：
 *
 *   想看 1214 · 看过 1061 · 想玩 287 · 玩过 221 · 在看 194 · 在玩 106
 *   想读 72 · 读过 36 · 听过 23 · 在读 20
 *   收藏X到豆列 61 · 转发 24 · 抽不到 27
 *
 * 「收藏图书到豆列」不是一个标记状态，硬塞进 wish/done/doing 任何一格都是编造。
 */
const ACTION_STATUS = {
  想看: 'wish', 想读: 'wish', 想听: 'wish', 想玩: 'wish',
  看过: 'done', 读过: 'done', 听过: 'done', 玩过: 'done',
  在看: 'doing', 在读: 'doing', 在听: 'doing', 在玩: 'doing',
};

/**
 * 广播附图，三种写法并存。
 *
 * **这三种不是历史演进，是同时存在的。** 这一点是实测出来的，不是推出来的——
 * 也正因为如此，没有一种是能靠猜写对的。
 *
 *     新版 a  <script> 里 `var photos = [ {image: {raw: {url}, …}} ];`
 *     新版 b  同一段 JSON，但**没有 raw**，只有 `image.large.url`
 *     老版    `data-raw-src="…"`（旁边的 data-median-src / data-small-src 是缩略版，不要）
 *
 * 抽取路径靠的是具体写法（变量名、属性名）。豆瓣哪天换一种渲染方式，两条路
 * **都会一声不吭地返回空**——而「这条广播没有图」和「这条广播的图我们不认识了」
 * 在数据上完全一样，事后无从分辨。所以另外看一眼容器 class：那是另一套标记，
 * 不随 JSON 的写法变。容器在而一张都没抽到，就是结构变了，必须报。
 *
 *     新版容器  <div class="pics-wrapper">                     里面是 var photos
 *     老版容器  <div class="attachments-saying attachments-pic">  里面是 data-raw-src
 *
 * **`group-pic` 不在这张表里，尽管它看起来最像。** 那是标记类广播旁边的作品封面
 * （外面裹着 `recommed-pics`，链接指向作品，`target_type: "ilmen"`），是豆瓣的目录
 * 数据，不是用户上传的东西。把它算进来的话，光第一份档案就误报几十条「结构变了」——
 * 而一条天天出现的假告警会让真的那条也被忽略。
 */
const PHOTO_CONTAINER = /pics-wrapper|attachments-pic/;

/**
 * 是不是一张 doubanio 上的图。
 *
 * **这个判据必须与抓取端逐字一致**（extension `classifier.js` 的同名函数）。
 * 两边不一致的后果是不对称的、而且都很难发现：
 *
 *   - 解析端**更松** → canonical 里出现一个抓取端从没取过的 URL，站点上是个死链
 *   - 解析端**更严** → 字节明明在档案里，canonical 却不提它，等于悄悄丢了一张图
 *
 * 所以这里**不按主机名收窄**。第一版写成 `img\d*\.doubanio\.com` 就漏了
 * `qnmob3.doubanio.com`——那是同一批广播里的另一个图片主机，实测存在。
 * 「从手上的样本推出一个封闭集合」是这个项目反复栽的那个跟头，这是第四次。
 */
function isDoubanioImage(url) {
  if (!/^https:\/\/[a-z0-9.]*doubanio\.com\//i.test(url)) return false;
  return /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url);
}

/**
 * 抽出**这一条**广播里的附图。
 *
 * 与抽取器整体同一个判据：只在单条广播的 wrapper 内找。页面级地找会把转发进来的
 * 别人的图算到自己头上——实测那 175 张广播页上，30 张图属于别人。
 *
 * @param {string} seg 单条广播的 HTML
 * @returns {{urls: string[], unresolved: number}}
 */
function extractImages(seg) {
  /** @type {Set<string>} */
  const urls = new Set();
  let unresolved = 0;

  for (const m of seg.matchAll(/var\s+photos\s*=\s*(\[[\s\S]*?\])\s*;/g)) {
    let list;
    try {
      // 只截到 `];` 为止——整段 script 后面还有别的语句，连着喂给 JSON.parse
      // 必然失败，而那会把「有图但解析不了」变成「没有图」。
      list = JSON.parse(m[1]);
    } catch {
      unresolved += 1;
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      // 优先原件，退而求其次取 large。**不取 small**：那是缩略图，
      // 而「档案里存的是当时看到的那张」这件事只有原件担得起。
      const raw = entry?.image?.raw?.url;
      const large = entry?.image?.large?.url;
      const pick = typeof raw === 'string' && raw ? raw : large;
      if (typeof pick === 'string' && isDoubanioImage(pick)) urls.add(pick);
      else unresolved += 1;
    }
  }

  for (const m of seg.matchAll(/data-raw-src="(https:\/\/[^"]+)"/g)) {
    if (isDoubanioImage(m[1])) urls.add(m[1]);
    else unresolved += 1;
  }

  if (urls.size === 0 && PHOTO_CONTAINER.test(seg)) unresolved += 1;
  return { urls: [...urls], unresolved };
}

/**
 * 豆瓣把超长广播截断之后留下的那个「（全文）」链接。
 *
 * ## 按结构认，不按文字认
 *
 * 判据是 blockquote 末尾的 `<a href="…">（全文）</a>` 这个**元素**，不是正文
 * 「以（全文）三个字结尾」。后者会把一条**用户自己打了「（全文）」结尾**的广播
 * 误判成截断——而误判的后果是给一条完整的正文盖上「不完整」的戳，
 * 那和漏判一样是在说假话。
 *
 * ## 它指向的地方通常已经在档案里了
 *
 * 实测那两条：`href` 都指向一篇**日记**，而两篇日记的全文早就抓下来了
 * （`longform.ndjson` 里的 872015292 与 868128497）。
 *
 * 所以这不是「档案缺了数据」，是「档案缺了一个指针」——全文一直都在，
 * 只是没有任何东西说这条广播的正文是它的开头。修法因此便宜得多：
 * **记下来，不用重抓。**
 *
 * @param {string} seg 单条广播的 HTML
 * @returns {string|null} 全文的 URL；没被截断就是 null
 */
function fullTextUrl(seg) {
  const q = /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/.exec(seg);
  if (!q) return null;
  return /<a href="([^"]+)"[^>]*>（全文）<\/a>\s*<\/p>/.exec(q[1])?.[1] ?? null;
}

/**
 * @typedef {object} RawBroadcast
 * @property {string} sid            data-sid，广播的身份
 * @property {string|null} postedAt  秒级时间戳（原始字符串）
 * @property {string|null} text      正文。实测 65% 的广播有（其余是纯标记动作）
 * @property {string|null} action    动作原文（想看 / 收藏图书到豆列 / …）
 * @property {{text: string, url?: string}[]|null} actionParts  动作句的分段，
 *   带上句子里那几个链接。**拼起来必须逐字等于 `action`**；没有链接时是 null
 * @property {string|null} status    动作能明确映射到三种标记状态时才有，否则 null
 * @property {number|null} rating    发这条广播时给的星数（1–5）。**与标记的评分不是
 *   一回事**：标记只留最新那个，而广播冻结，所以这是「那一天给了几颗星」
 * @property {string|null} targetType data-target-type
 * @property {string|null} targetId   data-object-id
 * @property {string|null} targetTitle 卡片上那个作品名，**那一刻的名字**
 * @property {string|null} url
 * @property {string[]} images       附图原件 URL。**空数组不是 null**——见下
 * @property {string|null} fullTextUrl 正文被豆瓣截断时，指向全文的 URL；没截断是 null
 */

/**
 * 人名后面那句话 —— **整句，不是前七个字**。
 *
 * ## 原来为什么是七个字，以及那个数为什么是错的
 *
 * 旧写法是 `([^<\s][^<]{0,6}?)\s*<`：从人名链接之后取最多七个非 `<` 字符。
 * 七这个数看起来是「最长的动作词」（`收藏图书到豆列` 正好七个字），实际上它是
 * **「在第一个行内链接前面刹住」**——而那个链接里装着的正是这句话的宾语：
 *
 *     收藏游戏到豆列 <a href="…/doulist/45473911/">游戏购买小账本</a>
 *     上传了17张照片到 <a href="…/game/30246116/">寂静之人</a> 的 <a …>相册</a>
 *
 * 于是「收藏到哪个豆列」在档案里一直是空的。实测 **61 条**广播这样丢掉了豆列名。
 *
 * 同一个上限还切掉了另外几种整句：`喜欢`（真正的问题不是长度，是它与
 * `<blockquote>` 之间隔着一个 `:`）、`上传了 N 张照片到 X 的相册`、
 * `分享了关于 X 的讨论`、`开始收听自己的豆瓣FM`。实测 33 条广播因此完全没有动作。
 *
 * ## 现在的判据是**结构**，不是长度
 *
 * 从 `class="lnk-people"` 那个链接之后，切到**内容开始的地方**——
 * `<blockquote>`（有正文时）或者 `.text` 那个 `</div>`（没有正文时），谁先来算谁。
 * 去掉标签、折叠空白 —— 也就是浏览器渲染行内 HTML 的做法；实体交给唯一那份
 * `stripTagsAndDecode`（先去标签再解实体，理由见 html-entities.js）。
 *
 * 实测这条规则在全部 3423 条广播上：**长度中位数 2、90% 是 2、最长 76**——
 * 也就是说它没有跑飞，绝大多数仍然是那两个字的标记动作词。
 *
 * ## 三件必须成立的事，都实测过
 *
 * - **12 个标记动作词一个都不能变形**，否则 `ACTION_STATUS` 查不到，
 *   状态就成了 null——**一条标记事件会静默消失**。实测：3265 条有状态的广播，
 *   保住 3265、丢 0、也没有凭空多出来。这是这次改动唯一危险的方向。
 * - **抽不到就是真的没有。** 剩下 2 条是日记广播，豆瓣压根没写动作词
 *   （`<span type="note"></span>` 之后直接就是卡片），那 `null` 是对的。
 * - **结尾的冒号去掉，开头的不去。** 结尾那个是动作与引文之间的分隔符，
 *   而豆瓣半角全角两种都写：CLAUDE.md 记着 `action` 那 59 对相邻修订差异里有
 *   **49 对只差冒号宽窄**（老页面 `说:`，新页面 `说：`）。去掉之后这 49 对自动消失。
 *   开头那个不动：实测有 1 条广播豆瓣就没写动作词，页面上原样显示
 *   `MewX : 《斯诺登…》预告片`——照抄比替它编一个动词诚实，而 n=1 也不够推出任何规则。
 *
 * @param {string} seg 一条广播的容器切片
 * @returns {{action: string, parts: {text: string, url?: string}[]|null}|null}
 */
function actionSentence(seg) {
  const at = seg.indexOf('class="lnk-people"');
  if (at < 0) return null;
  const after = seg.indexOf('</a>', at);
  if (after < 0) return null;

  const rest = seg.slice(after + 4);
  // 内容从哪儿开始：有正文是 `<blockquote>`，没有正文是 `.text` 的收尾 `</div>`。
  // 两个都找，取先到的那个 —— 只认一个的话，另一种形状会一路吃到页尾。
  const stops = [rest.indexOf('<blockquote'), rest.indexOf('</div>')].filter((i) => i >= 0);
  if (!stops.length) return null;

  // **标签直接删掉，不换成空格** —— 用的就是那份公用的 `stripTagsAndDecode`。
  //
  // 第一版换成了空格，怕把 `到豆列` 和 `游戏购买小账本` 粘成一个词。**那个担心是
  // 我编的**：浏览器渲染行内 HTML 就是「去掉标签、折叠空白」，所以该有空格的地方
  // 豆瓣源码里本来就有（`收藏游戏到豆列 \n      <a>…`）。反过来，换成空格会造出
  // 页面上根本没有的空格 —— 实测 4 条：
  //
  //     源码    写了《<a>千と千尋の神隠し</a>》的讨论
  //     页面    写了《千と千尋の神隠し》的讨论
  //     换空格  写了《 千と千尋の神隠し 》的讨论      ← 书名号里凭空多两个空格
  //
  // 判据因此是**「浏览器会把它显示成什么样」**，不是「怎样更保险」。
  // 这个毛病是**看生成出来的站点**看出来的，不是想出来的。
  //
  // 结尾的冒号连同它前面的空白一起去：`喜欢\n      \n:` 折叠成 `喜欢 :`，
  // 只去冒号会留一个尾随空格，那会让同一个动作出现两种写法。
  //
  // ## 句子里的链接要留住
  //
  // 这句话里有链接，而链接里装的正是它的宾语：豆列名、作品名、相册。
  // 只留文字的话，「上传了 1 张照片到 宝可梦明亮珍珠 的 相册」在站点上就是一句
  // 点不动的话——而那三个词在豆瓣上都是可以点的。
  //
  // 所以除了那句**给人看的整句**（`action`，`ACTION_STATUS` 也要按它精确查表），
  // 再给一份**结构化的分段**。这与 `bundle/1.4` 给缺口配 `detail` + `url` 是同一个
  // 形状，理由也一样：拿整句去做子串匹配把链接对回去，靠的是两边的实体解码分毫不差，
  // 而**对不上时是静默的**——链接不出现，没有任何报错。
  //
  // **不变量：`parts.map((p) => p.text).join('') === action`。** 有它，下游重建
  // 带链接的句子不需要任何匹配；没它，这个字段就只是又一次子串匹配。测试钉着它。
  //
  // 只在**真有链接**时才给 `parts`：3423 条广播里带链接的只有 90 条，其余全给一份
  // 单段数组只是把同一句话存两遍。
  const raw = rest.slice(0, Math.min(...stops));

  /** 一段：去标签解实体、把空白折成单个空格，**首尾的空白保留**（拼回去要靠它）。 */
  const chunk = (x) => stripTagsAndDecode(x).replace(/\s+/g, ' ');

  /** @type {{text: string, url?: string}[]} */
  const parts = [];
  let cursor = 0;
  for (const m of raw.matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) {
    if (m.index > cursor) parts.push({ text: chunk(raw.slice(cursor, m.index)) });
    // href 只解实体，不去标签：真实页面里有 `?icn=status_board&amp;cate=`。
    parts.push({ text: chunk(m[2]), url: decodeEntities(m[1]) });
    cursor = m.index + m[0].length;
  }
  if (cursor < raw.length) parts.push({ text: chunk(raw.slice(cursor)) });

  // 跨段也要折叠：`到豆列 ` 后面接 ` 游戏购买小账本` 会拼出两个空格，而整句折叠
  // 只会有一个——不处理的话上面那条不变量就不成立。
  for (let i = 1; i < parts.length; i += 1) {
    if (parts[i - 1].text.endsWith(' ') && parts[i].text.startsWith(' ')) {
      parts[i].text = parts[i].text.slice(1);
    }
  }
  if (parts.length) {
    parts[0].text = parts[0].text.replace(/^ /, '');
    const last = parts[parts.length - 1];
    last.text = last.text.replace(/ $/, '').replace(/\s*[:：]$/, '');
  }
  const kept = parts.filter((x) => x.text !== '');
  const s = kept.map((x) => x.text).join('');

  if (!s) return null;
  return kept.some((x) => x.url) ? { action: s, parts: kept } : { action: s, parts: null };
}

/**
 * @param {string} html
 * @param {string} ownerUserId  档案主人的数字 id。**必需**——没有它就分不清哪些是转发来的
 * @returns {{broadcasts: RawBroadcast[], skippedOthers: number, idless: number, unresolvedImages: number}}
 */
export function extractBroadcasts(html, ownerUserId) {
  if (typeof html !== 'string') return { broadcasts: [], skippedOthers: 0, idless: 0, unresolvedImages: 0 };
  if (!ownerUserId) throw new Error('extractBroadcasts 需要 ownerUserId，否则会把别人的广播也存下来');

  const at = [];
  const re = new RegExp(WRAPPER.source, 'g');
  for (let m = re.exec(html); m; m = re.exec(html)) at.push(m.index);

  /** @type {RawBroadcast[]} */
  const broadcasts = [];
  const seen = new Set();
  let skippedOthers = 0;
  let idless = 0;
  let unresolvedImages = 0;

  for (let i = 0; i < at.length; i++) {
    const seg = html.slice(at[i], i + 1 < at.length ? at[i + 1] : undefined);

    const uid = /data-uid="(\d+)"/.exec(seg);
    if (!uid || uid[1] !== String(ownerUserId)) { skippedOthers += 1; continue; }

    const sid = /data-sid="(\d+)"/.exec(seg);
    if (!sid) {
      // 有时间戳却没有 sid —— 抽取器跟不上页面了。要报。
      if (/class="created_at"/.test(seg)) idless += 1;
      continue;
    }
    // 头插列表翻页会让同一条广播出现在相邻两页上。实测 3386 个 wrapper / 3382 个
    // 唯一 sid——重复是正常的，不是错误。
    if (seen.has(sid[1])) continue;
    seen.add(sid[1]);

    const photos = extractImages(seg);
    unresolvedImages += photos.unresolved;
    const fullText = fullTextUrl(seg);

    const act = actionSentence(seg);
    const action = act?.action ?? null;
    // **先切出 blockquote，再在里面找第一个 `<p>`。**
    //
    // 原来是一条正则直接要求 `<blockquote>` 后面紧跟着 `<p>`：
    //
    //     /<blockquote[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/
    //
    // 而带评分的广播在两者之间还夹着一个评分星：
    //
    //     <blockquote>
    //       <span class="rating-stars">★★★★★</span>
    //       <p>7月2号首发玩起了，非常不错！</p>
    //     </blockquote>
    //
    // 于是**凡是打了分的广播，正文一律抽不到**。实测 2200 条有正文的广播里漏掉
    // 1411 条（64%），而漏掉的那 1411 条**每一条**都是带评分的——不是零星漏网，
    // 是一整类。
    //
    // 它一句告警都没有：`text: null` 与「这条广播本来就没写字」长得一模一样，
    // 而后者本来就占多数（纯标记动作），所以数字上也看不出异常。
    //
    // 广播是这份档案里最不可替代的东西（发布即冻结，是首次抓取之前那些编辑的
    // 唯一证据）。字节一直都在 WARC 里，改这一处重跑就全回来了。
    const blockquote = /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/.exec(seg)?.[1] ?? null;
    // **发这条广播时给的星数。** 与标记页那个分不是一回事，这正是它值钱的地方：
    // 标记只留最新那个（改一次覆盖一次，豆瓣不留历史），而广播发布即冻结，
    // 所以这是「那一天我给了几颗星」。同一部作品的几条广播排开，就是一份
    // **豆瓣自己都没有**的评分变化史。实测 3401 条里 1447 条带评分。
    //
    // **数星星，不解析文案**：页面上是 `&#9733;` 这样的实体，不是数字。
    // 没打分就是 null——0 星和没打分是两件事。
    const stars = blockquote
      ? (/<span class="rating-stars">([\s\S]*?)<\/span>/.exec(blockquote)?.[1] ?? null)
      : null;
    const rating = stars ? ((stars.match(/&#9733;|★/g) ?? []).length || null) : null;
    let quote = blockquote ? (/<p[^>]*>([\s\S]*?)<\/p>/.exec(blockquote)?.[1] ?? null) : null;
    // 「（全文）」是豆瓣的链接文字，**不是用户写的字**，所以不进正文——
    // 与「未知作品」「1740人浏览」「暂无封面」是同一条规则：占位符不是内容。
    // 截断这件事本身记在 fullTextUrl 上，不靠正文末尾的字来表达。
    if (quote && fullText) quote = quote.replace(/<a href="[^"]*"[^>]*>（全文）<\/a>\s*$/, '');

    broadcasts.push({
      sid: sid[1],
      // 秒级。**比标记页的日期精确**，合并同一条记录的观测时不得用低精度覆盖它。
      postedAt: /class="created_at"[^>]*title="([^"]+)"/.exec(seg)?.[1] ?? null,
      // 正文原样保留，只把标签剥掉——里面常有链接（`douc.cc` 短链）与表情。
      text: quote ? stripTags(quote) : null,
      action,
      // **句子里那几个链接。** 没有链接时是 null，不是空数组：3423 条广播里只有
      // 90 条带链接，其余给一份单段数组等于把同一句话存两遍。
      actionParts: act?.parts ?? null,
      status: action ? (ACTION_STATUS[action] ?? null) : null,
      rating,
      targetType: /data-target-type="(\w+)"/.exec(seg)?.[1] ?? null,
      targetId: /data-object-id="(\d+)"/.exec(seg)?.[1] ?? null,
      // 卡片上那个作品名。**广播发布即冻结，所以这也是那一刻的名字。**
      //
      // 实测这份档案里 162 条广播指向一个本地没有的条目（条目被豆瓣删了，或者
      // 豆列 / 关注榜单这类根本不产生标记的东西）。页面上它们只剩「想看」两个字
      // 后面空着，看起来像抓漏了——**而名字一直就在卡片里**，只是没人去取。
      //
      // 取 `block-subject` 里那个 `.title` 的链接文字。**必须在条目容器切片里取**：
      // 整页扫的话会取到别人那条转发的标题（第三方内容藏在自己的页面里，
      // 这个项目已经踩过三次）。
      targetTitle: cardTitle(seg),
      url: /data-status-url="([^"]+)"/.exec(seg)?.[1] ?? null,
      // **空数组，不是 null。** 广播页整个抓到了，就等于看清了「这条有没有图」——
      // 这与「没抽到」是两回事。null 会让下游分不清「确认没有」和「没看过」。
      images: photos.urls,
      // 被截断时记下全文在哪。**不记的话档案里存的是半截正文，而且没有任何
      // 字段说它是半截的**——读者无从分辨，这与「浏览计数进正文」是同一类错：
      // 不报错，只是让档案说了假话。
      fullTextUrl: fullText,
    });
  }

  return { broadcasts, skippedOthers, idless, unresolvedImages };
}

/**
 * 广播卡片上的作品名。
 *
 * 结构（实测）：
 *
 *     <div class="block block-subject">
 *       <div class="pic"><a title="莫阿娜 Moana (2026)" …><img …></a></div>
 *       <div class="content"><div class="title"><a …>莫阿娜 Moana (2026)</a></div>
 *
 * 取 `.title` 里的链接文字，不取 `title=` 属性——属性里那个在有些卡片上带着多余的
 * 后缀，而链接文字就是页面上显示的那几个字。
 *
 * @param {string} seg 一个条目容器的切片
 * @returns {string|null}
 */
function cardTitle(seg) {
  // **任何一种卡片，不只是作品卡。** 作品是 `block-subject`，而关注榜单是
  // `chart-block`——只认前者的话，「关注榜单：」后面就一直是空的。
  const at = /<div class="block[^"]*"/.exec(seg)?.index ?? -1;
  if (at < 0) return null;
  const title = /<div class="title">([\s\S]*?)<\/div>/.exec(seg.slice(at))?.[1];
  if (!title) return null;
  // **只认链接文字。** 条目被豆瓣移除时卡片是 `block-subject ban`，标题位置上是
  // 一段没有链接的「未知条目」——那是占位符，与「未知作品」「暂无封面」同一条规则：
  // 占位符不是内容。存下来的话，档案就替豆瓣说了一句它自己都没说的话。
  const m = /<a\b[^>]*>([\s\S]*?)<\/a>/.exec(title);
  if (!m) return null;
  return stripTagsAndDecode(m[1]).replace(/\s+/g, ' ').trim() || null;
}

/** 剥标签，保留文字。**不做任何归一化**——空白与全半角都是内容的一部分。 */
function stripTags(s) {
  return stripTagsAndDecode(s).trim() || null;
}
