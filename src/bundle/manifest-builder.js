/**
 * manifest.json 组装。
 *
 * 规范：doubak-data-specs/bundle/v1/SPEC.md §5
 *
 * 与 index 写入器同样的立场：**不合规就拒绝产出**。规范里那几条不变量
 * （水位线、声明数量的可追溯性、段与索引的对应）在这里全部被强制，
 * 而不是等事后校验器来发现。
 */

import { isRfc3339WithOffset } from '../core/time.js';
import { SPEC_VERSION, ENUMERATIONS } from '../core/spec-constants.js';

export { SPEC_VERSION };

const STATUSES = new Set(['in_progress', 'complete', 'aborted']);
const ENUMERATION_SET = new Set(ENUMERATIONS);

/**
 * coverage 里刻意不存在的字段。
 *
 * 豆瓣的计数有时统计于审查之前、有时之后，因此不能作为完整性判据。
 * 规范选择「不提供这些字段」而不是「提供了但警告不要用」——不存在的字段
 * 无法被误用。这里拦住它们，免得将来有人「顺手加上」。
 */
const FORBIDDEN_COVERAGE_FIELDS = ['completeness', 'reconciled', 'complete', 'is_complete'];

/**
 * 构造一条 coverage 记录，自动算 delta。
 *
 * @param {object} opts
 * @param {string} opts.routeKey
 * @param {string} opts.intent
 * @param {number | null} opts.claimedCount  取不到必须是 null；null ≠ 0
 * @param {string | null} [opts.claimedRaw]
 * @param {string | null} [opts.claimedSource]  读出该数字的那条捕获
 * @param {string | null} [opts.claimedObservedAt]
 * @param {number} opts.capturedCount
 */
export function coverageEntry({
  routeKey,
  intent,
  claimedCount,
  claimedRaw = null,
  claimedSource = null,
  claimedObservedAt = null,
  capturedCount,
}) {
  if (claimedCount !== null && !Number.isInteger(claimedCount)) {
    throw new Error(`claimed_count 必须是整数或 null（null 表示不知道，与 0 不同）`);
  }
  if (claimedCount !== null && claimedSource === null) {
    throw new Error(
      `coverage[${routeKey}]: claimed_count 非 null 时必须给 claimed_source。` +
        `无从追溯的数字等于没有记——校验器要靠它回到 WARC 里那张页面。`,
    );
  }
  return {
    route_key: routeKey,
    intent,
    claimed_count: claimedCount,
    claimed_raw: claimedRaw,
    claimed_source: claimedSource,
    claimed_observed_at: claimedObservedAt,
    captured_count: capturedCount,
    // 命名刻意中性：它是一个差值，不是一个错误
    delta: claimedCount === null ? null : capturedCount - claimedCount,
  };
}

/**
 * 构造一条抓取存档信息。
 *
 * @param {object} opts
 * @param {string} opts.routeKey
 * @param {string} opts.intent
 * @param {string | null} opts.highWaterTime
 * @param {string | null} [opts.highWaterRaw]
 * @param {string[]} [opts.highWaterIds]
 * @param {string | null} opts.floorTime
 * @param {'full' | 'bounded'} opts.enumeration
 * @param {boolean} opts.contiguous
 * @param {Array<object>} [opts.gaps]
 * @param {boolean} opts.advanced
 * @param {string | null} [opts.completedAt]
 * @param {string} opts.bundleId
 */
export function crawlStateEntry({
  routeKey,
  intent,
  highWaterTime,
  highWaterRaw = null,
  highWaterIds = [],
  floorTime,
  enumeration,
  contiguous,
  gaps = [],
  advanced,
  completedAt = null,
  bundleId,
}) {
  if (!ENUMERATION_SET.has(enumeration)) {
    throw new Error(
      `crawl_state[${routeKey}]: enumeration 必须是 full 或 bounded，实际 ${JSON.stringify(enumeration)}。` +
        `下游据此判断有无资格推断删除，取值不明时猜错的方向是静默地把没删的当成删了。`,
    );
  }

  // 核心不变量。中途暂停、被风控打断、用户放弃，一律不许推进水位线——
  // 重复是免费的，空洞是永久且不可检测的。
  if (advanced) {
    if (!contiguous) {
      throw new Error(
        `crawl_state[${routeKey}]: advanced=true 但 contiguous=false。` +
          `水位线只能在连续无缺口走完时推进，否则下次抓取会从一个假的下界开始。`,
      );
    }
    if (gaps.length > 0) {
      throw new Error(
        `crawl_state[${routeKey}]: advanced=true 但存在 ${gaps.length} 处缺口。`,
      );
    }
    if (highWaterTime === null) {
      throw new Error(`crawl_state[${routeKey}]: advanced=true 但 high_water_time 为 null。`);
    }
  }

  for (const [name, v] of [['high_water_time', highWaterTime], ['floor_time', floorTime]]) {
    if (v !== null && !isRfc3339WithOffset(v)) {
      throw new Error(`crawl_state[${routeKey}]: ${name} 必须带显式时区偏移，实际 ${JSON.stringify(v)}`);
    }
  }

  return {
    route_key: routeKey,
    intent,
    high_water_time: highWaterTime,
    high_water_raw: highWaterRaw,
    high_water_ids: highWaterIds,
    floor_time: floorTime,
    enumeration,
    contiguous,
    gaps,
    advanced,
    completed_at: completedAt,
    bundle_id: bundleId,
  };
}

export class ManifestBuilder {
  /**
   * @param {object} opts
   * @param {string} opts.bundleId
   * @param {string | null} opts.previousBundleId
   * @param {{user_id: string, username?: string | null, profile_url?: string}} opts.account
   * @param {{name: string, version: string, user_agent?: string, platform?: string}} opts.producer
   * @param {string} opts.timezoneAssumption
   * @param {string} opts.createdAt
   */
  constructor({ bundleId, previousBundleId, account, producer, timezoneAssumption, createdAt }) {
    if (!bundleId) throw new Error('缺少 bundleId');
    if (!account?.user_id) throw new Error('缺少 account.user_id（数字 ID 是稳定主键）');
    if (!producer?.name || !producer?.version) throw new Error('缺少 producer.name/version');
    if (!timezoneAssumption) {
      throw new Error(
        '缺少 timezoneAssumption。豆瓣页面上的时间不带时区，所假定的时区必须记下来——' +
          '将来假定被推翻时，才可能对存量重新解析。',
      );
    }
    if (!isRfc3339WithOffset(createdAt)) {
      throw new Error(`createdAt 必须带显式时区偏移: ${JSON.stringify(createdAt)}`);
    }

    this._bundleId = bundleId;
    this._previousBundleId = previousBundleId ?? null;
    this._account = account;
    this._producer = producer;
    this._tz = timezoneAssumption;
    this._createdAt = createdAt;

    /** @type {object[]} */
    this._coverage = [];
    /** @type {object[]} */
    this._crawlState = [];
  }

  /** @param {ReturnType<typeof coverageEntry>} entry */
  addCoverage(entry) {
    for (const forbidden of FORBIDDEN_COVERAGE_FIELDS) {
      if (forbidden in entry) {
        throw new Error(
          `coverage 不得含 ${forbidden} 字段。豆瓣的计数有时统计于审查之前、有时之后，` +
            `不能作为完整性判据——完整性证据在 crawl_state 里。`,
        );
      }
    }
    this._coverage.push(entry);
    return this;
  }

  /** @param {ReturnType<typeof crawlStateEntry>} entry */
  addCrawlState(entry) {
    this._crawlState.push(entry);
    return this;
  }

  /**
   * @param {object} opts
   * @param {'in_progress' | 'complete' | 'aborted'} opts.status
   * @param {string | null} [opts.completedAt]
   * @param {Array<object>} opts.segments  SegmentWriter.finalize() 的结果
   * @param {{filename: string, sha256: string, line_count: number}} opts.index
   * @param {object} [opts.counts]
   * @param {Map<string, number>} [opts.perSegmentIndexCounts]  用于交叉核对
   * @param {string} [opts.notes]
   */
  build({ status, completedAt = null, segments, index, counts, perSegmentIndexCounts, notes }) {
    if (!STATUSES.has(status)) throw new Error(`未知的 status: ${JSON.stringify(status)}`);
    if (status === 'complete') {
      if (!isRfc3339WithOffset(completedAt)) {
        throw new Error('status=complete 时必须给带时区偏移的 completedAt');
      }
    }
    if (!Array.isArray(segments)) throw new Error('segments 必须是数组');
    if (!index?.filename) throw new Error('缺少 index 元数据');

    // 段的 record_count 必须等于指向它的 index 行数。warcinfo 不是捕获，
    // 不进 index，也不计入 record_count（见规范 3628a3e）。
    if (perSegmentIndexCounts) {
      for (const seg of segments) {
        const actual = perSegmentIndexCounts.get(seg.filename) ?? 0;
        if (seg.record_count !== actual) {
          throw new Error(
            `${seg.filename}: record_count 为 ${seg.record_count}，` +
              `但 index 中指向本段的行数为 ${actual}。段与索引已失去对应关系。`,
          );
        }
      }
      const declared = new Set(segments.map((s) => s.filename));
      for (const name of perSegmentIndexCounts.keys()) {
        if (!declared.has(name)) {
          throw new Error(`index 引用了 manifest 未列出的段: ${name}`);
        }
      }
    }

    const manifest = {
      spec_version: SPEC_VERSION,
      bundle_id: this._bundleId,
      previous_bundle_id: this._previousBundleId,
      status,
      created_at: this._createdAt,
      completed_at: completedAt,
      producer: { ...this._producer },
      account: { ...this._account },
      timezone_assumption: this._tz,
      segments,
      index,
      coverage: this._coverage,
      crawl_state: this._crawlState,
    };
    if (counts) manifest.counts = counts;
    if (notes) manifest.notes = notes;

    return manifest;
  }

  /** 序列化成可直接落盘的字节。 */
  static serialize(manifest) {
    return new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n');
  }
}
