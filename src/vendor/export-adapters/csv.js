/* 【自动同步，请勿手改】来自 doubak-export-adapters 的 src/csv.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/**
 * CSV 写出器（RFC 4180）。
 *
 * ## 为什么不用「拼字符串然后 split(',') 检查一下」
 *
 * 导出的每一行里都有**用户自己写的字**：短评、影评、豆列评语、标签。这些字里有
 * 逗号、有引号、有换行。写坏一个字段不会报错，只会让那一行错位——而 CSV 错位的
 * 表现是「后面的字段整体挪一格」，导进去之后评分变成日期、评语变成标签，
 * **看着像是数据本来就那样。**
 *
 * 这是站点生成器上踩过的同一类坑（用户文本进 Markdown 前必须转义），换了个容器
 * 而已。规则同样只有一条：**用户文本永远走这里，不许在别处拼。**
 *
 * ## 三条约定，三个都是踩得到的
 *
 * - **不写 BOM。** NeoDB 的导入用 Python `csv.DictReader` 直接读，BOM 会让第一个
 *   表头变成 `﻿title`，于是**每一行的第一列都读不到**，而且不报错。
 * - **换行用 CRLF。** RFC 4180 就是这么写的，三个平台的读取端都按通用换行处理。
 * - **null 写成空字符串，不是 "null"。** JS 里 `String(null)` 是 `'null'` 四个字母，
 *   进了「我的评分」那一列就是一个非法值。
 */

/**
 * 一个字段。需要引号的时候才加引号——不必要的引号不会出错，但会让人在文本编辑器里
 * 看不清哪些是真的带了逗号。
 * @param {unknown} value
 * @returns {string}
 */
export function csvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (!/[",\r\n]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * 一整张表。
 * @param {string[]} header
 * @param {unknown[][]} rows
 * @returns {string}
 */
export function csv(header, rows) {
  const out = [header.map(csvField).join(',')];
  for (const row of rows) out.push(row.map(csvField).join(','));
  return out.join('\r\n') + '\r\n';
}
