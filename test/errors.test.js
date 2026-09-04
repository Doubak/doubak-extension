import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  TransportError,
  classifyTransportError,
  fetchWithTimeout,
  DEFAULT_TIMEOUT_MS,
} from '../src/crawl/errors.js';
import { Transport } from '../src/crawl/transport.js';
import { Pacer, RequestGate } from '../src/crawl/pacing.js';

/** 造一个 DOMException 风格的错误。 */
function namedError(name, message = name) {
  const e = new Error(message);
  e.name = name;
  return e;
}

describe('能不能重试：网络错误与风控是相反的两类', () => {
  test('网络错误可重试', () => {
    // 豆瓣根本没收到或没答复，重试是安全的，而且必要——几小时的抓取里
    // 网络抖一下太正常了。
    const e = classifyTransportError(new TypeError('Failed to fetch'));
    assert.equal(e.kind, 'network');
    assert.equal(e.retryable, true);
  });

  test('超时可重试', () => {
    const e = classifyTransportError(namedError('AbortError'), { timedOut: true });
    assert.equal(e.kind, 'timeout');
    assert.equal(e.retryable, true);
  });

  test('用户主动中止不重试 —— 那是用户的意思', () => {
    const e = classifyTransportError(namedError('AbortError'), { timedOut: false });
    assert.equal(e.kind, 'aborted');
    assert.equal(e.retryable, false);
  });

  test('同一个 AbortError，靠标记区分超时与用户中止', () => {
    // 两者能不能重试是相反的，而底层抛的是同一种异常。
    const timeout = classifyTransportError(namedError('AbortError'), { timedOut: true });
    const manual = classifyTransportError(namedError('AbortError'), { timedOut: false });
    assert.notEqual(timeout.retryable, manual.retryable);
  });

  test('分不清的一律不重试', () => {
    // 混为一谈的后果是不对称的：把网络错误当风控，只是抓得慢一点；
    // 把风控当网络错误去重试，可能把账号搞封。
    const e = classifyTransportError(new Error('某种没见过的错误'));
    assert.equal(e.kind, 'unknown');
    assert.equal(e.retryable, false);
  });

  test('已经分类过的错误不重复包装', () => {
    const original = new TransportError('network', 'x');
    assert.equal(classifyTransportError(original), original);
  });

  test('保留原始异常便于排查', () => {
    const cause = new TypeError('Failed to fetch');
    const e = classifyTransportError(cause, { url: 'https://x/' });
    assert.equal(e.cause, cause);
    assert.equal(e.url, 'https://x/');
  });
});

describe('超时：没有它，一个挂住的连接会永远卡住队列', () => {
  test('超时会中止请求并归类为 timeout', async () => {
    const hang = () => new Promise(() => {}); // 永不 resolve
    await assert.rejects(
      () => fetchWithTimeout(hang, 'https://x/', {}, { timeoutMs: 20 }),
      (err) => {
        assert.equal(err.kind, 'timeout');
        assert.equal(err.retryable, true);
        return true;
      },
    );
  });

  test('正常响应不受影响', async () => {
    const ok = async () => ({ status: 200 });
    const { response, body } = await fetchWithTimeout(ok, 'https://x/', {}, { timeoutMs: 1000 });
    assert.equal(response.status, 200);
    assert.equal(body, null, '没给 readBody 时不该凭空读出正文');
  });

  test('**正文也在期限里** —— 响应头到了不算这次请求完成了', async () => {
    // 这是 2026-09-04 那次卡死的成因。浏览器的 fetch 在**响应头到达时**就 resolve，
    // 正文还在路上；而 `fetchWithTimeout` 的 finally 里定时器已经清掉、外部 abort
    // 的监听也摘掉了。于是调用方那句 `await response.arrayBuffer()` 是一个
    // **完全没有上限**的等待——不报错、不重试、不发事件，抓取循环就此不再返回。
    // 实测卡了 8494 秒（抓封面图抓到 2414/2943 时）。
    const headersThenStall = async () => ({
      status: 200,
      arrayBuffer: () => new Promise(() => {}), // 头给了，正文永远不来
    });
    await assert.rejects(
      () => fetchWithTimeout(headersThenStall, 'https://x/', {}, {
        timeoutMs: 20,
        readBody: (r) => r.arrayBuffer(),
      }),
      (err) => {
        assert.equal(err.kind, 'timeout', '正文挂住必须和响应头挂住一样归类');
        assert.equal(err.retryable, true);
        return true;
      },
    );
  });

  test('正文挂住时，用户的暂停也要能掐断它', async () => {
    // 光会超时还不够：`externalSignal` 的监听原来在读正文之前就被摘了，于是
    // 用户按下暂停，那一条正在挂着的连接**收不到任何信号**——「点了暂停没反应」。
    const controller = new AbortController();
    const headersThenStall = async () => ({
      status: 200,
      arrayBuffer: () => new Promise(() => {}),
    });
    const p = fetchWithTimeout(headersThenStall, 'https://x/', {}, {
      timeoutMs: 60_000,
      externalSignal: controller.signal,
      readBody: (r) => r.arrayBuffer(),
    });
    controller.abort();
    await assert.rejects(p, (err) => {
      assert.equal(err.kind, 'aborted', '用户中止不是超时');
      return true;
    });
  });

  test('正文读出来了就带回来', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const ok = async () => ({ status: 200, arrayBuffer: async () => bytes });
    const { response, body } = await fetchWithTimeout(ok, 'https://x/', {}, {
      timeoutMs: 1000,
      readBody: (r) => r.arrayBuffer(),
    });
    assert.equal(response.status, 200);
    assert.equal(body, bytes);
  });

  test('请求完成后清掉定时器 —— 否则 worker 会被无谓地续命', async () => {
    // MV3 里挂着的定时器会影响 service worker 的存活判断。
    let cleared = false;
    const realClear = globalThis.clearTimeout;
    globalThis.clearTimeout = (id) => {
      cleared = true;
      return realClear(id);
    };
    try {
      await fetchWithTimeout(async () => ({ status: 200 }), 'https://x/', {}, { timeoutMs: 1000 });
      assert.equal(cleared, true);
    } finally {
      globalThis.clearTimeout = realClear;
    }
  });

  test('外部中止信号能提前取消', async () => {
    const controller = new AbortController();
    const hang = () => new Promise(() => {});
    const p = fetchWithTimeout(hang, 'https://x/', {}, {
      timeoutMs: 60_000,
      externalSignal: controller.signal,
    });
    controller.abort();
    await assert.rejects(p, (err) => {
      assert.equal(err.kind, 'aborted', '用户中止不是超时');
      assert.equal(err.retryable, false);
      return true;
    });
  });

  test('已经中止的信号立即生效', async () => {
    const controller = new AbortController();
    controller.abort();
    const hang = () => new Promise(() => {});
    await assert.rejects(
      () => fetchWithTimeout(hang, 'https://x/', {}, { timeoutMs: 60_000, externalSignal: controller.signal }),
      /中止/,
    );
  });

  test('signal 被传给底层 fetch', async () => {
    let seen = null;
    await fetchWithTimeout(
      async (_url, init) => {
        seen = init.signal;
        return { status: 200 };
      },
      'https://x/',
      { headers: {} },
      { timeoutMs: 1000 },
    );
    assert.ok(seen instanceof AbortSignal);
  });

  test('默认超时是有限值', () => {
    // 前代用的是 5 分钟——那基本等于没有超时，挂住的请求会拖垮整场抓取。
    assert.ok(DEFAULT_TIMEOUT_MS > 0 && DEFAULT_TIMEOUT_MS <= 60_000);
  });
});

describe('传输层接上了超时', () => {
  function transportWith(fetchImpl, opts = {}) {
    let now = 0;
    const gate = new RequestGate({
      pacer: new Pacer({ intervalMs: 0.001, jitterRatio: 0 }),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    return new Transport({ gate, fetchImpl, now: () => now, ...opts });
  }

  test('挂住的请求会超时，而不是永远等下去', async () => {
    const t = transportWith(() => new Promise(() => {}), { timeoutMs: 20 });
    await assert.rejects(() => t.fetch('https://www.douban.com/x'), (err) => {
      assert.equal(err.kind, 'timeout');
      return true;
    });
  });

  test('网络故障被归类为可重试', async () => {
    const t = transportWith(async () => {
      throw new TypeError('Failed to fetch');
    });
    await assert.rejects(() => t.fetch('https://www.douban.com/x'), (err) => {
      assert.equal(err.kind, 'network');
      assert.equal(err.retryable, true);
      return true;
    });
  });
});
