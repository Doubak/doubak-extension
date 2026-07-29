/**
 * 专用 Worker：替窗口那一侧读 OPFS。
 *
 * ## 为什么非得有这么一层
 *
 * OPFS 的原地读写 `createSyncAccessHandle()` **只能在 Worker 里用**
 * （见 opfs-store.js 开头的说明）。而档案预览和导出都发生在窗口里——
 * `showDirectoryPicker()` 需要用户手势，只有窗口有。
 *
 * 于是两端各有各的限制，且**恰好互斥**：
 *
 * | | 窗口 | Worker |
 * |---|---|---|
 * | 读 OPFS（sync access handle） | ✗ | ✓ |
 * | 选目录、`createWritable()` 写出去 | ✓ | ✗ |
 *
 * 所以导出必然是跨这条边界的：Worker 读、窗口写，中间按块传。这不是架构
 * 洁癖，是浏览器逼出来的唯一形状。
 *
 * ## 只读
 *
 * 这个 Worker 刻意**不提供任何写操作**。写 OPFS 的只有抓取那一条路径，
 * 而它跑在 service worker 里，有自己的一套。多开一条写路径就等于多一个能
 * 破坏偏移量的入口，而整个索引都建立在偏移量可信之上。
 */

import { OpfsFileStore } from './opfs-store.js';

/** @type {Map<string, import('./file-store.js').FileStore>} */
const open = new Map();

/** @param {string} dir */
async function storeFor(dir) {
  if (!open.has(dir)) open.set(dir, await OpfsFileStore.open(dir));
  return open.get(dir);
}

self.onmessage = async (e) => {
  const { id, op, dir, name, offset, length } = e.data ?? {};
  try {
    let result;
    /** @type {Transferable[]} */
    const transfer = [];

    switch (op) {
      case 'listBundleDirs':
        result = await OpfsFileStore.listBundleDirs();
        break;
      case 'list':
        result = await (await storeFor(dir)).list();
        break;
      case 'size':
        result = await (await storeFor(dir)).size(name);
        break;
      case 'exists':
        result = await (await storeFor(dir)).exists(name);
        break;
      case 'read': {
        const bytes = await (await storeFor(dir)).read(name, offset, length);
        result = bytes;
        // 转移所有权而不是复制。4 MiB 一块，逐块结构化克隆的开销没必要付。
        transfer.push(bytes.buffer);
        break;
      }
      default:
        throw new Error(`未知操作：${op}`);
    }

    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    // Error 本身跨不过 postMessage，只能传字符串。
    self.postMessage({ id, ok: false, error: String(err?.message ?? err) });
  }
};
