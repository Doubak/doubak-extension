/**
 * 文件存储抽象。
 *
 * bundle 写入器只认这个接口，不认 OPFS。这样最需要正确性的那部分逻辑
 * （偏移量、段轮转、崩溃恢复）可以完全在 Node 里测，不必启动浏览器。
 *
 * 两个实现：
 * - `MemoryFileStore`（本文件）—— 测试用，也是崩溃场景的模拟器
 * - `OpfsFileStore`（浏览器）—— 真正跑的时候用
 *
 * ## 接口为什么长这样
 *
 * 只有五个操作，都是 bundle 写入器真正需要的：
 *
 * - `append`   —— 抓到一条写一条，不攒批
 * - `size`     —— 下一条记录的偏移量就是当前文件长度；也用于判断该不该轮转
 * - `read`     —— 崩溃恢复要读段尾；导出要读全文
 * - `truncate` —— 崩溃恢复要把撕裂的尾巴切掉
 * - `replace`  —— manifest / checkpoint 是整体重写，不是追加
 *
 * 刻意【没有】随机位置写入。段文件只允许在末尾追加或从末尾截断——中间
 * 一旦可写，偏移量就不再可信，而整个索引都建立在偏移量可信之上。
 */

/**
 * @typedef {object} FileStore
 * @property {(name: string, bytes: Uint8Array) => Promise<void>} append
 *   追加到文件末尾。文件不存在则创建。
 * @property {(name: string, bytes: Uint8Array) => Promise<void>} replace
 *   整体替换文件内容。
 * @property {(name: string) => Promise<number>} size
 *   字节数。文件不存在返回 0。
 * @property {(name: string, offset?: number, length?: number) => Promise<Uint8Array>} read
 *   读取。不给范围则读全文。越界读取会抛。
 * @property {(name: string, length: number) => Promise<void>} truncate
 *   截断到指定长度。length 大于当前长度会抛（那是在要求补零，不是截断）。
 * @property {(name: string) => Promise<boolean>} exists
 * @property {() => Promise<string[]>} list  文件名，字典序
 * @property {(name: string) => Promise<void>} remove  不存在则静默通过
 */

/** @param {string} name */
function assertName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`文件名不能为空: ${JSON.stringify(name)}`);
  }
  // 段文件名由 ids.js 生成，这里挡的是拼接错误导致的路径穿越
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(`文件名不得含路径分隔符: ${JSON.stringify(name)}`);
  }
}

/**
 * 内存实现。
 *
 * 除了给测试用，它还是**崩溃场景的模拟器**：`truncate` 可以把段文件切在
 * 任意字节上，用来构造「gzip member 写了一半」的状态，这正是崩溃恢复
 * 必须处理的输入。
 *
 * @implements {FileStore}
 */
export class MemoryFileStore {
  constructor() {
    /** @type {Map<string, Uint8Array>} */
    this._files = new Map();

  }

  /** @param {string} name @param {Uint8Array} bytes */
  async append(name, bytes) {
    assertName(name);
    if (!(bytes instanceof Uint8Array)) throw new Error('append 需要 Uint8Array');

    const prev = this._files.get(name);
    if (prev === undefined) {
      this._files.set(name, bytes.slice());
    } else {
      const next = new Uint8Array(prev.length + bytes.length);
      next.set(prev, 0);
      next.set(bytes, prev.length);
      this._files.set(name, next);
    }

  }

  /** @param {string} name @param {Uint8Array} bytes */
  async replace(name, bytes) {
    assertName(name);
    if (!(bytes instanceof Uint8Array)) throw new Error('replace 需要 Uint8Array');
    this._files.set(name, bytes.slice());
  }

  /** @param {string} name */
  async size(name) {
    assertName(name);
    return this._files.get(name)?.length ?? 0;
  }

  /** @param {string} name @param {number} [offset] @param {number} [length] */
  async read(name, offset, length) {
    assertName(name);
    const data = this._files.get(name);
    if (data === undefined) throw new Error(`文件不存在: ${name}`);

    if (offset === undefined && length === undefined) return data.slice();

    const start = offset ?? 0;
    const end = length === undefined ? data.length : start + length;
    if (start < 0 || end > data.length || start > end) {
      throw new Error(`读取越界: ${name} [${start}, ${end}) 文件长度 ${data.length}`);
    }
    return data.slice(start, end);
  }

  /** @param {string} name @param {number} length */
  async truncate(name, length) {
    assertName(name);
    const data = this._files.get(name);
    if (data === undefined) throw new Error(`文件不存在: ${name}`);
    if (!Number.isInteger(length) || length < 0) {
      throw new Error(`截断长度必须是 >=0 的整数: ${length}`);
    }
    if (length > data.length) {
      // 允许的话就成了「补零扩展」，那会悄悄在段文件里插入合法字节，
      // 而崩溃恢复恰恰依赖「尾部要么完整要么解压失败」这个性质。
      throw new Error(`截断长度 ${length} 大于文件长度 ${data.length}`);
    }
    this._files.set(name, data.slice(0, length));
  }

  /** @param {string} name */
  async exists(name) {
    assertName(name);
    return this._files.has(name);
  }

  async list() {
    return [...this._files.keys()].sort();
  }

  /** @param {string} name */
  async remove(name) {
    assertName(name);
    this._files.delete(name);
  }

  // ---- 仅供测试与开发使用 ----

  /** 全部文件的快照，用于断言与导出。 */
  snapshot() {
    /** @type {Record<string, Uint8Array>} */
    const out = {};
    for (const [k, v] of this._files) out[k] = v.slice();
    return out;
  }

  /** 总字节数。 */
  totalBytes() {
    let n = 0;
    for (const v of this._files.values()) n += v.length;
    return n;
  }

}
