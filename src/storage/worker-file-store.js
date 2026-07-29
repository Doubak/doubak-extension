/**
 * 窗口侧的 FileStore：所有读操作转发给 Worker。
 *
 * 见 opfs-worker.js 开头——`createSyncAccessHandle()` 只能在 Worker 里用，
 * 而选目录、写出去只能在窗口里做。这个类就是那条边界的窗口一侧。
 *
 * ## 为什么只实现 FileStore 的一半
 *
 * 它只有 `read` / `size` / `list` / `exists`。写操作**故意缺席**：写 OPFS
 * 的只有抓取那一条路径，多开一条就等于多一个能破坏偏移量的入口，而整个索引
 * 都建立在偏移量可信之上。缺的那几个方法调用即抛，不是静默返回——静默的
 * 空实现会让「为什么没写进去」变成一次漫长的排查。
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
   */
  constructor({ worker, dir }) {
    this._worker = worker;
    this._dir = dir;
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this._pending = new Map();

    // 用 addEventListener 而不是 onmessage：后者是独占的，第二个实例会把
    // 第一个的处理器顶掉，于是先建的那个 store 从此永远收不到答复。
    worker.addEventListener('message', (e) => {
      const { id, ok, result, error } = e.data ?? {};
      const p = this._pending.get(id);
      if (!p) return; // 不是给我的
      this._pending.delete(id);
      ok ? p.resolve(result) : p.reject(new Error(error));
    });
    worker.addEventListener('error', (e) => {
      // Worker 整个挂掉时，所有在飞的请求都不会再有答复了。不主动拒绝的话
      // 界面会永远停在「正在读取…」——那比报错难查得多。
      const err = new Error(`存储 Worker 出错：${e.message ?? e.type}`);
      for (const p of this._pending.values()) p.reject(err);
      this._pending.clear();
    });
  }

  /** @param {object} msg */
  _call(msg) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._worker.postMessage({ id, dir: this._dir, ...msg });
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

  async append() { throw new Error('WorkerFileStore 是只读的：写 OPFS 只走抓取那一条路径'); }
  async replace() { throw new Error('WorkerFileStore 是只读的：写 OPFS 只走抓取那一条路径'); }
  async truncate() { throw new Error('WorkerFileStore 是只读的：写 OPFS 只走抓取那一条路径'); }
  async remove() { throw new Error('WorkerFileStore 是只读的：写 OPFS 只走抓取那一条路径'); }
}
