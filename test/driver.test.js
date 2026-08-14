import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { readFile } from 'node:fs/promises';

import {
  createDrive, driveWithinBudget, DEFAULT_BUDGET_MS, MAX_IDLE_BATCHES,
} from '../src/crawl/driver.js';
import { HEARTBEAT_PERIOD_MINUTES } from '../src/crawl/supervisor.js';

/**
 * 「我手上这一段还是当前那一段吗」——四种情形，一个比较。
 *
 * 头一条是 #3 带来的回归测试（@Colafornia），复现的是真实抓取里那次卡死：
 * 电影列表抓到 30 条之后不再推进，暂停再继续只留下 `preempted · stale_holder`
 * 和 `resumed` 两行日志，一个请求都没有再发出去。原样保留，因为它钉住的正是
 * 那条路径；其余三条补齐另外三种代号变化（理由见 driver.js 的 createDrive）。
 */
describe('createDrive：一段的身份认代号，不认「有没有 promise」', () => {
  /** @param {{staleAfterMs?: number}} [opts] */
  function harness({ staleAfterMs = 100 } = {}) {
    let now = 0;
    let runs = 0;
    /** @type {(() => void)[]} */
    const settle = [];
    const made = createDrive({
      staleAfterMs,
      now: () => now,
      run: () => {
        runs += 1;
        return new Promise((resolve) => settle.push(() => resolve(undefined)));
      },
    });
    return {
      ...made,
      runs: () => runs,
      advance: (ms) => { now += ms; },
      settleAll: () => { settle.splice(0).forEach((f) => f()); },
    };
  }

  test('失联的驱动被接管后会启动新的一段', async () => {
    let now = 0;
    let runs = 0;
    const { drive, lock } = createDrive({
      staleAfterMs: 100,
      now: () => now,
      run: () => {
        runs += 1;
        if (runs === 1) return new Promise(() => {});
      },
    });

    void drive();
    now = 101;
    await lock.run('恢复抓取', () => {});
    void drive();
    assert.equal(runs, 2);
  });

  test('心跳重入不会再开一段 —— 重复唤醒是常态，不是冲突', async () => {
    const h = harness();
    const a = h.drive();
    const b = h.drive();
    assert.equal(h.runs(), 1, '不许因为又醒了一次就再开一段');
    h.settleAll();
    await Promise.all([a, b]);
  });

  test('上一段正常跑完放了锁，下一次唤醒开新的一段', async () => {
    const h = harness();
    const first = h.drive();
    h.settleAll();
    await first;

    // 放锁之后 `lock.gen` 是 null。**这就是当年漏掉的那一步**：`stale` 以
    // `_held !== null` 开头，锁一空它就永远是 false，只看它就会把上一段的
    // promise 一直返回下去。
    assert.equal(h.lock.gen, null);
    const second = h.drive();
    assert.equal(h.runs(), 2);
    h.settleAll();
    await second;
  });

  test('卡死但还没人抢占时，自己就会接管', () => {
    const h = harness();
    void h.drive();
    assert.equal(h.runs(), 1);
    h.advance(101); // 判死，但锁还握在那一段手里
    void h.drive();
    assert.equal(h.runs(), 2, '判死了就该自己抢过来重开，不能等别的操作来救');
    h.settleAll();
  });
});

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

  test('**另一头在收尾：一批都不跑，如实报上去**', async () => {
    // 心跳与界面各会叫一次推进，而「推进」与「收尾」是两条消息，中间有缝。
    // 撞进这条缝的那一次要什么都不做：不跑批（收尾正在封段，这时抓到的东西会
    // 落在封条外面），也不能把 `done` 报成「干净跑完」——上层看到那个会跟着
    // 再收尾一次，而档案已经封好了，于是弹出一句「收尾失败」。
    let n = 0;
    const runner = {
      async runBatch() {
        n += 1;
        return { captured: 0, failed: 0, done: true, stoppedBy: null, finishing: true };
      },
    };
    const r = await driveWithinBudget({ runner, now: () => 0, budgetMs: 60_000 });

    assert.equal(r.finishing, true, '这个状态必须传到上层，否则它无从分辨');
    assert.equal(n, 1, '认出来就该立刻退出');
    assert.equal(r.captured, 0);
  });

  test('平常那些批次不带 finishing —— 免得上层永远什么都不做', async () => {
    const { runner, nowRef } = fakeRunner({ totalBatches: 2, batchCostMs: 10 });
    const r = await driveWithinBudget({ runner, now: nowRef, budgetMs: 60_000 });
    assert.equal(r.finishing, false);
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

/**
 * 上面那个 `finishing` 只有被 background 认了才有用。
 *
 * background.js 在 node:test 里导入不了（顶层全是 `chrome.*`），所以判据只能读源码。
 * 这类判据的老毛病是钉在一句文案上，改一个字就悄悄失效——所以这里钉的是**错误码**
 * 与**字段名**，那两样改了必须同时改这里。
 */
describe('service worker 那边要认这条缝', () => {
  const read = () => readFile(new URL('../src/background.js', import.meta.url), 'utf-8');

  test('`finishing` 要在判「跑完了」之前就早退', async () => {
    const bg = await read();
    const fn = bg.slice(bg.indexOf('async function drive()'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));

    const early = body.indexOf('r.result.finishing');
    const doneBranch = body.indexOf('r.result.done &&');
    assert.ok(early > 0, 'drive() 里没有认出「另一头在收尾」');
    assert.ok(doneBranch > 0, '找不到判「跑完了」的那一支，这条判据失去了意义');
    assert.ok(early < doneBranch,
      '认「正在收尾」必须在判「跑完了」之前 —— 放在后面等于没放，那一支已经去收尾了');
    assert.match(body.slice(early, doneBranch), /return/, '认出来之后要什么都不做地返回');
  });

  test('`no_run` 不算收尾失败', async () => {
    // 「已经收完了」与「收尾这一步坏了」是两回事：后者要停下整场抓取并弹通知
    // （心跳据此不再自动重试），前者什么都不用做。混在一起的话，一次成功的抓取
    // 最后一屏是红的。
    const bg = await read();
    const fn = bg.slice(bg.indexOf('async function drive()'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    const catchAt = body.indexOf('} catch (err) {');
    assert.ok(catchAt > 0, '找不到收尾的 catch');
    const tail = body.slice(catchAt);
    const guard = tail.indexOf("reason === 'no_run'");
    const pause = tail.indexOf('FINALIZE_FAILED');
    assert.ok(guard > 0, '收尾的 catch 里没有认 no_run');
    assert.ok(guard < pause, 'no_run 要在记 FINALIZE_FAILED 之前就返回');
  });

  test('错误码要能过 offscreen 那条边', async () => {
    // `reason` 是挂在 Error 上的，而消息通道只认 JSON——不显式带过去就只剩一句话。
    const host = await readFile(new URL('../src/offscreen/host.js', import.meta.url), 'utf-8');
    assert.match(host, /err\)\.reason = r\.reason/, 'host 要把错误码装回 Error 上');
    const off = await readFile(new URL('../src/offscreen/offscreen.js', import.meta.url), 'utf-8');
    assert.match(off, /reason: typeof e\?\.reason === 'string'/, 'offscreen 要把错误码送过界');
  });

  test('甩出去的推进要有人接 —— 否则只剩一条没人认领的红字', async () => {
    // `void drive()` 一旦 reject，浏览器把它记成 Uncaught (in promise)，显示在扩展
    // 详情页上，指着 `drive()` 的最后一行——那行什么错都没有，它只是这个 async
    // 函数的栈帧。用户看到「扩展报错了」，而没有任何线索指向真正发生的事。
    //
    // 判据是**数出来**的：文件里不许再出现没接住的 `drive()`。写死三处调用点的话，
    // 第四处照样会漏。
    // 先去掉注释：`driveDetached` 的说明里就写着 `void drive()` 这几个字，
    // 而一条会被自己的说明判红的判据活不过一个星期。
    const bg = (await read())
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const bare = [...bg.matchAll(/void drive\(\)/g)];
    assert.deepEqual(bare.map((m) => m.index), [],
      '有没接住的 void drive() —— 用 driveDetached()');
    assert.match(bg, /function driveDetached\(\)[\s\S]{0,200}?\.catch\(/,
      'driveDetached 必须真的接住，而不只是换个名字');
  });
});
