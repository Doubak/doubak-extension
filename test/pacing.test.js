import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  Pacer,
  RequestGate,
  DEFAULT_INTERVAL_MS,
  BACKOFF_FACTOR,
  MAX_INTERVAL_MS,
} from '../src/crawl/pacing.js';

describe('基础间隔与抖动', () => {
  test('不抖时就是基础间隔', () => {
    const p = new Pacer({ intervalMs: 3000, jitterRatio: 0 });
    assert.equal(p.nextDelayMs(), 3000);
  });

  test('抖动落在 ±比例 之内', () => {
    const p = new Pacer({ intervalMs: 1000, jitterRatio: 0.3, random: () => 0 });
    assert.equal(p.nextDelayMs(), 700, 'random=0 → 下界');

    const p2 = new Pacer({ intervalMs: 1000, jitterRatio: 0.3, random: () => 0.999999 });
    assert.ok(p2.nextDelayMs() <= 1300, 'random→1 → 接近上界');
  });

  test('抖动是对称的 —— 长期均值仍等于基础间隔', () => {
    // 抖动不是用来偷偷加速的。
    let i = 0;
    const seq = [0, 0.25, 0.5, 0.75, 0.999999];
    const p = new Pacer({ intervalMs: 1000, jitterRatio: 0.3, random: () => seq[i++ % seq.length] });

    let sum = 0;
    const n = 500;
    for (let k = 0; k < n; k++) sum += p.nextDelayMs();
    const mean = sum / n;
    assert.ok(Math.abs(mean - 1000) < 30, `均值应接近 1000，实际 ${mean}`);
  });

  test('默认值偏保守', () => {
    // 我们不知道豆瓣的真实限额，也不能去试。默认值是有理由的保守猜测：
    // 前代与 tofu 都用 1 秒固定间隔，我们比它们更慢且带抖动。
    assert.ok(DEFAULT_INTERVAL_MS >= 3000, '不该比前代更激进');
    assert.equal(new Pacer().level, 0);
  });

  test('拒绝非法参数', () => {
    assert.throws(() => new Pacer({ intervalMs: 0 }), /必须为正/);
    assert.throws(() => new Pacer({ jitterRatio: 1 }), /\[0, 1\)/);
    assert.throws(() => new Pacer({ jitterRatio: -0.1 }), /\[0, 1\)/);
    assert.throws(() => new Pacer({ backoffLevel: -1 }), />=0/);
  });
});

describe('退避：只增不减', () => {
  test('每次软封锁把间隔翻倍', () => {
    const p = new Pacer({ intervalMs: 1000, jitterRatio: 0 });
    assert.equal(p.intervalMs, 1000);

    p.slowDown();
    assert.equal(p.intervalMs, 1000 * BACKOFF_FACTOR);

    p.slowDown();
    assert.equal(p.intervalMs, 1000 * BACKOFF_FACTOR ** 2);
  });

  test('没有 speedUp —— 那是刻意的', () => {
    // 一次软封锁说明已经踩到了边界，而边界在哪儿我们并不知道。
    // 自动恢复原速等于假设「刚才那次是偶然」，那是没有依据的乐观。
    const p = new Pacer();
    assert.equal(typeof (/** @type {any} */ (p).speedUp), 'undefined');
    assert.equal(typeof (/** @type {any} */ (p).reset), 'undefined');
  });

  test('间隔有上限', () => {
    const p = new Pacer({ intervalMs: 1000, jitterRatio: 0 });
    for (let i = 0; i < 20; i++) p.slowDown();
    assert.equal(p.intervalMs, MAX_INTERVAL_MS);
    assert.equal(p.atMaxInterval, true, '到顶时应当提示用户改天再来');
  });

  test('冷却建议随层级递增', () => {
    const p = new Pacer();
    assert.equal(p.recommendedCooldownMs(), 0, '没被封过就不用冷却');

    const first = p.slowDown();
    assert.equal(first.cooldownMs, 30 * 60_000, '第一次半小时');

    const second = p.slowDown();
    assert.ok(second.cooldownMs > first.cooldownMs, '第二次更久');

    for (let i = 0; i < 10; i++) p.slowDown();
    assert.equal(p.recommendedCooldownMs(), 4 * 60 * 60_000, '封顶四小时');
  });
});

describe('降速跨会话保留', () => {
  test('序列化进 checkpoint', () => {
    const p = new Pacer({ intervalMs: 3000 });
    p.slowDown();
    p.slowDown();
    assert.deepEqual(p.serialize(), { interval_ms: 3000, backoff_level: 2 });
  });

  test('恢复后不会偷偷回到原速', () => {
    // 这正是把 backoff_level 写进 checkpoint 的意义：关掉浏览器再回来，
    // 也不该重新按原速去撞。
    const p = new Pacer({ intervalMs: 1000, jitterRatio: 0 });
    p.slowDown();
    p.slowDown();
    const slowed = p.intervalMs;

    const restored = Pacer.restore(p.serialize(), { jitterRatio: 0 });
    assert.equal(restored.level, 2);
    assert.equal(restored.intervalMs, slowed);
  });

  test('没有 checkpoint 时用默认值', () => {
    const p = Pacer.restore(undefined, { jitterRatio: 0 });
    assert.equal(p.level, 0);
    assert.equal(p.intervalMs, DEFAULT_INTERVAL_MS);
  });
});

describe('请求闸门：并发恒为 1，间隔从上次结束算起', () => {
  /** 可控时钟 + 假 sleep，避免测试真的等待。 */
  function harness({ intervalMs = 1000 } = {}) {
    let now = 0;
    /** @type {number[]} */
    const slept = [];
    const gate = new RequestGate({
      pacer: new Pacer({ intervalMs, jitterRatio: 0 }),
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });
    /** 模拟一次耗时 cost 毫秒的请求 */
    const req = (cost = 0) => gate.run(async () => { now += cost; return 'ok'; });
    return { gate, slept, req, nowRef: () => now };
  }

  test('第一次请求不等待', async () => {
    const { req, slept } = harness();
    const r = await req();
    assert.equal(r.waitedMs, 0);
    assert.deepEqual(slept, []);
  });

  test('两次请求之间隔够间隔', async () => {
    const { req, slept } = harness({ intervalMs: 1000 });
    await req();
    const r = await req();
    assert.equal(r.waitedMs, 1000);
    assert.deepEqual(slept, [1000]);
  });

  test('请求耗时【不】抵扣间隔 —— 从结束算起', async () => {
    // 从开始算的话，响应越慢我们催得越紧；而响应变慢恰恰是对方在限流或
    // 扛不住的信号，此时维持原压力正好是反的。
    const { req } = harness({ intervalMs: 1000 });
    await req(600);
    const r = await req();
    assert.equal(r.waitedMs, 1000, '耗时 600ms 之后仍然等满 1000ms');
  });

  test('接近超时的慢响应之后依然等满', async () => {
    const { req } = harness({ intervalMs: 3000 });
    await req(29_000);
    const r = await req();
    assert.equal(r.waitedMs, 3000, '慢响应不该换来更短的间隔');
  });

  test('外部空转的时间可以抵扣', async () => {
    // 这里抵扣的是「请求结束之后我们自己在干别的」的时间，不是请求耗时。
    let now = 0;
    const gate = new RequestGate({
      pacer: new Pacer({ intervalMs: 1000, jitterRatio: 0 }),
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });
    await gate.run(async () => {});
    now += 400; // 写盘、分类等本地工作
    const r = await gate.run(async () => {});
    assert.equal(r.waitedMs, 600);
  });

  test('并发调用被串行化 —— 同域并发恒为 1，没有例外', async () => {
    const { gate, slept } = harness({ intervalMs: 1000 });
    const results = await Promise.all([
      gate.run(async () => 'a'),
      gate.run(async () => 'b'),
      gate.run(async () => 'c'),
    ]);
    assert.deepEqual(results.map((r) => r.result), ['a', 'b', 'c'], '按调用顺序执行');
    assert.equal(results[0].waitedMs, 0);
    assert.deepEqual(slept, [1000, 1000]);
  });

  test('退避之后闸门也跟着变慢', async () => {
    let now = 0;
    const pacer = new Pacer({ intervalMs: 1000, jitterRatio: 0 });
    const gate = new RequestGate({
      pacer, now: () => now, sleep: async (ms) => { now += ms; },
    });
    await gate.run(async () => {});
    pacer.slowDown();
    const r = await gate.run(async () => {});
    assert.equal(r.waitedMs, 2000);
  });

  test('失败的请求同样从结束重新计时', async () => {
    // 失败的请求一样占用了对方的资源，何况失败往往正是对方不高兴的表现。
    const { gate, req } = harness({ intervalMs: 1000 });
    await assert.rejects(() => gate.run(async () => { throw new Error('boom'); }));
    const r = await req();
    assert.equal(r.waitedMs, 1000, '失败之后也要等满');
  });

  test('一次失败不会毒死后续请求', async () => {
    const { gate } = harness({ intervalMs: 1000 });
    await assert.rejects(() => gate.run(async () => { throw new Error('模拟失败'); }));
    await assert.doesNotReject(() => gate.run(async () => 'ok'));
  });

  test('返回值透传', async () => {
    const { gate } = harness();
    const r = await gate.run(async () => ({ status: 200 }));
    assert.deepEqual(r.result, { status: 200 });
  });
});
