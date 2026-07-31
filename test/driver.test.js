import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { driveWithinBudget, DEFAULT_BUDGET_MS, MAX_IDLE_BATCHES } from '../src/crawl/driver.js';
import { HEARTBEAT_PERIOD_MINUTES } from '../src/crawl/supervisor.js';

/**
 * 假 runner：每批花 batchCostMs，跑满 totalBatches 后报 done。
 */
function fakeRunner({ totalBatches = 10, batchCostMs = 5000, stopAt = null } = {}) {
  let n = 0;
  let now = 0;
  const runner = {
    async runBatch() {
      n += 1;
      now += batchCostMs;
      if (stopAt && n >= stopAt) {
        return { captured: 1, failed: 0, done: true, stoppedBy: 'blocked' };
      }
      return { captured: 2, failed: 0, done: n >= totalBatches, stoppedBy: null };
    },
  };
  return { runner, nowRef: () => now, batchCount: () => n };
}

describe('预算内持续推进', () => {
  test('跑到 done 就停', async () => {
    const { runner, nowRef, batchCount } = fakeRunner({ totalBatches: 3, batchCostMs: 100 });
    const r = await driveWithinBudget({ runner, now: nowRef, budgetMs: 60_000 });

    assert.equal(r.done, true);
    assert.equal(batchCount(), 3);
    assert.equal(r.captured, 6);
  });

  test('预算用完就让出去，不是跑完', async () => {
    // 一场抓取要几小时，一次唤醒只能干一小会儿。
    const { runner, nowRef, batchCount } = fakeRunner({ totalBatches: 1000, batchCostMs: 5000 });
    const r = await driveWithinBudget({ runner, now: nowRef, budgetMs: 12_000 });

    assert.equal(r.done, false);
    assert.equal(batchCount(), 3, '5s×3=15s 才越过 12s 预算');
    assert.ok(r.batches > 0, '至少要干点活');
  });

  test('预算是软上限，不打断进行中的一批', async () => {
    // 打断一批意味着丢掉已抓但未记账的游标，那正是分批要避免的。
    const { runner, nowRef, batchCount } = fakeRunner({ totalBatches: 100, batchCostMs: 30_000 });
    const r = await driveWithinBudget({ runner, now: nowRef, budgetMs: 1000 });

    assert.equal(batchCount(), 1, '哪怕一批就超预算，也要让它做完');
    assert.equal(r.done, false);
  });

  test('被停机时立刻退出', async () => {
    const { runner, nowRef, batchCount } = fakeRunner({ totalBatches: 100, stopAt: 2, batchCostMs: 10 });
    const r = await driveWithinBudget({ runner, now: nowRef, budgetMs: 60_000 });

    assert.equal(batchCount(), 2);
    assert.equal(r.stoppedBy, 'blocked');
  });

  test('预算耗尽会发事件', async () => {
    const events = [];
    const { runner, nowRef } = fakeRunner({ totalBatches: 100, batchCostMs: 5000 });
    await driveWithinBudget({
      runner, now: nowRef, budgetMs: 6000, onEvent: (e) => events.push(e),
    });
    assert.ok(events.some((e) => e.type === 'budget_exhausted'));
  });
});

describe('预算与心跳周期的关系', () => {
  test('预算比心跳周期略小，正常情况下两段不重叠', async () => {
    // 重叠有 Supervisor.tick() 的幂等兜底，但能不重叠更省事。
    const heartbeatMs = HEARTBEAT_PERIOD_MINUTES * 60_000;
    assert.ok(
      DEFAULT_BUDGET_MS < heartbeatMs,
      `预算 ${DEFAULT_BUDGET_MS}ms 应当小于心跳周期 ${heartbeatMs}ms`,
    );
    assert.ok(DEFAULT_BUDGET_MS > heartbeatMs / 2, '也不该小到每次只干一点点');
  });
});

describe('空转检测：一批什么都没推进，下一批也不会', () => {
  /** 永远「还没跑完」但什么都不做的 runner —— 那次 NaN bug 的形状。 */
  function spinner() {
    let n = 0;
    return {
      calls: () => n,
      runner: {
        async runBatch() {
          n += 1;
          return { captured: 0, failed: 0, done: false, stoppedBy: null };
        },
        status: () => ({ counts: { pending: 42 } }),
      },
    };
  }

  test('几批之后停下，而不是转到天荒地老', async () => {
    // 真实发生过：`resume()` 漏写 `maxCaptures` → `maxItems` 是 NaN →
    // `while (0 < NaN)` 一次都不进 → 一个请求都不发。日志里是每秒几十条 `batch`。
    //
    // **豆瓣那边什么都看不到**（一个请求都没发），所以不会有任何外力把它撞停。
    const { runner, calls } = spinner();
    // 时间不动：证明挡住它的是空转检测，不是预算
    const r = await driveWithinBudget({ runner, now: () => 0, budgetMs: 60_000 });

    assert.equal(r.stoppedBy, 'driver_stalled');
    assert.equal(calls(), MAX_IDLE_BATCHES);
    assert.equal(r.done, false, '空转不是「跑完了」');
  });

  test('预算挡不住它 —— 所以必须另有一层', async () => {
    // 预算只会让空转每 22 秒重来一次，而心跳一直把它叫醒。那是一个能烧到用户
    // 合上电脑为止的循环。
    const { runner, calls } = spinner();
    await driveWithinBudget({ runner, now: () => 0, budgetMs: DEFAULT_BUDGET_MS });
    assert.ok(calls() <= MAX_IDLE_BATCHES, '时间不推进时，只有空转检测能停下它');
  });

  test('停下来时把队列状态一起报出来 —— 下次才有的查', async () => {
    const events = [];
    const { runner } = spinner();
    await driveWithinBudget({ runner, now: () => 0, onEvent: (e) => events.push(e) });

    const st = events.find((e) => e.type === 'stalled');
    assert.ok(st, '必须发一条事件出来，否则它只是安静地停了');
    assert.deepEqual(st.counts, { pending: 42 });
  });

  test('有进展就重新计数 —— 偶尔一批空转是正常的', async () => {
    // 比如上一页刚触发降速、这一批恰好什么都没轮到。
    let n = 0;
    const runner = {
      async runBatch() {
        n += 1;
        // 每两批里有一批是空的
        const idle = n % 2 === 0;
        return { captured: idle ? 0 : 1, failed: 0, done: n >= 12, stoppedBy: null };
      },
    };
    const r = await driveWithinBudget({ runner, now: () => 0, budgetMs: 60_000 });
    assert.equal(r.done, true, '交替出现的空批不该被当成死循环');
    assert.equal(r.stoppedBy, null);
  });

  test('一批既没抓到也没失败、但说自己跑完了 → 那是正常收尾，不是空转', async () => {
    const runner = {
      runBatch: async () => ({ captured: 0, failed: 0, done: true, stoppedBy: null }),
    };
    const r = await driveWithinBudget({ runner, now: () => 0 });
    assert.equal(r.done, true);
    assert.equal(r.stoppedBy, null);
  });
});
