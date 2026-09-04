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
 * 带超时的一次完整往返：**响应头加正文**。
 *
 * 没有超时的话，一个挂住的连接会**永远**卡住队列——而监管层只会看到「还在
 * 跑」，永远不来干预。那是一种静默的失败，比响亮地报错糟糕得多。
 *
 * ## 正文必须在同一个期限里，否则这个保证是假的
 *
 * 浏览器的 `fetch()` 在**响应头到达时**就 resolve，正文还在路上。所以原来这里
 * 只盖住了半次往返：`finally` 里 `clearTimeout` 一执行，定时器没了、外部 abort
 * 的监听也摘了，紧接着调用方那句 `await response.arrayBuffer()` 就是**一个完全
 * 没有上限的等待**——连用户按下的暂停都中止不了它，因为信号已经不再挂在这上面。
 *
 * 实测的后果（2026-09-04，抓封面图抓到 2414/2943 时）：一条连接给了响应头之后
 * 停住，`arrayBuffer()` 再也没回来。它卡在两条事件之间，于是**没有任何东西发生**
 * ——不报错、不重试、不发事件，抓取循环就此不再返回。上层看到的是「还在跑」，
 * 一路顶到心跳每 30 秒说一次「未恢复」，共 282 次。
 *
 * 这个文件开头那句话本来就把这件事说对了；漏的是**「一次请求」到哪儿为止**。
 * 头到了不算到，字节收完才算。
 *
 * 所以正文由 `readBody` 交进来、在同一个 `race` 里读：超时定时器盖住它，
 * `controller.abort()` 也会把正文流一并掐断（只 reject 不 abort 的话，连接还
 * 挂在那儿）。**读正文也就自然被算进了闸门持有的时间**，那正是「并发恒为 1」
 * 本来的意思——此前下一个请求可以在上一个正文还在下载时就发出去。
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} init
 * @param {object} opts
 * @param {number} opts.timeoutMs
 * @param {AbortSignal} [opts.externalSignal]  用户暂停/关闭时用的
 * @param {(res: Response) => Promise<any>} [opts.readBody]  怎么把正文读出来
 * @returns {Promise<{response: Response, body: any}>}  没给 `readBody` 时 `body` 是 null
 */
export async function fetchWithTimeout(fetchImpl, url, init, { timeoutMs, externalSignal, readBody }) {
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

  // 一次往返是「头 + 正文」。**两段都要在 race 里面**，否则期限只盖住前半段。
  const exchange = (async () => {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    return { response, body: readBody ? await readBody(response) : null };
  })().catch((err) => {
    // 正文读到一半被掐断时抛的也是 AbortError，与头阶段超时同一种分类——
    // 对调用方来说它们本来就是同一件事：这一次请求没在期限内完成。
    throw classifyTransportError(err, { timedOut, url });
  });

  try {
    return await Promise.race([exchange, timeoutPromise, abortPromise]);
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
