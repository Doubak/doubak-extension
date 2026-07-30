/**
 * IndexedDB 实现的 KvStore。抓取状态（当前 bundle 指针 + checkpoint）就存这里。
 *
 * 设计：DESIGN.md F-10b（「进度状态全在 IndexedDB」）
 *
 * ## 为什么不是 `chrome.storage.local`
 *
 * 一开始用的是它，然后撞上了一个**架构性**的死结：
 *
 * offscreen document **拿不到 `chrome.storage`**（它只有一小部分扩展 API）。
 * 所以第一版让 offscreen 经由消息借道 service worker 去读写。但抓取是这样开始的：
 *
 * ```
 * service worker ──「开始抓取」──▶ offscreen        （SW 在 await 这个响应）
 *                                    │
 *                 ◀──「帮我写 checkpoint」──┘        （offscreen 又在 await SW）
 * ```
 *
 * 一个请求/响应**环**。它在浏览器里的表现是：`setCurrentRun()` 看起来成功了，
 * 紧接着的 `getCurrentRun()` 却拿不到东西，于是报「还没有 setCurrentRun，无处写
 * checkpoint」——一句完全指不到真实原因的话。
 *
 * IndexedDB 没有这个问题：它是**普通的 DOM/Worker API，不是 `chrome.*`**，
 * 在 service worker、offscreen document、窗口里都能直接用。同源同库，两边看到的
 * 是同一份数据，谁都不需要求谁。
 *
 * 而且这本来就是设计里写的（F-10b）——`chrome.storage.local` 是我的偏离。
 *
 * 顺带的好处：**offscreen 落 checkpoint 不再依赖 service worker 当时活着**。
 * 而 service worker 随时会被杀，正是这个项目最核心的约束之一。
 *
 * ## 为什么值得为几百字节动用 IndexedDB
 *
 * 因为存的东西小，恰恰说明这里的成本不重要，而**正确性**很重要：checkpoint 是
 * 「被杀等于可恢复的空操作」这条保证的全部依据。一页写一次，几百字节，
 * IndexedDB 完全不吃力。
 *
 * ## 每次操作开一次连接
 *
 * 和 `OpfsFileStore` 同样的取舍：缓存连接要管生命周期、要保证异常路径上一定关闭，
 * 而崩溃恢复恰恰是异常路径最密集的地方。这里的写入频率是「每页一次」，
 * 与之相比连接开销可以忽略。有实测支撑就不必自作聪明（见 opfs-store.js）。
 */

export const DB_NAME = 'doubak';
export const DB_VERSION = 1;
export const STORE_NAME = 'kv';

/**
 * @implements {import('./kv-store.js').KvStore}
 */
export class IdbKvStore {
  /**
   * @param {object} [opts]
   * @param {IDBFactory} [opts.idb]  注入用；默认 globalThis.indexedDB
   * @param {string} [opts.dbName]
   */
  constructor({ idb, dbName = DB_NAME } = {}) {
    this._idb = idb ?? globalThis.indexedDB;
    if (!this._idb) {
      throw new Error(
        'IndexedDB 不可用。抓取状态必须能持久化——没有它，被杀一次就等于丢掉整场进度。',
      );
    }
    this._dbName = dbName;
  }

  /** @returns {Promise<IDBDatabase>} */
  _open() {
    return new Promise((resolve, reject) => {
      const req = this._idb.open(this._dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('打不开 IndexedDB'));
      // 别的标签页占着旧版本时会走到这里。直说，别让它无声地挂着。
      req.onblocked = () => reject(new Error('IndexedDB 升级被其它页面阻塞，请关掉其它豆备页面再试'));
    });
  }

  /**
   * 跑一个事务。
   *
   * 等的是 `transaction.oncomplete` 而**不是** `request.onsuccess`——后者早于真正
   * 提交。写完就认为落盘了，然后进程被杀，那一次写可能根本没提交，而
   * checkpoint 的全部意义就是「被杀之后还在」。
   *
   * @template T
   * @param {IDBTransactionMode} mode
   * @param {(store: IDBObjectStore) => IDBRequest} fn
   * @returns {Promise<T>}
   */
  async _tx(mode, fn) {
    const db = await this._open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const req = fn(tx.objectStore(STORE_NAME));
        /** @type {any} */
        let value;
        req.onsuccess = () => { value = req.result; };
        req.onerror = () => reject(req.error ?? new Error('IndexedDB 操作失败'));
        tx.oncomplete = () => resolve(value);
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务被中止'));
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务出错'));
      });
    } finally {
      db.close();
    }
  }

  /**
   * `async` 是刻意的：`set` / `remove` 都是 async，非法参数会变成 rejection。
   * 如果 `get` 同步抛，同一个类的三个方法就有两种失败形态，而调用方全都在
   * `await` ——那种不一致是纯粹的陷阱。
   *
   * @param {string} key
   */
  async get(key) {
    assertKey(key);
    return this._tx('readonly', (s) => s.get(key));
  }

  /** @param {string} key @param {unknown} value */
  async set(key, value) {
    assertKey(key);
    await this._tx('readwrite', (s) => s.put(value, key));
  }

  /** @param {string} key */
  async remove(key) {
    assertKey(key);
    await this._tx('readwrite', (s) => s.delete(key));
  }
}

/** @param {string} key */
function assertKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`键必须是非空字符串: ${JSON.stringify(key)}`);
  }
}
