/**
 * 小状态的键值存储。
 *
 * 只放**指针类**的小东西：当前在抓哪个 bundle、放在哪个目录。真正的抓取状态
 * （checkpoint）按规范写在 bundle 目录里，不放这儿。
 *
 * 为什么要分开：service worker 启动时还不知道 bundle 是哪个，得先有个地方
 * 问一句「上次在抓什么」。这个地方必须极小、极稳，且不依赖 OPFS 已经打开。
 *
 * 与 FileStore 同样的做法：接口注入，内存实现给测试，IndexedDB 实现给
 * 浏览器。监管与恢复逻辑因此完全可以在 Node 里测。
 */

/**
 * @typedef {object} KvStore
 * @property {(key: string) => Promise<unknown>} get
 * @property {(key: string, value: unknown) => Promise<void>} set
 * @property {(key: string) => Promise<void>} remove
 */

/** @implements {KvStore} */
export class MemoryKvStore {
  constructor() {
    /** @type {Map<string, string>} */
    this._map = new Map();
  }

  /** @param {string} key */
  async get(key) {
    const raw = this._map.get(key);
    return raw === undefined ? undefined : JSON.parse(raw);
  }

  /** @param {string} key @param {unknown} value */
  async set(key, value) {
    // 存序列化后的副本：避免调用方之后改自己的对象，把已保存的状态一起改掉。
    // 这类「共享引用导致状态悄悄变化」的 bug 在崩溃恢复场景里极难查。
    this._map.set(key, JSON.stringify(value));
  }

  /** @param {string} key */
  async remove(key) {
    this._map.delete(key);
  }
}

/*
 * 这里曾经有一个 `ChromeKvStore`（`chrome.storage.local`）。删掉了。
 *
 * 原因不是它不好用，而是**它在 offscreen document 里压根不可用**——而抓取跑在
 * 那里。让 offscreen 借道 service worker 会形成一个请求/响应环（SW 正 await
 * offscreen 的响应，offscreen 又 await SW），实际表现是「刚 set 完就 get 不到」。
 *
 * 换成 `IdbKvStore`：IndexedDB 是普通 DOM/Worker API，service worker、offscreen、
 * 窗口都能直接用，同源同库。这本来也是设计里写的（DESIGN.md F-10b）。
 *
 * 连带结果：`storage` 权限不再需要，已从 manifest 里删掉。少一条权限就少一条要向
 * 用户解释的东西。
 */
