/**
 * 解析器那八项契约，在 OPFS 上的实现。
 *
 * 解析器仓库里的 `bundle-source.js` 读文件系统，这一份读 OPFS。**只有这一层是
 * 两份实现**——「字节从哪儿来」本来就该各写各的，而「字节怎么解释」（`parse.js`
 * 及它依赖的全部抽取器）是逐字节抄过来的同一份。见 `src/vendor/README.md`。
 *
 * 契约就八项，由解析器仓库的 `test/portable.test.js` 钉着：
 *
 *     status · manifest · bundleId · index · crawlState · coverage · payload · close
 *
 * 其中只有 `payload(row)` 做 I/O，也正因为它，`parse()` 是 async 的。
 *
 * ## 不缓存整个段，因为根本不需要
 *
 * Node 那边有个明确的教训：段缓存一度每处理完一条捕获就清一次，于是同一个
 * 159 MB 的 catalog 段被读了两千多遍（十分钟 → 6 秒）。站点生成器也踩过同一个坑
 * （8 分钟 → 1.5 秒）。
 *
 * **这边不会有那个问题，而且不是因为小心，是因为读法不同。** OPFS 的
 * `read(name, offset, length)` 是真正的区间读——只取那条记录的那几 KB，不解压整个
 * 段。Node 那边要缓存整段，是因为 `readFileSync` 只能整读。
 *
 * 所以这里**故意不加缓存**：加了反而是把整个段搬进堆里，而一份真实档案的
 * catalog 段有 166 MB。
 *
 * ## `close()` 什么都不做，但必须留着
 *
 * 契约里有它，`parse()` 换档案时会调。这边没有要释放的东西，但方法不能缺——
 * 缺了只在跑到那一行时才炸，而那时已经解析了几千页。
 */

import { gunzip } from '../core/warc.js';
import { indexFilename } from '../core/ids.js';

const dec = new TextDecoder();

/** WARC 记录里头与体的分隔，也是 HTTP 响应里的。 */
const SEP = '\r\n\r\n';

export class OpfsBundleSource {
  /**
   * @param {object} opts
   * @param {import('../storage/worker-file-store.js').WorkerFileStore} opts.store
   * @param {string} opts.bundleId
   * @param {object[]} opts.index    已经读好的 index 行
   * @param {object|null} opts.manifest
   */
  constructor({ store, bundleId, index, manifest }) {
    this._store = store;
    this.bundleId = bundleId;
    this.index = index;
    this.manifest = manifest;
  }

  /**
   * 从一份已经扫好的档案目录建一个源。
   *
   * `scanBundleDirs()` 已经把 manifest 读过一遍了，所以这里只补 index。
   *
   * **`store` 是传进来的**，不是这里 new 的：面板给 `WorkerFileStore`，测试给
   * `MemoryFileStore`，而这个模块因此不依赖存储层的任何具体实现——它要的只是
   * `exists` / `read` 两个方法。
   *
   * @param {object} opts
   * @param {{exists: (n: string) => Promise<boolean>,
   *          read: (n: string, o?: number, l?: number) => Promise<Uint8Array>}} opts.store
   * @param {{bundleId: string, manifest: object|null}} opts.entry
   */
  static async open({ store, entry }) {
    const name = indexFilename(entry.bundleId);

    /** @type {object[]} */
    let index = [];
    if (await store.exists(name)) {
      const text = dec.decode(await store.read(name));
      for (const [i, line] of text.split('\n').entries()) {
        if (!line.trim()) continue;
        try {
          index.push(JSON.parse(line));
        } catch (e) {
          // 坏行**不吞掉**：一行读不出来意味着索引与段文件可能已经失去对应关系。
          throw new Error(`${entry.bundleId} 的 index 第 ${i + 1} 行无法解析：${e.message}`);
        }
      }
    }
    return new OpfsBundleSource({ store, bundleId: entry.bundleId, index, manifest: entry.manifest });
  }

  /**
   * 没有 manifest 就是 in_progress（它确实还没收尾）。
   *
   * **没有 manifest 的档案照样要解析**——里面 `verdict: ok` 的捕获是真实观测。
   * 见 canonical/INGESTION.md §2.3：该丢弃的是「凭它能下什么结论」，不是数据本身。
   */
  get status() {
    return this.manifest?.status ?? 'in_progress';
  }

  /** routeKey → crawl_state 那一行。没有 manifest 时是空表。 */
  get crawlState() {
    const out = new Map();
    for (const cs of this.manifest?.crawl_state ?? []) out.set(cs.route_key, cs);
    return out;
  }

  /**
   * routeKey → coverage 那一行。
   *
   * 用来**否掉**明显说不通的完整性声明，不用来授予权限（INGESTION.md §2：
   * 豆瓣的计数有时统计于审查之前、有时之后，证明不了完整）。
   */
  get coverage() {
    const out = new Map();
    for (const c of this.manifest?.coverage ?? []) out.set(c.route_key, c);
    return out;
  }

  /**
   * 按 index 的 offset/length 取出那条 gzip member 并解压，得到整条 WARC 记录。
   *
   * 走的正是规范承诺第三方能走的那条路。图片那一路也用它——**图片要的是原始
   * 字节，不能解码**，所以切分停在这一步，由调用方各取所需。
   *
   * @param {object} row index 里的一行
   * @returns {Promise<Uint8Array>}
   */
  async readRaw(row) {
    const member = await this._store.read(row.segment, row.offset, row.length);
    return gunzip(member);
  }

  /**
   * 取一条捕获的 HTTP 响应正文，解码成字符串。
   *
   * @param {object} row index 里的一行
   * @returns {Promise<string>}
   */
  async payload(row) {
    const raw = await this.readRaw(row);

    // WARC 记录 = WARC 头 + 空行 + 块；块 = HTTP 状态行 + 头 + 空行 + 正文。
    //
    // **按字节切，不按字符切。** 先解码再找分隔符会在中文上错位——一个汉字三个
    // 字节，而 `Content-Length` 数的是字节。解析器那一份在 Buffer 上做同一件事。
    const headEnd = indexOfSep(raw, 0);
    if (headEnd < 0) throw new Error(`${row.capture_id}: WARC 记录结构不完整`);

    const warcHead = dec.decode(raw.subarray(0, headEnd));
    const len = /^Content-Length: (\d+)$/m.exec(warcHead);
    if (!len) throw new Error(`${row.capture_id}: WARC 头里没有 Content-Length`);

    const blockStart = headEnd + SEP.length;
    const block = raw.subarray(blockStart, blockStart + Number(len[1]));
    const bodyAt = indexOfSep(block, 0);
    return dec.decode(bodyAt < 0 ? block : block.subarray(bodyAt + SEP.length));
  }

  /** 契约里有，这边没有要释放的东西。见文件头。 */
  close() {}
}

/**
 * 在字节里找 `\r\n\r\n`。
 *
 * `Uint8Array` 没有 `indexOf(子串)`，而 `Buffer` 有——这是解析器那份代码搬不过来
 * 的少数地方之一，所以这里自己写一个。
 *
 * @param {Uint8Array} bytes @param {number} from
 */
function indexOfSep(bytes, from) {
  for (let i = from; i + 3 < bytes.length; i += 1) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}
