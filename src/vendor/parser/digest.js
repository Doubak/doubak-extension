/* 【自动同步，请勿手改】来自 doubak-data-parser 的 src/digest.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/**
 * 逐字段摘要。
 *
 * 规范：canonical/v1/common.schema.json 的 `digest`
 *
 * ## 规范化只做四件事，别的都不做
 *
 * NFC、去掉尾部空白、统一换行、完。
 *
 * **绝不折叠简繁，绝不折叠大小写。** 那些是真实的编辑——把「臺灣」和「台湾」算成
 * 同一个，等于把用户的一次修改抹掉，而这套数据存在的理由就是留住那些修改。
 *
 * ## 必须逐字段算，不能整条算一个
 *
 * 否则改一次评分会让短评也看起来被重写过。而「这条评论什么时候改的」正是要回答的
 * 问题——生成出来的那个真实例子里，两版之间变了 status/marked_at/rating/comment/tags
 * 五个字段，没变的只有 raw_meta；整条一个摘要的话，这个区别就没了。
 *
 * ## 哈希用的是本仓库那份，不是 node:crypto
 *
 * 这个文件要能原样跑在浏览器扩展里（`sync-vendor.mjs` 会把它抄过去），所以
 * 不能 import 任何内建模块。理由与对拍办法见 `sha256.js`。
 */

import { sha256 } from './sha256.js';

/**
 * @param {unknown} value
 * @returns {string|null} `sha256:<64 位十六进制>`；value 为 null/undefined 时返回 null
 */
export function fieldDigest(value) {
  if (value === null || value === undefined) return null;

  // 结构化的值（标签数组、带精度的日期）先转成稳定的字符串。键要排序——
  // 否则 JSON 里键的顺序一变，摘要就变，而内容根本没动。
  const text = typeof value === 'string' ? value : JSON.stringify(value, sortedKeys(value));

  const norm = text
    .normalize('NFC')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\s+$/, '');

  return `sha256:${sha256(norm)}`;
}

/** JSON.stringify 的 replacer：把对象的键排序，让摘要与键序无关。 */
function sortedKeys(root) {
  return function replacer(_key, val) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return val;
  };
}

/**
 * 一整组字段的摘要。
 *
 * **键必须与 fields 一一对应**，包括值为 null 的那些——`{rating: null}` 与「没有
 * rating 这个键」是两件事（前者是"页面上确实没有"，后者是"这次没抽到"），摘要表
 * 要能把它们区分开。
 *
 * @param {Record<string, unknown>} fields
 * @returns {Record<string, string|null>}
 */
export function digestAll(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = fieldDigest(v);
  return out;
}

/**
 * 两组字段是不是同一版内容。
 *
 * 用摘要比而不是深比较：摘要是**规范化之后**的，所以尾部空白变化不会被误判成编辑。
 *
 * @param {Record<string, string|null>} a
 * @param {Record<string, string|null>} b
 */
export function sameRevision(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}
