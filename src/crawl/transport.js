/**
 * 取页传输层。
 *
 * 设计：DESIGN.md F-04a/c/h、§1（请求头）
 *
 * ## 不伪造身份，但 Referer 必须设对
 *
 * 原则是**不伪造身份**：User-Agent 一律用浏览器默认。前代实现写死了一个
 * Chrome 109 的桌面 UA，那反而更容易被挑出来——伪造的 UA 与 TLS 指纹、
 * 其他请求头不一致。
 *
 * 但 `Referer` 是另一回事：豆瓣的移动端接口要求它指向对应页面，不设就取不到
 * 数据。而 `fetch()` 里 `Referer` 是**禁止修改**的 header，只能靠
 * `declarativeNetRequest` 规则改写。做法是发一个自定义头 `X-Override-Referer`，
 * 由 DNR 规则把它改写成真正的 `Referer`。
 *
 * 设一个真实浏览器本来就会发的 Referer 是**提高**保真度，不是降低。
 *
 * ## 保真度必须如实标注
 *
 * `fetch()` 拿不到真正的原始字节：响应体已经解除了 `Content-Encoding`，
 * 响应头也是过滤过的。所以每条记录都带 `capture_fidelity`，说明它的成色。
 * 做不到却宣称做到了，比做不到本身糟糕得多。
 */

import {
  DECODED_FILTERED,
  DECODED_OBSERVED,
} from './fidelity.js';

/** 豆瓣自家的短链域名。只记短链等于在档案里留一个死指针。 */
const SHORTLINK_HOSTS = new Set(['douc.cc']);

/** 跟随跳转的上限。超过就是跳转环或异常，停下来。 */
const MAX_REDIRECTS = 5;

/**
 * `ck` 是 Rexxar 接口的 CSRF 令牌，跟着会话走，要当查询参数拼进 URL。
 *
 * @param {string} url
 * @param {string | null} ck
 * @returns {string}
 */
export function withCkToken(url, ck) {
  if (!ck) return url;
  const u = new URL(url);
  // 已经带了就不覆盖——调用方可能有自己的理由
  if (!u.searchParams.has('ck')) u.searchParams.set('ck', ck);
  return u.toString();
}

/** @param {string} url */
export function isShortlink(url) {
  try {
    return SHORTLINK_HOSTS.has(new URL(url).host);
  } catch {
    return false;
  }
}

/**
 * @typedef {object} FetchOutcome
 * @property {string} requestedUrl  请求时的 URL，逐字节原样
 * @property {string} finalUrl      跟随跳转后的最终 URL
 * @property {string[]} redirectChain
 * @property {number} status
 * @property {[string, string][]} headers
 * @property {Uint8Array} body
 * @property {string} bodyText
 * @property {string} fidelity
 * @property {number} elapsedMs
 */

export class Transport {
  /**
   * @param {object} opts
   * @param {import('./pacing.js').RequestGate} opts.gate
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {() => Promise<string | null>} [opts.getCk]  从 cookie 读 ck
   * @param {boolean} [opts.canObserveHeaders]  能否用 webRequest 补齐真实响应头
   * @param {() => number} [opts.now]
   */
  constructor({ gate, fetchImpl, getCk, canObserveHeaders = false, now = () => Date.now() }) {
    if (!gate) throw new Error('缺少 gate —— 并发与节奏必须经过闸门');
    this._gate = gate;
    this._fetch = fetchImpl ?? globalThis.fetch;
    this._getCk = getCk ?? (async () => null);
    this._fidelity = canObserveHeaders ? DECODED_OBSERVED : DECODED_FILTERED;
    this._now = now;
  }

  get fidelity() {
    return this._fidelity;
  }

  /**
   * 取一个 URL。
   *
   * 每次调用都先过闸门——并发恒为 1，间隔由 Pacer 决定。**没有绕过闸门的
   * 路径**，包括金丝雀探测。
   *
   * @param {string} url
   * @param {object} [opts]
   * @param {string} [opts.referer]  会被 DNR 规则改写成真正的 Referer
   * @param {boolean} [opts.withCk]  是否自动拼上 ck 令牌
   * @param {boolean} [opts.followRedirects]
   * @returns {Promise<FetchOutcome>}
   */
  async fetch(url, { referer, withCk = false, followRedirects = true } = {}) {
    await this._gate.acquire();

    const requestedUrl = withCk ? withCkToken(url, await this._getCk()) : url;
    const startedAt = this._now();

    /** @type {string[]} */
    const redirectChain = [];
    let currentUrl = requestedUrl;
    let response;

    for (let hop = 0; ; hop++) {
      if (hop > MAX_REDIRECTS) {
        throw new Error(`跳转次数超过 ${MAX_REDIRECTS} 次，疑似跳转环: ${requestedUrl}`);
      }

      response = await this._fetch(currentUrl, {
        // 不伪造身份：不设 User-Agent，交给浏览器
        headers: referer ? { 'X-Override-Referer': referer } : {},
        credentials: 'include',
        redirect: followRedirects ? 'manual' : 'follow',
      });

      const location = headerOf(response, 'location');
      const isRedirect = response.status >= 300 && response.status < 400 && location;
      if (!followRedirects || !isRedirect) break;

      const next = new URL(location, currentUrl).toString();
      redirectChain.push(currentUrl);
      currentUrl = next;
    }

    const buf = await response.arrayBuffer();
    const body = new Uint8Array(buf);

    return {
      requestedUrl,
      // response.url 在某些实现下为空，退回到我们自己跟踪的 currentUrl
      finalUrl: response.url || currentUrl,
      redirectChain,
      status: response.status,
      headers: headerPairs(response),
      body,
      bodyText: new TextDecoder('utf-8', { fatal: false }).decode(body),
      fidelity: this._fidelity,
      elapsedMs: this._now() - startedAt,
    };
  }

  /**
   * 金丝雀探测。
   *
   * 恢复抓取前用它确认风控是否已解除。挑的是一个**极廉价、需登录、响应形状
   * 已知**的接口：标记总数。
   *
   * 注意它同样走闸门——探测也是请求，不能因为"只是探一下"就绕过节奏。
   *
   * @param {string} userId
   * @returns {Promise<FetchOutcome>}
   */
  async canary(userId) {
    const url =
      `https://m.douban.com/rexxar/api/v2/user/${encodeURIComponent(userId)}/interests` +
      `?count=1&for_mobile=1`;
    return this.fetch(url, {
      referer: 'https://m.douban.com/mine/',
      withCk: true,
    });
  }
}

/** @param {Response} res @param {string} name */
function headerOf(res, name) {
  return res.headers?.get?.(name) ?? null;
}

/**
 * 把响应头摊平成有序数组。
 *
 * 注意：这里拿到的是 `fetch()` **过滤后**的响应头——`Set-Cookie` 不可见，
 * 原始顺序与大小写也已丢失。这正是 `capture_fidelity` 要如实标注的原因。
 *
 * @param {Response} res
 * @returns {[string, string][]}
 */
function headerPairs(res) {
  /** @type {[string, string][]} */
  const out = [];
  if (!res.headers?.forEach) return out;
  res.headers.forEach((value, key) => out.push([key, value]));
  return out;
}
