/**
 * 链：从既有档案里挑出增量抓取的下界。
 *
 * 规范：bundle/v1 §5.5
 *
 * ## 为什么这是一个纯模块
 *
 * 挑下界这件事全部的复杂度都在**判断**上——哪一份能当基准、哪一条路线能、
 * 缺一环怎么办。而它一旦挑错，后果是**静默的**：下界定高了就漏抓，而漏掉的东西
 * 事后无从发现（那正是这个项目最怕的那种错）。
 *
 * 所以它不碰 OPFS、不碰网络，只吃一组 manifest 吐一组结论。调用方负责把 manifest
 * 读进来。
 *
 * ## 三条规则（都来自 §5.5）
 *
 * **① 下界按路线选，不按档案选。** `advanced` 是逐路线的：某条线可能因为有缺口
 * 而没能推进水位线，那时这条线要继续往回找，找不到就没有下界（从头重走）。于是
 * 同一次抓取里不同路线的下界可能来自**不同的档案**。
 *
 * **② 只认同一个账号，而且用户名也要一样。**
 *
 * 数字 ID 不同 = 是别人 —— 那会让你以为某段时间已经抓过了，而实际上抓的是别人的。
 * 账号切换在真实使用里会发生（多个豆瓣号），错误的方向是**漏抓**。
 *
 * 数字 ID 相同但**用户名改了**，也不接着抓。这一条需要解释，因为下界本身是没问题
 * 的（它是个**时间**，不是 URL，改名不影响它）。真正断掉的是别的东西：
 *
 *     https://www.douban.com/people/<用户名>/statuses?p=1
 *     https://movie.douban.com/people/<用户名>/collect
 *
 * **每一条路线的 URL 里都嵌着用户名。** 改名之后新抓取的 `url_key` 与旧档案里的
 * 全都对不上，于是跨档案去重（`Frontier.markCaptured`）失效、「同一页的历史版本」
 * 也拼不起来——而那两件事正是链存在的意义。
 *
 * 所以：**改名之后要重新打一份全量基准**。代价是一次全量，而改名是罕见事件；
 * 换来的是链上每一条 URL 都对得上。判错的方向也是安全的那一侧（多抓）。
 *
 * **③ 缺一环要说出来，不许当作连着。** 用户会删档案、会只搬走一部分。
 */

/**
 * @typedef {object} FloorPick
 * @property {string} floorTime         下界（RFC3339）
 * @property {string | null} floorRaw   下界的原始字符串（豆瓣给的那个）
 * @property {string} fromBundleId      这个下界取自哪一份
 * @property {string[]} boundaryIds     处于下界那一刻的条目 ID，供边界去重
 */

/**
 * 一份档案里我们关心的东西。调用方从 manifest 里摘出来。
 *
 * @typedef {object} ChainEntry
 * @property {string} bundleId
 * @property {string | null} completedAt
 * @property {string | null} accountUserId
 * @property {string | null} accountUsername
 * @property {string | null} previousBundleId
 * @property {Array<Record<string, any>>} crawlState
 */

/**
 * 把 manifest 摘成链需要的那几样。
 *
 * @param {Record<string, any>} manifest
 * @returns {ChainEntry}
 */
export function chainEntryFromManifest(manifest) {
  return {
    bundleId: manifest.bundle_id,
    completedAt: manifest.completed_at ?? null,
    accountUserId: manifest.account?.user_id ?? null,
    accountUsername: manifest.account?.username ?? null,
    previousBundleId: manifest.previous_bundle_id ?? null,
    crawlState: manifest.crawl_state ?? [],
  };
}

/**
 * 这一份档案的时间，化成毫秒。
 *
 * `completed_at` 缺失时退回 `bundle_id`——它以 `YYYYMMDDTHHMMSSZ` 开头（规范 §2.1
 * 那个命名的用意就在这里）。
 *
 * **两种形式必须先化成同一个尺度再比。** 直接拿字符串比是错的：
 *
 *     '2026-07-31T05:13:33Z'   ← completed_at（带连字符）
 *     '20260731T043423Z-d40c1d' ← bundle_id（紧凑）
 *
 * 逐字符比到第 5 位是 `-`（0x2D）对 `0`（0x30），于是**带连字符的那个永远排在
 * 前面**——一份 05:13 完成的档案会被判成比 04:34 那份还旧。混着两种形式的数据
 * 一出现（比如中止的档案没有 `completed_at`），链的顺序就静默地错了。
 *
 * @param {ChainEntry} e
 * @returns {number}
 */
function timeKeyOf(e) {
  if (e.completedAt) {
    const t = Date.parse(e.completedAt);
    if (Number.isFinite(t)) return t;
  }
  // 20260731T043423Z → 2026-07-31T04:34:23Z
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(e.bundleId ?? '');
  if (m) {
    const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
    if (Number.isFinite(t)) return t;
  }
  return 0; // 认不出来的排最后，但不崩
}

/**
 * 按时间**从新到旧**排序。
 *
 * @param {ChainEntry[]} entries
 */
export function newestFirst(entries) {
  return [...entries].sort((a, b) => {
    const d = timeKeyOf(b) - timeKeyOf(a);
    // 时间相同就按 id，保证顺序稳定（否则同一份数据两次渲染可能不一样）
    return d !== 0 ? d : (a.bundleId < b.bundleId ? 1 : a.bundleId > b.bundleId ? -1 : 0);
  });
}

/**
 * 挑出每条路线的下界。
 *
 * 从新到旧走，每条路线取**第一份 `advanced: true`** 的那个 `high_water_time`。
 *
 * 没有下界的路线**不出现在结果里**——那表示「从头重走」，而不是「下界是 null」。
 * 两者在调用方那里的处理完全一样，但少一个可以被误当成 0 的字段。
 *
 * @param {ChainEntry[]} entries  已有的档案（顺序无所谓）
 * @param {object} [opts]
 * @param {string | null} [opts.accountUserId]  只认这个账号的档案。**强烈建议传**。
 * @param {string | null} [opts.accountUsername]  用户名也要一样，理由见文件开头②。
 * @returns {Map<string, FloorPick>}
 */
export function pickFloors(entries, { accountUserId = null, accountUsername = null } = {}) {
  /** @type {Map<string, FloorPick>} */
  const out = new Map();

  for (const e of newestFirst(entries)) {
    if (!sameAccount(e, { accountUserId, accountUsername })) continue;

    for (const cs of e.crawlState) {
      if (out.has(cs.route_key)) continue; // 更新的那一份已经给过下界了
      if (cs.advanced !== true) continue; // 没推进水位线的不提供下界（§5.4）
      if (!cs.high_water_time) continue; // 防御：advanced 为真时它不该为空

      out.set(cs.route_key, {
        floorTime: cs.high_water_time,
        floorRaw: cs.high_water_raw ?? null,
        fromBundleId: e.bundleId,
        // 处于下界那一刻的条目 ID。下界比较是**闭区间**（宁可重复不可遗漏），
        // 所以那一秒的条目会被重抓；这些 ID 让下游认得出它们是同一条。
        boundaryIds: cs.high_water_ids ?? [],
      });
    }
  }

  return out;
}

/**
 * 这份档案是不是「同一个我」抓的。
 *
 * 数字 ID 与用户名**都要**一样，理由见文件开头②：ID 不同是别人；ID 相同而用户名
 * 变了，下界本身没问题（它是个时间），但每一条路线的 URL 里都嵌着用户名，跨档案
 * 去重与版本历史全都对不上。
 *
 * 判据缺失时一律不认——「不知道」不是「是同一个」。
 *
 * @param {ChainEntry} e
 * @param {{accountUserId?: string | null, accountUsername?: string | null}} me
 */
export function sameAccount(e, { accountUserId = null, accountUsername = null } = {}) {
  if (accountUserId && e.accountUserId !== accountUserId) return false;
  if (accountUsername && e.accountUsername !== accountUsername) return false;
  return true;
}

/**
 * 找出「同一个人，但改过名」的那些档案。
 *
 * 单独一个函数，是因为这件事**必须说给用户听**：它会让一次抓取从增量退回全量，
 * 而用户看到的现象是「明明抓过了，怎么又从头来」。不解释的话那看起来就是个 bug。
 *
 * @param {ChainEntry[]} entries
 * @param {{accountUserId?: string | null, accountUsername?: string | null}} me
 * @returns {Array<{bundleId: string, was: string | null}>}
 */
export function renamedBundles(entries, { accountUserId = null, accountUsername = null } = {}) {
  if (!accountUserId || !accountUsername) return [];
  return entries
    .filter((e) => e.accountUserId === accountUserId && e.accountUsername !== accountUsername)
    .map((e) => ({ bundleId: e.bundleId, was: e.accountUsername }));
}

/**
 * 给 `CrawlRunner.start()` 用的那个形状：`Map<routeKey, floorTime>`。
 *
 * @param {Map<string, FloorPick>} picks
 * @returns {Map<string, string>}
 */
export function floorsFor(picks) {
  return new Map([...picks].map(([k, v]) => [k, v.floorTime]));
}

/**
 * @typedef {object} ChainHole
 * @property {string} routeKey
 * @property {string} bundleId       在哪一份上断的
 * @property {string} missing        它指向的那一份（不在场，或对不上）
 * @property {'absent' | 'mismatch'} kind
 * @property {string} detail
 */

/**
 * 核对链的完整性（§5.5.3）。
 *
 * 对每条路线：如果某一份声称自己的下界取自某一份，那一份**必须在场**，而且它在
 * 同一条路线上的 `high_water_time` **必须**等于这边的 `floor_time`。
 *
 * 断了不代表在场的那几份无效——它们各自抓到的东西照样有效，只是「从今天连续回溯
 * 到 X」这句话不再成立。所以这里返回的是**洞的清单**，不是一个 true/false。
 *
 * @param {ChainEntry[]} entries
 * @returns {ChainHole[]}
 */
export function findChainHoles(entries) {
  const byId = new Map(entries.map((e) => [e.bundleId, e]));
  /** @type {ChainHole[]} */
  const holes = [];

  for (const e of entries) {
    for (const cs of e.crawlState) {
      const from = cs.floor_from_bundle_id;
      if (!from) continue; // 没有下界（首次全量），无从断

      const base = byId.get(from);
      if (!base) {
        holes.push({
          routeKey: cs.route_key,
          bundleId: e.bundleId,
          missing: from,
          kind: 'absent',
          detail: `它的下界取自档案 ${from}，而那一份不在了。`
            + '这一份抓到的东西照样有效，只是「连续回溯到更早」这句话现在证明不了。',
        });
        continue;
      }

      const baseCs = base.crawlState.find((x) => x.route_key === cs.route_key);
      if (!baseCs || baseCs.high_water_time !== cs.floor_time) {
        holes.push({
          routeKey: cs.route_key,
          bundleId: e.bundleId,
          missing: from,
          kind: 'mismatch',
          detail: `它的下界是 ${cs.floor_time}，而基准档案 ${from} 在这条路线上的`
            + `水位线是 ${baseCs?.high_water_time ?? '（没有这条路线）'}。两者对不上，`
            + '中间那一段没有人抓过。',
        });
      }
    }
  }

  return holes;
}

/**
 * 从某一份档案出发，沿 `previous_bundle_id` 往回走出**一条**链。
 *
 * ## 为什么必须先分链
 *
 * 一堆档案不等于一条链。`previous_bundle_id` 为 null 的那些各自是一条链的**起点**
 * ——比如增量做出来之前的每一次抓取，都是独立的全量。
 *
 * 把它们全当成一条链接起来，会得出两个错误结论：档案数虚高（「合起来 4 份」，
 * 而其实是 4 次互不相干的全量），以及**任何一份的缺口都会污染全部**（真实数据里
 * 每一行都变成了「没走完」，包括那些各自明明验证通过的）。
 *
 * @param {ChainEntry[]} entries
 * @param {string} headId  从哪一份开始往回走
 * @returns {ChainEntry[]}  从新到旧；`headId` 不存在时返回空数组
 */
export function chainOf(entries, headId) {
  const byId = new Map(entries.map((e) => [e.bundleId, e]));
  /** @type {ChainEntry[]} */
  const out = [];
  const seen = new Set();

  let cur = byId.get(headId);
  while (cur && !seen.has(cur.bundleId)) {
    seen.add(cur.bundleId); // 环是坏数据，但不能让它把我们转死
    out.push(cur);
    cur = cur.previousBundleId ? byId.get(cur.previousBundleId) : undefined;
  }
  return out;
}

/**
 * 把一堆档案分成若干条链，**最新的那条在前**。
 *
 * @param {ChainEntry[]} entries
 * @returns {ChainEntry[][]}
 */
export function splitChains(entries) {
  const claimed = new Set();
  /** @type {ChainEntry[][]} */
  const chains = [];

  for (const head of newestFirst(entries)) {
    if (claimed.has(head.bundleId)) continue;
    const chain = chainOf(entries, head.bundleId);
    for (const e of chain) claimed.add(e.bundleId);
    chains.push(chain);
  }
  return chains;
}

/**
 * 一条路线在**一条链**上覆盖到了哪儿。
 *
 * ## 连续性怎么算
 *
 * 不是「每一份都连续」——那个规则是错的。考虑 B2 → B1，B1 那条线有缺口所以
 * B2 用不了它当下界，于是 B2 **从头走了一遍**（`floor_time` 为 null）。那时
 * B2 一份就覆盖了全部，B1 的缺口无关紧要。
 *
 * 正确的走法是从最新那一份往回追：
 *
 * 1. 最新那份自己得连续，否则「从今天起往回」这句话就不成立；
 * 2. 它的 `floor_time` 是 null → 它一路走到了最早，**到此为止，链是连续的**；
 * 3. 否则要求基准在场、对得上（`findChainHoles` 管这件事），并对基准递归。
 *
 * **刻意不算「一共抓了多少条」**：下界是闭区间，相邻两份必然重叠，加出来的数
 * 只会误导。而这个项目的论点本来就是「计数不能证明完整性，连续性才能」。
 *
 * @param {ChainEntry[]} chain  从新到旧的一条链
 * @param {string} routeKey
 */
export function routeChainCoverage(chain, routeKey) {
  const byId = new Map(chain.map((e) => [e.bundleId, e]));
  const holes = findChainHoles(chain).filter((h) => h.routeKey === routeKey);

  /** @type {string | null} */
  let newest = null;
  /** @type {string | null} */
  let oldest = null;
  /** @type {string[]} */
  const bundles = [];

  for (const e of chain) {
    const cs = e.crawlState.find((x) => x.route_key === routeKey);
    if (!cs) continue;
    bundles.push(e.bundleId);
    if (cs.high_water_time && (!newest || cs.high_water_time > newest)) newest = cs.high_water_time;
    if (cs.low_water_time && (!oldest || cs.low_water_time < oldest)) oldest = cs.low_water_time;
  }

  // 从最新那份有这条线的档案开始往回追
  let contiguous = false;
  const walked = new Set();
  let cur = chain.find((e) => e.crawlState.some((x) => x.route_key === routeKey));
  while (cur && !walked.has(cur.bundleId)) {
    walked.add(cur.bundleId);
    const cs = cur.crawlState.find((x) => x.route_key === routeKey);
    if (!cs?.contiguous) break; // 这一段自己就不连续
    if (!cs.floor_time) { contiguous = true; break; } // 走到了最早，收工
    if (!cs.floor_from_bundle_id) break; // 有下界却说不出来自哪儿 —— 证明不了
    cur = byId.get(cs.floor_from_bundle_id);
  }

  if (holes.length) contiguous = false;

  return { newest, oldest, bundles, contiguous, holes };
}

/**
 * 一条链上每条路线的覆盖情况。
 *
 * @param {ChainEntry[]} chain  从新到旧的一条链
 */
export function chainCoverage(chain) {
  /** @type {Map<string, ReturnType<typeof routeChainCoverage>>} */
  const out = new Map();
  for (const e of chain) {
    for (const cs of e.crawlState) {
      if (out.has(cs.route_key)) continue;
      out.set(cs.route_key, routeChainCoverage(chain, cs.route_key));
    }
  }
  return out;
}

/**
 * 一份档案的索引里我们关心的东西。
 *
 * @typedef {object} IndexSlice
 * @property {string} bundleId
 * @property {string | null} completedAt
 * @property {Array<{url_key: string, capture_id: string, observed_at: string, verdict: string}>} entries
 */

/**
 * 跟链上更早的档案比一比：哪些是**新增**的，哪些是**又抓了一次**。
 *
 * ## 为什么这件事值得做
 *
 * 增量档案里混着两种东西：这次新出现的条目，和边界上被重抓的那几条（下界比较是
 * 闭区间，宁可重复不可遗漏）。捕获列表里它们长得一模一样，而用户想知道的恰恰是
 * 「这次到底新得到了什么」。
 *
 * ## 版本历史
 *
 * 同一个 URL 在不同时间被抓到多次，**那不是重复数据，是版本**——评分变了、短评
 * 改了、条目被删了。这正是「有意保留不同版本」的兑现处，也是 canonical 的 revision
 * 模型的原料。
 *
 * 只返回**有多个版本**的那些：一个版本的条目占绝大多数，全都返回等于把整份索引
 * 再传一遍。
 *
 * @param {IndexSlice} current
 * @param {IndexSlice[]} others  链上的其它档案（新旧都可以，这里自己按时间排）
 */
export function diffAgainstChain(current, others) {
  const older = others.filter((o) => o.bundleId !== current.bundleId);

  /** @type {Set<string>} 出现在**更早**档案里的 url_key */
  const seenBefore = new Set();
  const curKey = current.completedAt ?? current.bundleId;
  for (const o of older) {
    const k = o.completedAt ?? o.bundleId;
    if (k >= curKey) continue; // 比当前这份新，不算「更早」
    for (const e of o.entries) seenBefore.add(e.url_key);
  }

  const repeated = [...new Set(
    current.entries.filter((e) => seenBefore.has(e.url_key)).map((e) => e.url_key),
  )];

  // 版本历史：跨整条链按 url_key 聚，只留有多个版本的。
  /** @type {Map<string, Array<{bundleId: string, captureId: string, observedAt: string}>>} */
  const byKey = new Map();
  for (const slice of [current, ...older]) {
    for (const e of slice.entries) {
      const list = byKey.get(e.url_key) ?? [];
      list.push({
        bundleId: slice.bundleId,
        captureId: e.capture_id,
        observedAt: e.observed_at,
      });
      byKey.set(e.url_key, list);
    }
  }

  /** @type {Array<{urlKey: string, versions: Array<object>}>} */
  const versions = [];
  for (const [urlKey, list] of byKey) {
    if (list.length < 2) continue;
    // 从新到旧：用户先想看最近那一版
    list.sort((a, b) => (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : 0));
    versions.push({ urlKey, versions: list });
  }
  versions.sort((a, b) => b.versions.length - a.versions.length);

  return { repeated, versions };
}

/**
 * 哪些档案里的作品详情页算「已经抓过」。
 *
 * ## 按账号取，**不按链取**
 *
 * 这两个问题不是一回事，而混起来的代价很贵：
 *
 * | 问题 | 用什么回答 |
 * |---|---|
 * | 「从今天往回一直到 X 有没有断」 | **链**（`previous_bundle_id` 串起来的那条） |
 * | 「这一页我是不是已经有了」 | **这个账号名下的全部档案** |
 *
 * 作品详情页没有时间序（规范 §5.5.5），链对它毫无意义。而按链算的后果在真实使用
 * 里立刻就出来了：`previous_bundle_id` 为 null 的档案各自成链，于是「最新那条链」
 * 常常只有一份档案——如果那一份恰好是刚跑了一小段的增量（只抓到十几个详情页），
 * **此前几千个就全都不认识了**，下一次增量把它们重抓一遍。用户看到的是
 * 「我只加了一本想读的书，它却在抓游戏」。
 *
 * @param {ChainEntry[]} entries  全部档案
 * @param {{accountUserId?: string | null, accountUsername?: string | null}} me
 * @returns {ChainEntry[]}
 */
export function bundlesWithKnownSubjects(entries, me) {
  return entries.filter((e) => sameAccount(e, me));
}
