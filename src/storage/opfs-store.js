/**
 * OPFS 实现的 FileStore。
 *
 * 与 `MemoryFileStore` 满足同一份契约（test/helpers/file-store-contract.js），
 * 所以 bundle 写入器不需要知道自己写在哪里。
 *
 * ## 为什么用 createSyncAccessHandle 而不是 createWritable
 *
 * `createWritable()` 的写入语义是「写进一个临时副本，close 时整体换上去」。
 * 对一个几百 MB 的段文件，每次追加一条记录都要复制一遍整个文件——完全不可用。
 *
 * `createSyncAccessHandle()` 是真正的原地读写，有 `write(buf, {at})`、
 * `truncate()`、`getSize()`。代价是它**只能在 Worker 里用**，所以扩展里
 * 所有 OPFS 写入都要经过一个专用 Worker。
 *
 * ## 已知的性能取舍
 *
 * TODO(性能): 目前每次操作都开关一次 sync access handle。同一文件同时只能
 * 有一个 handle，缓存住当前段的 handle 能显著减少开销，但要处理好异常路径
 * 上的释放。先求正确，等实测到瓶颈再优化——真实抓取是几秒一页，不是热循环。
 */

/** @param {string} name */
function assertName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`文件名不能为空: ${JSON.stringify(name)}`);
  }
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(`文件名不得含路径分隔符: ${JSON.stringify(name)}`);
  }
}

/**
 * @implements {import('./file-store.js').FileStore}
 */
export class OpfsFileStore {
  /** @param {FileSystemDirectoryHandle} dir */
  constructor(dir) {
    this._dir = dir;
  }

  /**
   * 在 OPFS 根下打开（或创建）一个子目录。
   *
   * 每个 bundle 用自己的子目录，这样多个 bundle 并存时互不干扰，删除也只是
   * 删一个目录。
   *
   * @param {string} dirName
   * @returns {Promise<OpfsFileStore>}
   */
  static async open(dirName) {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
      throw new Error('当前环境没有 OPFS（navigator.storage.getDirectory 不可用）');
    }
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(dirName, { create: true });
    return new OpfsFileStore(dir);
  }

  /**
   * 取一个 sync access handle。
   *
   * @param {string} name
   * @param {boolean} create
   * @returns {Promise<FileSystemSyncAccessHandle>}
   */
  async _handle(name, create) {
    let fileHandle;
    try {
      fileHandle = await this._dir.getFileHandle(name, { create });
    } catch (e) {
      if (e?.name === 'NotFoundError') throw new Error(`文件不存在: ${name}`);
      throw e;
    }
    if (typeof fileHandle.createSyncAccessHandle !== 'function') {
      throw new Error(
        'createSyncAccessHandle 不可用。OPFS 的原地写入只能在 Worker 里进行——' +
          '扩展的所有 OPFS 写入都必须经过专用 Worker。',
      );
    }
    return fileHandle.createSyncAccessHandle();
  }

  /** @param {string} name @param {Uint8Array} bytes */
  async append(name, bytes) {
    assertName(name);
    if (!(bytes instanceof Uint8Array)) throw new Error('append 需要 Uint8Array');

    const h = await this._handle(name, true);
    try {
      // 追加 = 写在当前末尾。偏移量取自写入前的长度，与 MemoryFileStore 一致。
      h.write(bytes, { at: h.getSize() });
      h.flush();
    } finally {
      h.close();
    }
  }

  /** @param {string} name @param {Uint8Array} bytes */
  async replace(name, bytes) {
    assertName(name);
    if (!(bytes instanceof Uint8Array)) throw new Error('replace 需要 Uint8Array');

    const h = await this._handle(name, true);
    try {
      // 先截到 0，否则旧内容比新内容长时会留下残尾。
      h.truncate(0);
      h.write(bytes, { at: 0 });
      h.flush();
    } finally {
      h.close();
    }
  }

  /** @param {string} name */
  async size(name) {
    assertName(name);
    if (!(await this.exists(name))) return 0;
    const h = await this._handle(name, false);
    try {
      return h.getSize();
    } finally {
      h.close();
    }
  }

  /** @param {string} name @param {number} [offset] @param {number} [length] */
  async read(name, offset, length) {
    assertName(name);
    const h = await this._handle(name, false);
    try {
      const total = h.getSize();
      const start = offset ?? 0;
      const end = length === undefined ? total : start + length;
      if (start < 0 || end > total || start > end) {
        throw new Error(`读取越界: ${name} [${start}, ${end}) 文件长度 ${total}`);
      }
      const out = new Uint8Array(end - start);
      if (out.length > 0) h.read(out, { at: start });
      return out;
    } finally {
      h.close();
    }
  }

  /** @param {string} name @param {number} length */
  async truncate(name, length) {
    assertName(name);
    if (!Number.isInteger(length) || length < 0) {
      throw new Error(`截断长度必须是 >=0 的整数: ${length}`);
    }
    const h = await this._handle(name, false);
    try {
      const total = h.getSize();
      if (length > total) {
        // 允许的话就成了补零扩展，会在段文件里悄悄插入合法的零字节，
        // 而崩溃恢复依赖「尾部要么完整、要么解压失败」这个性质。
        throw new Error(`截断长度 ${length} 大于文件长度 ${total}`);
      }
      h.truncate(length);
      h.flush();
    } finally {
      h.close();
    }
  }

  /** @param {string} name */
  async exists(name) {
    assertName(name);
    try {
      await this._dir.getFileHandle(name, { create: false });
      return true;
    } catch (e) {
      if (e?.name === 'NotFoundError') return false;
      throw e;
    }
  }

  async list() {
    const names = [];
    for await (const name of this._dir.keys()) names.push(name);
    return names.sort();
  }

  /** @param {string} name */
  async remove(name) {
    assertName(name);
    try {
      await this._dir.removeEntry(name);
    } catch (e) {
      if (e?.name !== 'NotFoundError') throw e;
    }
  }

  /** 整个目录删掉。导出后清理用。 */
  static async destroy(dirName) {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry(dirName, { recursive: true });
    } catch (e) {
      if (e?.name !== 'NotFoundError') throw e;
    }
  }
}
