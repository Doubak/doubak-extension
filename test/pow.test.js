import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isPowChallenge, extractPowChallenge, sha512Hex, solvePowChallenge, PowBudgetError } from '../src/crawl/pow.js';
import { classifyResponse, ROUTE_PROFILES } from '../src/crawl/classifier.js';
import { fixtures } from './helpers/fixtures.js';

// Issue #29: downloads/豆瓣.html. Only the short-lived tok was replaced;
// the original markup, challenge and browser script are preserved. This fixture
// is mandatory: missing files and failed assertions must fail CI, not be swallowed.
const realPowPage = readFileSync(new URL('./fixtures/sec-pow.html', import.meta.url), 'utf-8');
const realPowUrl = 'https://sec.douban.com/c?r=https%3A%2F%2Fmovie.douban.com%2Fsubject%2F37134598%2F';

describe('PoW 算力挑战识别 (isPowChallenge)', () => {
  test('识别标准的 sec.douban.com/c 算力表单', () => {
    assert.equal(
      isPowChallenge('https://sec.douban.com/c?r=https%3A%2F%2Fmovie.douban.com%2Fsubject%2F123%2F', fixtures.powChallengePage),
      true,
    );
  });

  test('识别真实 dump 的豆瓣 PoW 页面', () => {
    assert.equal(isPowChallenge(realPowUrl, realPowPage), true);
  });

  test('真实载入中页面没有验证码提示，仍分类为 challenge 而非 blocked', () => {
    assert.match(realPowPage, /载入中/);
    assert.doesNotMatch(realPowPage, /验证码/);
    const result = classifyResponse({
      finalUrl: realPowUrl,
      status: 200,
      bodyText: realPowPage,
      route: ROUTE_PROFILES['broadcast.timeline'],
    });
    assert.equal(result.verdict, 'challenge');
  });

  test('非 sec.douban.com 域名不判定为 PoW 挑战', () => {
    assert.equal(isPowChallenge('https://movie.douban.com/c', fixtures.powChallengePage), false);
    assert.equal(isPowChallenge('https://www.douban.com/c', fixtures.powChallengePage), false);
  });

  test('非 /c 路径不判定为 PoW 挑战', () => {
    assert.equal(isPowChallenge('https://sec.douban.com/b?r=x', fixtures.powChallengePage), false);
  });

  test('无表单的风控或普通页面不判定为 PoW 挑战', () => {
    assert.equal(isPowChallenge('https://sec.douban.com/c?r=x', fixtures.blockedPage), false);
    assert.equal(isPowChallenge('https://sec.douban.com/c?r=x', fixtures.securityChallengePage), false);
    assert.equal(isPowChallenge('https://sec.douban.com/c?r=x', ''), false);
    assert.equal(isPowChallenge('https://sec.douban.com/c?r=x', null), false);
  });
});

describe('PoW 参数提取 (extractPowChallenge)', () => {
  test('保留真实表单参数，并从内联函数的默认参数读取难度', () => {
    assert.deepEqual(extractPowChallenge(realPowPage), {
      tok: 'fixture-token-not-valid',
      cha: '7c76d757c7cef3b398720c1dd03885ffd33c67dea5d34129df398fd30ae774a26d627418729f8ebe83103de39d2e093f65a70ff4365ffc97e3ac9ef6a6a33bc6',
      red: 'https://movie.douban.com/subject/37134598/',
      difficulty: 4,
    });
  });

  test('从表单正确提取 tok, cha, red 与 difficulty', () => {
    const extracted = extractPowChallenge(fixtures.powChallengePage);
    assert.deepEqual(extracted, {
      tok: '1792280920@testtok',
      cha: 'testchallenge12345',
      red: 'https://movie.douban.com/subject/37134598/',
      difficulty: 4,
    });
  });

  test('支持自定义 difficulty 参数', () => {
    const html = fixtures.powChallengePage.replace('</form>', '</form><script>difficulty = 3;</script>');
    const extracted = extractPowChallenge(html);
    assert.equal(extracted?.difficulty, 3);
  });

  test('缺少 tok 或 cha 时返回 null', () => {
    assert.equal(extractPowChallenge('<form id="sec" action="/c"><input name="red" value="x"></form>'), null);
    assert.equal(extractPowChallenge(''), null);
    assert.equal(extractPowChallenge(null), null);
  });
});

describe('SHA-512 计算与 PoW 求解', () => {
  test('已取消时不计算任何摘要', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await assert.rejects(solvePowChallenge('seed', 4, { subtle: { digest: async () => { calls++; } } },
      { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls, 0);
  });

  test('计算中取消会立即返回；挂起的 digest 恢复也不继续计算', async () => {
    const controller = new AbortController();
    let calls = 0, release;
    const pending = solvePowChallenge('seed', 4, { subtle: { digest: () => {
      calls++;
      return new Promise(resolve => { release = resolve; });
    } } }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    release(new Uint8Array(64).fill(255).buffer);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
  });

  test('单次 digest 挂住也受时间预算约束', async () => {
    await assert.rejects(solvePowChallenge('seed', 4,
      { subtle: { digest: () => new Promise(() => {}) } }, { timeoutMs: 10 }), PowBudgetError);
  });

  test('高难度达到尝试次数上限后停止', async () => {
    let calls = 0;
    await assert.rejects(solvePowChallenge('seed', 8, { subtle: { digest: async () => {
      calls++; return new Uint8Array(64).fill(255).buffer;
    } } }, { maxAttempts: 3 }), PowBudgetError);
    assert.equal(calls, 3);
  });

  test('同步完成的摘要也让出事件循环，暂停事件不会被饿死', async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = solvePowChallenge('seed', 8, { subtle: { digest: async () => {
      calls++; return new Uint8Array(64).fill(255).buffer;
    } } }, { signal: controller.signal, maxAttempts: 10_000 });
    setTimeout(() => controller.abort(), 0);
    await assert.rejects(pending, { name: 'AbortError' });
    assert.ok(calls < 10_000);
  });

  test('真实挑战在原始难度下求解，使用独立 SHA-512 实现核验', async () => {
    const { cha, difficulty } = extractPowChallenge(realPowPage);
    const nonce = await solvePowChallenge(cha, difficulty);
    // Independently derived with node:crypto, starting at 1 as the page does.
    assert.equal(nonce, 279267);
    assert.equal(
      createHash('sha512').update(cha + nonce).digest('hex'),
      '0000523118876f15e6d14bf294acc9c7689ca80010fd9d20b281811eb39a53e3d0525e51254ca176b5244119d68f279543154de106172fbcf12b81ea1dde95db',
    );
  });

  test('sha512Hex 输出已知向量', async () => {
    const emptyHash = await sha512Hex('');
    assert.equal(
      emptyHash,
      'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e',
    );
  });

  test('solvePowChallenge 在指定难度下产出有效 nonce', async () => {
    const cha = 'test-challenge-seed';
    const nonce = await solvePowChallenge(cha, 2);
    assert.ok(nonce > 0);
    const hash = await sha512Hex(cha + nonce);
    assert.ok(hash.startsWith('00'), `Hash should start with '00', got: ${hash}`);
  });

  test('缺少 subtle.digest 时明确抛出错误', async () => {
    await assert.rejects(
      () => sha512Hex('test', {}),
      /缺少 crypto\.subtle\.digest 支持/,
    );
  });
});
