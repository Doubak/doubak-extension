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

/**
 * 同一个作品被标记过两次时，只留现存的那一条。
 *
 * ## 为什么会有两条
 *
 * 用户在豆瓣上**删掉再重标**：豆瓣发一个新的条目 id，解析器据此如实分成两条记录
 * ——那是对的，canonical 是事件日志，它必须留着两条。站点生成器 2026-09-04 已经
 * 为同一件事做过一次（`projection.js` 的 `mergeReMarks`），这边当时没跟上。
 *
 * ## 但导出是当前状态，一个作品只能有一行
 *
 * 不合并的话，实测《盗梦空间》(`movie/3541415`) 导出了**两条 ShelfMember**，短评
 * 也对不上。而 NeoDB 那边一个作品只有一个书架条目，第二条会把第一条覆盖掉——
 * 谁覆盖谁由文件里的先后决定，不由任何判据决定。
 *
 * ## 判据是「最后一次看到它是什么时候」
 *
 * 豆瓣现在还留着的那条，才是最近一次抓取里出现过的。**按 `marked_at` 挑是错的**：
 * 补标一部老片可以有更早的日期，而它仍然是现存的那一条。
 *
 * 归组的键是 `(medium, subject.id)`——**豆瓣的 subject id 在不同媒介下会撞号**，
 * 只按 id 归会把两个不相干的作品并成一个。
 *
 * @param {object[]} marks
 * @returns {{marks: object[], superseded: number}} `superseded` 是被顶掉的条数
 */
export function mergeReMarks(marks) {
  /** @type {Map<string, object[]>} */
  const groups = new Map();
  for (const m of marks ?? []) {
    const key = `${m.medium}:${m.subject?.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  const seenAt = (m) => latest(m)?.last_observed_at ?? '';
  const markedAt = (m) => latest(m)?.fields?.marked_at?.iso ?? '';

  const out = [];
  let superseded = 0;
  for (const g of groups.values()) {
    if (g.length === 1) { out.push(g[0]); continue; }
    // 排序要是**全序**，否则同一份 canonical 读两次可能给出不同的结果——
    // 与 bundle 去重那次的教训一样。`last_observed_at` 相同就比 `marked_at`，
    // 再相同就比上游 id（它一定不同，两条记录正是因为 id 不同才分开的）。
    const sorted = [...g].sort((a, b) => {
      if (seenAt(a) !== seenAt(b)) return seenAt(a) < seenAt(b) ? 1 : -1;
      if (markedAt(a) !== markedAt(b)) return markedAt(a) < markedAt(b) ? 1 : -1;
      return String(a.upstream_id ?? '') < String(b.upstream_id ?? '') ? 1 : -1;
    });
    out.push(sorted[0]);
    superseded += sorted.length - 1;
  }
  return { marks: out, superseded };
}

/**
 * 把五个 ndjson 数组补成下游要的那个形状。
 *
 * ## 为什么这几行必须**只有一份实现**
 *
 * 读文件的 `loadCanonical()` 与扩展里读 OPFS 的 `withCanonicalShape()` 是
 * 「一条流水线，两个宿主」的那一对：**字节从哪来是各宿主的事，字节是什么意思
 * 只能有一份实现**。而 `subjectOf` / `multiRevisionMarks` / `account` /
 * 「删掉再重标并成一条」全是后者——它们不碰 I/O，只是从同一批记录里算出来的。
 *
 * 原来这几行在两边各写了一份，扩展那边的注释还写着「照抄它的定义，不要另发明」。
 * 2026-09-07 就漂了：命令行这边加了 `mergeReMarks`，扩展那边没有，于是同一份档案
 * 从扩展导出会多一条 `ShelfMember`（实测《盗梦空间》2 条）。**没有报错，包照样
 * 生成，导入照样成功**，只是 NeoDB 上那个作品的书架条目由文件里的先后决定。
 *
 * 一句注释拦不住这个，而 byte-copy 的 vendor 检查拦得住（两边的 CI 都跑它）。
 * 所以这里不是「再加一条测试」，是**把重复删掉**。
 *
 * @param {{marks: object[], subjects: object[], doulists: object[]}} out
 * @returns {object} 原样加上 `subjectOf` / `reMarkedSuperseded` / `multiRevisionMarks` / `account`
 */
export function canonicalShape(out) {
  // 作品数据按 `(medium, id)` 定位：豆瓣的 subject id 在不同 medium 下会撞号，
  // 只按 id 找会把一本书的又名安到一部电影上。
  const byKey = new Map();
  for (const s of out.subjects ?? []) byKey.set(`${s.medium}:${s.id}`, s);

  // 删掉再重标的并成一条 —— 见 `mergeReMarks`。**要在 `multiRevisionMarks` 之前**：
  // 那个数说的是「导出会把几条标记压平」，而被顶掉的那条已经不在导出里了。
  const merged = mergeReMarks(out.marks ?? []);

  return {
    ...out,
    marks: merged.marks,
    reMarkedSuperseded: merged.superseded,
    subjectOf: (mark) => byKey.get(`${mark.medium}:${mark.subject?.id}`) ?? null,
    multiRevisionMarks: merged.marks.filter((m) => (m.revisions?.length ?? 0) > 1).length,
    account: merged.marks[0]?.account ?? out.doulists?.[0]?.account ?? null,
  };
}
