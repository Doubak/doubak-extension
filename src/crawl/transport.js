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
 * 头部值不能取自另一个头，所以做不到「每张图带上它所在的那一页」。图片与广播回复首屏各有一条窄范围规则，统一设成
 * `https://www.douban.com/`——防盗链看的是来源站点，不是具体哪一页。同一条规则
 * 顺手把 `X-Override-Referer` 删掉，免得把一个非标准头发给豆瓣。
 *
 * 也就是说：`route.referer` / `item.referer` 目前只表达**意图**，不决定实际发出去
 * 的值。要做到逐请求精确，得在每次请求前后各改一次会话规则（闸门保证并发恒为 1，
 * 所以做得到），等确有必要时再说。广播回复首屏已实测站点级 Referer 足够；
 * 不能仅凭 route.referer 就以为浏览器实际发出了这个头。
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
import { isPowChallenge, extractPowChallenge, solvePowChallenge, PowBudgetError } from './pow.js';
import { makeDebugLog } from '../core/debug-log.js';

const debugLog = makeDebugLog('[doubak/transport]');

/** 豆瓣自家的短链域名。只记短链等于在档案里留一个死指针。 */
const SHORTLINK_HOSTS = new Set(['douc.cc']);

/** 跟随跳转的上限。超过就是跳转环或异常，停下来。 */
const MAX_REDIRECTS = 5;

/**
 * 豆瓣 CDN 域名匹配。
 * 覆盖 img1/img2/img3/img9/qnmob3/img-fm 等所有 doubanio 静态资源分发节点。
 */
export const DOUBANIO_CDN_PATTERN = /^https?:\/\/(?:[a-z0-9-]+\.)*doubanio\.com\//i;

/**
 * 豆瓣 CDN 静态资源请求的默认延迟倍率（1/3，即频率为原来的 3 倍）。
 * 静态资源（封面、头像、附图等）由 CDN 边缘节点承载，无动态业务逻辑与 WAF 限制，
 * 采用更高的抓取频率以加快备份进度；切回主站页面请求时依然严格等满全额基础间隔。
 */
export const DOUBANIO_DELAY_MULTIPLIER = 1 / 3;

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
   * @param {boolean} [opts.rejectRedirects] 头像拒绝跳转，浏览器无法安全逐跳检查 Location。
   * @param {'include'|'omit'} [opts.credentials]  目录请求可明确禁用登录凭据
   * @param {number} [opts.minimumIntervalMs]  此请求的最小间隔，仍受全局退避约束
   * @param {number} [opts.delayMultiplier]    延迟倍率。未指定时若目标为 doubanio CDN 自动采用 1/3
   * @param {boolean} [opts.followRedirects]  只影响**手动**跟随（注入的 fetch 替身
   *   会给出可读的 302）。真实浏览器里跳转由浏览器跟，这个开关管不着——
   *   `redirect` 默认为 `follow`；头像可用 rejectRedirects 明确拒绝跳转。
   * @returns {Promise<FetchOutcome>}
   */
  async fetch(url, { referer, withCk = false, followRedirects = true, credentials = 'include', minimumIntervalMs = 0, delayMultiplier, rejectRedirects = false, _powRetried = false } = {}) {
    if (!['include', 'omit'].includes(credentials)) throw new Error('不支持的 credentials');
    if (credentials === 'omit' && (withCk || new URL(url).searchParams.has('ck'))) {
      throw new Error('无登录凭据的请求不能携带 ck');
    }
    const requestedUrl = withCk ? withCkToken(url, await this._getCk()) : url;
    const startedAt = this._now();

    /** @type {string[]} */
    const redirectChain = [];
    let currentUrl = requestedUrl;
    let response;
    /** 最后一跳的正文。跳转途中那几跳的正文读了就丢，反正 3xx 基本是空的。 */
    let buf = new ArrayBuffer(0);

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
      const isCdn = DOUBANIO_CDN_PATTERN.test(hopUrl);
      const hopMultiplier = delayMultiplier ?? (isCdn ? DOUBANIO_DELAY_MULTIPLIER : 1);

      /** @type {{result: {response: Response, body: ArrayBuffer}}} */
      let hopResult;
      try {
        hopResult = await this._gate.run(() =>
          fetchWithTimeout(
            this._fetch,
            hopUrl,
            {
              // 不伪造身份：不设 User-Agent，交给浏览器
              headers: referer ? { 'X-Override-Referer': referer } : {},
              credentials,
              // 不复用浏览器里可能含登录者收藏/短评的缓存页。
              ...(credentials === 'omit' ? { cache: 'no-store' } : {}),
              // 普通页面用 follow，头像用 error；manual 在浏览器里给的是 opaqueredirect：
              // status 0、url 空、header 列表全空，读不到 Location，跟不了。
              // 见文件开头。
              redirect: rejectRedirects ? 'error' : 'follow',
            },
            {
              timeoutMs: this._timeoutMs,
              externalSignal: this._signal,
              // **正文也交给它读。** 在这儿 `await response.arrayBuffer()` 的话，
              // 那句等待没有任何上限——期限与 abort 监听在 `fetchWithTimeout`
              // 的 finally 里就已经撤了。实测卡死过 8494 秒，见 errors.js。
              readBody: (res) => res.arrayBuffer(),
            },
          ), { minimumIntervalMs, delayMultiplier: hopMultiplier },
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
      response = hopResult.result.response;
      buf = hopResult.result.body;

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
      if (rejectRedirects || !followRedirects || !isRedirect) break;

      const next = new URL(location, currentUrl).toString();
      redirectChain.push(currentUrl);
      currentUrl = next;
    }

    const body = new Uint8Array(buf);
    const outcome = {
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

    // 豆瓣客户端算力证明（PoW）挑战自动求解与凭据续期。
    // 单次请求最多只尝试一次，避免在风控升级为验证码或硬封禁时陷入重试循环。
    //
    // ## 关于匿名目录请求（credentials: 'omit'）的凭据升级说明：
    // 公开模式下的目录请求（如作品详情页 interest.item）初始按 'omit' 发起，以尽可能减少操作者评价噪音。
    // 但豆瓣安全中心在对部分作品页面进行风控时，会 302 重定向到 sec.douban.com/c 的 PoW 验证页。
    // 验证成功后豆瓣下发全站通行 Cookie（dbsawcv1）。依据 W3C Fetch 规范，'omit' 会丢弃 Set-Cookie 并在发请求时禁带 Cookie；
    // 因此为了能够通过算力验证并拿到目标页面，POST /c 与随后的重试必须携带 'include' 凭据。
    // 解析器对作品详情仅从 #info 提取客观元数据，不会摄取操作者评价或标记；而 rejectRedirects 策略（如头像防跳转）依然保留。
    if (!_powRetried && outcome.status === 200 && !rejectRedirects
      && isPowChallenge(outcome.finalUrl, outcome.bodyText)) {
      const challenge = extractPowChallenge(outcome.bodyText);
      if (challenge) {
        debugLog('检测到 PoW 挑战 (sec.douban.com/c): cha=%s, difficulty=%d', challenge.cha, challenge.difficulty);
        try {
          const t0 = this._now();
          const sol = await solvePowChallenge(challenge.cha, challenge.difficulty, globalThis.crypto, {
            signal: this._signal, timeoutMs: this._timeoutMs,
          });
          const solveMs = this._now() - t0;
          debugLog('PoW 求解成功: sol=%s, 耗时=%dms', sol, solveMs);

          const postBody = new URLSearchParams({
            tok: challenge.tok,
            cha: challenge.cha,
            sol: String(sol),
            red: challenge.red || requestedUrl,
          });
          const postUrl = new URL('/c', outcome.finalUrl).toString();

          debugLog('向 %s 提交 PoW 验证 (credentials: include)...', postUrl);

          const { result: postOutcome } = await this._gate.run(() => fetchWithTimeout(
            this._fetch,
            postUrl,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/x-www-form-urlencoded',
                // 注意：切勿添加 'X-Override-Referer' 等非简单请求头，否则会触发跨域 OPTIONS 预检，
                // sec.douban.com 对 OPTIONS 返回 403 导致提交失败！
              },
              body: postBody.toString(),
              credentials: 'include', // 必须 include，浏览器才能存储 Set-Cookie: dbsawcv1
              redirect: 'follow',
            },
            {
              timeoutMs: this._timeoutMs,
              externalSignal: this._signal,
              readBody: (res) => res.arrayBuffer(),
            },
          ), { minimumIntervalMs });

          debugLog('PoW 提交响应: status=%d, url=%s', postOutcome.response.status, postOutcome.response.url);

          // Preserve the actual POST response, including error bodies and Retry-After.
          // A second GET is allowed only for a readable success redirect to the
          // original target (test/non-browser transports); browsers follow it already.
          const postFinalUrl = postOutcome.response.url || postUrl;
          const postBuf = postOutcome.body ? new Uint8Array(postOutcome.body) : new Uint8Array();
          const result = {
            requestedUrl,
            finalUrl: postFinalUrl,
            redirectChain: [...redirectChain, postUrl, ...(postFinalUrl === postUrl ? [] : [postFinalUrl])],
            status: postOutcome.response.status,
            headers: headerPairs(postOutcome.response),
            body: postBuf,
            bodyText: new TextDecoder('utf-8', { fatal: false }).decode(postBuf),
            fidelity: this._fidelity,
            elapsedMs: this._now() - startedAt,
          };
          const location = headerOf(postOutcome.response, 'location');
          let returnsToTarget = false;
          try { returnsToTarget = location && new URL(location, postFinalUrl).href === new URL(requestedUrl).href; }
          catch { /* Invalid Location is preserved as evidence, never followed. */ }
          if ([302, 303].includes(result.status) && returnsToTarget && followRedirects) {
            const retriedOutcome = await this.fetch(url, {
              referer, withCk, followRedirects,
              credentials: 'include', // 重试必须带 include 凭据以携带刚写入的 dbsawcv1 通行 Cookie
              minimumIntervalMs, delayMultiplier,
              rejectRedirects, _powRetried: true,
            });
            retriedOutcome.redirectChain = [...result.redirectChain, ...retriedOutcome.redirectChain];
            retriedOutcome.elapsedMs = this._now() - startedAt;
            if (retriedOutcome.status === 200 && new URL(retriedOutcome.finalUrl).href === new URL(requestedUrl).href
              && !isPowChallenge(retriedOutcome.finalUrl, retriedOutcome.bodyText)) {
              retriedOutcome.powSolved = true;
            }
            return retriedOutcome;
          }
          if (result.status === 200 && new URL(postFinalUrl).href === new URL(requestedUrl).href
            && !isPowChallenge(postFinalUrl, result.bodyText)) result.powSolved = true;
          return result;
        } catch (err) {
          if (err instanceof PowBudgetError) {
            debugLog('PoW 求解预算耗尽，保留挑战页并等待人工处理');
            return outcome;
          }
          if (this._signal?.aborted || err.name === 'AbortError' || err.kind === 'aborted') throw err;
          // Cancellation, network failures and lost permissions retain their normal
          // handling. Returning the initial challenge here would hide the failure.
          const permErr = await permissionErrorIfLost({ permissions: this._permissions });
          throw permErr ?? err;
        }
      } else {
        debugLog('检测到 PoW 挑战页面，但未能解析出 cha/tok 参数');
      }
    }

    return outcome;
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
