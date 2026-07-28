/**
 * 摘要与归一化。
 *
 * 规范：doubak-data-specs/bundle/v1/SPEC.md §9
 *
 * - WARC 内部沿用 WARC 惯例：`sha1:` + base32，保证既有工具能校验。
 * - index / manifest 用 `sha256` 十六进制小写，服务于本项目自身的完整性校验。
 */

const RFC4648_B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** @param {Uint8Array} bytes */
function toHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * RFC 4648 base32，带 `=` 填充——WARC 工具链期望的就是这个形式。
 * @param {Uint8Array} bytes
 */
function toBase32(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;

  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += RFC4648_B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += RFC4648_B32[(value << (5 - bits)) & 31];
  while (out.length % 8 !== 0) out += '=';

  return out;
}

/**
 * @param {Uint8Array | ArrayBuffer} data
 * @returns {Promise<string>} 小写十六进制
 */
export async function sha256Hex(data) {
  const buf = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(buf));
}

/**
 * WARC 惯例的摘要形式。
 * @param {Uint8Array | ArrayBuffer} data
 * @returns {Promise<string>} 形如 `sha1:AB2C...`
 */
export async function sha1Base32(data) {
  const buf = await crypto.subtle.digest('SHA-1', data);
  return `sha1:${toBase32(new Uint8Array(buf))}`;
}

/** 空字符串的 SHA-256。用于识别零长度载荷（SPEC §6.5.2）。 */
export const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * 内容摘要前的归一化。
 *
 * **只做三件事**：NFC 规范化、去掉每行尾部空白、统一换行为 \n。
 *
 * 刻意【不】做的：不折叠简繁，不折叠大小写。那些是**真实的编辑**——
 * 把「喫」改成「吃」是用户改了字，不是同一段文本的两种写法。折叠掉就
 * 再也看不见了。
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeForDigest(text) {
  if (typeof text !== 'string') throw new Error('normalizeForDigest 需要 string');
  return text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t 　]+$/, ''))
    .join('\n');
}

/**
 * 逐字段摘要。
 *
 * 分开算是为了让「改了评分」不会看起来像「改了评论」——整体对象比对会把
 * 两种完全不同的编辑混为一谈。
 *
 * @param {Record<string, string>} fields
 * @returns {Promise<Record<string, string>>}
 */
export async function digestFields(fields) {
  const enc = new TextEncoder();
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, value] of Object.entries(fields)) {
    out[name] = await sha256Hex(enc.encode(normalizeForDigest(value)));
  }
  return out;
}
