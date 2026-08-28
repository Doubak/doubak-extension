/**
 * 从 OPFS 里的档案取出图片字节。
 *
 * **判定不在这里。** 「哪张图是哪张、叫什么名字、算不算缺」全在
 * `vendor/site-generator/image-index.js` 里，是站点生成器那一份的逐字节拷贝。
 * 这个文件只做它做不了的事：把字节从 OPFS 里读出来。
 *
 * 这跟 `opfs-bundle-source.js` 是同一种关系：**「字节从哪儿来」各写各的。**
 * 曾经差点在这里照着字段名重写一遍那套判定，写出来的版本三处全错（按
 * `content_type` 而不是 `surface` 筛、按一个根本不存在的 `parent_url` 找作品 id、
 * 同名图留最早那份而不是最新那份），而且三处都不会报错。
 *
 * ## 不缓存段文件，因为不需要
 *
 * 站点生成器那边必须缓存：`readFileSync` 只能整读，不缓存就是每张图重读一遍
 * 159 MB（实测 2918 张封面要 5 分半，99% 的时间在做无用功）。OPFS 的
 * `read(name, offset, length)` 是真正的区间读，只取那几十 KB。
 */

import { gunzip } from '../core/warc.js';
import {
  buildImageIndex, fileNameFor, subdirFor, reallyMissing,
} from '../vendor/site-generator/image-index.js';

export { fileNameFor, reallyMissing };

/**
 * 把已经打开的那些档案编成两张图片索引。
 *
 * @param {Array<{index: object[]}>} sources 打开着的 OpfsBundleSource
 */
export function indexImages(sources) {
  return buildImageIndex(sources.map((source) => ({ host: source, rows: source.index })));
}

/**
 * 取一条图片捕获的字节。
 *
 * @param {{host: object, row: object}} hit
 * @returns {Promise<Uint8Array>}
 */
export async function imageBytes(hit) {
  // 走的是 source 自己的 store。`payload()` 只解 HTML，图片要的是原始字节，
  // 所以这里重走一遍同样的切分——**按字节切，不解码**。
  const raw = await hit.host.readRaw(hit.row);
  const headEnd = findSep(raw, 0);
  if (headEnd < 0) throw new Error(`${hit.row.capture_id}: WARC 记录结构不完整`);
  const block = raw.subarray(headEnd + 4);
  const bodyAt = findSep(block, 0);
  return bodyAt < 0 ? block : block.subarray(bodyAt + 4);
}

/** @param {Uint8Array} bytes @param {number} from */
function findSep(bytes, from) {
  for (let i = from; i + 3 < bytes.length; i += 1) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
  }
  return -1;
}

/**
 * 把想要的图都写出去，返回 URL → 站内路径。
 *
 * 与站点生成器的 `exportImages` 同一套流程：先按作品 id 找封面（那是档案里真的
 * 有的那一张），再按 URL 找剩下的。
 *
 * @param {object} opts
 * @param {{byUrl: Map<string, object>, bySubject: Map<string, object>}} opts.index
 * @param {Set<string>} opts.wanted
 * @param {Set<string>} opts.wantedBySubject
 * @param {(rel: string, bytes: Uint8Array) => Promise<void>} opts.write
 *   `rel` 已经带上 `static/` 前缀，与页面里写的 `/covers/x.jpg` 对得上
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @returns {Promise<{paths: Record<string, string>, bySubject: Record<string, string>,
 *   written: number, missing: string[]}>}
 */
export async function exportImages({ index, wanted, wantedBySubject, write, onProgress }) {
  /** @type {Record<string, string>} */
  const paths = {};
  /** @type {Record<string, string>} */
  const bySubject = {};
  /** @type {string[]} */
  const missing = [];
  const done = new Set();
  let written = 0;

  const total = wantedBySubject.size + wanted.size;
  let seen = 0;

  const put = async (hit) => {
    const name = `${subdirFor(hit.row)}/${fileNameFor(hit.row.url, hit.row.content_type)}`;
    if (!done.has(name)) {
      await write(`static/${name}`, await imageBytes(hit));
      done.add(name);
      written += 1;
    }
    return `/${name}`;
  };

  for (const id of wantedBySubject) {
    const hit = index.bySubject.get(id);
    if (hit) bySubject[id] = await put(hit);
    onProgress?.(seen += 1, total);
  }

  for (const url of wanted) {
    const hit = index.byUrl.get(url);
    // **按 URL 找不到 ≠ 这张图缺了**，判断留给 `reallyMissing`（调用方过滤）。
    if (hit) paths[url] = await put(hit);
    else missing.push(url);
    onProgress?.(seen += 1, total);
  }

  return { paths, bySubject, written, missing };
}
