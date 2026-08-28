/* 【自动同步，请勿手改】来自 doubak-data-parser 的 src/html-entities.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/**
 * HTML 实体解码。**整个解析器只有这一份。**
 *
 * ## 为什么要有这个文件
 *
 * 原来四个抽取器各写各的：`extract-subject.js` 认八种，`extract-longform.js` 认六种，
 * `extract-broadcast.js` 的 `stripTags` 认五种，而 `extract.js`（标记列表页，也就是
 * 标题和短评的来源）**一种都不认**。
 *
 * 后果在生成的站点上看得见。canonical 里留着没解开的实体：
 *
 * ```
 * "comment": "感谢up主“半支烟&#34;的解说…"
 * "…纸上&lt;传奇&gt;，依旧是很怀念的回忆。"
 * "n": "木乃伊 / Lee Cronin&#39;s The Mummy"
 * ```
 *
 * 站点生成器那边是对的——用户写的文本进 Markdown 之前必须转义，所以它把 `&` 转成
 * `&amp;`，于是 `&#34;` 变成 `&amp;#34;`，**在页面上原样显示成 `&#34;`**。
 * 两边各做各的对事，合起来是错的：漏解一次，就会被下游忠实地展示出来。
 *
 * ## 一遍扫完，不是链式 replace
 *
 * 四份旧实现有同一个 bug：`&amp;` 排在最前面解。于是
 *
 * ```
 * &amp;lt;   →（先解 &amp;）→   &lt;   →（再解 &lt;）→   <
 * ```
 *
 * 而 `&amp;lt;` 的原文是**字面的 `&lt;` 四个字符**——用户在短评里讨论 HTML 转义时
 * 就会写出这个。链式解码把它变成了一个尖括号，之后再也还原不回去。
 *
 * 这里改成一次 `replace`，每个实体只被看一眼，级联不可能发生。
 *
 * ## 认不出来的原样留着
 *
 * `&foo;` 不是已知实体，就让它继续是 `&foo;`。猜一个字符出来是不可逆的，而原样
 * 留着至少能在 canonical 里被 grep 到——这份档案的规矩是「可以晚点丢，不能先丢」。
 */

/**
 * 具名实体表。
 *
 * **只收豆瓣页面上真出现过的，加上 HTML 那五个必备的。** 一张抄全的 2231 条
 * WHATWG 实体表在这里不是「更完整」，而是更大的猜测面：多认一个，就多一处
 * 把用户原文里的 `&copy;` 悄悄改写成 `©` 的机会。要加就先在档案里量到它。
 */
const NAMED = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // U+00A0，不是普通空格。**照实解**：页面上写的就是不换行空格，把它改成 ' '
  // 是一次静默改写。需要归一化的是下游（搜索、Markdown），不是这里。
  nbsp: '\u00a0',
};

/** `&#34;` / `&#x22;` / `&amp;` / `&nbsp;` —— 一遍扫完。 */
const REF = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

/**
 * 把一段 HTML 文本里的实体解开。
 *
 * @param {string} s
 * @returns {string}
 */
export function decodeEntities(s) {
  if (typeof s !== 'string' || !s.includes('&')) return s;
  return s.replace(REF, (whole, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      // 代理区与超出 Unicode 的码位不是字符。原样留着，别造一个 U+FFFD 出来
      // ——那会把「页面上有个奇怪的东西」变成「这里本来就是替换字符」。
      if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff) return whole;
      if (cp >= 0xd800 && cp <= 0xdfff) return whole;
      return String.fromCodePoint(cp);
    }
    return Object.hasOwn(NAMED, body) ? NAMED[body] : whole;
  });
}

/**
 * 去标签 + 解实体，给「我只要这段的纯文本」的地方用。
 *
 * **顺序是先去标签再解实体**，反过来会把 `&lt;script&gt;` 解成 `<script>` 之后
 * 当成标签删掉——用户在短评里写的一段文字就此消失。
 *
 * @param {string} s
 * @returns {string}
 */
export function stripTagsAndDecode(s) {
  if (typeof s !== 'string') return s;
  return decodeEntities(s.replace(/<[^>]+>/g, ''));
}
