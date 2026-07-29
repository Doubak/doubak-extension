/**
 * 传输层错误的分类。
 *
 * 设计：DESIGN.md F-03（frontier 状态机）、F-04b
 *
 * ## 为什么要分类
 *
 * 「能不能重试」这件事上，网络错误与风控是**完全相反**的两类：
 *
 * - **网络错误**（连接失败、超时、DNS）——豆瓣根本没收到或没答复，重试是
 *   安全的，而且必要：几小时的抓取里网络抖一下太正常了。
 * - **风控**（封锁、验证码）——豆瓣明确表示了拒绝。重试正是把限流升级成
 *   封号的标准路径。
 *
 * 混为一谈的后果是不对称的：把网络错误当风控，只是抓得慢一点；把风控当网络
 * 错误去重试，可能把账号搞封。所以**分不清的一律按不可重试处理**。
 *
 * 注意风控根本不走这里——它是**成功的 HTTP 响应**，由分类器判成 verdict。
 * 本模块只处理「请求压根没能完成」的情况。
 */

/** 请求超时。太长等于没有超时，太短会在慢网络上误杀。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * @typedef {'network' | 'timeout' | 'aborted' | 'unknown'} TransportErrorKind
 */

export class TransportError extends Error {
  /**
   * @param {TransportErrorKind} kind
   * @param {string} message
   * @param {object} [opts]
   * @param {unknown} [opts.cause]
   * @param {string} [opts.url]
   */
  constructor(kind, message, { cause, url } = {}) {
    super(message);
    this.name = 'TransportError';
    this.kind = kind;
    this.cause = cause;
    this.url = url;
  }

  /**
   * 能不能重试。
   *
   * **只有网络错误与超时可以。** 其余一律不行——包括「不认识的错误」，
   * 因为分不清的时候保守方向是不重试。
   */
  get retryable() {
    return this.kind === 'network' || this.kind === 'timeout';
  }
}

/**
 * 把底层异常归类。
 *
 * 浏览器里 `fetch()` 遇到网络故障会抛 `TypeError`；中止会抛
 * `DOMException{name:'AbortError'}`。我们自己的超时也是用 abort 实现的，
 * 所以要靠一个标记把「超时」与「用户中止」区分开——两者能不能重试是相反的。
 *
 * @param {unknown} err
 * @param {object} [ctx]
 * @param {boolean} [ctx.timedOut]  这次中止是不是我们的超时触发的
 * @param {string} [ctx.url]
 * @returns {TransportError}
 */
export function classifyTransportError(err, { timedOut = false, url } = {}) {
  if (err instanceof TransportError) return err;

  const name = /** @type {any} */ (err)?.name;
  const message = /** @type {any} */ (err)?.message ?? String(err);

  if (name === 'AbortError' || name === 'TimeoutError') {
    return timedOut
      ? new TransportError('timeout', `请求超时：${url ?? ''}`, { cause: err, url })
      : // 用户主动中止（暂停、关闭）。不该重试——那是用户的意思。
        new TransportError('aborted', '请求已被中止', { cause: err, url });
  }

  // 浏览器 fetch 的网络故障统一是 TypeError，且信息里通常带 "fetch"
  if (name === 'TypeError') {
    return new TransportError('network', `网络请求失败：${message}`, { cause: err, url });
  }

  // 分不清。保守方向是**不重试**——把风控当网络错误去重试的代价是账号。
  return new TransportError('unknown', `未预期的传输错误：${message}`, { cause: err, url });
}

/**
 * 带超时的 fetch。
 *
 * 没有超时的话，一个挂住的连接会**永远**卡住队列——而监管层只会看到「还在
 * 跑」，永远不来干预。那是一种静默的失败，比响亮地报错糟糕得多。
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} init
 * @param {object} opts
 * @param {number} opts.timeoutMs
 * @param {AbortSignal} [opts.externalSignal]  用户暂停/关闭时用的
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(fetchImpl, url, init, { timeoutMs, externalSignal }) {
  const controller = new AbortController();
  let timedOut = false;
  /** @type {any} */
  let timer;
  /** @type {() => void} */
  let onExternalAbort = () => {};

  // 超时既要 abort（让底层尽快释放连接），也要**自己 reject**。
  //
  // 只 abort 是不够的：那等于把「能不能超时」交给底层实现是否遵守
  // AbortSignal。真实的 fetch 遵守，但这条路径的全部意义就是「挂住的连接
  // 绝不能永远卡住队列」——一个依赖对方配合才成立的保证，算不上保证。
  const timeoutPromise = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(classifyTransportError(namedAbort(), { timedOut: true, url }));
    }, timeoutMs);
  });

  const abortPromise = new Promise((_resolve, reject) => {
    if (!externalSignal) return;
    onExternalAbort = () => {
      controller.abort();
      reject(classifyTransportError(namedAbort(), { timedOut: false, url }));
    };
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  });

  try {
    return await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }).catch((err) => {
        throw classifyTransportError(err, { timedOut, url });
      }),
      timeoutPromise,
      abortPromise,
    ]);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener?.('abort', onExternalAbort);
  }
}

/** 造一个与浏览器中止行为一致的错误，供上面的 race 使用。 */
function namedAbort() {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}
