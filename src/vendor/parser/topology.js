/* 【自动同步，请勿手改】来自 doubak-data-parser 的 src/topology.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/**
 * 一个目录里的这些档案，是不是该被一起解析。
 *
 * ## 为什么不是「选一条链来解析」
 *
 * 档案确实是成链的（`previous_bundle_id`，以及每条路线各自的
 * `floor_from_bundle_id`），而一个目录里出现多个根、出现分叉，都是很正常的事——
 * 删掉一份重抓、换台机器、同一天跑两次增量，都会分叉。
 *
 * 但**分叉不是矛盾**。捕获是带时间戳的观测：两条分支只是同一个账号的两批观测，
 * 合并起来是信息更多，不是信息打架。解析器本来就是对全集的纯函数，且
 * 追加是纯增的、顺序无关（canonical/INGESTION.md §5.1、§5.2）。
 *
 * 实测那八份档案，恰好就是两个根（一条 7 份的链 + 一份独立的全量重抓）：
 *
 *     只解析那条链    标记 2940（修订 2943）· 长文 4
 *     只解析那一份    标记  155（修订  155）· 长文 5
 *     八份一起        标记 2940（修订 2943）· 长文 5      ← 恰好是并集
 *
 *     标记观测 3863 + 155 = 4018，一次不多一次不少
 *     修订数仍是 2943 —— 多出来的 155 次观测**没有凭空产生一条修订**
 *
 * 也就是说：挑任何一条链都会丢东西（挑链丢那篇新日记，挑那一份丢 2785 条标记），
 * 而合并既不丢也不重。所以这个模块**不做取舍，只做体检**。
 *
 * ## 那什么才是真该拦下来的
 *
 * 不是分叉，是**这些档案根本不属于同一份存档**：
 *
 *   - 账号不同 —— 把两个人的档案合进同一份 canonical。这个必须拦死。
 *   - 地板指向的那份档案不在目录里 —— 增量只看了地板以上，地板以下那段谁也没看过。
 *     这是个真实的覆盖空洞，而它**看起来一切正常**：条数、连续性、告警全是好的。
 */

/**
 * @param {Array<{bundleId: string, manifest: object|null}>} sources
 * @returns {{
 *   accounts: string[], roots: string[], forks: Array<{parent: string, children: string[]}>,
 *   danglingFloors: Array<{bundle: string, routeKey: string, missing: string}>,
 *   bundles: number,
 * }}
 */
export function topology(sources) {
  const ids = new Set(sources.map((s) => s.bundleId));
  const accounts = new Set();
  const roots = [];
  /** @type {Map<string, string[]>} */
  const children = new Map();
  const danglingFloors = [];

  for (const s of sources) {
    const m = s.manifest;
    const uid = m?.account?.user_id;
    // **没有 manifest 不等于不能读**（INGESTION.md §2.3）。这里只收集能收集的，
    // 缺 manifest 的档案在别处已经按「结论受限」处理了。
    if (uid) accounts.add(String(uid));

    const prev = m?.previous_bundle_id ?? null;
    if (prev) {
      if (!children.has(prev)) children.set(prev, []);
      children.get(prev).push(s.bundleId);
    } else {
      roots.push(s.bundleId);
    }

    for (const cs of m?.crawl_state ?? []) {
      const from = cs.floor_from_bundle_id;
      if (from && !ids.has(from)) {
        danglingFloors.push({ bundle: s.bundleId, routeKey: cs.route_key, missing: from });
      }
    }
  }

  const forks = [...children]
    .filter(([, kids]) => kids.length > 1)
    .map(([parent, kids]) => ({ parent, children: kids.sort() }));

  return {
    accounts: [...accounts].sort(),
    roots: roots.sort(),
    forks,
    danglingFloors,
    bundles: sources.length,
  };
}

/**
 * 混了不同账号就**直接报错**，不是告警。
 *
 * 告警是「你可能想看一眼」，而这件事没有「可能」：两个人的标记合进同一份
 * canonical 之后，从产出里再也分不开——身份键里带账号的那部分只在退化层用得上，
 * 有 `data-cid` 的那一半根本不看账号。
 *
 * 而它太容易发生了：把两次导出解压到同一个下载目录就够了。
 *
 * @param {ReturnType<typeof topology>} t
 */
export function assertSingleAccount(t, opts = {}) {
  if (t.accounts.length <= 1) return null;
  const msg = `这个目录（含子目录）里混着 ${t.accounts.length} 个账号的档案`
    + `（${t.accounts.join('、')}）。一起解析会把它们合进同一份 canonical，而且事后分不开。`;
  // **绕过是给「我知道这是同一个人的两个账号」准备的，不是给「先跑起来再说」。**
  // 所以它不让消息消失，只是把停下来换成说出来——一句被读到的告警，
  // 和一次读不到的静默合并，代价差着一个量级。
  if (opts.ignoreWarnings) return `${msg}（--ignore-warnings 让它继续了）`;
  throw new Error(`${msg}请分开放，或者确认它们真的属于同一个人之后加 --ignore-warnings。`);
}
