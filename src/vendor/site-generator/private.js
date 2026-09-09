/* 【自动同步，请勿手改】来自 doubak-site-generator 的 src/private.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/**
 * 豆瓣上不公开的东西，以及站点默认怎么处置它们。
 *
 * ## 起因：一篇私密日记的全文上了样张站的首页
 *
 * 09-07 给**日记**补了 `visibility` / `restricted_by`，站点也照着做了。漏掉的是
 * 另外两种记录：
 *
 * - **广播。** 豆瓣发一篇私密日记时会同步一条广播，正文一字不差，而抓取跑在用户
 *   自己的登录态下，所以那条只有他自己看得见的广播照样进了档案。站点默认全发，
 *   于是那篇日记的正文出现在 `broadcast/2026-09.html`、广播索引和**首页**上——
 *   而日记本身那一页当时是不是发出去了，根本不重要：**内容从旁边那条路漏了出去。**
 * - **豆列。** `visibility: private` 早就在 canonical 里了（`extract-doulist.js`
 *   一直在读），站点这一侧从来没看过它。
 *
 * 一般化的那句：**一条规则只在它被写下的那个记录类型上生效，而内容会从别的类型
 * 上漏出去。** 这个文件里已经记过同一形状好几次（`<span class="comment">` 是电影
 * 专用、又名只在详情页、导出那边晚了三天才跟上删掉再重标）。
 *
 * ## 默认值：不发；`--include-private` 才发，且带 🔒
 *
 * 这翻转了 09-07 那个「站点默认全发」的默认值，理由是那次没料到的这条旁路：
 * 当时的论证是「不发 = 这一页在网上不存在，没有一个同样安全的动作」，而那只考虑了
 * 日记**自己那一页**。内容能从广播漏出去之后，「发」的那一侧多了一个此前不存在的
 * 代价——用户以为自己藏住了，实际没有。
 *
 * **豆瓣锁掉的那一类仍然默认发**，09-07 的理由一字未变：它之所以不公开，恰恰因为
 * 它曾经是公开的，跟着豆瓣一起收起来这份存档就白存了。所以这里分三栏而不是一个
 * 布尔值——与导出适配器那边完全一致。
 */

/** `--drop-notes` 认得的三栏。 */
export const DROPPABLE = ['author', 'platform', 'unsure'];

/** 默认就不发的那几栏。**`platform` 不在里面**，见文件头。 */
export const PRIVATE_BY_DEFAULT = ['author', 'unsure'];

/** @param {object} rec @returns {object} 最后一版的 fields */
const last = (rec) => rec?.revisions?.[rec.revisions.length - 1]?.fields ?? {};

/**
 * 一条长文属于哪一栏。评论恒为 `null`（豆瓣没给评论私密这个设置），不进任何一栏。
 *
 * @param {object} rec @returns {'public'|'author'|'platform'|'unsure'}
 */
export function noteBucket(rec) {
  if (rec.kind !== 'note') return 'public';
  const f = last(rec);
  if (f.visibility === 'public') return 'public';
  if (f.visibility === 'private') return f.restricted_by === 'platform' ? 'platform' : 'author';
  // `unknown`、以及 0.12.0 之前没有这个字段的老 canonical。**都不当作公开**——
  // 把「认不出来」并进「公开」是这条链路上最坏的方向。
  return 'unsure';
}

/**
 * 这份 canonical 到底知不知道某一类记录的可见性。
 *
 * **这是把「认不出来」和「压根没这个字段」分开的判据，而两者的正确处置相反。**
 *
 * 日记那边「缺字段 → 当私密」是安全的，因为一份档案里日记只有几篇。广播不是：
 * 0.13.0 之前生成的 canonical 里**每一条**广播都没有这个字段，照那条规则办
 * 就是把整条时间线（实测 3429 条）从站点上全部抹掉——一个破坏性大到没人敢用的
 * 默认值，等于没有这个默认值。
 *
 * 判据是**整个数据集**：只要有任意一条带着非 null 的可见性，就说明解析器读过它，
 * 那么剩下的 null 是「这一条认不出来」，按私密处理（少见、且安全）。一条都没有，
 * 就说明这份 canonical 根本没有这个信息，**不猜**——照发，并让上层报出来请人重跑
 * 解析器。与导出适配器那边 `legacy` / `unrecognized` 分开报是同一条。
 *
 * @param {object[]} recs @returns {boolean}
 */
export const privacyKnown = (recs) => (recs ?? []).some((r) => last(r).visibility != null);

/**
 * 一条广播是不是只有作者本人看得见。
 *
 * **没有 `restricted_by` 可分**：豆瓣不在广播上出面说明理由，页面上只有一个 class。
 * 所以私密广播一律按「作者自己藏的」处置——这是安全的那一边，而且实测唯一一条
 * 私密广播正是作者自己设的私密日记同步出来的。
 *
 * @param {object} rec @returns {boolean}
 */
export const broadcastIsPrivate = (rec) => last(rec).visibility !== 'public';

/** @param {object} rec @returns {boolean} */
export const doulistIsPrivate = (rec) => last(rec).visibility !== 'public';

/**
 * 这份 canonical 里不公开的东西，按记录类型点名。
 *
 * **只点名，不筛选**——筛选是 `withoutPrivate()` 的事，而部署预演要能把两边都印
 * 出来：铺进仓库是不可逆的，而预演是它前面唯一一道。
 *
 * @param {{longform?: object[], broadcasts?: object[], doulists?: object[]}} canonical
 */
export function privateContent(canonical) {
  /** @type {{author: object[], platform: object[], unsure: object[]}} */
  const notes = { author: [], platform: [], unsure: [] };
  for (const rec of canonical.longform ?? []) {
    const b = noteBucket(rec);
    if (b === 'public') continue;
    const f = last(rec);
    notes[b].push({ title: f.title ?? '(无标题)', id: rec.upstream_id, notice: f.restriction_notice ?? null });
  }
  // 不知道可见性时点名是**假的**：老 canonical 里每一条都会被列出来。
  // 那种情况下报的应当是「这份 canonical 没有这个信息」，不是「这 3429 条是私密的」。
  const bcKnown = privacyKnown(canonical.broadcasts);
  const dlKnown = privacyKnown(canonical.doulists);
  return {
    notes,
    doulists: dlKnown
      ? (canonical.doulists ?? []).filter(doulistIsPrivate)
        .map((r) => ({ title: last(r).title ?? '(无标题)', id: r.upstream_id }))
      : [],
    broadcasts: bcKnown
      ? (canonical.broadcasts ?? []).filter(broadcastIsPrivate)
        .map((r) => ({ id: r.upstream_id, text: last(r).text ?? null }))
      : [],
    // 上层要照实说「这一份根本没有这个信息，重跑一次解析器」，而不是说「都没有私密的」。
    unknownPrivacy: [
      ...(bcKnown || !(canonical.broadcasts ?? []).length ? [] : ['broadcasts']),
      ...(dlKnown || !(canonical.doulists ?? []).length ? [] : ['doulists']),
    ],
  };
}

/**
 * 去掉默认不发的那些，返回一份新的 canonical。
 *
 * **原对象一个字不改**：调用方（`bin/deploy.js`）还要拿原始那份去印预演。
 *
 * @param {object} canonical
 * @param {{includePrivate?: boolean, dropNotes?: string[]}} [opts]
 *   `includePrivate` 为真时，默认那几栏照发（由主题打上 🔒）；`dropNotes` 是额外
 *   再去掉哪几栏，两者方向相反：一个放宽，一个收紧。
 */
export function withoutPrivate(canonical, { includePrivate = false, dropNotes = [] } = {}) {
  const drop = new Set(dropNotes.includes('all') ? DROPPABLE : dropNotes);
  // `--include-private` 只解开**默认**那几栏；用户显式写进 `--drop-notes` 的仍然去掉。
  // 显式压过默认，否则那个开关会替用户推翻他刚说过的话。
  const buckets = new Set([...(includePrivate ? [] : PRIVATE_BY_DEFAULT), ...drop]);
  const out = { ...canonical };
  if (buckets.size) {
    out.longform = (canonical.longform ?? []).filter((r) => !buckets.has(noteBucket(r)));
  }
  // **这份 canonical 不知道可见性时，一条都不筛。** 见 `privacyKnown` 的说明：
  // 老 canonical 里每一条都是 null，照「null 当私密」办就是清空整个站点。
  if (!includePrivate) {
    if (privacyKnown(canonical.broadcasts)) {
      out.broadcasts = (canonical.broadcasts ?? []).filter((r) => !broadcastIsPrivate(r));
    }
    if (privacyKnown(canonical.doulists)) {
      out.doulists = (canonical.doulists ?? []).filter((r) => !doulistIsPrivate(r));
    }
  }
  return out;
}
