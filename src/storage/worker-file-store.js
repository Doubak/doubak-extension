/**
 * 窗口侧的 FileStore：所有读操作转发给 Worker。
 *
 * 见 opfs-worker.js 开头——`createSyncAccessHandle()` 只能在 Worker 里用，
 * 而选目录、写出去只能在窗口里做。这个类就是那条边界的窗口一侧。
 *
 * ## 默认只读
 *
 * `readOnly`（默认 true）时写操作**立刻抛**，一个消息都不发。写 OPFS 只该有
 * 一条路径（抓取），多开一条就多一个能破坏偏移量的入口，而整个索引都建立在
 * 偏移量可信之上。
 *
 * 抛而不是静默返回：静默的空实现会让「为什么没写进去」变成一次漫长的排查。
 *
 * 客户端这条限制只是**约定**；真正的保证在 Worker 一侧——只读那个入口
 * （`opfs-worker.js`）会拒绝所有写操作，不管客户端怎么说。两层都要有：客户端
 * 那层给出好的报错，Worker 那层给出真的保证。
 */

/**
 * 请求编号在**模块级**递增，不是每个实例各数各的。
 *
 * 一个 Worker 上会同时挂着好几个 store（档案列表一个、每份档案一个），它们
 * 共用同一条消息通道。各数各的话两个实例会发出同号请求，而答复只按号找人——
 * 于是 A 的数据被交给 B。这种错不会抛异常，只会让你看到别的档案的字节。
 */
let nextId = 0;

/** @implements {Partial<import('./file-store.js').FileStore>} */
export class WorkerFileStore {
  /**
   * @param {object} opts
   * @param {Worker} opts.worker
   * @param {string} opts.dir  档案目录名
   * @param {boolean} [opts.readOnly]  默认 true
   */
  constructor({ worker, dir, readOnly = true }) {
    this._worker = worker;
    this._dir = dir;
    this._readOnly = readOnly;
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this._pending = new Map();

    // 用 addEventListener 而不是 onmessage：后者是独占的，第二个实例会把
    // 第一个的处理器顶掉，于是先建的那个 store 从此永远收不到答复。
    worker.addEventListener('message', (e) => {
      const { id, ok, result, error, errorName } = e.data ?? {};
      const p = this._pending.get(id);
      if (!p) return; // 不是给我的
      this._pending.delete(id);
      if (ok) {
        p.resolve(result);
        return;
      }
      // name 要还原：上层靠它认出 QuotaExceededError，而 Error 本身跨不过
      // postMessage，只能靠这两个字段重建。
      const err = new Error(error);
      if (errorName) err.name = errorName;
      p.reject(err);
    });
    worker.addEventListener('error', (e) => {
      // Worker 整个挂掉时，所有在飞的请求都不会再有答复了。不主动拒绝的话
      // 界面会永远停在「正在读取…」——那比报错难查得多。
      const err = new Error(`存储 Worker 出错：${e.message ?? e.type}`);
      for (const p of this._pending.values()) p.reject(err);
      this._pending.clear();
    });
  }

  /** @param {object} msg @param {Transferable[]} [transfer] */
  _call(msg, transfer = []) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._worker.postMessage({ id, dir: this._dir, ...msg }, transfer);
    });
  }

  /** @param {string} name @param {number} [offset] @param {number} [length] */
  read(name, offset, length) {
    return this._call({ op: 'read', name, offset, length });
  }

  /** @param {string} name */
  size(name) {
    return this._call({ op: 'size', name });
  }

  /** @param {string} name */
  exists(name) {
    return this._call({ op: 'exists', name });
  }

  list() {
    return this._call({ op: 'list' });
  }

  /**
   * 列出所有档案目录。不属于某一份档案，所以是静态的。
   * @param {Worker} worker
   * @returns {Promise<string[]>}
   */
  static listBundleDirs(worker) {
    return new WorkerFileStore({ worker, dir: '' })._call({ op: 'listBundleDirs' });
  }

  /** @param {string} op */
  _assertWritable(op) {
    if (this._readOnly) {
      throw new Error(`这个 WorkerFileStore 是只读的，不接受 ${op}——写 OPFS 只走抓取那一条路径`);
    }
  }

  /**
   * 写入**不转移** buffer 所有权，让结构化克隆复制一份。
   *
   * 转移过所有权，然后撤了。原因是它在这里根本不安全：
   *
   * 1. `postMessage` 转移的是**整个 ArrayBuffer**，而传进来的 `Uint8Array` 完全
   *    可能只是某个更大 buffer 上的一个视图（`subarray`）。转移它等于把调用方还要
   *    用的数据一起 detach 掉。
   * 2. detach 之后调用方那一侧的 `bytes.length` 变成 0。**没有任何异常**，只是
   *    数据悄悄空了——而这是往档案里写字节的路径。
   *
   * 一条 WARC 记录几十 KB，复制一次的代价接近零；OPFS 实测吞吐 45.5 MB/s，
   * 瓶颈从来不在这里。为一个可以忽略的收益换一类静默的数据损坏，是净亏。
   *
   * 读方向仍然转移（见 opfs-rpc.js）：那边的 buffer 是 Worker 刚分配、之后再也
   * 不碰的，转移是安全的。
   *
   * @param {string} name @param {Uint8Array} bytes
   */
  append(name, bytes) {
    this._assertWritable('append');
    return this._call({ op: 'append', name, bytes });
  }

  /** @param {string} name @param {Uint8Array} bytes */
  replace(name, bytes) {
    this._assertWritable('replace');
    return this._call({ op: 'replace', name, bytes });
  }

  /** @param {string} name @param {number} length */
  truncate(name, length) {
    this._assertWritable('truncate');
    return this._call({ op: 'truncate', name, length });
  }

  /** @param {string} name */
  remove(name) {
    this._assertWritable('remove');
    return this._call({ op: 'remove', name });
  }
}
