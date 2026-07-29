/**
 * bundle 写入器：把一次捕获变成磁盘上的字节。
 *
 * 规范：doubak-data-specs/bundle/v1/SPEC.md §8
 *
 * ## 落盘顺序不可调换
 *
 *   1. 分配序号
 *   2. 追加 WARC 记录到当前段（独立 gzip member）
 *   3. 追加 index.ndjson 一行
 *   4. 更新状态 / checkpoint
 *
 * 先写 index 后写 WARC 会留下**指向不存在记录的索引项**，那比孤儿记录
 * 难处理得多：孤儿记录只是浪费空间，悬空索引会让下游按 offset 读到一段
 * 别的东西。
 *
 * 序号在第 1 步分配，所以崩在任何一步都只会留下空洞，不会留下重复。
 *
 * ## 抓到一条写一条
 *
 * 不攒批。攒批意味着崩溃会丢掉一整批，而 MV3 的 service worker 随时会被
 * 杀——「termination 是一次可恢复的空操作」这个性质靠的就是每页都落盘。
 */

import {
  newBundleId,
  captureId as makeCaptureId,
  indexFilename,
  newWarcRecordId,
  SequenceAllocator,
} from '../core/ids.js';
import { buildWarcRecord, buildHttpResponseBlock } from '../core/warc.js';
import { sha256Hex, sha1Base32 } from '../core/digest.js';
import { nowRfc3339, toRfc3339 } from '../core/time.js';
import { urlKey, URL_KEY_RULES_VERSION } from '../core/urlkey.js';
import { SegmentWriter, DEFAULT_MAX_SEGMENT_BYTES } from './segment-writer.js';
import { IndexWriter } from './index-writer.js';
import { ManifestBuilder } from './manifest-builder.js';

/** 段的留存等级。data/assets 是神圣的，catalog 是缓存。 */
const KINDS = /** @type {const} */ (['data', 'assets', 'catalog']);

export class BundleWriter {
  /**
   * @param {object} opts
   * @param {import('../storage/file-store.js').FileStore} opts.store
   * @param {{user_id: string, username?: string | null, profile_url?: string}} opts.account
   * @param {string} [opts.bundleId]
   * @param {string | null} [opts.previousBundleId]
   * @param {{name: string, version: string, user_agent?: string, platform?: string}} [opts.producer]
   * @param {string} [opts.timezoneAssumption]
   * @param {number} [opts.maxSegmentBytes]
   * @param {() => Date} [opts.now]
   * @param {number} [opts.startSeq] 崩溃恢复时传入「已用到的最大序号」
   * @param {Record<string, {segmentNo: number, segments: object[]}>} [opts.resume]
   *   崩溃恢复返回的段状态，按留存等级分组。见 recovery.js
   */
  constructor({
    store,
    account,
    bundleId,
    previousBundleId = null,
    producer = { name: 'doubak-extension', version: '0.0.1' },
    timezoneAssumption = 'Asia/Shanghai',
    maxSegmentBytes = DEFAULT_MAX_SEGMENT_BYTES,
    now,
    startSeq = 0,
    resume,
  }) {
    if (!store) throw new Error('缺少 store');

    this._store = store;
    this._now = now ?? (() => new Date());
    this._bundleId = bundleId ?? newBundleId(this._now());
    this._seq = new SequenceAllocator(startSeq);

    /** @type {Map<string, SegmentWriter>} */
    this._segmentWriters = new Map();
    for (const kind of KINDS) {
      this._segmentWriters.set(
        kind,
        new SegmentWriter({
          store,
          bundleId: this._bundleId,
          kind,
          software: `${producer.name}/${producer.version}`,
          maxBytes: maxSegmentBytes,
          now: this._now,
          resume: resume?.[kind],
        }),
      );
    }

    this._index = new IndexWriter({ store, filename: indexFilename(this._bundleId) });

    this._manifest = new ManifestBuilder({
      bundleId: this._bundleId,
      previousBundleId,
      account,
      producer,
      timezoneAssumption,
      createdAt: toRfc3339(this._now()),
    });

    // TODO(debug): 开发期计数。发布前连同 debugStats() 一起删。
    this._debug = { captures: 0, byKind: { data: 0, assets: 0, catalog: 0 } };
  }

  get bundleId() {
    return this._bundleId;
  }

  /** 已分配到的最大序号。崩溃恢复时用它重建分配器。 */
  get lastSeq() {
    return this._seq.last;
  }

  /**
   * 写入一次捕获。
   *
   * @param {object} cap
   * @param {string} cap.url                请求时的原始 URL，跟踪参数照留
   * @param {string} cap.intent
   * @param {string} cap.routeKey
   * @param {'html' | 'api'} cap.surface
   * @param {string} cap.verdict
   * @param {string} cap.captureFidelity
   * @param {Uint8Array} cap.body           响应体，逐字节原样
   * @param {number} cap.httpStatus
   * @param {[string, string][]} [cap.headers]  响应头
   * @param {string} [cap.statusLine]
   * @param {string} [cap.contentType]
   * @param {'data' | 'assets' | 'catalog'} [cap.kind]  留存等级，默认 data
   * @param {string | null} [cap.parentCaptureId]
   * @param {object | null} [cap.cursor]
   * @param {string} [cap.observedAt]
   * @param {string} [cap.note]
   * @returns {Promise<{captureId: string, segment: string, offset: number, length: number}>}
   */
  async writeCapture(cap) {
    const {
      url,
      intent,
      routeKey,
      surface,
      verdict,
      captureFidelity,
      body,
      httpStatus,
      headers = [],
      statusLine = `HTTP/1.1 ${httpStatus}`,
      contentType,
      kind = 'data',
      parentCaptureId = null,
      cursor = null,
      observedAt,
      note,
    } = cap;

    if (!(body instanceof Uint8Array)) throw new Error('body 必须是 Uint8Array');
    if (!KINDS.includes(kind)) throw new Error(`未知的段类型: ${kind}`);

    // ── 第 1 步：分配序号（先分配后写，崩溃留空洞而非重复）
    const captureId = makeCaptureId(this._bundleId, this._seq.next());
    const warcRecordId = newWarcRecordId();

    const block = buildHttpResponseBlock({ statusLine, headers, body });
    const record = buildWarcRecord({
      type: 'response',
      recordId: warcRecordId,
      date: this._now(),
      targetUri: url,
      contentType: 'application/http;msgtype=response',
      headers: [
        ['WARC-Block-Digest', await sha1Base32(block)],
        ['WARC-Payload-Digest', await sha1Base32(body)],
      ],
      block,
    });

    // ── 第 2 步：WARC 记录先落盘
    const loc = await this._segmentWriters.get(kind).append(record, captureId);

    // ── 第 3 步：再写 index 行
    //
    // 顺序不能换：先写 index 会留下指向不存在记录的索引项，下游按 offset
    // 读会读到一段别的东西。反过来最坏只是一条孤儿记录，浪费点空间。
    await this._index.append({
      capture_id: captureId,
      warc_record_id: warcRecordId,
      segment: loc.segment,
      offset: loc.offset,
      length: loc.length,
      url,
      url_key: urlKey(url),
      url_key_rules: URL_KEY_RULES_VERSION,
      intent,
      route_key: routeKey,
      surface,
      verdict,
      capture_fidelity: captureFidelity,
      observed_at: observedAt ?? nowRfc3339(),
      http_status: httpStatus,
      content_type: contentType,
      content_sha256: await sha256Hex(body),
      parent_capture_id: parentCaptureId,
      cursor,
      ...(note ? { note } : {}),
    });

    // ── 第 4 步：状态更新
    // TODO: checkpoint 落地后接在这里（A5）。现在还没有需要持久化的抓取状态。

    this._debug.captures += 1;
    this._debug.byKind[kind] += 1;

    return { captureId, ...loc };
  }

  /** @param {object} entry 见 manifest-builder 的 coverageEntry */
  addCoverage(entry) {
    this._manifest.addCoverage(entry);
    return this;
  }

  /** @param {object} entry 见 manifest-builder 的 crawlStateEntry */
  addCrawlState(entry) {
    this._manifest.addCrawlState(entry);
    return this;
  }

  /**
   * 收尾：汇总各段、写 manifest.json 与 README.txt。
   *
   * @param {object} [opts]
   * @param {'in_progress' | 'complete' | 'aborted'} [opts.status]
   * @param {string} [opts.notes]
   * @returns {Promise<object>} 写出的 manifest
   */
  async finalize({ status = 'complete', notes } = {}) {
    /** @type {object[]} */
    const segments = [];
    for (const writer of this._segmentWriters.values()) {
      segments.push(...(await writer.finalize()));
    }
    segments.sort((a, b) => (a.filename < b.filename ? -1 : 1));

    const index = await this._index.finalize();

    const manifest = this._manifest.build({
      status,
      completedAt: status === 'complete' ? toRfc3339(this._now()) : null,
      segments,
      index,
      counts: this._index.counts(),
      perSegmentIndexCounts: this._index.perSegmentCounts(),
      notes,
    });

    await this._store.replace('manifest.json', ManifestBuilder.serialize(manifest));
    await this._store.replace('README.txt', new TextEncoder().encode(renderReadme(this._bundleId)));

    return manifest;
  }

  /** TODO(debug): 与 _debug 一起删。 */
  debugStats() {
    return { ...this._debug, lastSeq: this._seq.last };
  }
}

/**
 * bundle 里的 README.txt。
 *
 * 这**不是文档，是档案的一部分**：目标读者包括若干年后偶然拿到这个目录、
 * 而项目本身可能早已不在的人。所以必须中英双语、纯文本、自包含。
 *
 * @param {string} bundleId
 */
export function renderReadme(bundleId) {
  return `doubak 备份档案 / doubak backup bundle
======================================

规范版本 / Spec version: bundle/1.0
档案编号 / Bundle ID:    ${bundleId}

这是什么
--------
这是从豆瓣 (douban.com) 抓取的个人数据存档，由 doubak 生成。
它保存的是抓取当时的原始网页与接口响应，而不只是提取出来的数据。

文件说明
--------
  manifest.json      本次抓取的清单：抓了谁、产出哪些文件、走到了哪里。
  index-*.ndjson     每行一条抓取记录（JSON）。用 jq 即可查阅，无需专门工具。
  data-*.warc.gz     网页与接口响应，标准 WARC 格式。
  assets-*.warc.gz   你自己上传的图片。
  catalog-*.warc.gz  作品条目详情页等目录数据。删掉它不影响你自己写的内容，
                     但会失去离线重新生成完整网站的能力。
  checkpoint.json    仅在抓取未完成时存在，用于续抓。

怎么打开
--------
  WARC 是国际通行的网页存档格式 (ISO 28500)，可用以下工具打开：
    - ReplayWeb.page   https://replayweb.page/   （浏览器内直接打开，无需安装）
    - pywb             https://github.com/webrecorder/pywb
  索引是 NDJSON（每行一个 JSON 对象），可直接用 jq 查询，例如：
    jq -r '.url' index-*.ndjson

重要提示
--------
  index 中的 capture_fidelity 字段说明每条记录的保真程度。浏览器环境下
  无法取得完全未经处理的原始字节，该字段如实记录了实际成色。

  manifest 中的 coverage 记录了豆瓣当时声称的条目数量，但该数字【不可】
  作为档案完整性的依据——豆瓣的计数有时统计于内容屏蔽之前、有时之后。
  完整性证据在 crawl_state 中（连续性证明）。

完整规范 / Full specification
  https://spec.doubak.com/bundle/v1/


What this is
------------
A personal data archive captured from douban.com by doubak. It preserves the
original web pages and API responses as they were at capture time, not merely
the data extracted from them.

Files
  manifest.json      Inventory of this capture run.
  index-*.ndjson     One JSON object per line, one line per capture. Readable
                     with \`jq\`; no special tooling required.
  data-*.warc.gz     Pages and API responses, standard WARC format.
  assets-*.warc.gz   Images you uploaded yourself.
  catalog-*.warc.gz  Catalogue data such as work detail pages. Deleting these
                     does not touch anything you wrote, but you lose the
                     ability to regenerate a full site offline.
  checkpoint.json    Present only if the capture run is incomplete.

Opening it
  WARC is a standard web archive format (ISO 28500). Open with
  ReplayWeb.page (in-browser, no install) or pywb.

Important
  The \`capture_fidelity\` field states how faithful each record is; a browser
  cannot obtain fully unprocessed bytes, and this field records what was
  actually achieved. The \`coverage\` section records the item counts Douban
  claimed at capture time, but those counts MUST NOT be treated as proof of
  completeness -- see \`crawl_state\` for the actual completeness evidence.

Full specification: https://spec.doubak.com/bundle/v1/
`;
}
