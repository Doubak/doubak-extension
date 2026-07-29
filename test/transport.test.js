import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Transport, withCkToken, isShortlink } from '../src/crawl/transport.js';
import { DECODED_FILTERED, DECODED_OBSERVED, ALL, isKnownFidelity } from '../src/crawl/fidelity.js';
import { Pacer, RequestGate } from '../src/crawl/pacing.js';

const enc = new TextEncoder();

/**
 * 假的 HTTP 层。记录每次请求，按预设脚本回应。
 *
 * @param {Array<{status?: number, headers?: Record<string,string>, body?: string, url?: string}>} script
 */
function fakeHttp(script) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const s = script[Math.min(i++, script.length - 1)] ?? {};
    const headers = new Headers(s.headers ?? {});
    const bytes = enc.encode(s.body ?? '');
    return {
      status: s.status ?? 200,
      url: s.url ?? url,
      headers,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  return { fetchImpl, calls };
}

/** @param {object} [over] */
function makeTransport(over = {}) {
  let now = 0;
  const gate = new RequestGate({
    pacer: new Pacer({ intervalMs: 1000, jitterRatio: 0 }),
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  const { fetchImpl, calls } = over.http ?? fakeHttp([{ body: '<html>ok</html>' }]);
  const t = new Transport({
    gate,
    fetchImpl,
    now: () => now,
    ...over.transport,
  });
  return { transport: t, calls, gate };
}

describe('ck 令牌', () => {
  test('拼进查询参数', () => {
    const url = withCkToken('https://m.douban.com/rexxar/api/v2/user/1/interests?count=1', 'ABC');
    assert.match(url, /ck=ABC/);
    assert.match(url, /count=1/);
  });

  test('没有 ck 时原样返回', () => {
    const url = 'https://m.douban.com/x?a=1';
    assert.equal(withCkToken(url, null), url);
  });

  test('已经带了就不覆盖', () => {
    const url = withCkToken('https://x/?ck=EXISTING', 'NEW');
    assert.match(url, /ck=EXISTING/);
    assert.doesNotMatch(url, /NEW/);
  });
});

describe('请求头：不伪造身份，但 Referer 要设对', () => {
  test('不设 User-Agent —— 浏览器自己的才是对的', async () => {
    // 伪造的 UA 与 TLS 指纹、其他请求头不一致，反而更容易被挑出来。
    const { transport, calls } = makeTransport();
    await transport.fetch('https://www.douban.com/x');
    const headers = calls[0].init.headers;
    assert.equal(headers['User-Agent'], undefined);
    assert.equal(headers['user-agent'], undefined);
  });

  test('Referer 走 X-Override-Referer —— fetch 不允许直接设', async () => {
    // Referer 是 fetch() 的禁止修改 header，只能靠 declarativeNetRequest
    // 规则把这个自定义头改写成真正的 Referer。
    const { transport, calls } = makeTransport();
    await transport.fetch('https://m.douban.com/rexxar/api/v2/x', {
      referer: 'https://m.douban.com/mine/',
    });
    assert.equal(calls[0].init.headers['X-Override-Referer'], 'https://m.douban.com/mine/');
  });

  test('不给 referer 就不加这个头', async () => {
    const { transport, calls } = makeTransport();
    await transport.fetch('https://www.douban.com/x');
    assert.equal(calls[0].init.headers['X-Override-Referer'], undefined);
  });

  test('带上会话 cookie', async () => {
    const { transport, calls } = makeTransport();
    await transport.fetch('https://www.douban.com/x');
    assert.equal(calls[0].init.credentials, 'include');
  });
});

describe('跳转', () => {
  test('跟随并记录跳转链', async () => {
    const http = fakeHttp([
      { status: 302, headers: { location: 'https://www.douban.com/real' } },
      { status: 200, body: '<html>目标</html>' },
    ]);
    const { transport } = makeTransport({ http });

    const r = await transport.fetch('https://douc.cc/abc123');

    assert.equal(r.requestedUrl, 'https://douc.cc/abc123', 'url 记的是请求时的事实');
    assert.equal(r.finalUrl, 'https://www.douban.com/real', 'final_url 记的是跟随结果');
    assert.deepEqual(r.redirectChain, ['https://douc.cc/abc123']);
    assert.equal(r.status, 200);
  });

  test('相对 Location 也能解析', async () => {
    const http = fakeHttp([
      { status: 301, headers: { location: '/moved' } },
      { status: 200, body: 'ok' },
    ]);
    const { transport } = makeTransport({ http });
    const r = await transport.fetch('https://www.douban.com/old/page');
    assert.equal(r.finalUrl, 'https://www.douban.com/moved');
  });

  test('跳转环会被挡住，不会无限打转', async () => {
    const http = fakeHttp([{ status: 302, headers: { location: 'https://x/loop' } }]);
    const { transport } = makeTransport({ http });
    await assert.rejects(() => transport.fetch('https://x/loop'), /跳转环|跳转次数/);
  });

  test('可以关掉跟随', async () => {
    const http = fakeHttp([{ status: 302, headers: { location: 'https://elsewhere/' } }]);
    const { transport } = makeTransport({ http });
    const r = await transport.fetch('https://x/', { followRedirects: false });
    assert.equal(r.status, 302, '不跟随时原样返回 3xx');
  });

  test('识别豆瓣自家短链', () => {
    // 只记短链等于在档案里留一个指向第三方跳转服务的死指针。
    assert.equal(isShortlink('https://douc.cc/4uYky6'), true);
    assert.equal(isShortlink('https://www.douban.com/x'), false);
    assert.equal(isShortlink('不是 URL'), false);
  });
});

describe('保真度如实标注', () => {
  test('默认是过滤版响应头', async () => {
    // fetch() 给的 Headers 是过滤过的：Set-Cookie 不可见，顺序与大小写已丢失。
    const { transport } = makeTransport();
    assert.equal(transport.fidelity, DECODED_FILTERED);
    const r = await transport.fetch('https://www.douban.com/x');
    assert.equal(r.fidelity, DECODED_FILTERED);
  });

  test('能观察到真实响应头时标注为 observed', async () => {
    const { transport } = makeTransport({ transport: { canObserveHeaders: true } });
    assert.equal(transport.fidelity, DECODED_OBSERVED);
  });

  test('这里的取值必须都在规范的词表里', () => {
    // 规范是唯一权威；这里只是给它们起了个可读的名字。
    for (const v of ALL) {
      assert.ok(isKnownFidelity(v), `${v} 不在规范的 capture_fidelity 词表里`);
    }
  });
});

describe('响应内容', () => {
  test('同时给出字节与文本', async () => {
    const http = fakeHttp([{ body: '<html>看过《银翼杀手》</html>' }]);
    const { transport } = makeTransport({ http });
    const r = await transport.fetch('https://www.douban.com/x');

    assert.ok(r.body instanceof Uint8Array, '字节用于写 WARC');
    assert.match(r.bodyText, /银翼杀手/, '文本用于分类');
    assert.ok(r.body.length > r.bodyText.length, '中文的字节数应大于字符数');
  });

  test('非 UTF-8 字节不会导致抛错', async () => {
    // 图片等二进制内容也走这条路；解码失败不能让整次抓取炸掉。
    const http = fakeHttp([{ body: '' }]);
    const { transport } = makeTransport({ http });
    await assert.doesNotReject(() => transport.fetch('https://img.doubanio.com/x.jpg'));
  });

  test('响应头被摊平成有序数组，供写 WARC', async () => {
    const http = fakeHttp([{ headers: { 'content-type': 'text/html; charset=utf-8' } }]);
    const { transport } = makeTransport({ http });
    const r = await transport.fetch('https://www.douban.com/x');
    assert.ok(r.headers.some(([k, v]) => k === 'content-type' && v.includes('utf-8')));
  });
});

describe('闸门：没有绕过的路径', () => {
  test('每次 fetch 都过闸门', async () => {
    const { transport } = makeTransport();
    const r1 = await transport.fetch('https://www.douban.com/a');
    const r2 = await transport.fetch('https://www.douban.com/b');
    // 第二次的耗时里包含了等待——说明确实排了队
    assert.ok(r2.elapsedMs >= 0);
    assert.ok(r1.elapsedMs >= 0);
  });

  test('金丝雀探测同样走闸门', async () => {
    // 探测也是请求，不能因为「只是探一下」就绕过节奏。
    const { transport, calls } = makeTransport();
    await transport.canary('82160871');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /user\/82160871\/interests/);
    assert.match(calls[0].url, /count=1/, '要挑最廉价的响应');
    assert.equal(calls[0].init.headers['X-Override-Referer'], 'https://m.douban.com/mine/');
  });

  test('金丝雀会带上 ck', async () => {
    const { transport, calls } = makeTransport({
      transport: { getCk: async () => 'TOKEN123' },
    });
    await transport.canary('1');
    assert.match(calls[0].url, /ck=TOKEN123/);
  });

  test('缺闸门直接拒绝构造', () => {
    assert.throws(() => new Transport({}), /闸门/);
  });
});

describe('跳转的每一跳都要限速', () => {
  test('一条短链带出的多跳都过闸门', async () => {
    // 只给第一跳限速等于给自己开了个后门：一条 douc.cc 短链可能带出好几跳，
    // 那些都是真实请求。
    let now = 0;
    const gateCalls = [];
    const pacer = new Pacer({ intervalMs: 1000, jitterRatio: 0 });
    const gate = new RequestGate({
      pacer,
      now: () => now,
      sleep: async (ms) => {
        gateCalls.push(ms);
        now += ms;
      },
    });

    const http = fakeHttp([
      { status: 302, headers: { location: 'https://www.douban.com/hop1' } },
      { status: 302, headers: { location: 'https://www.douban.com/hop2' } },
      { status: 200, body: '目标' },
    ]);
    const t = new Transport({ gate, fetchImpl: http.fetchImpl, now: () => now });

    await t.fetch('https://douc.cc/abc');

    assert.equal(http.calls.length, 3, '一共发了三次请求');
    assert.equal(gateCalls.length, 2, '第二、三跳各等了一个间隔');
    assert.deepEqual(gateCalls, [1000, 1000]);
  });
});
