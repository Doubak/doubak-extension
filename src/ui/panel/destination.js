/**
 * 「导出的字节交到哪儿」——两种目的地，一个契约。
 *
 * ## 为什么需要这一层
 *
 * Chrome / Edge 有 File System Access：让用户选一个文件夹，我们直接往里写。
 * **Firefox 完全没有**（`showDirectoryPicker` / `showSaveFilePicker` /
 * `showOpenFilePicker` 三个都没实现，不是版本低），所以那边只能交出一个文件。
 *
 * 在这一层之前，三个写入点（整条链、单份档案、导出页的派生产物）各自写着
 * 「没有 `showDirectoryPicker` 就报错，请用 Chrome 或 Edge」。那句话**是对的，
 * 但它指向的下一步是错的**——用户换个浏览器就为了导出，而档案在这个浏览器里。
 * 与 #12 是同一个形状：一句正确的拒绝，指向完全错误的一条路。
 *
 * ## zip 是壳子，不是格式
 *
 * zip 里装的就是标准的档案目录，**解开之后与 Chrome 直接导出的逐字节相同**
 * ——这条不变量有测试钉着（`test/zip-sink.test.js`）。所以界面上一个字都不许说它是
 * 「Firefox 专用格式」：那句话是假的，而且正好把「你的数据在你自己手里」说反了。
 *
 * ## 为什么先写进 OPFS，再交出去
 *
 * 两条候选量过（docs/firefox.md）：攒成 `Blob` 再 `createObjectURL`，240 MB 的假
 * 数据让 RSS 涨 230 MB——**整份都在内存里**，而且松不掉：下载用的 object URL 必须
 * 一直活着。先流式写进 OPFS 再 `getFile()` 只多约 40 MB。619 MB 的真实档案按前者
 * 就是把整份塞进内存，正是这个项目从第一天起写着不许做的事。
 *
 * 这偏离了「导出直接写进用户选的文件夹，绝不在 OPFS 里中转」那条规矩。那条规矩的
 * 理由是 `createWritable()` 的原子替换（中断留下的是「没有这个文件」而不是「半个
 * 文件」）——**而 Firefox 上根本没有可选的第二条路**。代价照说：导出期间需要大约
 * 两倍的空闲空间，这句话要出现在界面上。
 *
 * ## 中转文件的生命周期
 *
 * 失败时 abort 写入并删除临时文件；成功交给下载后保留中转文件，因为 `<a download>`
 * 没有完成通知。下次导出或手动清理必须先确认下载已完成／取消，不能凭经过了多久猜测。
 * 清理与打包共用跨面板锁，只操作专用中转目录，不触碰档案。
 */

import { subdirectorySink } from '../../bundle/exporter.js';
import { zipSink } from '../../bundle/zip-sink.js';
import { ZipWriter } from '../../vendor/export-adapters/zip.js';
import { classifyWriteError, preflightStorage, QUOTA } from '../../storage/quota.js';
import { bytes } from './shared.js';

/** OPFS 里的中转目录。**刻意不叫 `doubak-bundle-*`**——那个前缀是档案扫描的判据
 * （`bundleIdFromDirName`），撞上的话中转文件会被当成一份档案列出来。 */
export const STAGING_DIR = 'doubak-export-staging';

/**
 * 撤销 object URL 之前等多久。
 *
 * 早撤就是把下载掐断，而**没有事件能告诉我们什么时候读完**。取一个「大到没人会
 * 撞上」的值：619 MB 的档案在实测的 230 MB/s 下是几秒钟，十分钟留了两个数量级。
 * 撤销只是为了不无限期钉住那个 `File`，晚一点没有任何代价。
 */
export const REVOKE_DELAY_MS = 10 * 60 * 1000;
const handedUrls = new Set();

/** 这个浏览器能不能让用户选文件夹。**按能力问，不按 UA 问。** */
export function canPickDirectory() {
  return typeof globalThis.window?.showDirectoryPicker === 'function';
}

/**
 * 把界面上只对一种目的地成立的句子挑出来显示。
 *
 * ## 为什么不能就那么写在 HTML 里
 *
 * 「Firefox 上会打包成一个 zip」写死在页面上的话，**Chrome 用户会读到一句与自己
 * 无关的话**——而这一页已经很满了，一句读了发现不适用的提示，教会人的是「这些灰字
 * 可以跳过」。下一次真的要紧的那句就也被跳过了。这与「一个永远有条目的失败列表是
 * 没人看的失败列表」是同一条。
 *
 * 反过来同样要紧：Firefox 用户读到「直接写入你选的文件夹」是**一句假话**。
 * 所以两边都标出来，各显示各的，没有一句是「顺带提一下另一个浏览器」。
 *
 * 判据仍然是 `canPickDirectory()`——**按能力问，不按 UA 问**，而且与真正决定走哪条
 * 路的是同一个函数。要是这里判一次、导出时再判一次，迟早有一天页面上写着一句话、
 * 按钮做的是另一件事。
 *
 * 两种都默认 `hidden`：漏掉这一步的话页面上是**少一句话**，而不是多一句错话。
 */
export function applyDestinationCopy(root = globalThis.document) {
  const zip = !canPickDirectory();
  for (const el of root?.querySelectorAll?.('[data-when="zip"]') ?? []) el.hidden = !zip;
  for (const el of root?.querySelectorAll?.('[data-when="folder"]') ?? []) el.hidden = zip;
}

/** @param {FileSystemDirectoryHandle} root */
async function purgeStaging(root) {
  try { await root.removeEntry(STAGING_DIR, { recursive: true }); }
  catch (e) { if (e?.name !== 'NotFoundError') throw e; }
}

/** 中转目录不属于档案；单独统计，包括旧版本留下的临时文件。 */
export async function stagingUsage(root = null) {
  root ??= await navigator.storage.getDirectory();
  let dir;
  try { dir = await root.getDirectoryHandle(STAGING_DIR); }
  catch (e) { if (e?.name === 'NotFoundError') return { bytes: 0, files: 0 }; throw e; }
  const usage = { bytes: 0, files: 0 };
  async function walk(handle) {
    for await (const entry of handle.values()) {
      if (entry.kind === 'directory') await walk(entry);
      else { usage.bytes += (await entry.getFile()).size; usage.files++; }
    }
  }
  await walk(dir);
  return usage;
}

async function confirmPurge(root) {
  let usage;
  try { usage = await stagingUsage(root); }
  catch { usage = { bytes: null, files: null }; } // 统计失败不能堵死专用临时目录的清理入口。
  if (usage.files !== 0 && !globalThis.confirm(
    `上次导出的 ZIP 中转文件${usage.bytes === null ? '占用暂时无法统计' : `占用 ${bytes(usage.bytes)}`}。请先在浏览器下载列表确认下载已完成或已取消。\n\n`
    + '现在清理中转文件？仍在进行的下载可能因此中断。扩展里的原始档案不会删除。',
  )) throw new DOMException('已取消清理，请等下载完成后再试。', 'AbortError');
  await purgeStaging(root);
  for (const url of handedUrls) URL.revokeObjectURL(url);
  handedUrls.clear();
  return usage;
}

/** 显式清理与新导出用同一把锁，不能删除另一个面板正在打包的文件。 */
export async function clearExportStaging() {
  const release = await claimZipExport();
  try { return await confirmPurge(await navigator.storage.getDirectory()); }
  finally { await release(); }
}

/** 所有导出入口共用；配额不等于物理磁盘剩余空间。 */
export function exportErrorMessage(error, kind = 'zip') {
  let message = `${kind === 'zip' ? '打包' : '导出'}失败：${error?.message ?? String(error)}`;
  if (classifyWriteError(error).reason === QUOTA) {
    message = kind === 'zip'
      ? '打包空间不足：可能是浏览器存储配额已满，或磁盘可用空间不足。到「档案」页清理 ZIP 中转文件，并检查浏览器配置文件所在磁盘及下载磁盘的空闲空间；整条链太大时可逐份导出（保留所有祖先档案）。'
      : '导出空间不足：请释放目标磁盘空间后重试；已有文件可通过再次导出进行核对与补齐。';
    if (error?.space) message += ` 浏览器估算剩余 ${bytes(error.space.available)}，本次中转预计需要 ${bytes(error.space.need)}。`;
    message += ` 原始错误：${error?.message ?? error}。`;
  }
  if (error?.cleanupError) message += ` 中转文件未能完全清理：${error.cleanupError.message}；请稍后在「档案」页再次清理。`;
  return message + ' 扩展里的原始档案未修改。';
}

/**
 * 把写好的文件交给浏览器的下载。
 *
 * **不用 `chrome.downloads`。** 它会在 AMO 上显示成「读取和修改你的下载记录」，
 * 而 `<a download>` 一条权限都不要。为一个功能换一条权限提示不划算。
 *
 * @param {File} file @param {string} name
 */
function handOff(file, name) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  // 必须真的挂进文档：Firefox 不点击游离节点上的下载。
  try { document.body.append(a); a.click(); }
  catch (e) { URL.revokeObjectURL(url); throw e; }
  finally { a.remove(); }
  handedUrls.add(url);
  setTimeout(() => { URL.revokeObjectURL(url); handedUrls.delete(url); }, REVOKE_DELAY_MS);
}

/**
 * 目的地的统一契约。三个写入点都只认这四个成员，于是「哪种目的地」只在**一处**
 * 决定，不是三处各判一次 —— 一条规则写在三个地方，第三个地方迟早忘了改。
 *
 * @typedef {object} Destination
 * @property {'directory' | 'zip'} kind
 * @property {(subdir: string) => Promise<import('../../bundle/exporter.js').ExportSink>} sinkFor
 *   一份档案一个子目录，两种目的地同名（`doubak-bundle-<编号>`）——搬回来不用改名。
 * @property {(subdir: string) => Promise<(rel: string, data: Uint8Array) => Promise<void>>} writerFor
 *   派生产物那条路：按相对路径写一个整块文件。
 * @property {() => Promise<{name: string, bytes: number} | null>} finish
 *   目录那条路没有「收尾」，返回 null；zip 那条返回交出去的文件。
 * @property {() => Promise<void>} abort
 */

/**
 * 用户选的文件夹当目的地。
 *
 * @param {FileSystemDirectoryHandle} dir
 * @returns {Destination}
 */
export function directoryDestination(dir) {
  return {
    kind: 'directory',
    sinkFor: (subdir) => subdirectorySink(dir, subdir),
    writerFor: async (subdir) => directoryWriter(
      await dir.getDirectoryHandle(subdir, { create: true }),
    ),
    finish: async () => null,
    abort: async () => {},
  };
}

// 档案页与派生导出页共用中转目录，跨标签页也不能互删正在写的 ZIP。
let zipActive = false;
async function claimZipExport() {
  if (zipActive) throw new Error('已有 ZIP 正在打包，请等它完成后再导出。');
  zipActive = true;
  let releaseLock = () => {};
  let lockDone = Promise.resolve();
  try {
    if (navigator.locks?.request) {
      await new Promise((resolve, reject) => {
        lockDone = navigator.locks.request('doubak-export-staging', { ifAvailable: true }, (lock) => {
          if (!lock) { reject(new Error('另一个面板正在打包 ZIP，请等它完成后再导出。')); return; }
          return new Promise((release) => { releaseLock = release; resolve(); });
        });
        lockDone.catch(reject);
      });
    }
  } catch (e) { zipActive = false; throw e; }
  let releasing;
  return () => {
    // 回调结束不代表浏览器已经释放锁；等 request 完成再允许下一次导出。
    releasing ??= (async () => {
      releaseLock();
      try { await lockDone; }
      finally { zipActive = false; }
    })();
    return releasing;
  };
}

/**
 * 一个 zip 当目的地。**先写进 OPFS，收尾时再交出去。**
 *
 * @param {object} opts
 * @param {string} opts.zipName 交给用户的文件名
 * @param {(b: Uint8Array) => Promise<Uint8Array>} [opts.deflateRaw]
 *   只影响整块写入的成员。档案那条路一个都用不上（段文件是 `.warc.gz`，已经压过），
 *   派生产物那条路（NDJSON / Markdown）值得压。
 * @param {string} [opts.readme] 放在 zip 根上的一句说明
 * @param {number} [opts.expectedBytes] 原始档案 ZIP 的估算大小；派生输出未知时不硬性拦截。
 * @returns {Promise<Destination>}
 */
export async function zipDestination({ zipName, deflateRaw, readme, expectedBytes }) {
  const release = await claimZipExport();
  let root;
  let out;
  let ownsStaging = false;
  let closed = false;
  let handed = false;
  let aborted = false;
  const abort = async () => {
    if (handed || aborted) return;
    aborted = true;
    let failure;
    try {
      // 失败不能 close()：那会尝试提交半份 ZIP，甚至再次遇到配额错误。
      if (out && !closed) try { await out.abort(); } catch (e) { failure = e; }
      if (ownsStaging) try { await purgeStaging(root); } catch (e) { failure ??= e; }
    } finally { await release(); }
    if (failure) throw failure;
  };
  const fail = async (error) => {
    try { await abort(); } catch (cleanupError) { error.cleanupError = cleanupError; }
    throw error;
  };
  try {
    root = await navigator.storage.getDirectory();
    await confirmPurge(root);
    if (Number.isFinite(expectedBytes) && expectedBytes > 0) {
      const space = await preflightStorage({ needBytes: expectedBytes });
      if (space && !space.enough) {
        const error = new DOMException('浏览器估算的剩余配额不足以存放 ZIP 中转文件', 'QuotaExceededError');
        error.space = space;
        throw error;
      }
    }
    ownsStaging = true;
    const dir = await root.getDirectoryHandle(STAGING_DIR, { create: true });
    const fh = await dir.getFileHandle(zipName, { create: true });
    out = await fh.createWritable();
    const writer = new ZipWriter({ write: async (chunk) => {
      if (aborted || handed) throw new Error('ZIP 打包已结束');
      try { await out.write(chunk); } catch (e) { await fail(e); }
    }, deflateRaw });
    return {
      kind: 'zip',
      sinkFor: async (subdir) => zipSink(writer, subdir),
      writerFor: async (subdir) => (rel, data) => writer.add(`${subdir}/${rel}`, data),
      finish: async () => {
        if (aborted || handed) throw new Error('ZIP 打包已结束');
        try {
          if (readme) await writer.add('先看这个.txt', new TextEncoder().encode(readme));
          await writer.finish();
          await out.close();
          closed = true;
          const file = await fh.getFile();
          handOff(file, zipName);
          handed = true;
          await release();
          return { name: zipName, bytes: file.size };
        } catch (e) { return fail(e); }
      },
      abort,
    };
  } catch (e) { return fail(e); }
}

/**
 * 目录那条路的整块写入器。**从 `formats.js` 平移过来的**，一字未改——两份实现
 * 对同一个相对路径得出不同的目录结构，只是早晚的事。
 *
 * @param {FileSystemDirectoryHandle} root
 */
export function directoryWriter(root) {
  /** @type {Map<string, Promise<FileSystemDirectoryHandle>>} 子目录只建一次 */
  const dirs = new Map();

  const dirFor = (parts) => {
    const key = parts.join('/');
    if (!dirs.has(key)) {
      dirs.set(key, parts.reduce(
        async (parent, name) => (await parent).getDirectoryHandle(name, { create: true }),
        Promise.resolve(root),
      ));
    }
    return dirs.get(key);
  };

  return async (rel, data) => {
    const parts = rel.split('/');
    const name = parts.pop();
    const dir = parts.length ? await dirFor(parts) : root;
    const fh = await dir.getFileHandle(name, { create: true });
    // **走 createWritable，不是先攒后写。** 它写的是临时文件，只在 close() 那一刻
    // 整体换上去——中断留下的是「没有这个文件」，而不是「半个文件」。
    const w = await fh.createWritable();
    try {
      await w.write(data);
      await w.close();
    } catch (e) {
      await w.abort().catch(() => {});
      throw e;
    }
  };
}

/**
 * 「解开之后就是那个目录」这句话，放在 zip 根上。
 *
 * **不许出现「Firefox 专用格式」。** 见文件头。
 *
 * @param {string} what 这一份 zip 里装的是什么
 */
export function shellReadme(what) {
  return [
    '这是一个 zip 壳子，不是另一种格式。',
    '',
    `解开之后里面就是${what}，与 Chrome / Edge 直接导出的完全一样。`,
    '搬回豆备、喂给解析器（doubak-data-parser）用的都是解开之后的那个文件夹，',
    '不是这个 zip 本身。',
    '',
    '为什么是个 zip：Firefox 没有「让网页往你选的文件夹里写」这个接口，',
    '所以只能交出一个文件。你这一步多花的力气就是解压一次。',
    '',
    'https://doubak.com',
    '',
  ].join('\n');
}
