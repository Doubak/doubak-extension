import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { driveWithinBudget, DEFAULT_BUDGET_MS } from '../src/crawl/driver.js';
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
