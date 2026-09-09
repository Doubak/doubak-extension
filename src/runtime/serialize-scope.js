/**
 * `Map` 过不了 JSON 边界（会变成 `{}`），拆成数组对再传。
 *
 * 这类「结构在边界上被静默拍平」不会报错，只会让下界变成空的——于是一次本该
 * 到某天为止的增量抓取变成全量重抓。
 *
 * ## 为什么它单独一个文件
 *
 * 两个宿主都要它，而它必须**不把任何一个宿主拉进来**：`host.js` 只加载挑中的
 * 那一个实现，从它这儿 re-export 一个住在某个实现文件里的函数，等于把两个实现
 * 都拖进来——正是那个动态 import 要避免的事。
 *
 * Firefox 那条路其实不需要序列化（直接调函数，`Map` 原样过），但**照样走同一份**：
 * 让一个宿主看到 `Map`、另一个看到数组对，就是给「两边行为分岔」开了个口子，
 * 而这类分岔是静默的。
 *
 * @param {object} options
 */
export function serializeScope(options = {}) {
  const o = { ...options };
  if (o.floors instanceof Map) o.floors = [...o.floors];
  return o;
}
