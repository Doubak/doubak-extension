/**
 * 段写入器：把 WARC 记录追加进 `*.warc.gz`，满了就换下一段。
 *
 * 规范：doubak-data-specs/bundle/v1/SPEC.md §2、§4
 *
 * 职责边界：它只管**字节落在哪里**，不管这些字节是什么意思。谁写的、为什么
 * 抓、可不可信，都是 index.ndjson 的事。
 *
 * ## 两条不变量
 *
 * **① 一条记录必须完整落在一个段里。** index.ndjson 的 `offset`/`length`
 * 是「某个文件里的一段字节」，跨文件就没法表达了。所以轮转永远发生在两条
 * 记录之间，绝不会把一条记录劈开。单条记录比段上限还大时，它独占一整段——
 * 超限总比劈开好。
 *
 * **② 偏移量取自写入前的文件长度。** 先问 `size()`，那就是这条记录的
 * `offset`。这要求存储只能末尾追加（见 file-store.js）。
 */

import { segmentFilename, newWarcRecordId } from '../core/ids.js';
import { buildWarcinfoRecord, gzipMember } from '../core/warc.js';
import { sha256Hex } from '../core/digest.js';

/**
 * 段大小上限的默认值。
 *
 * 规范不强制，这是生产者的选择：足够小，低配机器处理得动；足够大，不至于
 * 产生几千个文件。
 */
export const DEFAULT_MAX_SEGMENT_BYTES = 256 * 1024 * 1024;

/**
 * @typedef {object} RecordLocation
 * @property {string} segment  段文件名
 * @property {number} offset   gzip member 在段文件中的起始字节
 * @property {number} length   gzip member 的压缩后字节数
 */

export class SegmentWriter {
  /**
   * @param {object} opts
   * @param {import('../storage/file-store.js').FileStore} opts.store
   * @param {string} opts.bundleId
   * @param {'data' | 'assets' | 'catalog'} opts.kind  留存等级，不是媒体类型
   * @param {string} opts.software  写进 warcinfo，如 `doubak-extension/0.0.1`
   * @param {number} [opts.maxBytes]
   * @param {() => Date} [opts.now]  便于测试注入
   * @param {{segmentNo: number, segments: Array<{filename: string, recordCount: number, firstCaptureId: string, lastCaptureId: string}>}} [opts.resume]
   *   崩溃恢复后续写用。不给这个，写入器会从第 1 段重新开，而那个文件已经
   *   存在——它会（正确地）拒绝覆盖，于是恢复完了却写不下去。
   */
  constructor({ store, bundleId, kind, software, maxBytes = DEFAULT_MAX_SEGMENT_BYTES, now, resume }) {
    if (!store) throw new Error('缺少 store');
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new Error(`maxBytes 必须是正整数: ${maxBytes}`);
    }

    this._store = store;
    this._bundleId = bundleId;
    this._kind = kind;
    this._software = software;
    this._maxBytes = maxBytes;
    this._now = now ?? (() => new Date());

    /** 当前段序号；0 表示还没开过段。 */
    this._segmentNo = resume?.segmentNo ?? 0;
    /** @type {Map<string, {filename: string, recordCount: number, firstCaptureId: string|null, lastCaptureId: string|null}>} */
    this._segments = new Map();
    for (const meta of resume?.segments ?? []) {
      this._segments.set(meta.filename, { ...meta });
    }

  }

  /** 当前段的文件名；还没开段则为 null。 */
  get currentSegment() {
    return this._segmentNo === 0 ? null : segmentFilename(this._kind, this._bundleId, this._segmentNo);
  }

  /**
   * 开一个新段，并写入段首的 warcinfo 记录。
   *
   * warcinfo 描述的是「这个文件是什么」，不是一次捕获，因此**不进 index**，
   * 也不计入 `recordCount`。
   */
  async _openSegment() {
    this._segmentNo += 1;
    const filename = segmentFilename(this._kind, this._bundleId, this._segmentNo);

    if (await this._store.exists(filename)) {
      // 每次抓取产出全新 bundle，段文件名内嵌 bundle_id，正常不该撞上。
      // 撞上说明有别的东西在写同一个 bundle，继续写下去会毁掉偏移量。
      throw new Error(`段文件已存在，拒绝覆盖: ${filename}`);
    }

    const info = buildWarcinfoRecord({
      recordId: newWarcRecordId(),
      date: this._now(),
      filename,
      bundleId: this._bundleId,
      software: this._software,
    });
    await this._store.append(filename, await gzipMember(info));

    this._segments.set(filename, {
      filename,
      recordCount: 0,
      firstCaptureId: null,
      lastCaptureId: null,
    });

    return filename;
  }

  /**
   * 追加一条 WARC 记录。
   *
   * @param {Uint8Array} recordBytes  未压缩的完整 WARC 记录
   * @param {string} captureId
   * @returns {Promise<RecordLocation>}
   */
  async append(recordBytes, captureId) {
    if (!(recordBytes instanceof Uint8Array)) throw new Error('append 需要 Uint8Array');
    if (!captureId) throw new Error('append 需要 captureId');

    const member = await gzipMember(recordBytes);

    if (this._segmentNo === 0) await this._openSegment();

    let filename = /** @type {string} */ (this.currentSegment);
    let offset = await this._store.size(filename);

    // 轮转判定：只在段里已经有记录时才换段。否则一条超大记录会导致
    // 无限开新段——它在任何一段里都放不下。
    const meta = this._segments.get(filename);
    if (meta.recordCount > 0 && offset + member.length > this._maxBytes) {
      filename = await this._openSegment();
      offset = await this._store.size(filename);
    }

    await this._store.append(filename, member);

    const m = this._segments.get(filename);
    m.recordCount += 1;
    m.firstCaptureId ??= captureId;
    m.lastCaptureId = captureId;


    return { segment: filename, offset, length: member.length };
  }

  /**
   * 汇总各段的元数据，供 manifest 使用。
   *
   * `recordCount` 是**捕获记录数**，不含段首的 warcinfo——这样它就等于指向
   * 该段的 index 行数，可以被交叉校验。
   *
   * @returns {Promise<Array<{filename: string, bytes: number, sha256: string, record_count: number, first_capture_id: string|null, last_capture_id: string|null}>>}
   */
  async finalize() {
    const out = [];
    for (const meta of this._segments.values()) {
      const bytes = await this._store.read(meta.filename);
      out.push({
        filename: meta.filename,
        bytes: bytes.length,
        sha256: await sha256Hex(bytes),
        record_count: meta.recordCount,
        first_capture_id: meta.firstCaptureId,
        last_capture_id: meta.lastCaptureId,
      });
    }
    return out;
  }

}
