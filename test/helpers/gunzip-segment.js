/**
 * 把**整个段文件**解开——按 RFC 1952 的多 member 语义。
 *
 * ## 为什么不是 `src/core/warc.js` 的 `gunzip()`
 *
 * 因为那个函数用的是 `DecompressionStream`，而**它按规范只认单个 member**。
 * WHATWG Compression Streams 明写「压缩数据结束之后还有输入就抛 TypeError」，
 * 三家浏览器一直都是这么做的：
 *
 *   Chrome  “Junk found after end of compressed data”
 *   Firefox “Unexpected input after the end of stream”
 *   Safari  “Extra bytes past the end”
 *
 * Node 是唯一一个不抛的，直到 24.19.0 把这条补齐（nodejs/node#58247）。于是这里
 * 有四条测试**在浏览器里从来就不成立**，只是靠 Node 当时的宽松而绿了——
 * 而这个扩展只跑在浏览器里。Node 那次升级不是把测试搞坏了，是把一直藏着的
 * 假绿灯照出来了。
 *
 * ## 那「整段能解开」这条性质还成立吗
 *
 * 成立，而且很重要——`zcat`、pywb、ReplayWeb.page 读段文件靠的就是它。只是它是
 * **RFC 1952 的性质，不是 DecompressionStream 的性质**，所以要用一个真正实现了
 * 多 member 的东西去验：`node:zlib`（`gunzipSync` 的 `rejectGarbageAfterEnd`
 * 默认仍是 false，多 member 照旧拼接），以及 `warc-interop.test.js` 里的 warcio。
 *
 * 生产代码不受影响：它**从来只解单条 member**——`bundle-reader.js` 按 index 里的
 * offset/length 切一条，`recovery.js` 拿一条试探。收紧对那两处只有好处，撕裂的
 * 尾部本来就该干脆地抛。
 *
 * 这个文件只被测试 import，不在 selftest 的依赖闭包里，所以用 node 内建没问题
 * （见 `test/no-node-builtins.test.js`）。
 */

import { gunzipSync } from 'node:zlib';

/**
 * @param {Uint8Array} bytes 一个或多个首尾相接的 gzip member
 * @returns {Uint8Array} 各 member 解压结果首尾相接
 */
export function gunzipSegment(bytes) {
  return new Uint8Array(gunzipSync(bytes));
}

/**
 * @param {Uint8Array} bytes
 * @returns {string} 解压后按 UTF-8 解码
 */
export function gunzipSegmentText(bytes) {
  return new TextDecoder().decode(gunzipSegment(bytes));
}
