/**
 * 覆盖率页「合起来」那个视角里，每一行怎么写。
 *
 * ## 为什么单独一个纯函数模块
 *
 * 与 `capture-label.js` 是同一个理由：埋在面板里就没法测，而这里要回答的问题
 * **很容易悄悄答错**——增量之后，「实抓 3 条」可能完全正常（那只是这次新增的），
 * 而「完整」是整条**链**的属性。把两者混起来，用户会对着一个正常的数字以为出事了，
 * 或者对着一条断掉的链以为没事。
 *
 * ## 刻意不提供「合起来一共抓了多少」
 *
 * 下界比较是**闭区间**（宁可重复不可遗漏），所以相邻两份档案在边界上必然重叠。
 * 把各份的 `captured` 加起来会比真实条目数多，而多多少取决于边界那一秒有几条——
 * 一个**看起来精确、实际没有意义**的数字。
 *
 * 而这一页存在的全部理由就是那句话：**计数不能证明完整性，连续性才能**。所以
 * 这里的主角是区间与连续性，声称数量只作线索。
 */

import { routeName, contiguityLabel } from './route-names.js';

/** 只取日期。区间显示到天就够，精确到秒是噪音。 */
function day(s) {
  return s ? String(s).slice(0, 10) : null;
}

/**
 * 一条路线在链上的那一行。
 *
 * @param {{routeKey: string, oldest?: string | null, newest?: string | null,
 *          bundles?: string[], contiguous?: boolean, holes?: Array<object>}} r
 */
export function chainRow(r) {
  const o = day(r.oldest);
  const n = day(r.newest);
  return {
    name: routeName(r.routeKey),
    // 没有时间水位线的路线（作品详情页）在这里是**不适用**，不是「没抓到」。
    // 写成「—」会被读成后者，而那是两件完全不同的事。
    span: o && n ? `${o} ─ ${n}` : null,
    spanNote: o && n ? null : '不适用（这条线没有时间水位线）',
    bundles: r.bundles?.length ?? 0,
    verdict: contiguityLabel({
      contiguous: Boolean(r.contiguous),
      settled: true,
      gaps: r.holes ?? [],
    }),
  };
}

/**
 * 整条链的一句话概括。
 *
 * @param {Array<object>} bundles  从新到旧
 */
export function chainHeadline(bundles) {
  if (!bundles?.length) return '还没有收尾的档案。';
  if (bundles.length === 1) return '只有 1 份档案 —— 还没有增量。';
  return `合起来 ${bundles.length} 份档案，从最近的一份往回接。`;
}

/**
 * 链断了那句话。
 *
 * **不能因此说在场的那几份无效**——它们各自抓到的东西照样有效，只是「从今天连续
 * 回溯到 X」这句话不再成立。措辞要把这两件事分开，否则用户会以为档案坏了。
 *
 * @param {{routeKey: string, missing: string, kind: string, detail: string}} h
 */
export function holeText(h) {
  return `${routeName(h.routeKey)} · 链断了`;
}
