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
 * ## 中转文件什么时候删：下一次导出开始时，不是这一次结束时
 *
 * `<a download>` 点下去之后，**没有任何事件告诉我们浏览器读完了没有**。此时删掉
 * OPFS 里那份，下载会静默截断——用户拿到一个能打开、但少了东西的 zip，而这正是
 * 这个项目最怕的那类结果。所以清理挪到**下一次导出的开头**：那时上一次要么早就
 * 下完了，要么用户自己知道还在下。
 *
 * 代价是真的，写在这儿而不是藏着：**上一次导出的中转文件会一直占着空间，直到下一次
 * 导出**。仅剩的窗口是「上一份还在下载时又点了一次导出」——两害相权，无界增长的
 * 那一边更糟，因为它吃的是档案自己的配额。
 */

import { subdirectorySink } from '../../bundle/exporter.js';
import { zipSink } from '../../bundle/zip-sink.js';
import { ZipWriter } from '../../vendor/export-adapters/zip.js';

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

/** 这个浏览器能不能让用户选文件夹。**按能力问，不按 UA 问。** */
export function canPickDirectory() {
  return typeof globalThis.window?.showDirectoryPicker === 'function';
}

/** @param {FileSystemDirectoryHandle} root */
async function purgeStaging(root) {
  try {
    await root.removeEntry(STAGING_DIR, { recursive: true });
  } catch {
    // 不存在（第一次导出）或者正被占用。两种都不该挡住这次导出——中转文件的清理
    // 是善后，不是前提。
  }
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
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
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

/**
 * 一个 zip 当目的地。**先写进 OPFS，收尾时再交出去。**
 *
 * @param {object} opts
 * @param {string} opts.zipName 交给用户的文件名
 * @param {(b: Uint8Array) => Promise<Uint8Array>} [opts.deflateRaw]
 *   只影响整块写入的成员。档案那条路一个都用不上（段文件是 `.warc.gz`，已经压过），
 *   派生产物那条路（NDJSON / Markdown）值得压。
 * @param {string} [opts.readme] 放在 zip 根上的一句说明
 * @returns {Promise<Destination>}
 */
export async function zipDestination({ zipName, deflateRaw, readme }) {
  const root = await navigator.storage.getDirectory();
  await purgeStaging(root);
  const dir = await root.getDirectoryHandle(STAGING_DIR, { create: true });
  const fh = await dir.getFileHandle(zipName, { create: true });
  const out = await fh.createWritable();
  const writer = new ZipWriter({ write: (chunk) => out.write(chunk), deflateRaw });

  let closed = false;
  const closeOnce = async () => { if (!closed) { closed = true; await out.close(); } };

  return {
    kind: 'zip',
    sinkFor: async (subdir) => zipSink(writer, subdir),
    writerFor: async (subdir) => (rel, data) => writer.add(`${subdir}/${rel}`, data),
    finish: async () => {
      // 这一句放在中央目录之前：它是解压之后第一眼看到的东西，而「这是个壳子」
      // 恰恰要在那一刻说清楚。
      if (readme) await writer.add('先看这个.txt', new TextEncoder().encode(readme));
      await writer.finish();
      await closeOnce();
      const file = await fh.getFile();
      handOff(file, zipName);
      return { name: zipName, bytes: file.size };
    },
    abort: async () => {
      await closeOnce().catch(() => {});
      await purgeStaging(root);
    },
  };
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
    await w.write(data);
    await w.close();
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
