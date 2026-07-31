import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RunStore, ScheduleStore, buildCheckpoint, CURRENT_RUN_KEY } from '../src/crawl/run-store.js';
import { MemoryKvStore } from '../src/storage/kv-store.js';
import { kvStoreContract } from './helpers/kv-store-contract.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { Frontier, StallDetector } from '../src/crawl/frontier.js';
import { Pacer } from '../src/crawl/pacing.js';
import { SPEC_VERSION } from '../src/core/spec-constants.js';

const BID = '20260729T101500Z-a3f9c1';
const DIR = `doubak-bundle-${BID}`;

function harness() {
  const kv = new MemoryKvStore();
  /** @type {Map<string, MemoryFileStore>} */
  const dirs = new Map();
  const openBundle = async (dir) => {
    if (!dirs.has(dir)) throw new Error(`目录不存在: ${dir}`);
    return dirs.get(dir);
  };
  const store = new RunStore({ kv, openBundle });
  const create = (dir) => {
    dirs.set(dir, new MemoryFileStore());
    return dirs.get(dir);
  };
  return { kv, store, dirs, create };
}

describe('指针与 checkpoint 分两处放', () => {
  test('指针在 KV 里，checkpoint 在 bundle 目录里', async () => {
    // worker 启动时还不知道 bundle 是哪个，得先有地方问一句「上次在抓什么」。
    const { kv, store, create } = harness();
    const fs = create(DIR);

    await store.setCurrentRun({ bundleId: BID, dir: DIR });
    await store.saveCheckpoint({
      bundle_id: BID, pause_reason: 'crash', paused_at: '2026-07-30T00:00:00Z',
      rate_state: { backoff_level: 2 }, routes: [], frontier: [],
    });

    assert.ok(await fs.exists('checkpoint.json'), 'checkpoint 随档案走');

    // 指针里额外镜像了**调度需要的三个字段**：service worker 读不了 OPFS，但它
    // 必须知道「有没有没抓完的、为什么停的」才能决定要不要自动恢复。
    assert.deepEqual(await kv.get(CURRENT_RUN_KEY), {
      bundleId: BID,
      dir: DIR,
      pause_reason: 'crash',
      paused_at: '2026-07-30T00:00:00Z',
      rate_state: { backoff_level: 2 },
    });
  });

  test('镜像只放调度字段，游标与 frontier 一概不进指针', async () => {
    // 多存一份就是多一个会不一致的地方。SW 拿到它们也没用，而**能拿到**就意味着
    // 有人早晚会在 SW 里写抓取逻辑。
    const { kv, store, create } = harness();
    create(DIR);

    await store.setCurrentRun({ bundleId: BID, dir: DIR });
    await store.saveCheckpoint({
      bundle_id: BID, pause_reason: 'blocked', paused_at: 'x',
      routes: [{ route_key: 'broadcast.timeline', cursor: { value: 7 } }],
      frontier: [{ url: 'https://example.com', state: 'failed' }],
    });

    const p = await kv.get(CURRENT_RUN_KEY);
    assert.equal('routes' in p, false);
    assert.equal('frontier' in p, false);
  });

  test('checkpoint 随档案走 —— 半成品换台机器也能续抓', async () => {
    const { store, create } = harness();
    create(DIR);
    await store.setCurrentRun({ bundleId: BID, dir: DIR });
    await store.saveCheckpoint({ bundle_id: BID, pause_reason: 'user_paused', routes: [], frontier: [] });

    const cp = await store.loadCheckpoint();
    assert.equal(cp.bundle_id, BID);
    assert.equal(cp.pause_reason, 'user_paused');
    assert.equal(cp.spec_version, SPEC_VERSION, '按规范写入');
  });
});

describe('没有未完成的抓取是正常状态', () => {
  test('没有指针时返回 null，不抛错', async () => {
    const { store } = harness();
    assert.equal(await store.loadCheckpoint(), null);
  });

  test('有指针但没有 checkpoint 文件也返回 null', async () => {
    const { store, create } = harness();
    create(DIR);
    await store.setCurrentRun({ bundleId: BID, dir: DIR });
    assert.equal(await store.loadCheckpoint(), null);
  });

  test('目录没了就清掉悬空指针', async () => {
    // 用户删了档案，或换了机器。留着指针会让每次启动都报错。
    const { kv, store } = harness();
    await store.setCurrentRun({ bundleId: BID, dir: 'doubak-bundle-已删除' });

    assert.equal(await store.loadCheckpoint(), null);
    assert.equal(await kv.get(CURRENT_RUN_KEY), undefined, '悬空指针应当被清掉');
  });
});

describe('checkpoint 坏了不能当成「没有未完成的抓取」', () => {
  test('解析失败时返回一个原因未知的 checkpoint', async () => {
    // 返回 null 会让恢复逻辑以为一切正常。必须让它知道「有东西没抓完，
    // 但状态读不出来」，然后由恢复策略保守处理。
    const { store, create } = harness();
    const fs = create(DIR);
    await store.setCurrentRun({ bundleId: BID, dir: DIR });
    await fs.replace('checkpoint.json', new TextEncoder().encode('{ 这不是 JSON'));

    const cp = await store.loadCheckpoint();
    assert.ok(cp, '不能返回 null');
    assert.equal(cp.pause_reason, 'checkpoint_unreadable');
  });

  test('未知的停止原因会被恢复策略拒绝自动恢复', async () => {
    const { decideResume } = await import('../src/crawl/resume-policy.js');
    const d = decideResume({ pause_reason: 'checkpoint_unreadable', paused_at: new Date().toISOString() });
    assert.equal(d.resume, false, '读不出状态时保守处理');
  });
});

describe('干净结束', () => {
  test('清掉 checkpoint 与指针', async () => {
    // 规范要求已完成的 bundle 不该再有 checkpoint.json——它的存在本身就
    // 意味着「这份档案没抓完」。
    const { kv, store, create } = harness();
    const fs = create(DIR);
    await store.setCurrentRun({ bundleId: BID, dir: DIR });
    await store.saveCheckpoint({ bundle_id: BID, pause_reason: 'crash', routes: [], frontier: [] });

    await store.clearCheckpoint();

    assert.equal(await fs.exists('checkpoint.json'), false);
    assert.equal(await kv.get(CURRENT_RUN_KEY), undefined);
  });

  test('目录已经没了也能干净收尾', async () => {
    const { store } = harness();
    await store.setCurrentRun({ bundleId: BID, dir: 'doubak-bundle-没了' });
    await assert.doesNotReject(() => store.clearCheckpoint());
  });

  test('没有指针时保存会明确报错', async () => {
    const { store } = harness();
    await assert.rejects(() => store.saveCheckpoint({}), /setCurrentRun/);
  });
});

describe('checkpoint 只放推导不出来的东西', () => {
  function parts({ pauseReason = 'crash' } = {}) {
    const frontier = new Frontier();
    frontier.enqueue({ url: 'https://x/1', urlKey: 'k1', routeKey: 'r', intent: 'i' });
    frontier.enqueue({ url: 'https://x/2', urlKey: 'k2', routeKey: 'r2', intent: 'i' });
    frontier.settle(frontier.next(), 'ok'); // 已完成

    const pacer = new Pacer({ intervalMs: 1000 });
    pacer.slowDown();

    const stall = new StallDetector();
    stall.observePage(['a', 'b', 'c']);

    return {
      bundleId: BID,
      frontier,
      pacer,
      routes: new Map([['r', { cursor: { kind: 'page', value: 7 }, stall }]]),
      lastCaptureId: `${BID}#000042`,
      pauseReason,
      pausedAt: '2026-07-29T12:00:00.000Z',
    };
  }

  test('已完成的条目一条都不写 —— 那是 index 的职责', async () => {
    // 重复记录只会带来两个可能不一致的真相来源。
    const cp = buildCheckpoint(parts());
    assert.equal(cp.frontier.length, 1, '只剩未完成的那一条');
    assert.equal(cp.frontier[0].route_key, 'r2');
  });

  test('在途的条目写成待抓 —— 它们没写完', async () => {
    const p = parts();
    p.frontier.next(); // 变成 in_flight
    const cp = buildCheckpoint(p);
    assert.equal(cp.frontier[0].state, 'pending');
  });

  test('记下每条路线的游标与停滞计数', async () => {
    const cp = buildCheckpoint(parts());
    const r = cp.routes.find((x) => x.route_key === 'r');
    assert.deepEqual(r.cursor, { kind: 'page', value: 7 });
    assert.equal(r.items_seen, 3);
    assert.equal(r.stall_counter, 0);
  });

  test('退避层级必须写进去 —— 降速要跨会话保留', async () => {
    const cp = buildCheckpoint(parts());
    assert.equal(cp.rate_state.backoff_level, 1);
    assert.equal(cp.rate_state.interval_ms, 1000);
  });

  test('带上规范版本与停止原因', async () => {
    const cp = buildCheckpoint(parts({ pauseReason: 'blocked' }));
    assert.equal(cp.spec_version, SPEC_VERSION);
    assert.equal(cp.pause_reason, 'blocked');
    assert.equal(cp.last_capture_id, `${BID}#000042`);
  });

  test('写出来的 checkpoint 能读回来', async () => {
    const { store, create } = harness();
    create(DIR);
    await store.setCurrentRun({ bundleId: BID, dir: DIR });

    const cp = buildCheckpoint(parts());
    await store.saveCheckpoint(cp);

    const back = await store.loadCheckpoint();
    assert.equal(back.rate_state.backoff_level, 1);
    assert.equal(back.routes[0].cursor.value, 7);
  });
});

describe('KV 存副本，不共享引用', () => {
  test('保存后改原对象不影响已存的值', async () => {
    // 这类「共享引用导致状态悄悄变化」的 bug 在崩溃恢复场景里极难查。
    const kv = new MemoryKvStore();
    const obj = { a: 1, nested: { b: 2 } };
    await kv.set('k', obj);
    obj.a = 999;
    obj.nested.b = 999;

    const back = await kv.get('k');
    assert.equal(back.a, 1);
    assert.equal(back.nested.b, 2);
  });

  test('不存在的键返回 undefined', async () => {
    assert.equal(await new MemoryKvStore().get('nope'), undefined);
  });
});

describe('MemoryKvStore', () => {
  test('满足 KvStore 契约', async () => {
    // 它是 IdbKvStore 的参照，所以它自己也得
    // 过同一份契约——否则「与内存实现一致」这句话就没有基准。
    await kvStoreContract(() => new MemoryKvStore());
  });
});

describe('ScheduleStore：service worker 那一侧', () => {
  /** 一对共享同一个 KV 的 store：offscreen 写全本，SW 只读镜像。 */
  function pair() {
    const kv = new MemoryKvStore();
    /** @type {Map<string, MemoryFileStore>} */
    const dirs = new Map([[DIR, new MemoryFileStore()]]);
    const full = new RunStore({ kv, openBundle: async (d) => dirs.get(d) });
    const sched = new ScheduleStore({ kv });
    return { kv, full, sched, dirs };
  }

  test('读不到东西时也**绝不**碰档案', async () => {
    // 这是它存在的全部理由：service worker 里 `createSyncAccessHandle` 不可用，
    // 所以任何试图开档案的动作都会直接抛。第一版给 SW 一个会抛的 `openBundle`，
    // 那只是把「静默不可用」变成「响亮不可用」——「开始抓取」照样失败。
    const kv = new MemoryKvStore();
    const sched = new ScheduleStore({ kv });
    // 压根没有 openBundle 可传，所以「不碰档案」是结构性的
    assert.equal(await sched.loadCheckpoint(), null);
  });

  test('offscreen 写全本 → SW 读得到调度字段', async () => {
    const { full, sched } = pair();
    await full.setCurrentRun({ bundleId: BID, dir: DIR });
    await full.saveCheckpoint({
      bundle_id: BID, pause_reason: 'blocked', paused_at: '2026-07-30T01:00:00Z',
      rate_state: { backoff_level: 1, interval_ms: 2000 },
      routes: [{ route_key: 'r', cursor: { value: 3 } }], frontier: [],
    });

    const cp = await sched.loadCheckpoint();
    assert.equal(cp.bundle_id, BID);
    assert.equal(cp.pause_reason, 'blocked');
    assert.equal(cp.paused_at, '2026-07-30T01:00:00Z');
    assert.equal(cp.rate_state.backoff_level, 1);
  });

  test('形状与真 checkpoint 的同名字段一致 —— 恢复策略不必知道拿到的是摘要', async () => {
    const { full, sched } = pair();
    await full.setCurrentRun({ bundleId: BID, dir: DIR });
    await full.saveCheckpoint({
      bundle_id: BID, pause_reason: 'blocked',
      paused_at: new Date(Date.now() - 60_000).toISOString(),
      rate_state: { backoff_level: 1 }, routes: [], frontier: [],
    });

    const { decideResume, requiredCooldownMs } = await import('../src/crawl/resume-policy.js');
    const cp = await sched.loadCheckpoint();
    assert.equal(decideResume(cp).resume, false, '软封锁不自动恢复');
    assert.ok(requiredCooldownMs(cp) > 0, '退避层级要能算出冷却');
  });

  test('刚建好指针、还没写过 checkpoint → 当成崩溃哨兵', async () => {
    // 与 runner.start() 的做法一致：宁可把正常状态误判成崩溃（代价是多做一次
    // 幂等的恢复检查），也不要把崩溃误判成正常（代价是数据对不上却无人察觉）。
    const { full, sched } = pair();
    await full.setCurrentRun({ bundleId: BID, dir: DIR });
    const cp = await sched.loadCheckpoint();
    assert.equal(cp.pause_reason, 'crash');
  });

  test('SW 更新原因只动镜像，不动档案', async () => {
    // 档案里的那份由 offscreen 写，**那份才是恢复时真正被读的**。
    const { full, sched, dirs } = pair();
    await full.setCurrentRun({ bundleId: BID, dir: DIR });
    await full.saveCheckpoint({ bundle_id: BID, pause_reason: 'crash', paused_at: 'a', routes: [], frontier: [] });

    await sched.saveCheckpoint({ pause_reason: 'user_paused', paused_at: 'b' });

    assert.equal((await sched.loadCheckpoint()).pause_reason, 'user_paused');
    const onDisk = JSON.parse(new TextDecoder().decode(await dirs.get(DIR).read('checkpoint.json')));
    assert.equal(onDisk.pause_reason, 'crash', '档案没被 SW 改过');
  });

  test('没有在跑的抓取时，写入是无操作', async () => {
    const { sched, kv } = pair();
    await sched.saveCheckpoint({ pause_reason: 'user_paused', paused_at: 'x' });
    assert.equal(await kv.get(CURRENT_RUN_KEY), undefined, '不该凭空造出一个指针');
  });

  test('clearCheckpoint 清掉指针', async () => {
    const { full, sched, kv } = pair();
    await full.setCurrentRun({ bundleId: BID, dir: DIR });
    await sched.clearCheckpoint();
    assert.equal(await kv.get(CURRENT_RUN_KEY), undefined);
    assert.equal(await sched.loadCheckpoint(), null);
  });
});
