/* 【自动同步，请勿手改】来自 doubak-export-adapters 的 src/record.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/**
 * 一条 canonical 记录怎么读——**只有这两件事，而且不碰任何内建模块。**
 *
 * ## 为什么从 canonical.js 里拆出来
 *
 * 那个文件干两件事：读目录（`node:fs`），和读记录（纯计算）。扩展要的是后者
 * ——它的 canonical 是刚在内存里解析出来的，压根没有目录可读——而只要还在同
 * 一个文件里，import 它就等于 import `node:fs`，在浏览器里直接加载失败。
 *
 * 这跟解析器那边的划法是同一条：**「字节从哪儿来」各写各的，「字节怎么解释」
 * 只有一份。** 后者错了两边一起错，才是要防的；前者本来就该不同。
 *
 * ## 「最后一条」按 `last_observed_at` 取，不按数组下标
 *
 * 解析器是按顺序追加的，下标取最后一条今天就是对的。但那是解析器的实现细节，
 * 不是 canonical 规定的次序；照下标取等于把一条没写进 spec 的保证当成保证。
 * 按时间取多花不了什么，而且错了会明显（时间倒退），不会静默。
 */

/**
 * 取一条记录的当前状态（最后一次观测到的那条 revision）。
 * @param {{revisions?: object[]}} record
 * @returns {object|null} revision，没有 revision 时是 null
 */
export function latest(record) {
  const revs = record?.revisions;
  if (!Array.isArray(revs) || revs.length === 0) return null;
  let best = revs[0];
  for (const r of revs) {
    if ((r.last_observed_at ?? '') >= (best.last_observed_at ?? '')) best = r;
  }
  return best;
}

/** 当前状态的 `fields`，永远返回一个对象，省得每个调用点都判空。 */
export function fieldsOf(record) {
  return latest(record)?.fields ?? {};
}
