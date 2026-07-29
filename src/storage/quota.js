/**
 * 存储配额：写失败的归类，以及开抓前的预检。
 *
 * ## 写失败必须让整场抓取停下
 *
 * 写入器的契约是「抓到一条写一条，每页都落盘」。这条契约一破，后面每一件事
 * 都建立在假前提上：索引里的偏移量、连续性证明、`captured` 计数，全都以
 * 「写成功了」为前提。
 *
 * 所以写失败**不能**像取页失败那样只把该路线标失败然后继续——后续的写大概率
 * 同样失败，而每一次失败都可能在段文件尾部留下撕裂的半条记录。停下来只需要
 * 一次崩溃恢复就能修好；接着写下去，是一路撕裂到用户放弃。
 *
 * ## 配额耗尽为什么单独归一类
 *
 * 它和其它写失败的**下一步动作完全不同**：磁盘满了要用户去导出或清理，不是
 * 重试能解决的，也不是报个错就完了。而且它是一定会发生的——真实档案 782 MB，
 * 目录页占 90.3%，用户很可能在抓到九成时撞上。
 *
 * ## 预检为什么按含目录页的体量估
 *
 * 只按列表页估会给出一个乐观得离谱的数字，然后用户在抓了几小时之后撞墙。
 * 宁可开工前就说「空间可能不够」，也不要在九成处失败。
 */

/** 真实档案实测体量（DESIGN.md 附录 C：782 MB / 7353 个文件）。 */
export const TYPICAL_ARCHIVE_BYTES = 800 * 1024 * 1024;

/** 留出的余量倍数。撞线的代价（几小时白跑）远大于多提醒一次。 */
export const HEADROOM_FACTOR = 1.5;

/** 存储相关的停机原因。 */
export const QUOTA = 'quota';
export const WRITE_FAILED = 'write_failed';

export class StorageError extends Error {
  /** @param {'quota' | 'write_failed'} reason @param {string} message @param {unknown} [cause] */
  constructor(reason, message, cause) {
    super(message);
    this.name = 'StorageError';
    this.reason = reason;
    this.cause = cause;
  }
}

/**
 * 把一个写入异常归类。
 *
 * 配额耗尽在不同浏览器/API 上的名字不统一：OPFS 与 IndexedDB 报
 * `QuotaExceededError`，有些路径只在 message 里带字样，还有 legacy 的
 * `DOMException.QUOTA_EXCEEDED_ERR`（code 22）。都认下来——认漏了就会把
 * 「磁盘满了」显示成「未知错误」，而这两句话对用户的意义完全不同。
 *
 * @param {unknown} err
 * @returns {StorageError}
 */
export function classifyWriteError(err) {
  if (err instanceof StorageError) return err;

  const name = /** @type {any} */ (err)?.name ?? '';
  const code = /** @type {any} */ (err)?.code;
  const message = /** @type {any} */ (err)?.message ?? String(err);

  const isQuota =
    name === 'QuotaExceededError' ||
    code === 22 ||
    /quota|storage full|no space|磁盘|空间不足/i.test(message);

  return isQuota
    ? new StorageError(QUOTA, `存储空间不足：${message}`, err)
    : new StorageError(WRITE_FAILED, `写入档案失败：${message}`, err);
}

/**
 * 开抓前的空间预检。
 *
 * 返回 `null` 表示**查不了**（API 不可用）——不是「够用」。把前者当后者就等于
 * 悄悄取消了这项检查。
 *
 * @param {object} [opts]
 * @param {any} [opts.storage]  注入 navigator.storage
 * @param {number} [opts.needBytes]
 * @returns {Promise<{usage: number, quota: number, available: number, need: number, enough: boolean} | null>}
 */
export async function preflightStorage({
  storage,
  needBytes = TYPICAL_ARCHIVE_BYTES * HEADROOM_FACTOR,
} = {}) {
  const api = storage ?? globalThis.navigator?.storage;
  if (!api?.estimate) return null;

  let est;
  try {
    est = await api.estimate();
  } catch {
    return null;
  }

  const usage = est?.usage ?? 0;
  const quota = est?.quota ?? 0;
  // quota 为 0 通常意味着浏览器不肯说，而不是真的没有空间。当成查不了。
  if (!quota) return null;

  const available = Math.max(0, quota - usage);
  return { usage, quota, available, need: needBytes, enough: available >= needBytes };
}
