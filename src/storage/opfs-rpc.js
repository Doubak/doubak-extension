/**
 * OPFS 的 RPC 操作分发。两个 Worker 入口共用它。
 *
 * ## 为什么要有 Worker 这一层
 *
 * `createSyncAccessHandle()`（OPFS 唯一的原地读写手段）**只在专用 Worker 里
 * 可用**。窗口没有，**service worker 也没有**。所以任何要碰 OPFS 的上下文都得
 * 先起一个专用 Worker，再把操作转发进去。
 *
 * ## 为什么读写要分成两个入口
 *
 * | 入口 | 谁用 | 能写吗 |
 * |---|---|---|
 * | `opfs-worker.js` | 面板（窗口） | ✗ |
 * | `opfs-rw-worker.js` | offscreen document（抓取） | ✓ |
 *
 * 写 OPFS 的只该有**一条**路径。多一条就多一个能破坏偏移量的入口，而整个索引
 * 都建立在偏移量可信之上。面板只是看档案，没有任何理由能写——所以它连能力都
 * 不该有，而不是「有能力但不用」。
 *
 * 这条边界在**worker 一侧**执行，不是在客户端。客户端的限制只是约定，worker
 * 的拒绝才是保证。
 *
 * ## 字节怎么过界
 *
 * `Worker.postMessage` 用的是结构化克隆，`Uint8Array` 原样过去，还能转移所有权
 * 不复制。这和 `chrome.runtime.sendMessage` 完全不同——那条通道只认 JSON，
 * `Uint8Array` 过去会变成 `{"0":1,"1":2,...}`。这个差别决定了整个架构的形状
 * （见 src/offscreen/offscreen.js）。
 */

import { OpfsFileStore } from './opfs-store.js';

/** 会改动磁盘的操作。 */
export const WRITE_OPS = new Set(['append', 'replace', 'truncate', 'remove', 'destroy']);

/**
 * 处理一条 RPC 请求，返回 `{result, transfer}`。
 *
 * @param {object} msg
 * @param {object} opts
 * @param {boolean} opts.allowWrites
 * @param {(dir: string) => Promise<import('./file-store.js').FileStore>} opts.storeFor
 */
export async function handleOpfsRpc(msg, { allowWrites, storeFor }) {
  const { op, dir, name, offset, length, bytes } = msg ?? {};

  if (WRITE_OPS.has(op) && !allowWrites) {
    throw new Error(`这个 Worker 是只读的，不接受 ${op}——写 OPFS 只走抓取那一条路径`);
  }

  switch (op) {
    case 'listBundleDirs':
      return { result: await OpfsFileStore.listBundleDirs() };
    case 'destroy':
      return { result: await OpfsFileStore.destroy(dir) };

    case 'list':
      return { result: await (await storeFor(dir)).list() };
    case 'size':
      return { result: await (await storeFor(dir)).size(name) };
    case 'exists':
      return { result: await (await storeFor(dir)).exists(name) };
    case 'read': {
      const out = await (await storeFor(dir)).read(name, offset, length);
      // 转移所有权而不是复制。导出时一块 4 MiB，逐块复制没必要付。
      return { result: out, transfer: [out.buffer] };
    }

    case 'append':
      return { result: await (await storeFor(dir)).append(name, toBytes(bytes)) };
    case 'replace':
      return { result: await (await storeFor(dir)).replace(name, toBytes(bytes)) };
    case 'truncate':
      return { result: await (await storeFor(dir)).truncate(name, length) };
    case 'remove':
      return { result: await (await storeFor(dir)).remove(name) };

    default:
      throw new Error(`未知操作：${op}`);
  }
}

/**
 * 结构化克隆之后 `Uint8Array` 通常保持原样，但如果对面转移的是裸
 * `ArrayBuffer`，这里要包回来。多一句判断，省掉一类只在某些浏览器上出现的
 * 「bytes 不是 Uint8Array」。
 *
 * @param {unknown} b
 * @returns {Uint8Array}
 */
function toBytes(b) {
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  throw new Error(`写入需要 Uint8Array，收到 ${Object.prototype.toString.call(b)}`);
}

/**
 * OPFS 的同步访问句柄是**独占的**：同一个文件上已经有一个打开的句柄时，
 * `createSyncAccessHandle()` 会抛 `NoModificationAllowedError`。
 *
 * 两种撞法都真实存在：
 *
 * 1. **同一个 Worker 内**——RPC 消息是并发到达的，两条针对同一文件的操作会重叠。
 *    靠串行化彻底消除。
 * 2. **两个 Worker 之间**——面板（只读）在读索引，同时 offscreen 在往索引里追加。
 *    串行化管不到别人，只能重试。
 *
 * 第二种尤其阴：它只在「用户正好打开了档案页」时发生，也就是**抓取跑了几小时之后
 * 用户去看一眼进度**的那一刻。而它的表现是「写入档案时出错」，然后整场停机。
 *
 * @param {() => Promise<any>} fn
 */
async function withRetry(fn) {
  // 句柄冲突是**瞬时**的（对面开关一次句柄只占几毫秒），所以短退避几次足够。
  // 退避上限刻意小：真正长时间占着句柄意味着别处有 bug，那时应该报错而不是干等。
  const delays = [5, 20, 60, 150];
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const name = err?.name ?? '';
      const retryable = name === 'NoModificationAllowedError' || name === 'InvalidStateError';
      if (!retryable || i >= delays.length) throw err;
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
}

/**
 * 把 `handleOpfsRpc` 接到一个 Worker 的 `onmessage` 上。
 *
 * @param {object} opts
 * @param {boolean} opts.allowWrites
 */
export function serveOpfsRpc({ allowWrites }) {
  /** @type {Map<string, import('./file-store.js').FileStore>} */
  const open = new Map();
  const storeFor = async (dir) => {
    if (!open.has(dir)) open.set(dir, await OpfsFileStore.open(dir));
    return open.get(dir);
  };

  /**
   * 按「目录/文件」串行化。
   *
   * 同一个文件上的两次操作绝不重叠——句柄是独占的，重叠必然一方失败。不同文件之间
   * 照旧并发（段文件与索引就是两个文件，没有理由互相等）。
   *
   * @type {Map<string, Promise<unknown>>}
   */
  const chains = new Map();

  /** @param {string} key @param {() => Promise<any>} fn */
  function serialize(key, fn) {
    const prev = chains.get(key) ?? Promise.resolve();
    // 用 `.then(fn, fn)` 而不是 `.then(fn)`：前一个失败了后一个照样要跑，
    // 否则一次失败会把这个文件的队列永久堵死。
    const next = prev.then(fn, fn);
    chains.set(key, next.catch(() => {}));
    return next;
  }

  self.onmessage = async (e) => {
    const id = e.data?.id;
    try {
      const key = `${e.data?.dir ?? ''}/${e.data?.name ?? ''}`;
      const { result, transfer = [] } = await serialize(key, () =>
        withRetry(() => handleOpfsRpc(e.data, { allowWrites, storeFor })));
      self.postMessage({ id, ok: true, result }, transfer);
    } catch (err) {
      // Error 本身跨不过 postMessage，只能传字符串。name 要带上——上层要靠它
      // 认出 QuotaExceededError。
      self.postMessage({
        id,
        ok: false,
        error: String(err?.message ?? err),
        errorName: err?.name ?? 'Error',
      });
    }
  };
}
