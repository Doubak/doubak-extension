/**
 * 小状态的键值存储。
 *
 * 只放**指针类**的小东西：当前在抓哪个 bundle、放在哪个目录。真正的抓取状态
 * （checkpoint）按规范写在 bundle 目录里，不放这儿。
 *
 * 为什么要分开：service worker 启动时还不知道 bundle 是哪个，得先有个地方
 * 问一句「上次在抓什么」。这个地方必须极小、极稳，且不依赖 OPFS 已经打开。
 *
 * 与 FileStore 同样的做法：接口注入，内存实现给测试，chrome.storage 实现给
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

/**
 * chrome.storage.local 实现。
 *
 * 注意**不能用 `chrome.storage.sync`**：它有约 100 KB 的硬上限且会跨设备
 * 同步，无论如何都不该用来放抓取状态。
 *
 * @implements {KvStore}
 */
export class ChromeKvStore {
  /** @param {any} [area] 默认 chrome.storage.local */
  constructor(area) {
    this._area = area ?? globalThis.chrome?.storage?.local;
    if (!this._area) throw new Error('chrome.storage.local 不可用');
  }

  /** @param {string} key */
  async get(key) {
    const out = await this._area.get(key);
    return out?.[key];
  }

  /** @param {string} key @param {unknown} value */
  async set(key, value) {
    await this._area.set({ [key]: value });
  }

  /** @param {string} key */
  async remove(key) {
    await this._area.remove(key);
  }
}
