/**
 * bundle 读取器：写入器的反面。
 *
 * 规范：doubak-data-specs/bundle/v1/SPEC.md
 *
 * ## 为什么值得单独有一个
 *
 * 界面要能预览档案——但这不是「浏览器」功能，而是**信任**功能。整个项目的
 * 承诺是「你有一份完整的档案」，而用户此刻没有任何办法看到这件事是真的。
 * 一份看不见的档案，只能靠信。
 *
 * 所以读取器的定位是：**验证工具**。它顺着 index 走，按 offset/length 把
 * WARC 记录取出来解压——走的正是规范承诺第三方能走的那条路。读得通，档案
 * 就是自洽的。
 *
 * ## 只读，不缓存，不建第二个真相来源
 *
 * 读取器**不写任何东西**，也不建索引缓存。档案本身就是真相；再存一份派生
 * 状态，就会有两个可能不一致的来源——那正是「任何东西都不写投影」这条规矩
 * 要防的事。
 */

import { gunzip } from '../core/warc.js';
import { indexFilename } from '../core/ids.js';

const dec = new TextDecoder();

/** HTTP 响应块里头与体的分隔。 */
const HEAD_SEP = '\r\n\r\n';

export class BundleReader {
  /**
   * @param {object} opts
   * @param {import('../storage/file-store.js').FileStore} opts.store
   * @param {string} opts.bundleId
   */
  constructor({ store, bundleId }) {
    this._store = store;
    this._bundleId = bundleId;
    /** @type {object[] | null} */
    this._index = null;
  }

  /**
   * 打开一个 bundle，顺带读出 manifest。
   *
   * @param {import('../storage/file-store.js').FileStore} store
   * @param {string} bundleId
   */
  static async open(store, bundleId) {
    const reader = new BundleReader({ store, bundleId });
    reader._manifest = await reader.manifest();
    return reader;
  }

  /**
   * 读 manifest。**没有就抛**——严格是对的：没有 manifest 的目录不是一份完整的
   * bundle，不能冒充。
   *
   * 但「还没抓完」也没有 manifest（它只在 `finalize()` 时写一次），所以想看
   * **进行中**的档案要用 `summary()`，它会退回到只靠 index 的那条路。见那里。
   *
   * @returns {Promise<object>}
   */
  async manifest() {
    if (!(await this._store.exists('manifest.json'))) {
      throw new Error('这个目录里没有 manifest.json，不是一个 bundle');
    }
    return JSON.parse(dec.decode(await this._store.read('manifest.json')));
  }

  /** manifest 在不在。抓取跑完 `finalize()` 之后才有。 */
  hasManifest() {
    return this._store.exists('manifest.json');
  }

  /**
   * 读回全部 index 行。
   *
   * 逐行解析，**坏行不吞掉**——一行读不出来意味着索引与段文件可能已经失去
   * 对应关系，那是必须让人知道的事。
   *
   * @returns {Promise<object[]>}
   */
  async index() {
    if (this._index) return this._index;

    const name = indexFilename(this._bundleId);
    if (!(await this._store.exists(name))) return (this._index = []);

    const text = dec.decode(await this._store.read(name));
    /** @type {object[]} */
    const out = [];
    for (const [i, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch (e) {
        throw new Error(`index 第 ${i + 1} 行无法解析：${e.message}`);
      }
    }
    return (this._index = out);
  }

  /**
   * 按 capture_id 取回一次捕获的完整内容。
   *
   * 这条路径就是规范承诺第三方能走的那条：顺着 index 的 offset/length 定位
   * gzip member，解压得到 WARC 记录，再从中切出 HTTP 响应。
   *
   * @param {string} captureId
   * @returns {Promise<{entry: object, warcRecord: string, status: string, headers: [string,string][], body: Uint8Array, bodyText: string}>}
   */
  async readCapture(captureId) {
    const entry = (await this.index()).find((e) => e.capture_id === captureId);
    if (!entry) throw new Error(`索引里没有这条捕获：${captureId}`);
    return this.readEntry(entry);
  }

  /** @param {object} entry */
  async readEntry(entry) {
    const member = await this._store.read(entry.segment, entry.offset, entry.length);
    const raw = await gunzip(member);
    const record = dec.decode(raw);

    // WARC 记录 = 头 + 空行 + 块；块本身是 HTTP 响应 = 状态行 + 头 + 空行 + 体
    const warcBodyAt = record.indexOf(HEAD_SEP);
    if (warcBodyAt < 0) throw new Error(`${entry.capture_id}: WARC 记录结构不完整`);

    const blockStart = warcBodyAt + HEAD_SEP.length;
    const httpHeadEnd = record.indexOf(HEAD_SEP, blockStart);
    const headText = record.slice(blockStart, httpHeadEnd < 0 ? undefined : httpHeadEnd);
    const lines = headText.split('\r\n');
    const status = lines[0] ?? '';
    /** @type {[string, string][]} */
    const headers = [];
    for (const line of lines.slice(1)) {
      const at = line.indexOf(':');
      if (at > 0) headers.push([line.slice(0, at), line.slice(at + 1).trim()]);
    }

    // 体要按**字节**切，不能按字符——中文一个字符占三个字节，按字符切会错位。
    const bodyByteOffset =
      httpHeadEnd < 0 ? raw.length : byteLengthOf(record.slice(0, httpHeadEnd + HEAD_SEP.length));
    // 记录末尾有两个 CRLF 的分隔，不属于载荷
    const body = raw.slice(bodyByteOffset, Math.max(bodyByteOffset, raw.length - 4));

    return {
      entry,
      warcRecord: record,
      status,
      headers,
      body,
      bodyText: dec.decode(body),
    };
  }

  /**
   * 档案概览，供界面显示。
   *
   * 刻意**不给百分比**：豆瓣的计数不可信，完整性看的是 crawl_state 里的
   * 连续性证明，不是「抓到的条数 ÷ 声称的条数」。
   *
   * ## 没有 manifest 也要能看
   *
   * `manifest.json` 只在 `finalize()` 时写一次。所以**整个抓取过程中它都不存在**
   * ——而抓取要跑几小时，用户一定会在那期间打开档案页。
   *
   * 早先这里直接 `await this.manifest()`，于是进行中的档案会得到一句
   * 「这个目录里没有 manifest.json，不是一个 bundle」。那句话对**正在写**的档案
   * 是错的，而且听起来像档案坏了——最糟的一种误报：它会让用户以为几小时的抓取白费，
   * 甚至去删掉一份其实完好的档案。
   *
   * 所以退回到只靠 `index.ndjson`：它每页都落盘，本来就是「哪些抓过了」的权威
   * 记录。拿不到的字段如实给 null，`status` 报 `in_progress`，让界面照实说
   * 「还没收尾」。
   */
  async summary() {
    const manifest = (await this.hasManifest()) ? await this.manifest() : null;
    const index = await this.index();

    /** @type {Record<string, number>} */
    const byVerdict = {};
    /** @type {Record<string, {count: number, bytes: number}>} */
    const byRoute = {};
    for (const e of index) {
      byVerdict[e.verdict] = (byVerdict[e.verdict] ?? 0) + 1;
      const r = (byRoute[e.route_key] ??= { count: 0, bytes: 0 });
      r.count += 1;
      r.bytes += e.length;
    }

    // 没有 manifest 时体积从 index 累加：段文件里除了记录还有 gzip 头尾，所以
    // 这是个**下界**而不是精确值。宁可少报也不多报——多报会让用户以为已经抓了
    // 更多东西。
    const totalBytes = manifest
      ? (manifest.segments ?? []).reduce((n, s) => n + (s.bytes ?? 0), 0)
      : index.reduce((n, e) => n + (e.length ?? 0), 0);

    return {
      bundleId: manifest?.bundle_id ?? this._bundleId,
      // 没有 manifest 就是还没收尾。这是事实陈述，不是错误。
      status: manifest?.status ?? 'in_progress',
      hasManifest: Boolean(manifest),
      account: manifest?.account ?? null,
      createdAt: manifest?.created_at ?? null,
      completedAt: manifest?.completed_at ?? null,
      captures: index.length,
      segments: manifest?.segments ?? [],
      totalBytes,
      // 体积是估的还是准的，界面要能分辨——否则它只能猜着说。
      totalBytesExact: Boolean(manifest),
      byVerdict,
      byRoute,
      // 覆盖率证据是收尾时才攒的。进行中给空数组而不是编一个，
      // 免得界面显示出一份看起来很完整的假证据。
      coverage: manifest?.coverage ?? [],
      crawlState: manifest?.crawl_state ?? [],
      // 这一份接在谁后面（增量）。null = 全量。界面要靠它说清「捕获条数比上次
      // 小是正常的」——增量档案只含新增的部分。
      previousBundleId: manifest?.previous_bundle_id ?? null,
    };
  }

  /**
   * 自检：顺着 index 把每条记录都取一遍。
   *
   * 这是**用户能自己按的那个「验一验」按钮**背后的东西。它做的事和规范的
   * 参考校验器同源：不信任何声明，直接去段文件里把字节取出来。
   *
   * @param {object} [opts]
   * @param {number} [opts.limit]  只验前 N 条，用于大档案的快速抽查
   * @returns {Promise<{checked: number, ok: number, problems: Array<{captureId: string, error: string}>}>}
   */
  async verify({ limit = Infinity } = {}) {
    const index = await this.index();
    const problems = [];
    let checked = 0;

    for (const entry of index) {
      if (checked >= limit) break;
      checked += 1;
      try {
        const r = await this.readEntry(entry);
        if (!r.warcRecord.startsWith('WARC/')) {
          problems.push({ captureId: entry.capture_id, error: '解出来的不是 WARC 记录' });
        }
      } catch (e) {
        problems.push({ captureId: entry.capture_id, error: e.message });
      }
    }

    return { checked, ok: checked - problems.length, problems };
  }
}

/** @param {string} s */
function byteLengthOf(s) {
  return new TextEncoder().encode(s).length;
}
