/**
 * bundle / capture 标识符。
 *
 * 规范：doubak-data-specs/bundle/v1/SPEC.md §3
 *
 * 核心性质：
 * - 段文件名内嵌 bundle_id，使得多次抓取的文件混放在同一目录也不会互相覆盖。
 * - capture 序号【在写入之前分配】，所以崩溃只会留下空洞，不会留下重复。
 *   空洞合法，重复非法。
 */

/** capture 序号的最小零填充宽度。超过这个位数就自然变长。 */
const SEQ_PAD = 6;

const BUNDLE_ID_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/;
const CAPTURE_ID_RE = /^([0-9]{8}T[0-9]{6}Z-[0-9a-f]{6})#([0-9]{6,})$/;

// 注意：不能写成 `export { X } from '...'`——那是纯粹的再导出，不会建立
// 本模块内的绑定，下面的 segmentFilename 就用不到它了。
import { SEGMENT_KINDS } from './spec-constants.js';

/** 段文件前缀，表示【留存等级】而非媒体类型（SPEC §2.1）。 */
export { SEGMENT_KINDS };

/**
 * 生成一个新的 bundle_id：UTC 紧凑时间戳 + 6 位十六进制随机。
 * 前缀是时间戳，因此按字典序排序即按时间排序。
 *
 * @param {Date} [now]
 * @returns {string} 形如 `20260728T101500Z-a3f9c1`
 */
export function newBundleId(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;

  const rand = new Uint8Array(3);
  crypto.getRandomValues(rand);
  const suffix = Array.from(rand, (b) => b.toString(16).padStart(2, '0')).join('');

  return `${stamp}-${suffix}`;
}

/** @param {string} s */
export function isBundleId(s) {
  return BUNDLE_ID_RE.test(s);
}

/**
 * 拼出 capture_id。
 * @param {string} bundleId
 * @param {number} seq 从 1 开始
 */
export function captureId(bundleId, seq) {
  if (!isBundleId(bundleId)) throw new Error(`bundle_id 非法: ${bundleId}`);
  if (!Number.isInteger(seq) || seq < 1) throw new Error(`序号必须是 >=1 的整数: ${seq}`);
  return `${bundleId}#${String(seq).padStart(SEQ_PAD, '0')}`;
}

/**
 * @param {string} s
 * @returns {{ bundleId: string, seq: number }}
 */
export function parseCaptureId(s) {
  const m = CAPTURE_ID_RE.exec(s);
  if (!m) throw new Error(`capture_id 非法: ${s}`);
  return { bundleId: m[1], seq: Number(m[2]) };
}

/**
 * 段文件名。
 * @param {(typeof SEGMENT_KINDS)[number]} kind
 * @param {string} bundleId
 * @param {number} n 从 1 开始
 */
export function segmentFilename(kind, bundleId, n) {
  if (!SEGMENT_KINDS.includes(kind)) throw new Error(`未知的段类型: ${kind}`);
  if (!isBundleId(bundleId)) throw new Error(`bundle_id 非法: ${bundleId}`);
  if (!Number.isInteger(n) || n < 1) throw new Error(`段序号必须是 >=1 的整数: ${n}`);
  return `${kind}-${bundleId}-${String(n).padStart(5, '0')}.warc.gz`;
}

/** @param {string} bundleId */
export function indexFilename(bundleId) {
  if (!isBundleId(bundleId)) throw new Error(`bundle_id 非法: ${bundleId}`);
  return `index-${bundleId}.ndjson`;
}

/** @param {string} bundleId */
export function bundleDirName(bundleId) {
  if (!isBundleId(bundleId)) throw new Error(`bundle_id 非法: ${bundleId}`);
  return `doubak-bundle-${bundleId}`;
}

/** WARC-Record-ID：urn:uuid 形式，满足 WARC 对全局唯一的要求。 */
export function newWarcRecordId() {
  return `urn:uuid:${crypto.randomUUID()}`;
}

/**
 * 序号分配器。
 *
 * **必须在写入之前调用 next()**，这样进程崩在写入途中只会让某个序号没被
 * 用上（空洞），而不会让两条记录拿到同一个序号（重复）。空洞是无害的，
 * 重复会毁掉索引与 WARC 的对应关系。
 */
export class SequenceAllocator {
  /** @param {number} [startAt] 恢复时传入「已用到的最大序号」 */
  constructor(startAt = 0) {
    if (!Number.isInteger(startAt) || startAt < 0) {
      throw new Error(`startAt 必须是 >=0 的整数: ${startAt}`);
    }
    this._last = startAt;
  }

  /** @returns {number} 下一个序号 */
  next() {
    this._last += 1;
    return this._last;
  }

  /** 已分配到的最大序号（不代表都写成功了）。 */
  get last() {
    return this._last;
  }
}
