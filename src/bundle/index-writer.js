/**
 * index.ndjson 写入器。
 *
 * 规范：doubak-data-specs/bundle/v1/SPEC.md §6
 *
 * 这是整个 bundle 里唯一存放 doubak 专有元数据的地方——WARC 保持原味，
 * 不加任何私有扩展头。
 *
 * ## 为什么在写入时校验
 *
 * 本模块拒绝写出不符合规范的行，而不是留给事后的校验器去发现。因为等到
 * 校验器报错时，**bundle 已经写完了**，而抓取是不可逆的一步——重来一次
 * 意味着让用户重爬一遍，那正是这个项目最不能要求用户做的事。
 *
 * 校验的都是「事后不可恢复」或「带安全含义」的规则，不是形式主义。
 */

import { EMPTY_SHA256, sha256Hex } from '../core/digest.js';
import { isRfc3339WithOffset } from '../core/time.js';
import {
  VERDICTS,
  SURFACES,
  CAPTURE_FIDELITIES,
  REQUIRED_INDEX_FIELDS,
} from '../core/spec-constants.js';

/**
 * 字段输出顺序。
 *
 * 固定顺序让 index.ndjson 可读、可 diff，也让 `jq` 之外的粗暴手段（grep、
 * 肉眼）更好用——这份文件的目标读者包括十年后拿着它的陌生人。
 */
const FIELD_ORDER = [
  'capture_id',
  'warc_record_id',
  'segment',
  'offset',
  'length',
  'url',
  'url_key',
  'url_key_rules',
  'intent',
  'route_key',
  'surface',
  'verdict',
  'capture_fidelity',
  'observed_at',
  'http_status',
  'content_type',
  'content_sha256',
  'parent_capture_id',
  'cursor',
  'item_count',
  'item_time_range',
  'note',
];

// 以下取值全部来自 spec-constants.js，那是从规范的 JSON Schema 生成的。
// 手抄会让规范新增一个 verdict 之后，扩展继续把它当非法值拒掉而无人察觉。
const REQUIRED = REQUIRED_INDEX_FIELDS;
const VERDICT_SET = new Set(VERDICTS);
const SURFACE_SET = new Set(SURFACES);
const FIDELITY_SET = new Set(CAPTURE_FIDELITIES);

/**
 * @param {Record<string, unknown>} entry
 * @throws 不符合规范时抛，且信息里说明【为什么】这条规则存在
 */
export function assertValidEntry(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('index 行必须是对象');

  for (const field of REQUIRED) {
    if (entry[field] === undefined || entry[field] === null) {
      throw new Error(`index 行缺少必填字段 ${field}（此字段事后不可恢复）`);
    }
  }

  if (!VERDICT_SET.has(/** @type {string} */ (entry.verdict))) {
    throw new Error(
      `未知的 verdict: ${JSON.stringify(entry.verdict)}。` +
        `这是封闭词表，拼错必须失败——判不出来的响应应当按失败处理并停下。`,
    );
  }
  if (!SURFACE_SET.has(/** @type {string} */ (entry.surface))) {
    throw new Error(`未知的 surface: ${JSON.stringify(entry.surface)}（只能是 ${SURFACES.join(' / ')}）`);
  }
  if (!FIDELITY_SET.has(/** @type {string} */ (entry.capture_fidelity))) {
    throw new Error(`未知的 capture_fidelity: ${JSON.stringify(entry.capture_fidelity)}`);
  }

  if (!isRfc3339WithOffset(/** @type {string} */ (entry.observed_at))) {
    throw new Error(
      `observed_at 必须是带显式时区偏移的 RFC 3339，实际是 ${JSON.stringify(entry.observed_at)}。` +
        `丢掉偏移量会让海外时区的用户得到整体偏移数小时的水位线。`,
    );
  }

  if (!Number.isInteger(entry.offset) || /** @type {number} */ (entry.offset) < 0) {
    throw new Error(`offset 必须是 >=0 的整数: ${entry.offset}`);
  }
  if (!Number.isInteger(entry.length) || /** @type {number} */ (entry.length) < 1) {
    throw new Error(`length 必须是正整数: ${entry.length}`);
  }

  // SPEC §6.5.2：真实旧档案里出现过 7 个零字节文件，与一次会话失效同批
  // 产生，磁盘上没有任何失败痕迹——下游只会看到「文件在」。
  if (entry.content_sha256 === EMPTY_SHA256 && entry.verdict === 'ok') {
    throw new Error(
      '载荷为零长度却记为 verdict=ok。空响应必须如实判定，否则就是静默的数据丢失。',
    );
  }
}

/** 按固定顺序序列化，未提供的可选字段直接省略。 */
function serialize(entry) {
  /** @type {Record<string, unknown>} */
  const ordered = {};
  for (const key of FIELD_ORDER) {
    if (entry[key] !== undefined) ordered[key] = entry[key];
  }
  // 规范要求读者容忍未知字段且重写时不得丢弃，我们自己也照做
  for (const key of Object.keys(entry)) {
    if (!(key in ordered) && entry[key] !== undefined) ordered[key] = entry[key];
  }
  return JSON.stringify(ordered);
}

export class IndexWriter {
  /**
   * @param {object} opts
   * @param {import('../storage/file-store.js').FileStore} opts.store
   * @param {string} opts.filename  index-<bundle_id>.ndjson
   * @param {IndexStats} [opts.resume]  崩溃恢复时，已经写在文件里的那些行的统计
   */
  constructor({ store, filename, resume }) {
    if (!store) throw new Error('缺少 store');
    if (!filename) throw new Error('缺少 filename');
    this._store = store;
    this._filename = filename;

    // ── 恢复
    //
    // **少了这一段，任何被恢复过的抓取都收不了尾。**
    //
    // index 文件是追加写的，崩溃之后那些行还在；但这几个计数器活在内存里，
    // 新建一个 IndexWriter 就全归零。而段那边是**会**从磁盘恢复的
    // （`SegmentWriter` 收 `resume`），于是收尾时两边对不上：
    //
    //   record_count 为 219，但 index 中指向本段的行数为 0
    //
    // 那句话是对的——只是它描述的不是档案坏了，是我们忘了把计数读回来。
    // 而一场几小时的抓取必然跨越很多次 service worker 死亡，也就是说
    // **正常的完整抓取一次都收不了尾**。
    this._lineCount = resume?.lineCount ?? 0;

    /** @type {{by_verdict: Record<string, number>, by_surface: Record<string, number>, by_intent: Record<string, number>}} */
    this._counts = {
      by_verdict: { ...(resume?.counts?.by_verdict ?? {}) },
      by_surface: { ...(resume?.counts?.by_surface ?? {}) },
      by_intent: { ...(resume?.counts?.by_intent ?? {}) },
    };

    /** @type {Map<string, number>} 每段的行数，供 manifest 的 record_count 交叉核对 */
    this._perSegment = new Map(resume?.perSegment ?? []);
  }

  get filename() {
    return this._filename;
  }

  get lineCount() {
    return this._lineCount;
  }

  /**
   * 追加一行。校验不过就抛，且**什么都不写**——宁可抓取停下，也不要写出
   * 一份事后才发现不合规的档案。
   *
   * @param {Record<string, unknown>} entry
   */
  async append(entry) {
    assertValidEntry(entry);

    await this._store.append(this._filename, new TextEncoder().encode(serialize(entry) + '\n'));

    this._lineCount += 1;
    const bump = (bucket, key) => {
      if (typeof key === 'string') bucket[key] = (bucket[key] ?? 0) + 1;
    };
    bump(this._counts.by_verdict, entry.verdict);
    bump(this._counts.by_surface, entry.surface);
    bump(this._counts.by_intent, entry.intent);

    const seg = /** @type {string} */ (entry.segment);
    this._perSegment.set(seg, (this._perSegment.get(seg) ?? 0) + 1);
  }

  /** 汇总计数，供 manifest。全部可从 index.ndjson 重算，因此是可选字段。 */
  counts() {
    return {
      by_verdict: { ...this._counts.by_verdict },
      by_surface: { ...this._counts.by_surface },
      by_intent: { ...this._counts.by_intent },
    };
  }

  /**
   * @typedef {object} IndexStats
   * @property {number} lineCount
   * @property {{by_verdict: Record<string, number>, by_surface: Record<string, number>, by_intent: Record<string, number>}} counts
   * @property {Array<[string, number]> | Map<string, number>} perSegment
   */

  /** 每段的行数。manifest 里每段的 record_count 必须与之相等。 */
  perSegmentCounts() {
    return new Map(this._perSegment);
  }

  /**
   * 收尾：读回整个 index 文件，算摘要，**并按文件重算行数与每段计数**。
   *
   * ## 为什么按文件重算，而不是用内存里的累加
   *
   * 因为**文件才是权威**。内存里的计数器活在一个随时会被杀掉的 service worker 里，
   * 而 index 是追加写的、每页落盘。两者一旦分叉，分叉的一定是内存那边。
   *
   * 这不是假想：`IndexWriter` 原本压根没有恢复路径，于是任何被恢复过的抓取收尾时
   * 都会撞上
   *
   *     record_count 为 219，但 index 中指向本段的行数为 0
   *
   * ——段那边从磁盘恢复了，index 这边从零开始。而一场几小时的抓取必然跨越很多次
   * worker 死亡，也就是说**正常的完整抓取一次都收不了尾**。
   *
   * 恢复路径现在有了（见构造函数），但那只解决了「这一次」。按文件重算是结构性的：
   * 内存计数器往后再怎么错，也不会写进 manifest。
   *
   * 代价是把 index 再解析一遍。这个文件本来就要整份读进来算 sha256，多一次解析
   * 在收尾时跑一次，可以忽略。
   *
   * 与段的交叉核对因此变得更硬了：它现在比的是「段自己声称写了多少条记录」与
   * 「index 文件里真的有多少行指向它」——两个独立来源。
   *
   * @returns {Promise<{filename: string, sha256: string, line_count: number}>}
   */
  async finalize() {
    const bytes = (await this._store.exists(this._filename))
      ? await this._store.read(this._filename)
      : new Uint8Array(0);

    this._recountFromFile(bytes);

    return {
      filename: this._filename,
      sha256: await sha256Hex(bytes),
      line_count: this._lineCount,
    };
  }

  /**
   * 按文件内容重建三个计数器。
   *
   * 解析不动的行**跳过而不抛**：崩溃可能在末尾留半行，那属于 `recoverBundle()`
   * 的职责，不该在收尾时把一份本来能救的档案变成异常。
   *
   * @param {Uint8Array} bytes
   */
  _recountFromFile(bytes) {
    const text = new TextDecoder().decode(bytes);
    let lines = 0;
    const counts = { by_verdict: {}, by_surface: {}, by_intent: {} };
    /** @type {Map<string, number>} */
    const perSegment = new Map();
    const bump = (bucket, key) => {
      if (typeof key === 'string') bucket[key] = (bucket[key] ?? 0) + 1;
    };

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      lines += 1;
      bump(counts.by_verdict, e.verdict);
      bump(counts.by_surface, e.surface);
      bump(counts.by_intent, e.intent);
      if (typeof e.segment === 'string') {
        perSegment.set(e.segment, (perSegment.get(e.segment) ?? 0) + 1);
      }
    }

    this._lineCount = lines;
    this._counts = counts;
    this._perSegment = perSegment;
  }
}
