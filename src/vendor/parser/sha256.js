/* 【自动同步，请勿手改】来自 doubak-data-parser 的 src/sha256.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/**
 * SHA-256，同步、纯函数、不碰任何内建模块。
 *
 * ## 为什么自己写一份，而不是用 node:crypto 或 crypto.subtle
 *
 * 因为这份代码要在**两个**地方跑：Node 里的解析器，和浏览器扩展里的解析器
 * （`doubak-extension/src/vendor/parser/`）。两边各有一个现成的实现，但它们
 * 一个同步一个异步：
 *
 * - `node:crypto` 的 `createHash` 是同步的，浏览器里根本没有；
 * - `crypto.subtle.digest` 浏览器里有，Node 里也有，但它**返回 Promise**。
 *
 * 走 `crypto.subtle` 就意味着 `fieldDigest` 变成 async，而它是逐字段调的——
 * 一份真实档案 9322 条记录、每条七八个字段，是七万多次 await。那不只是慢，
 * 更是把 `parse.js` 里每一处摘要计算都染成异步，而那些地方在语义上**没有一处
 * 是在等 I/O**。
 *
 * 所以这里放一份纯 JS 的实现。它没有秘密可泄露——摘要算的是页面上公开的字段，
 * 用来回答「这段文字变过没有」，不参与任何认证，所以**不存在时序攻击面**，
 * 这也是「别自己写密码学」那条规矩在这里不适用的原因。
 *
 * 代价实测过：8 万次五十来字的中文，本实现 620 ms，`node:crypto` 146 ms——
 * 慢 4.2 倍。而一份真实档案（9322 条记录）整趟大约就是 7.5 万次，也就是**半秒**。
 * 拿半秒换「同一份代码两处都能跑」是划算的；拿七万多次 await 换就不是。
 *
 * ## 正确性由对拍保证，不由「看起来对」保证
 *
 * `test/sha256.test.js` 拿 `node:crypto` 当标准答案逐条比：官方测试向量、
 * 各种长度（尤其是 55/56/63/64/119/120 字节这些跨块与跨填充的边界）、
 * 中日文、emoji（代理对）、以及真实 conformance 语料里的每一个字段值。
 * 有一个对不上就红。
 *
 * **别「优化」这个文件。** 它一天跑几万次，但总耗时以毫秒计；而任何一处笔误
 * 都会让摘要整体偏移，其后果是所有记录同时看起来被编辑过——canonical 只比较
 * 同一 parser_version 的修订，摘要一变，那道保护就失效了。
 */

/** 前 64 个质数立方根小数部分的前 32 位。FIPS 180-4 §4.2.2。 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** 前 8 个质数平方根小数部分的前 32 位。FIPS 180-4 §5.3.3。 */
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/** 每一轮的消息调度表。**在模块级复用**，省掉每块一次分配。 */
const W = new Uint32Array(64);

const enc = new TextEncoder();

/** 循环右移。JS 的 `>>>` 是逻辑右移，所以这样拼出来的就是标准的 ROTR。 */
const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

/**
 * @param {Uint8Array} bytes
 * @returns {string} 64 位小写十六进制
 */
export function sha256Bytes(bytes) {
  // 填充：1 个 0x80，若干 0x00，最后 8 字节大端写原始**比特**长度。
  // 补到 64 的倍数，且长度字段自己要占满最后 8 字节——所以 55 字节的消息占
  // 一块，56 字节的就要占两块。那正是最容易写错、也最容易测漏的地方。
  const len = bytes.length;
  const blocks = Math.ceil((len + 9) / 64);
  const buf = new Uint8Array(blocks * 64);
  buf.set(bytes);
  buf[len] = 0x80;

  // 比特长度是 64 位。JS 的位运算只有 32 位，所以高低两半分开写：
  // 高位用除法（不是 `>>>`，那会先把数截成 32 位），低位用取模。
  const bits = len * 8;
  const view = new DataView(buf.buffer);
  view.setUint32(buf.length - 8, Math.floor(bits / 0x100000000), false);
  view.setUint32(buf.length - 4, bits >>> 0, false);

  let [a, b, c, d, e, f, g, h] = H0;

  for (let i = 0; i < buf.length; i += 64) {
    for (let t = 0; t < 16; t += 1) W[t] = view.getUint32(i + t * 4, false);
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }

    let [A, B, C, D, E, F, G, H] = [a, b, c, d, e, f, g, h];
    for (let t = 0; t < 64; t += 1) {
      const S1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const ch = (E & F) ^ (~E & G);
      const t1 = (H + S1 + ch + K[t] + W[t]) >>> 0;
      const S0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const maj = (A & B) ^ (A & C) ^ (B & C);
      const t2 = (S0 + maj) >>> 0;
      H = G; G = F; F = E; E = (D + t1) >>> 0;
      D = C; C = B; B = A; A = (t1 + t2) >>> 0;
    }

    a = (a + A) >>> 0; b = (b + B) >>> 0; c = (c + C) >>> 0; d = (d + D) >>> 0;
    e = (e + E) >>> 0; f = (f + F) >>> 0; g = (g + G) >>> 0; h = (h + H) >>> 0;
  }

  let out = '';
  for (const w of [a, b, c, d, e, f, g, h]) out += w.toString(16).padStart(8, '0');
  return out;
}

/**
 * UTF-8 编码之后取摘要。
 *
 * **编码必须是 UTF-8**，与 `node:crypto` 的 `.update(s, 'utf-8')` 一致。
 * `TextEncoder` 只会产出 UTF-8，所以这里没有第二种可能——但值得写下来，
 * 因为两边编码不一致的后果是所有非 ASCII 字段的摘要全部不同，而这个项目的
 * 语料几乎全是中文。
 *
 * @param {string} text
 * @returns {string}
 */
export function sha256(text) {
  return sha256Bytes(enc.encode(text));
}
