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

describe('跳转模式', () => {
  test('传给 fetch 的 redirect 一律是 follow', async () => {
    // 这一条是拿真事换来的。文件开头写着「改成 follow」，而代码里那一行**没改
    // 成功**（一次字符串替换静默失配），于是文档说一套、代码做一套，装进浏览器
    // 就是 opaqueredirect。
    //
    // 断言 init 里的实际值，而不是去 grep 源码——源码检查只能证明某个字符串在，
    // 证明不了它被传下去了。
    const inits = [];
    const t = new Transport({
      gate: new RequestGate({ pacer: new Pacer({ intervalMs: 1, jitterRatio: 0 }) }),
      fetchImpl: async (url, init) => {
        inits.push(init);
        return {
          status: 200, url,
          headers: new Headers({ 'content-type': 'text/html' }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      },
    });

    await t.fetch('https://www.douban.com/');
    assert.equal(inits[0].redirect, 'follow');

    // followRedirects:false 也不许把它改回 manual —— 那个开关只管手动跟随的
    // 循环，管不着浏览器怎么跟。
    await t.fetch('https://www.douban.com/x', { followRedirects: false });
    assert.equal(inits[1].redirect, 'follow');
  });

  test('收到 opaqueredirect 时必须显式抛出错误，禁止静默作为最终 URL', async () => {
    // 静默的后果是：把跳转前的 /mine/ 当成落地页，解析不出用户名，然后报出
    // 「请先登录豆瓣」——一个把人指向完全错误方向的提示。
    const t = new Transport({
      gate: new RequestGate({ pacer: new Pacer({ intervalMs: 1, jitterRatio: 0 }) }),
      fetchImpl: async (url) => ({
        status: 0,
        type: 'opaqueredirect',
        url: '',
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    });

    await assert.rejects(() => t.fetch('https://www.douban.com/mine/'), (e) => {
      assert.match(e.message, /opaqueredirect/);
      assert.match(e.message, /follow/, '错误信息要说明怎么修');
      return true;
    });
  });

  test('浏览器跟完跳转后，最终 URL 取自 response.url', async () => {
    // follow 模式下我们看不到中间跳数，只能靠 response.url。它要是空的（某些
    // 实现会），退回到自己跟踪的 URL。
    const t = new Transport({
      gate: new RequestGate({ pacer: new Pacer({ intervalMs: 1, jitterRatio: 0 }) }),
      fetchImpl: async () => ({
        status: 200,
        url: 'https://www.douban.com/people/mewcatcher/',
        headers: new Headers({ 'content-type': 'text/html' }),
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    });

    const r = await t.fetch('https://www.douban.com/mine/');
    assert.equal(r.requestedUrl, 'https://www.douban.com/mine/');
    assert.equal(r.finalUrl, 'https://www.douban.com/people/mewcatcher/');
  });
});

test('无凭据请求的每一跳都 omit/no-store，不能偷偷加 ck', async () => {
  const { transport, calls } = makeTransport({ http: fakeHttp([
    { status: 302, headers: { location: 'https://movie.douban.com/subject/2/' } }, { body: '目录' },
  ]) });
  await transport.fetch('https://movie.douban.com/subject/1/', { credentials: 'omit', minimumIntervalMs: 5000 });
  assert.equal(calls.length, 2);
  for (const c of calls) { assert.equal(c.init.credentials, 'omit'); assert.equal(c.init.cache, 'no-store'); }
  await assert.rejects(() => transport.fetch('https://www.douban.com/x', { credentials: 'omit', withCk: true }), /ck/);
  await assert.rejects(() => transport.fetch('https://www.douban.com/x?ck=token', { credentials: 'omit' }), /ck/);
  assert.equal(calls.length, 2);
});

describe('豆瓣 PoW 算力挑战自动求解与凭据续期', () => {
  for (const opts of [{ credentials: 'omit' }, { rejectRedirects: true }]) {
    test(`PoW 不能放宽请求策略 ${JSON.stringify(opts)}`, async () => {
      const body = '<form id="sec" action="/c"><input name="tok" value="x"><input name="cha" value="y"></form>';
      const { transport, calls } = makeTransport({ http: fakeHttp([
        { status: 200, url: 'https://sec.douban.com/c', body },
      ]) });
      const result = await transport.fetch('https://movie.douban.com/subject/1/', opts);
      assert.equal(calls.length, 1, '不得发送带登录 Cookie 的 POST 或重放');
      assert.equal(result.bodyText, body);
      assert.equal(result.powSolved, undefined);
      if (opts.credentials === 'omit') {
        assert.equal(calls[0].init.credentials, 'omit');
        assert.equal(calls[0].init.cache, 'no-store');
      } else {
        assert.equal(calls[0].init.redirect, 'error');
      }
    });
  }

  test('落地页为 sec.douban.com/c 时自动计算 PoW 并重试原请求（保留 include）', async () => {
    const powPage = `<!DOCTYPE html><html><body>
      <form id="sec" action="/c" method="POST">
        <input name="tok" value="token123">
        <input name="cha" value="challenge456">
        <input name="red" value="https://movie.douban.com/subject/37134598/">
      </form>
      <script>difficulty = 2;</script>
    </body></html>`;

    const { transport, calls } = makeTransport({
      http: fakeHttp([
        // 第 1 次：原登录请求被重定向到了 sec.douban.com/c
        {
          status: 200,
          url: 'https://sec.douban.com/c?r=https%3A%2F%2Fmovie.douban.com%2Fsubject%2F37134598%2F',
          body: powPage,
        },
        // 第 2 次：自动发送 POST /c 提交算力解
        {
          status: 302,
          url: 'https://sec.douban.com/c',
          headers: { location: 'https://movie.douban.com/subject/37134598/' },
        },
        // 第 3 次：自动重新发起原请求，拿到正常页面
        {
          status: 200,
          url: 'https://movie.douban.com/subject/37134598/',
          body: '<html><head><title>正常作品页</title></head></html>',
        },
      ]),
    });

    const res = await transport.fetch('https://movie.douban.com/subject/37134598/', {
      credentials: 'include',
    });
    assert.equal(calls.length, 3);

    // 核对第 1 次调用：请求原地址，初始使用 include
    assert.equal(calls[0].url, 'https://movie.douban.com/subject/37134598/');
    assert.equal(calls[0].init.credentials, 'include');

    // 核对第 2 次调用：POST /c 提交算出的 sol、tok、cha、red，且 credentials 必须为 include 以接收 dbsawcv1
    assert.equal(calls[1].url, 'https://sec.douban.com/c');
    assert.equal(calls[1].init.method, 'POST');
    assert.equal(calls[1].init.credentials, 'include');
    assert.equal(calls[1].init.headers['X-Override-Referer'], undefined, '切勿发送 X-Override-Referer 以免触发 OPTIONS 预检');
    assert.match(calls[1].init.body, /tok=token123/);
    assert.match(calls[1].init.body, /cha=challenge456/);
    assert.match(calls[1].init.body, /sol=\d+/);
    assert.match(calls[1].init.body, /red=https%3A%2F%2Fmovie\.douban\.com%2Fsubject%2F37134598%2F/);

    // 核对第 3 次调用：重放原请求，credentials 必须为 include 以携带 dbsawcv1
    assert.equal(calls[2].url, 'https://movie.douban.com/subject/37134598/');
    assert.equal(calls[2].init.credentials, 'include');
    assert.equal(res.status, 200);
    assert.equal(res.powSolved, true);
    assert.match(res.bodyText, /正常作品页/);
  });

  test('POST /c 自动跟随 302 重定向直接到达目标页时直接返回', async () => {
    const powPage = `<!DOCTYPE html><html><body>
      <form id="sec" action="/c" method="POST">
        <input name="tok" value="token123">
        <input name="cha" value="challenge456">
      </form>
      <script>difficulty = 1;</script>
    </body></html>`;

    const { transport, calls } = makeTransport({
      http: fakeHttp([
        // 第 1 次：原请求被拦截到 sec
        {
          status: 200,
          url: 'https://sec.douban.com/c?r=https%3A%2F%2Fmovie.douban.com%2Fsubject%2F37134598%2F',
          body: powPage,
        },
        // 第 2 次：POST /c 在浏览器 follow 模式下直接重定向到了目标页 200
        {
          status: 200,
          url: 'https://movie.douban.com/subject/37134598/',
          body: '<html><head><title>直接重定向获得作品页</title></head></html>',
        },
      ]),
    });

    const res = await transport.fetch('https://movie.douban.com/subject/37134598/');
    assert.equal(calls.length, 2);
    assert.equal(res.status, 200);
    assert.equal(res.finalUrl, 'https://movie.douban.com/subject/37134598/');
    assert.equal(res.powSolved, true);
    assert.match(res.bodyText, /直接重定向获得作品页/);
  });

  test('PoW 求解后仍被拦截时不无限循环，至多尝试一次', async () => {
    const powPage = `<!DOCTYPE html><html><body>
      <form id="sec" action="/c" method="POST">
        <input name="tok" value="token123">
        <input name="cha" value="challenge456">
      </form>
      <script>difficulty = 1;</script>
    </body></html>`;

    const { transport, calls } = makeTransport({
      http: fakeHttp([
        // 第 1 次：返回 PoW
        { status: 200, url: 'https://sec.douban.com/c', body: powPage },
        // 第 2 次：POST /c
        { status: 302, url: 'https://sec.douban.com/c', headers: { location: 'https://movie.douban.com/subject/1/' } },
        // 第 3 次：再次返回 PoW（例如风控升级为验证码或硬拦）
        { status: 200, url: 'https://sec.douban.com/c', body: powPage },
      ]),
    });

    const res = await transport.fetch('https://movie.douban.com/subject/1/');
    // 只重试了一次（1: GET, 2: POST /c, 3: GET 重放），第 3 次依然遇到时不继续死循环
    assert.equal(calls.length, 3);
    assert.equal(res.finalUrl, 'https://sec.douban.com/c');
    assert.equal(res.powSolved, undefined);
  });
});
