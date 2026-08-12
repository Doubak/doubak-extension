/**
 * 一个假的 OPFS Worker：接同一套 RPC，底下换成 `MemoryFileStore`。
 *
 * ## 为什么值得有
 *
 * 面板里凡是碰存储的那几页（档案、存储、导入）此前**一次都没被执行过**。原因很实际：
 * `WorkerFileStore` 发消息出去等答复，而假 DOM 里的 `Worker` 是个空壳——
 * `postMessage` 什么都不做，于是那个 Promise 永远不落地，测试挂住。所以那几页只被
 * `node --check` 看过语法。
 *
 * 代价刚刚兑现过一次：存储页的
 *
 *     setStorageUsage(summarizeBundles)({ … })
 *
 * 括号打错了位置——语法合法，作用域检查也发现不了（它是「调用一次调用的结果」，
 * 名字一个都没少）。真实后果是**存储页整页打不开**，一直显示「统计不出来：
 * setStorageUsage(...) is not a function」。要抓住这一类，只能真的把它跑一遍。
 *
 * ## 它有意与真货共用什么
 *
 * 派发走的是生产代码里同一个 `handleOpfsRpc`，所以「导入模式拒绝没认领过的目录」
 * 这类判据在这里验就等于在生产路径上验。换掉的只有最底下的存储实现，以及
 * `listBundleDirs` / `destroy` 这两个直接落在 OPFS 根上的操作。
 */

import { handleOpfsRpc } from '../../src/storage/opfs-rpc.js';
import { MemoryFileStore } from '../../src/storage/file-store.js';
import { bundleIdFromDirName } from '../../src/core/ids.js';

/**
 * @param {object} [opts]
 * @param {boolean} [opts.allowWrites]
 * @param {boolean} [opts.importOnly]
 * @param {Map<string, MemoryFileStore>} [opts.dirs]  预置的目录
 */
export function fakeOpfsWorker({ allowWrites = false, importOnly = false, dirs = new Map() } = {}) {
  /** @type {Record<string, Function[]>} */
  const listeners = {};
  const claimed = new Set();
  // **必须与真 Worker 一样跨请求保留。** 每次调用现开一个新的话，
  // 「本次新建的文件」这条记录立刻就没了，于是同一份文件的第二个分块会被自己
  // 的写入边界拦下来 —— 而那是导入的正常形态（按块流式复制）。
  const owned = new Set();

  const storeFor = async (dir) => {
    if (!dirs.has(dir)) dirs.set(dir, new MemoryFileStore());
    return dirs.get(dir);
  };
  const listDirs = async () =>
    [...dirs.keys()].filter((d) => bundleIdFromDirName(d)).sort().reverse();
  const destroyDir = async (dir) => { dirs.delete(dir); };

  const emit = (data) => {
    for (const fn of listeners.message ?? []) fn({ data });
  };

  return {
    /** 测试直接读它来断言「盘上到底成了什么样」。 */
    dirs,
    claimed,
    owned,
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    postMessage(msg) {
      // 真 Worker 的答复是异步的。同步答复会让「先发两条、再等结果」这种顺序
      // 在测试里表现得与浏览器里不同，而那正是并发 bug 藏身的地方。
      queueMicrotask(async () => {
        try {
          const { result } = await handleOpfsRpc(msg, {
            allowWrites, importOnly, storeFor, listDirs, destroyDir, claimed, owned,
          });
          emit({ id: msg.id, ok: true, result });
        } catch (e) {
          emit({ id: msg.id, ok: false, error: String(e?.message ?? e), errorName: e?.name });
        }
      });
    },
  };
}

/**
 * 往假 Worker 里塞一份档案。
 *
 * @param {ReturnType<typeof fakeOpfsWorker>} worker
 * @param {string} dir
 * @param {Record<string, string | Uint8Array>} files
 */
export async function seedBundle(worker, dir, files) {
  const store = new MemoryFileStore();
  for (const [name, body] of Object.entries(files)) {
    await store.replace(name, typeof body === 'string' ? new TextEncoder().encode(body) : body);
  }
  worker.dirs.set(dir, store);
  return store;
}
