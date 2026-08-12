/**
 * OPFS 的 RPC 操作分发。两个 Worker 入口共用它。
 *
 * ## 为什么要有 Worker 这一层
 *
 * `createSyncAccessHandle()`（OPFS 唯一的原地读写手段）**只在专用 Worker 里
 * 可用**。窗口没有，**service worker 也没有**。所以任何要碰 OPFS 的上下文都得
 * 先起一个专用 Worker，再把操作转发进去。
 *
 * ## 为什么读写要分成三个入口
 *
 * | 入口 | 谁用 | 能写吗 |
 * |---|---|---|
 * | `opfs-worker.js` | 面板看档案、导出 | ✗ |
 * | `opfs-rw-worker.js` | offscreen document（抓取） | ✓ |
 * | `opfs-import-worker.js` | 面板导入 | 只能**新建文件**，碰不到已有的字节 |
 *
 * 原来只有两个，规矩是「写 OPFS 只该有一条路径」。导入把这句话逼到了台面上：
 * 它必然是第二条写路径，而面板（窗口）是唯一能同时拿到用户磁盘和 OPFS 的地方
 * ——`showDirectoryPicker()` 只有窗口有，offscreen 拿不到；而字节又过不了
 * `chrome.runtime.sendMessage`（那条通道只认 JSON）。所以不存在「让 offscreen 去
 * 导入」这个选项。
 *
 * 于是要问的不是「能不能多一条写路径」，而是**那条规矩到底在保护什么**：
 * 保护的是**已有档案里的偏移量**——索引里每一条都记着 `segment @offset+length`，
 * 而整个「第三方能顺着索引把字节取出来」的承诺都建立在它可信之上。
 *
 * 导入模式因此不是「弱一点的读写」，而是一条**只增不改**的规矩：
 *
 * > **导入只能新建文件，碰不到任何已经在那儿的字节。**
 *
 * 具体到操作：`append` / `replace` 的目标文件**必须原本不存在**（之后这个 worker
 * 认下它，同一份文件的后续分块照写）；`remove` 只能删自己新建的；`truncate` 永远拒
 * ——它是唯一能改变已写入字节位置的操作，而导入压根不需要它。
 *
 * 这条比「只往空目录里写」更准，也更有用：它天然允许**把上次没导完的补齐**
 * （缺的文件是新建，已有的一个都碰不到），而「空目录」那条会把这种情况一起挡掉，
 * 逼用户先把半份档案删掉——那正是最不该让用户去做的操作。
 *
 * `claimForImport(dir)` 仍然保留，但它只回答一个更窄的问题：**这个目录是不是我从零
 * 建起来的**。只有那样的目录才允许 `destroy`，用于导到一半失败时整份回滚。
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
 * 导入模式下**永远**拒绝的操作。
 *
 * `truncate` 是唯一能改变已写入字节位置的操作，而索引里每一条捕获都记着
 * `segment @offset+length`。导入本身也不需要它：它只新建文件。
 */
const NEVER_ON_IMPORT = new Set(['truncate']);

/**
 * 导入模式的那一条规矩，逐个操作地执行。
 *
 * > **只能新建文件，碰不到任何已经在那儿的字节。**
 *
 * 判据是「这个文件此刻在不在」，去问存储本身——**不是**问调用方传了什么。调用方
 * 说得再对也只是约定，而这里要的是保证。
 */
async function assertImportMayWrite({ op, dir, name, storeFor, claimed, owned }) {
  if (NEVER_ON_IMPORT.has(op)) {
    throw new Error(`导入用的 Worker 不接受 ${op}——它会改变已写入字节的位置，而索引全靠偏移量`);
  }

  if (op === 'destroy') {
    if (!claimed.has(dir)) {
      throw new Error(
        `导入用的 Worker 不能删掉 ${dir}：它不是这次导入从零建起来的。`
        + '否则「导入」就成了一条删档案的旁路。',
      );
    }
    return;
  }

  const key = `${dir}/${name}`;
  if (owned.has(key)) return; // 本次新建的，后续分块照写

  if (await (await storeFor(dir)).exists(name)) {
    throw new Error(
      `导入用的 Worker 不覆盖已经存在的 ${name}（在 ${dir} 里）。`
      + '导入只能新建文件——已有档案里的字节，它在结构上就够不着。'
      + '如果确实想换掉这一份，请先在档案页把旧的那份删掉。',
    );
  }
  if (op === 'remove') {
    return; // 删一个不存在的文件是空操作，本来就没碰到任何字节
  }
  owned.add(key);
}

/**
 * 处理一条 RPC 请求，返回 `{result, transfer}`。
 *
 * @param {object} msg
 * @param {object} opts
 * @param {boolean} opts.allowWrites
 * @param {boolean} [opts.importOnly]
 *   导入模式：只能新建文件，碰不到任何已经在那儿的字节。理由见文件开头。
 * @param {(dir: string) => Promise<import('./file-store.js').FileStore>} opts.storeFor
 * @param {() => Promise<string[]>} [opts.listDirs]  默认走 OPFS
 * @param {(dir: string) => Promise<void>} [opts.destroyDir]  默认走 OPFS
 * @param {Set<string>} [opts.claimed]  导入模式下「从零建起来的」目录
 * @param {Set<string>} [opts.owned]    导入模式下本次新建的文件（`dir/name`）
 */
export async function handleOpfsRpc(msg, {
  allowWrites,
  importOnly = false,
  storeFor,
  listDirs = () => OpfsFileStore.listBundleDirs(),
  destroyDir = (d) => OpfsFileStore.destroy(d),
  claimed = new Set(),
  owned = new Set(),
}) {
  const { op, dir, name, offset, length, bytes } = msg ?? {};

  if (WRITE_OPS.has(op) && !allowWrites) {
    throw new Error(`这个 Worker 是只读的，不接受 ${op}——写 OPFS 只走抓取那一条路径`);
  }
  if (importOnly && WRITE_OPS.has(op)) {
    await assertImportMayWrite({ op, dir, name, storeFor, claimed, owned });
  }

  switch (op) {
    case 'listBundleDirs':
      return { result: await listDirs() };
    case 'destroy':
      return { result: await destroyDir(dir) };

    /**
     * 记下「这个目录是我从零建起来的」。
     *
     * **只在目录不存在或是空的时候才成立**，而它换来的唯一权限是 `destroy`：
     * 导到一半失败时要能把半份档案整个回滚掉，而回滚一个本来就有东西的目录会
     * 连带删掉不属于这次导入的文件。
     *
     * 它**不是**写权限的开关——那条规矩是「只能新建文件」，见文件开头。
     */
    case 'claimForImport': {
      if (!importOnly) throw new Error('claimForImport 只用于导入模式');
      const existing = await (await storeFor(dir)).list();
      if (existing.length === 0) claimed.add(dir);
      return { result: { fresh: existing.length === 0, files: existing.length } };
    }

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
export function serveOpfsRpc({ allowWrites, importOnly = false }) {
  /** @type {Map<string, import('./file-store.js').FileStore>} */
  const open = new Map();
  const storeFor = async (dir) => {
    if (!open.has(dir)) open.set(dir, await OpfsFileStore.open(dir));
    return open.get(dir);
  };
  /**
   * 认领过的目录。**活在 Worker 里，不在消息里**——写在消息里的话调用方自己就能
   * 声称认领过了，那这条边界就退回成了一句约定。
   * @type {Set<string>}
   */
  const claimed = new Set();
  /** 本次新建的文件（`dir/name`）。同上：活在 Worker 里，不在消息里。 @type {Set<string>} */
  const owned = new Set();

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
        withRetry(() => handleOpfsRpc(e.data, { allowWrites, importOnly, storeFor, claimed, owned })));
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
