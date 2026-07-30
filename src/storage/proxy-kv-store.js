/**
 * 经由 service worker 读写 `chrome.storage.local` 的 KvStore。
 *
 * ## 为什么需要它
 *
 * **offscreen document 拿不到 `chrome.storage`。** 它虽然是扩展页面，却只有一小
 * 部分扩展 API 可用——`chrome.runtime`（消息）在，`chrome.storage` 不在。
 *
 * 这件事的发现过程值得记一笔：症状是点「开始抓取」报
 * 「chrome.storage.local 不可用」，而那句话在 service worker 里是不可能出现的
 * （`storage` 权限声明着、SW 里一直用得好好的）。真正抛它的是 offscreen 那一侧，
 * 但错误信息里没有任何上下文，看上去像是权限配错了。**所以这个类的错误信息
 * 一律带上「在哪个上下文」。**
 *
 * ## 走这条路要付什么、换到什么
 *
 * 付的是每次读写多一跳消息。可以接受：checkpoint 一页写一次，内容是个几百字节
 * 的小 JSON——和这条通道的能力正好匹配（它只认 JSON，而这里根本没有字节要传，
 * 与 WARC 记录完全相反，那才是抓取必须整条搬进 offscreen 的原因）。
 *
 * 换到的是**只有一处真正碰 `chrome.storage`**。哪个上下文有哪个 API 是 MV3 里
 * 最容易踩空的一类知识，把它收敛到一个地方，就少一整类「在这里能用、在那里不
 * 能用」的意外。
 *
 * ## 顺带：service worker 会被这些消息唤醒
 *
 * 如果 SW 正好死着，`sendMessage` 会把它拉起来再送达。这不是负担而是好事——
 * checkpoint 落盘因此不依赖 SW 当时活着。
 */

/** 消息类型。**刻意不带 `target`**：带了就会被 offscreen 自己的监听器抢走。 */
export const KV_MESSAGE = 'kv';

/**
 * @implements {import('./kv-store.js').KvStore}
 */
export class ProxyKvStore {
  /**
   * @param {object} [opts]
   * @param {(msg: object) => Promise<any>} [opts.send]  注入用；默认 chrome.runtime.sendMessage
   * @param {string} [opts.context]  出错时告诉人是谁在喊
   */
  constructor({ send, context = 'offscreen' } = {}) {
    this._send = send ?? ((msg) => globalThis.chrome.runtime.sendMessage(msg));
    this._context = context;
  }

  /** @param {string} op @param {object} extra */
  async _call(op, extra) {
    let r;
    try {
      r = await this._send({ type: KV_MESSAGE, op, ...extra });
    } catch (e) {
      throw new Error(`${this._context} 无法访问存储（消息没送到 service worker）：${e?.message ?? e}`);
    }
    // 没有答复通常意味着 SW 里没人处理这条消息。这比「存储坏了」更可能，也更
    // 值得直说——否则会有人去查配额。
    if (!r) throw new Error(`${this._context} 无法访问存储：service worker 没有答复 ${op}`);
    if (!r.ok) throw new Error(`${this._context} 存储操作失败（${op}）：${r.error}`);
    return r.value;
  }

  /** @param {string} key */
  get(key) {
    return this._call('get', { key });
  }

  /** @param {string} key @param {unknown} value */
  async set(key, value) {
    await this._call('set', { key, value });
  }

  /** @param {string} key */
  async remove(key) {
    await this._call('remove', { key });
  }
}

/**
 * service worker 那一侧的处理器。
 *
 * @param {object} msg
 * @param {import('./kv-store.js').KvStore} kv
 * @returns {Promise<{ok: true, value?: unknown} | {ok: false, error: string}>}
 */
export async function handleKvMessage(msg, kv) {
  try {
    switch (msg?.op) {
      case 'get':
        return { ok: true, value: await kv.get(msg.key) };
      case 'set':
        await kv.set(msg.key, msg.value);
        return { ok: true };
      case 'remove':
        await kv.remove(msg.key);
        return { ok: true };
      default:
        return { ok: false, error: `未知的存储操作：${msg?.op}` };
    }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
