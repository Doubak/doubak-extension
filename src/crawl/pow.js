/**
 * 豆瓣客户端算力证明（Proof-of-Work, PoW）挑战识别与自动求解。
 *
 * ## 为什么需要这个模块
 *
 * 访问敏感资源（如作品详情页 `https://movie.douban.com/subject/\d+/`）时，豆瓣网关可能
 * 返回 302 重定向到 `https://sec.douban.com/c?r=<target>&_s=<sig>&a=1`。
 *
 * 该页面并非传统的图形验证码或永久封禁，而是一个无感的前端算力挑战：
 * 页面内嵌表单携带 `tok`、`cha`、`red`，并通过 JavaScript 调用 `SHA-512(cha + nonce)`，
 * 寻找满足前导 `0000`（难度 4）的 `nonce`，算完后自动 `POST /c`。服务端校验通过后
 * 下发有效期为 120 秒的关键 Cookie（`dbsawcv1`），并重定向回原目标页面。
 *
 * 扩展后台通过 `fetch()` 取页时不会执行页面中的 JavaScript 代码；且由于该页面全文
 * 没有“验证码”字样，过去会被分类器误判为硬封禁（`blocked`），进而触发翻倍降速与停机。
 *
 * 本模块负责：
 * 1. 准确识别 `sec.douban.com/c` 的 PoW 表单挑战；
 * 2. 提取挑战参数并使用 Web Crypto 原生 `crypto.subtle` 快速求解（通常只需 50~150ms）；
 * 3. 供 Transport 层自动换取通行凭据，或供分类器识别为 `challenge` 而非 `blocked`。
 */

/** 豆瓣风控域名 */
const SEC_HOST = 'sec.douban.com';

/**
 * 判断是否为豆瓣 PoW 算力挑战页面。
 *
 * @param {string} url 最终落地 URL
 * @param {string} bodyText 响应 HTML 文本
 * @returns {boolean}
 */
export function isPowChallenge(url, bodyText) {
  if (typeof bodyText !== 'string' || !bodyText) return false;
  if (url) {
    try {
      const u = new URL(url);
      if (!/(?:^|\.)sec\.douban\.com$/.test(u.host)) return false;
      if (!u.pathname.startsWith('/c')) return false;
    } catch {
      return false;
    }
  }

  // 必须包含专用的 PoW 表单与必要字段
  return /<form\b[^>]*\bid=["']sec["'][^>]*\baction=["']\/c["']/i.test(bodyText)
    && /name=["']tok["']/i.test(bodyText)
    && /name=["']cha["']/i.test(bodyText);
}

/**
 * 从 PoW 挑战页面中提取必要参数。
 *
 * @param {string} bodyText
 * @returns {{tok: string, cha: string, red: string, difficulty: number} | null}
 */
export function extractPowChallenge(bodyText) {
  if (typeof bodyText !== 'string') return null;

  const extractInput = (name) => {
    // 兼容 name 在前或 value 在前的属性写法
    const re1 = new RegExp(`<input\\b[^>]*\\bname=["']${name}["'][^>]*\\bvalue=["']([^"']+)["']`, 'i');
    const re2 = new RegExp(`<input\\b[^>]*\\bvalue=["']([^"']+)["'][^>]*\\bname=["']${name}["']`, 'i');
    return re1.exec(bodyText)?.[1] ?? re2.exec(bodyText)?.[1] ?? null;
  };

  const tok = extractInput('tok');
  const cha = extractInput('cha');
  const red = extractInput('red') ?? '';

  if (!tok || !cha) return null;

  // 默认难度为 4（与豆瓣内联脚本中的 difficulty = 4 一致）
  let difficulty = 4;
  const diffMatch = /difficulty\s*=\s*(\d+)/i.exec(bodyText);
  if (diffMatch?.[1]) {
    const d = parseInt(diffMatch[1], 10);
    if (d > 0 && d <= 8) difficulty = d;
  }

  return { tok, cha, red, difficulty };
}

/**
 * 计算字符串的 SHA-512 十六进制摘要。
 *
 * @param {string} string
 * @param {Crypto} [cryptoImpl]
 * @returns {Promise<string>}
 */
export async function sha512Hex(string, cryptoImpl = globalThis.crypto) {
  const subtle = cryptoImpl?.subtle;
  if (!subtle?.digest) throw new Error('当前环境缺少 crypto.subtle.digest 支持');

  const buf = new TextEncoder().encode(string);
  const digest = await subtle.digest('SHA-512', buf);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * 求解 PoW 挑战，返回满足前导零条件的 nonce。
 *
 * @param {string} cha challenge 字符串
 * @param {number} [difficulty] 前导零个数，默认 4
 * @param {Crypto} [cryptoImpl]
 * @returns {Promise<number>}
 */
export async function solvePowChallenge(cha, difficulty = 4, cryptoImpl = globalThis.crypto) {
  const subtle = cryptoImpl?.subtle;
  if (!subtle?.digest) throw new Error('当前环境缺少 crypto.subtle.digest 支持');

  const encoder = new TextEncoder();
  const fullBytes = Math.floor(difficulty / 2);
  const odd = difficulty % 2 !== 0;

  let nonce = 0;
  while (true) {
    nonce += 1;
    const buf = encoder.encode(cha + nonce);
    const digest = await subtle.digest('SHA-512', buf);
    const bytes = new Uint8Array(digest);

    let match = true;
    for (let i = 0; i < fullBytes; i++) {
      if (bytes[i] !== 0) {
        match = false;
        break;
      }
    }
    if (match && (!odd || bytes[fullBytes] <= 0x0f)) {
      return nonce;
    }
  }
}
