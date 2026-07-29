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

describe('请求闸门：并发恒为 1', () => {
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
    return { gate, slept, advance: (ms) => (now += ms), nowRef: () => now };
  }

  test('第一次请求不等待', async () => {
    const { gate, slept } = harness();
    const r = await gate.acquire();
    assert.equal(r.waitedMs, 0);
    assert.deepEqual(slept, []);
  });

  test('两次请求之间隔够间隔', async () => {
    const { gate, slept } = harness({ intervalMs: 1000 });
    await gate.acquire();
    const r = await gate.acquire();
    assert.equal(r.waitedMs, 1000);
    assert.deepEqual(slept, [1000]);
  });

  test('已经过去的时间可以抵扣', async () => {
    const { gate, advance } = harness({ intervalMs: 1000 });
    await gate.acquire();
    advance(600); // 抓取本身耗时 600ms
    const r = await gate.acquire();
    assert.equal(r.waitedMs, 400, '只需再等 400ms');
  });

  test('间隔已经过去就不等', async () => {
    const { gate, advance } = harness({ intervalMs: 1000 });
    await gate.acquire();
    advance(5000);
    const r = await gate.acquire();
    assert.equal(r.waitedMs, 0);
  });

  test('并发调用被串行化 —— 同域并发恒为 1，没有例外', async () => {
    // 抓取是能跑几小时的后台任务，多开几路省下的时间对用户没有意义，
    // 换来的却是成倍的风控暴露。
    const { gate, slept } = harness({ intervalMs: 1000 });

    const results = await Promise.all([gate.acquire(), gate.acquire(), gate.acquire()]);

    assert.equal(results[0].waitedMs, 0, '第一个立即放行');
    assert.equal(results[1].waitedMs, 1000);
    assert.equal(results[2].waitedMs, 1000);
    assert.deepEqual(slept, [1000, 1000], '后两个各等了一个间隔');
  });

  test('退避之后闸门也跟着变慢', async () => {
    let now = 0;
    const pacer = new Pacer({ intervalMs: 1000, jitterRatio: 0 });
    const gate = new RequestGate({
      pacer,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    await gate.acquire();
    pacer.slowDown();
    const r = await gate.acquire();
    assert.equal(r.waitedMs, 2000, '间隔翻倍后闸门要等更久');
  });

  test('一次失败不会毒死后续请求', async () => {
    // 尾链上如果留下 rejected promise，后面所有 acquire() 都会跟着炸。
    let now = 0;
    let calls = 0;
    const gate = new RequestGate({
      pacer: new Pacer({ intervalMs: 1000, jitterRatio: 0 }),
      now: () => now,
      sleep: async (ms) => {
        calls += 1;
        if (calls === 1) throw new Error('模拟 sleep 失败');
        now += ms;
      },
    });

    await gate.acquire();
    await assert.rejects(() => gate.acquire(), /模拟 sleep 失败/);
    await assert.doesNotReject(() => gate.acquire(), '后续请求应当照常');
  });
});
