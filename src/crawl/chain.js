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
 * **② 只认同一个账号。** 一份属于别人的档案不能给你当基准——那会让你以为某段
 * 时间已经抓过了，而实际上抓的是别人的。这一条比它看起来重要：账号切换在真实
 * 使用里是会发生的（多个豆瓣号），而错误的方向是**漏抓**。
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
    previousBundleId: manifest.previous_bundle_id ?? null,
    crawlState: manifest.crawl_state ?? [],
  };
}

/**
 * 按时间**从新到旧**排序。
 *
 * `completed_at` 缺失时退回 `bundle_id`——它以 `YYYYMMDDTHHMMSSZ` 开头，字典序
 * 就是时间序（这正是那个命名的用意，见规范 §2.1）。
 *
 * @param {ChainEntry[]} entries
 */
export function newestFirst(entries) {
  return [...entries].sort((a, b) => {
    const ka = a.completedAt ?? a.bundleId;
    const kb = b.completedAt ?? b.bundleId;
    if (ka === kb) return 0;
    return ka < kb ? 1 : -1;
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
 * @returns {Map<string, FloorPick>}
 */
export function pickFloors(entries, { accountUserId = null } = {}) {
  /** @type {Map<string, FloorPick>} */
  const out = new Map();

  for (const e of newestFirst(entries)) {
    // 别人的档案不能当基准：那会让你以为某段时间已经抓过了，而抓的是别人的。
    // 账号不明的也不认——「不知道」不是「是同一个」。
    if (accountUserId && e.accountUserId !== accountUserId) continue;

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
 * 一条路线在整条链上覆盖到了哪儿。
 *
 * 这是覆盖率页「合起来」那个视角的数据来源。**刻意不算「一共抓了多少条」**：
 * 下界是闭区间，档案之间必然重叠，加出来的数只会误导。而这个项目的论点本来就是
 * 「计数不能证明完整性，连续性才能」。
 *
 * @param {ChainEntry[]} entries
 * @returns {Map<string, {newest: string | null, oldest: string | null, bundles: string[], contiguous: boolean, holes: ChainHole[]}>}
 */
export function chainCoverage(entries) {
  const holes = findChainHoles(entries);
  /** @type {Map<string, any>} */
  const out = new Map();

  for (const e of newestFirst(entries)) {
    for (const cs of e.crawlState) {
      const cur = out.get(cs.route_key) ?? {
        newest: null, oldest: null, bundles: [], contiguous: true, holes: [],
      };
      cur.bundles.push(e.bundleId);
      if (cs.high_water_time && (!cur.newest || cs.high_water_time > cur.newest)) {
        cur.newest = cs.high_water_time;
      }
      if (cs.low_water_time && (!cur.oldest || cs.low_water_time < cur.oldest)) {
        cur.oldest = cs.low_water_time;
      }
      // 任何一份不连续，整条链就不连续——连续性是「从最新一直到最旧没有断」，
      // 一处断掉整句话就不成立。
      if (!cs.contiguous) cur.contiguous = false;
      out.set(cs.route_key, cur);
    }
  }

  for (const h of holes) {
    const cur = out.get(h.routeKey);
    if (!cur) continue;
    cur.holes.push(h);
    cur.contiguous = false;
  }

  return out;
}
