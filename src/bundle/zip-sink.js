/**
 * 把导出写进一个 zip，而不是写进用户选的文件夹。
 *
 * ## 为什么需要它
 *
 * Firefox **完全没有** File System Access（`showDirectoryPicker` / `showSaveFilePicker`
 * / `showOpenFilePicker` 三个都没有，不是版本低，是没实现）。所以「让用户选个文件夹，
 * 我们往里写」这条路在那边不存在，只能交出一个文件。
 *
 * ## 它不是另一种档案格式，是一个**壳子**
 *
 * zip 里装的就是标准的档案目录，**解开之后与 Chrome 直接导出的逐字节相同**。
 * 这一条不是说法，是测试钉住的不变量——它同时保证了两件事：
 *
 * - 跨浏览器可用：解开就是 Chrome 那边「搬回来」认的那个文件夹；
 * - 下游可用：`bin/parse.js`、`bin/verify.js`、`validate.py` 收的都是**目录**，
 *   而 `bundle/1.4` 定义的档案本来就是目录。
 *
 * 所以界面上一个字都不许说它是「Firefox 专用格式」——那句话是假的，而且正好把
 * 「你的数据在你自己手里」说反了。措辞统一成「壳子，不是格式」。
 *
 * ## 为什么只有 `open`，没有 `read` / `list`
 *
 * zip 是一次写完的流，回头读不了。`exporter.js` 的契约本来就允许缺这两个
 * （`if (!sink.list || !sink.read) return out;`），而且**已经为这种情况写好了话**：
 * 「目的地读不回来，无法校验」。
 *
 * 代价要说出来，不能让它看起来和 Chrome 那条路一样：**Chrome 那边「目标目录就是
 * 进度，验一遍补上缺的」在这里不成立**——zip 是一次性的，中断了就得重来。
 */

import { ZipWriter } from '../vendor/export-adapters/zip.js';

/**
 * @param {ZipWriter} writer
 * @param {string} [prefix] zip 内的目录前缀
 * @returns {{open: (name: string) => Promise<{write: (b: Uint8Array) => Promise<void>, close: () => Promise<void>}>}}
 */
export function zipSink(writer, prefix = '') {
  return {
    async open(name) {
      // **路径分隔符一律用 `/`。** zip 规范只认它（4.4.17.1），而 Windows 上拼出
      // 反斜杠的话，解压工具会把 `a\b.warc.gz` 当成一个**文件名里带反斜杠的文件**，
      // 目录结构当场没了——而「解开就是那个目录」正是这整条路的前提。
      const full = prefix ? `${prefix}/${name}` : name;
      const m = await writer.beginMember(full);
      return {
        write: (bytes) => m.write(bytes),
        close: () => m.close(),
      };
    },
  };
}

/**
 * 一份档案一个子目录，与 Chrome 那条路同名。
 *
 * 目录名用 `doubak-bundle-<id>`，与 OPFS 里、与 Chrome 导出的一致：**搬回来的时候
 * 不用改名**。这是「壳子不是格式」那句话的技术前提之一。
 *
 * @param {ZipWriter} writer @param {string} name
 */
export function subdirectoryZipSink(writer, name) {
  return zipSink(writer, name);
}
