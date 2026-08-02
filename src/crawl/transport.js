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
 * 但 `Referer` 是另一回事。两处都需要它：
 *
 * - 豆瓣的移动端接口要求它指向对应页面，不设就取不到数据。
 * - **图片域有防盗链**：不带 Referer 去取一张封面，拿回来的是
 *   `418 I'm a teapot`（13 字节，还标着 `image/jpeg`）。实测确认过。
 *
 * 而 `fetch()` 里 `Referer` 是**禁止修改**的 header，代码里设了会被丢掉，唯一的
 * 途径是 `declarativeNetRequest` 的 `modifyHeaders`。
 *
 * ## 这里发的 `X-Override-Referer` 曾经是一句空话
 *
 * 本文件一直按「发一个 `X-Override-Referer`，由 DNR 规则改写成 `Referer`」来写，
 * 而 **manifest 里从来没有过 DNR 权限，也从来没有过规则**。整套机制自始至终是空的。
 * 在此之前抓的全是 douban.com 的页面（不查防盗链），所以一直没暴露；抓图片是第一
 * 次踩到，代价是 123 张封面连续 418。
 *
 * 现在真的有规则了（`crawl/referer-rule.js`），但它是**静态**的：DNR 规则里的
 * 头部值不能取自另一个头，所以做不到「每张图带上它所在的那一页」。规则统一设成
 * `https://www.douban.com/`——防盗链看的是来源站点，不是具体哪一页。同一条规则
 * 顺手把 `X-Override-Referer` 删掉，免得把一个非标准头发给豆瓣。
 *
 * 也就是说：`route.referer` / `item.referer` 目前只表达**意图**，不决定实际发出去
 * 的值。要做到逐请求精确，得在每次请求前后各改一次会话规则（闸门保证并发恒为 1，
 * 所以做得到），等确有必要时再说。
 *
 * 设一个真实浏览器本来就会发的 Referer 是**提高**保真度，不是降低。
 *
 * ## 跳转交给浏览器跟随，不自己走
 *
 * 原来用 `redirect: 'manual'` 自己一跳一跳走，图的是**每一跳都过闸门**。
 * 但那在浏览器里根本不成立：`manual` 模式下 fetch 返回的是一个
 * **opaqueredirect** 响应——`status` 为 0、`url` 为空字符串、**header 列表
 * 完全是空的**。也就是说读不到 `Location`，压根没法跟。
 *
 * 后果不是报错，是**静默地拿错东西**：循环发现没有 `Location`，认为「这不是
 * 跳转」，于是把 `/mine/` 这个跳转前的 URL 当成最终 URL 返回。上层拿它去解析
 * 用户名，解析不出来，报的却是「请先登录豆瓣」——一个把人指向完全错误方向的
 * 提示。（这个 bug 就是这么被发现的。）
 *
 * 所以改成 `redirect: 'follow'`，让浏览器跟，我们读 `response.url` 拿最终
 * URL。代价说清楚：
 *
 * - **中间跳数看不见了。** 只知道起点与终点。分类器要判的
 *   `sec.douban.com` 恰好是**落点**（封锁页就在那儿），所以这条判据不受影响。
 * - **跳转的那一跳不过闸门。** 一条跳转链通常只有一跳，而替代方案是整个功能
 *   都不工作。真要拿回逐跳控制，得靠 `chrome.webRequest.onBeforeRedirect`
 *   观察，那需要额外权限，留到确有必要时再说。
 *
 * 手动跟随的循环**保留着**：注入的 fetch 替身（测试、演练）会如实给出 302 与
 * `Location`，那时按老路走。两种形状都认，才能既在浏览器里对、又在测试里
 * 测得到跳转逻辑本身。
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
import { fetchWithTimeout, DEFAULT_TIMEOUT_MS } from './errors.js';
import { permissionErrorIfLost } from './permissions.js';

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
   * @param {number} [opts.timeoutMs]
   * @param {AbortSignal} [opts.signal]  用户暂停/关闭时用
   * @param {() => number} [opts.now]
   * @param {any} [opts.permissions]  注入 chrome.permissions，测试用
   */
  constructor({
    gate,
    fetchImpl,
    getCk,
    canObserveHeaders = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    now = () => Date.now(),
    permissions,
  }) {
    if (!gate) throw new Error('缺少 gate —— 并发与节奏必须经过闸门');
    this._gate = gate;
    /** 注入用；默认走 chrome.permissions。 */
    this._permissions = permissions;
    this._fetch = fetchImpl ?? globalThis.fetch;
    this._getCk = getCk ?? (async () => null);
    this._fidelity = canObserveHeaders ? DECODED_OBSERVED : DECODED_FILTERED;
    this._timeoutMs = timeoutMs;
    this._signal = signal;
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
   * @param {boolean} [opts.followRedirects]  只影响**手动**跟随（注入的 fetch 替身
   *   会给出可读的 302）。真实浏览器里跳转由浏览器跟，这个开关管不着——
   *   `redirect` 一律是 `follow`。
   * @returns {Promise<FetchOutcome>}
   */
  async fetch(url, { referer, withCk = false, followRedirects = true } = {}) {
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

      // 【每一跳都要过闸门】。跳转也是一次真实请求——一条短链可能带出好几跳，
      // 只给第一跳限速等于给自己开了个后门。
      //
      // 必须有超时：挂住的连接会永远卡住队列，而监管层只会看到「还在跑」，
      // 永远不来干预——那是一种静默的失败，比响亮地报错糟糕得多。
      const hopUrl = currentUrl;
      /** @type {{result: Response}} */
      let hopResult;
      try {
        hopResult = await this._gate.run(() =>
          fetchWithTimeout(
            this._fetch,
            hopUrl,
            {
              // 不伪造身份：不设 User-Agent，交给浏览器
              headers: referer ? { 'X-Override-Referer': referer } : {},
              credentials: 'include',
              // **一律 follow。** `manual` 在浏览器里给的是 opaqueredirect：
              // status 0、url 空、header 列表全空，读不到 Location，跟不了。
              // 见文件开头。
              redirect: 'follow',
            },
            { timeoutMs: this._timeoutMs, externalSignal: this._signal },
          ),
        );
      } catch (err) {
        // 站点权限被撤之后，fetch 抛的是 `TypeError`——**和网络故障一模一样**。
        // 不在这里分开，它就会被判成可重试的网络错误，然后一遍遍重试一个永远
        // 不会自己好的问题。用户看到的是「网络怎么这么差」。
        //
        // 只在失败之后问一次，不在每次请求前问：每页都查一遍权限，是给一件
        // 极少发生的事付常态开销。
        const permErr = await permissionErrorIfLost({ permissions: this._permissions });
        throw permErr ?? err;
      }
      response = hopResult.result;

      // opaqueredirect：万一哪天又有人把 redirect 改回 manual，要响亮地报错，
      // 而不是像上次那样静默地把跳转前的 URL 当成最终 URL 用。
      if (response.status === 0 || response.type === 'opaqueredirect') {
        throw new Error(
          `拿到了 opaqueredirect 响应（读不到 Location，跟不了跳转）：${hopUrl}。` +
            'fetch 的 redirect 模式必须是 follow。',
        );
      }

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
