import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Supervisor, ALARM_NAME, HEARTBEAT_PERIOD_MINUTES } from '../src/crawl/supervisor.js';

/** 内存版的 RunStore。 */
function memStore(initial = null) {
  let cp = initial;
  return {
    loadCheckpoint: async () => (cp ? { ...cp } : null),
    saveCheckpoint: async (v) => {
      cp = { ...v };
    },
    clearCheckpoint: async () => {
      cp = null;
    },
    peek: () => cp,
  };
}

/** 假的 chrome.alarms。 */
function fakeAlarms() {
  const map = new Map();
  return {
    create: async (name, opts) => map.set(name, opts),
    get: async (name) => map.get(name) ?? null,
    clear: async (name) => map.delete(name),
    _map: map,
  };
}

/** @param {object} [over] */
function harness(over = {}) {
  const store = over.store ?? memStore();
  const alarms = fakeAlarms();
  const resumed = [];
  const blocked = [];
  const sup = new Supervisor({
    store,
    alarms,
    now: over.now ?? (() => Date.parse('2026-07-29T12:00:00Z')),
    hooks: {
      onResume: async () => resumed.push(true),
      onBlocked: async (d) => blocked.push(d),
    },
  });
  return { sup, store, alarms, resumed, blocked };
}

describe('崩溃检测：开工前先写崩溃哨兵', () => {
  test('startRun 写下的 pause_reason 是 crash', async () => {
    // worker 被杀时没有机会写任何东西，指望它临终留言是不现实的。
    // 所以反过来：先假定会崩，正常结束时再改写。
    const { sup, store } = harness();
    await sup.startRun({ bundle_id: 'b1', frontier: [] });
    assert.equal(store.peek().pause_reason, 'crash');
  });

  test('正常暂停会改写掉哨兵', async () => {
    const { sup, store } = harness();
    await sup.startRun({ bundle_id: 'b1' });
    await sup.pauseRun('user_paused');
    assert.equal(store.peek().pause_reason, 'user_paused');
  });

  test('「没来得及改写」就是崩溃的证据', async () => {
    const { sup, store } = harness();
    await sup.startRun({ bundle_id: 'b1' });
    // 这里模拟 worker 被杀：什么都没做

    const fresh = harness({ store });
    const { acted, decision } = await fresh.sup.tick();
    assert.equal(decision.resume, true);
    assert.equal(acted, true, '应当自动接着抓');
  });
});

describe('心跳', () => {
  test('开工时建立闹钟', async () => {
    const { sup, alarms } = harness();
    await sup.startRun({ bundle_id: 'b1' });
    const alarm = await alarms.get(ALARM_NAME);
    assert.ok(alarm, '必须有闹钟——它是唯一一个我们死了它还在的东西');
    assert.equal(alarm.periodInMinutes, HEARTBEAT_PERIOD_MINUTES);
  });

  test('干净结束时撤掉闹钟', async () => {
    const { sup, alarms } = harness();
    await sup.startRun({ bundle_id: 'b1' });
    await sup.finishRun();
    assert.equal(await alarms.get(ALARM_NAME), null);
  });

  test('没有未完成的抓取时，心跳自己收摊', async () => {
    const { sup, alarms } = harness();
    await sup.startRun({ bundle_id: 'b1' });
    await sup.finishRun();
    await sup.tick();
    assert.equal(await alarms.get(ALARM_NAME), null, '不该留下一个永远空转的闹钟');
  });

  test('还有未完成的抓取时，即使暂不恢复也要保住闹钟', async () => {
    // 在等冷却或等人处理时，闹钟必须还在，否则以后就再也没人来叫醒了。
    const store = memStore({
      bundle_id: 'b1',
      pause_reason: 'blocked',
      paused_at: '2026-07-29T11:00:00Z',
    });
    const { sup, alarms } = harness({ store });

    await sup.tick();
    assert.ok(await alarms.get(ALARM_NAME), '被风控挡住时也要保住叫醒能力');
  });

  test('闹钟已存在就不重复创建', async () => {
    const { sup, alarms } = harness();
    await sup.startRun({ bundle_id: 'b1' });
    const first = await alarms.get(ALARM_NAME);
    await sup.tick();
    assert.equal(await alarms.get(ALARM_NAME), first);
  });
});

describe('tick 必须幂等', () => {
  test('连续多次唤醒不会重复开工', async () => {
    // worker 会因为各种事件被反复唤醒，每次都要能安全地跑一遍。
    const store = memStore({
      bundle_id: 'b1',
      pause_reason: 'crash',
      paused_at: '2026-07-29T11:00:00Z',
    });
    const { sup, resumed } = harness({ store });

    await sup.tick();
    await sup.tick();
    await sup.tick();

    assert.equal(resumed.length, 1, '只该开工一次');
  });

  test('没有 checkpoint 时 tick 是空操作', async () => {
    const { sup, resumed } = harness();
    const r = await sup.tick();
    assert.equal(r.acted, false);
    assert.equal(resumed.length, 0);
  });
});

describe('醒来后不一定接着抓', () => {
  test('被风控挡住时不恢复，但会通知', async () => {
    const store = memStore({
      bundle_id: 'b1',
      pause_reason: 'blocked',
      paused_at: '2026-07-29T11:00:00Z',
    });
    const { sup, resumed, blocked } = harness({ store });

    const r = await sup.tick();
    assert.equal(r.acted, false);
    assert.equal(resumed.length, 0, '绝不能自动重试软封锁');
    assert.equal(blocked.length, 1, '但要让用户知道');
  });

  test('崩溃恢复不打扰用户', async () => {
    const store = memStore({
      bundle_id: 'b1',
      pause_reason: 'crash',
      paused_at: '2026-07-29T11:00:00Z',
    });
    const { sup, blocked } = harness({ store });
    await sup.tick();
    assert.equal(blocked.length, 0, '「已从断点恢复」不需要打扰');
  });

  test('崩溃但此前退避过 → 先等冷却', async () => {
    const store = memStore({
      bundle_id: 'b1',
      pause_reason: 'crash',
      paused_at: '2026-07-29T11:50:00Z', // 10 分钟前
      rate_state: { backoff_level: 1 }, // 需等 30 分钟
    });
    const { sup, resumed } = harness({ store });

    const r = await sup.tick();
    assert.equal(r.acted, false);
    assert.equal(resumed.length, 0, '崩溃不能当成绕过退避的后门');
    assert.ok(r.decision.cooldownMs > 0);
  });
});

describe('暂停时能带上额外状态', () => {
  test('rate_state 会被写进 checkpoint', async () => {
    // 降速这件事必须跨会话保留，否则一恢复又按原速去撞。
    const { sup, store } = harness();
    await sup.startRun({ bundle_id: 'b1' });
    await sup.pauseRun('blocked', { rate_state: { interval_ms: 3000, backoff_level: 2 } });

    assert.equal(store.peek().rate_state.backoff_level, 2);
    assert.equal(store.peek().pause_reason, 'blocked');
  });

  test('暂停不会丢掉原有字段', async () => {
    const { sup, store } = harness();
    await sup.startRun({ bundle_id: 'b1', frontier: [{ url: 'x' }] });
    await sup.pauseRun('user_paused');
    assert.equal(store.peek().bundle_id, 'b1');
    assert.deepEqual(store.peek().frontier, [{ url: 'x' }]);
  });
});

describe('没有 alarms 时也能工作', () => {
  test('注入 alarms 是可选的（便于测试与非浏览器环境）', async () => {
    const sup = new Supervisor({
      store: memStore(),
      hooks: { onResume: async () => {} },
    });
    await assert.doesNotReject(() => sup.startRun({ bundle_id: 'b1' }));
    await assert.doesNotReject(() => sup.tick());
  });
});
