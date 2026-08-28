/* 【自动同步，请勿手改】来自 doubak-data-parser 的 src/extract-subject.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/**
 * 从作品详情页里抽东西。
 *
 * ## 这些页面此前一张都没被解析过
 *
 * 作品记录一直是从**列表页**攒出来的（标题、封面缩略图、那行没拆的元信息），
 * 而 2925 张详情页抓下来之后就躺在档案里没人读。`aliases` 字段早就在 schema 里，
 * 值却一直硬编码成 `null`。
 *
 * ## 为什么先做「又名」
 *
 * 因为它是**搜索时最有用、而别处又完全拿不到**的一项。实测抽查：
 *
 *     电影  150 张里 144 张有（96%）
 *     音乐  150 张里  73 张有（49%）
 *     书 / 游戏 / 舞台剧  0 —— 这几类页面上根本没有这一栏
 *
 * 而它装着的正是台译名、港译名、原文名：
 *
 *     重返沉默之丘(台) / 重返鬼魅山房 / 寂静岭2真人版
 *
 * 一个记得住《重返沉默之丘》却想不起《寂静岭2》的人，在没有又名的索引里
 * 什么都搜不到。
 *
 * ## 不猜语言
 *
 * CLAUDE.md 定死的：豆瓣的又名里混着粤语、台湾译名、英文、日文与各种转写，
 * **一个语言标记都没有**。所以这里存成一个无标注的字符串数组，`lang` 一律留空。
 * 猜语言属于 enricher——它的产出带 `source` 与置信度、可以重跑；解析器的产出会被
 * 当作「页面当时就是这么说的」，在这一层猜错等于把猜测冒充成观测，而源页面消失
 * 之后两者再也分不开。
 */

import { decodeEntities } from './html-entities.js';

/**
 * 抽 `#info` 里那一整块带标签的字段。
 *
 * ## 键用豆瓣自己的标签，原样存
 *
 * `{"导演": ["克里斯托夫·甘斯"], "制片国家/地区": ["美国", "德国"], …}`。
 *
 * **不翻译、不归一化、不跨媒介统一。** 电影的「导演」与书的「作者」是不是同一个
 * 概念，那是 enricher 的判断（它的产出带 source 与置信度、可以重跑）；解析器的
 * 产出会被当作「页面当时就是这么说的」。在这一层做映射，等于把猜测冒充成观测。
 *
 * ## 实测各媒介有什么（各抽 120 张）
 *
 *     电影  类型 100% · 制片国家/地区 100% · 语言 100% · 主演 99% · 导演 98%
 *           · IMDb 97% · 又名 96% · 编剧 95% · 上映日期 76% · 片长 76%
 *           （剧集另有 首播 / 集数 / 单集片长 / 季数）
 *     书    ISBN 100% · 作者 99% · 出版年 98% · 出版社 96% · 页数 93% · 定价 93%
 *           · 装帧 91% · 译者 43% · 原作名 38% · 丛书 30% · 出品方 18%
 *     音乐  发行时间 100% · 出版者 100% · 介质 98% · 专辑类型 93% · 唱片数 83%
 *           · 条形码 75% · 流派 74% · 又名 51%
 *     游戏 / 舞台剧  **没有 #info 这一块**，一个字段都没有
 *
 * ## 两条判据都是量出来的
 *
 * **① 必须限定在 `#info` 里。** `span.pl` 在页面别处还用来标评论区的用户名——
 * 整页扫会把几十个陌生人的 id 当成字段名存进档案主人的 canonical。
 * 这正是「第三方内容藏在你自己的页面里」那条。
 *
 * **② 单引号双引号都要认。** 导演 / 编剧 / 主演 用的是 `class='pl'`，其余用
 * `class="pl"`。只认双引号的话，恰好把最有价值的三个字段整个漏掉——而它
 * 不报错，只是那三行永远是空的。
 *
 * @param {string} html
 * @returns {Record<string, string[]>|null} 没有 #info 就是 null
 */
export function extractInfo(html) {
  if (typeof html !== 'string') return null;
  const info = sliceInfo(html);
  if (info === null) return null;

  /** @type {Record<string, string[]>} */
  const out = {};
  // 按 <br> 切成一行行。每行的形状是「标签 + 冒号 + 值」。
  for (const line of info.split(/<br\s*\/?>/i)) {
    const m = /<span[^>]*class=['"]pl['"][^>]*>\s*([^<:：]{1,20}?)\s*[:：]?\s*<\/span>([\s\S]*)/.exec(line);
    if (!m) continue;
    const label = m[1].trim();
    if (!label) continue;
    // 冒号有时在标签 span 里面（`<span class="pl">类型:</span>`），有时在外面
    // （`<span class='pl'>导演</span>: …`）。两种都得剥掉，否则值会变成「: 甲」。
    const value = splitList(decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/^\s*[:：]\s*/, ''));
    if (value.length) out[label] = value;
  }
  return out;
}

/**
 * 截出 `#info` 那个 div 的内容，**按 div 嵌套深度收尾**。
 *
 * 不能只截「到第一个 `</div>`」——`#info` 里面还嵌着别的 div；也不能截固定长度，
 * 那样会一路读进评论区。而评论区里的 `span.pl` 装的是**别人的用户名**：
 * 越界的话，几十个陌生人的 id 会变成字段名，存进档案主人的 canonical。
 * 这正是「第三方内容藏在你自己的页面里」那条，而它不报错。
 *
 * @param {string} html
 * @returns {string|null} 没有 #info 就是 null
 */
function sliceInfo(html) {
  const open = /<div[^>]+id=['"]info['"][^>]*>/.exec(html);
  if (!open) return null;

  const from = open.index + open[0].length;
  const tag = /<div\b[^>]*>|<\/div>/gi;
  tag.lastIndex = from;
  let depth = 1;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(from, m.index);
  }
  // 没闭合就取到末尾——**宁可多截也不返回 null**：返回 null 会让一整页的字段
  // 静默消失，而多截的那部分至少还会被下面的标签判据挡掉大部分。
  return html.slice(from);
}

/**
 * 按豆瓣的列表分隔符切开。
 *
 * **分隔符是 ` / `（两侧有空白），不是裸的 `/`。** 这一条是实测纠正的：第一版
 * 按裸斜杠切，把 `犯罪101(港/台)` 切成了 `犯罪101(港` 和 `台)`——`(港/台)` 是
 * 中文里「港译名／台译名相同」的常用写法，斜杠两侧没有空格。
 *
 * 实测 4022 张有又名的页面：裸切得 12246 条，按 ` / ` 切得 12070 条，
 * **差的 176 条全是被切坏的**。切坏的后果是档案里存着一个不存在的片名，
 * 而且看不出来。
 *
 * @param {string} raw
 */
function splitList(raw) {
  return raw.split(/\s+\/\s+/).map((x) => x.trim()).filter(Boolean);
}

/**
 * 抽「又名」。
 *
 * 它只是 `#info` 里的一项，单独拎出来是因为 canonical 给了它一个顶层字段——
 * 它是搜索里最有用的一项（台译名、港译名、原文名）。
 *
 * @param {string} html
 * @returns {string[]} 没有就是空数组
 */
export function extractAliases(html) {
  return extractInfo(html)?.['又名'] ?? [];
}

/**
 * 从详情页 URL 上反解 (媒介, 作品 id)。五种媒介五种形状。
 *
 * @param {string} url
 * @returns {{medium: string, id: string}|null}
 */
export function subjectRefOf(url) {
  if (typeof url !== 'string') return null;
  let m = /movie\.douban\.com\/subject\/(\d+)/.exec(url);
  if (m) return { medium: 'movie', id: m[1] };
  m = /book\.douban\.com\/subject\/(\d+)/.exec(url);
  if (m) return { medium: 'book', id: m[1] };
  m = /music\.douban\.com\/subject\/(\d+)/.exec(url);
  if (m) return { medium: 'music', id: m[1] };
  m = /douban\.com\/game\/(\d+)/.exec(url);
  if (m) return { medium: 'game', id: m[1] };
  m = /douban\.com\/location\/drama\/(\d+)/.exec(url);
  if (m) return { medium: 'drama', id: m[1] };
  return null;
}

/**
 * 详情页 → 能补进作品记录的东西。
 *
 * 目前只有又名。这个函数存在的意义是**给后续留个口子**：详情页上还有结构化的
 * 导演/编剧/主演、制片国家、语言、IMDb id ——都是列表页那行 `raw_meta` 里
 * 拆不出来的（实测电影 2090 条里出现过 43 种段数）。
 *
 * @param {string} html
 * @param {string} url
 */
export function extractSubjectDetail(html, url) {
  const ref = subjectRefOf(url);
  if (!ref) return null;
  const info = extractInfo(html);
  return { ...ref, info, aliases: info?.['又名'] ?? [] };
}
