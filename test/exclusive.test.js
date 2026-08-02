import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Exclusive } from '../src/crawl/exclusive.js';

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('互斥锁', () => {
  test('空闲时照常跑，并把返回值带回来', async () => {
    const lock = new Exclusive();
    assert.equal(lock.busy, false);
    assert.equal(await lock.run('抓取', async () => 42), 42);
    assert.equal(lock.busy, false);
  });

  test('被占用时立刻拒绝，不排队', async () => {
    // 排队意味着第二件事会在用户不知道的时候自己开始跑——可能是十几分钟以后。
    // 对一个每个请求都算账的工具来说，静默延后启动比直接拒绝糟糕得多。
    const lock = new Exclusive();
    let secondStarted = false;

    const first = lock.run('抓取', () => sleep(30));
    await assert.rejects(
      () => lock.run('演练', async () => { secondStarted = true; }),
      /已经有「抓取」在进行中/,
    );
    assert.equal(secondStarted, false, '第二件事的函数体一次都不该被调用');

    await first;
    // 放开之后能再拿
    assert.equal(await lock.run('演练', async () => 'ok'), 'ok');
  });

  test('拒绝信息说清了是谁占着、占了多久、以及为什么不让', async () => {
    // 「已经有一个在跑」不够——用户会以为是 bug。得说出后果：两条请求流叠加会
    // 让实际频率翻倍，而那是封号路径。
    let t = 1000;
    const lock = new Exclusive({ now: () => t });
    const first = lock.run('抓取', () => sleep(30));
    t = 46_000;

    await assert.rejects(() => lock.run('演练', async () => {}), (e) => {
      assert.match(e.message, /抓取/);
      assert.match(e.message, /45 秒前/);
      assert.match(e.message, /频率|账号/);
      return true;
    });
    await first;
  });

  test('临界区抛异常也要放锁', async () => {
    // 不放的话，一次失败就把整个扩展锁死到下次重启——而抓取里出错是常态
    // （风控、验证码、网络抖动）。
    const lock = new Exclusive();
    await assert.rejects(() => lock.run('抓取', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(lock.busy, false);
    assert.equal(await lock.run('抓取', async () => 'ok'), 'ok');
  });

  test('同步抛也要放锁', async () => {
    const lock = new Exclusive();
    await assert.rejects(() => lock.run('抓取', () => { throw new Error('同步炸'); }), /同步炸/);
    assert.equal(lock.busy, false);
  });

  test('holder 报出当前占用者，空闲时是 null', async () => {
    const lock = new Exclusive();
    assert.equal(lock.holder, null);
    const p = lock.run('开始抓取', () => sleep(20));
    assert.equal(lock.holder, '开始抓取');
    await p;
    assert.equal(lock.holder, null);
  });

  test('并发两个请求只有一个能进', async () => {
    // 真实触发路径：popup 和面板都开着，两边都点了「开始抓取」。
    const lock = new Exclusive();
    let ran = 0;
    const results = await Promise.allSettled([
      lock.run('开始抓取', async () => { ran += 1; await sleep(20); }),
      lock.run('开始抓取', async () => { ran += 1; await sleep(20); }),
    ]);

    assert.equal(ran, 1, '两个都跑起来了 —— 那就是两条请求流');
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  });

  test('顺序执行不受影响', async () => {
    // 锁不该让正常的连续操作变慢或失败。
    const lock = new Exclusive();
    for (let i = 0; i < 5; i++) {
      assert.equal(await lock.run(`第 ${i} 次`, async () => i), i);
    }
  });
});

describe('持有者永远不返回 —— 合上电脑睡一觉就会这样', () => {
  /**
   * 真实发生过：抓取跑着的时候合上电脑，醒来之后
   *
   *     心跳出错 已经有「抓取」在进行中（93990 秒前开始）
   *
   * 26 小时。持有者那一段 await 再也没回来，锁就永久被占了。此后每一次心跳、
   * 每一次「继续」、每一次「开始」全被拒，而拒绝理由看起来还很合理——用户
   * 看到的是「点继续没反应」，唯一的出路是重载扩展。
   *
   * 原来的实现只在 `finally` 里放锁：挡住了「抛异常」，没挡住「永远不结算」。
   */

  /** 一个永远不结算的临界区。 */
  const wedged = () => new Promise(() => {});

  test('久不吭声的持有者会被抢占', async () => {
    let t = 0;
    const lock = new Exclusive({ staleAfterMs: 60_000, now: () => t });
    lock.run('抓取', wedged); // 永不返回

    t = 61_000;
    assert.equal(lock.stale, true);
    assert.equal(await lock.run('恢复抓取', async () => 'ok'), 'ok');
  });

  test('**还在吭声的持有者不许被抢占**', async () => {
    // 判早了会真的造成两条请求流叠加，那比多等几分钟严重得多。
    let t = 0;
    const lock = new Exclusive({ staleAfterMs: 60_000, now: () => t });
    lock.run('抓取', wedged);

    // 一路都在干活，只是这一件事跑得久
    for (let i = 0; i < 10; i++) {
      t += 50_000;
      lock.touch();
    }
    assert.equal(lock.stale, false, `持有了 ${t / 1000} 秒但一直在吭声，不该判死`);
    await assert.rejects(() => lock.run('恢复抓取', async () => {}), /已经有/);
  });

  test('抢占必须报出来，不能悄悄夺锁', async () => {
    // 静默地夺锁等于把一次异常变成看不见的事。而它意味着「上一段抓取卡死了」
    // ——那是要查的，不是要藏的。
    let t = 0;
    const seen = [];
    const lock = new Exclusive({ staleAfterMs: 60_000, now: () => t, onPreempt: (i) => seen.push(i) });
    lock.run('抓取', wedged);
    t = 200_000;
    await lock.run('恢复抓取', async () => {});

    assert.equal(seen.length, 1);
    assert.equal(seen[0].name, '抓取');
    assert.equal(seen[0].silentMs, 200_000);
  });

  test('**老持有者醒过来，不许放掉新持有者的锁**', async () => {
    // 这是抢占最危险的一步。老的那段若在 finally 里无条件清掉持有者，放掉的
    // 是新持有者的锁 —— 于是真的出现两条并行的流，正好是这个类存在的理由。
    let t = 0;
    const lock = new Exclusive({ staleAfterMs: 60_000, now: () => t });

    let wakeUp;
    const old = lock.run('抓取', () => new Promise((r) => { wakeUp = r; }));

    t = 61_000;
    let newHolderDone;
    const fresh = lock.run('恢复抓取', () => new Promise((r) => { newHolderDone = r; }));
    assert.equal(lock.holder, '恢复抓取');

    wakeUp(); // 老的醒了
    await old;

    assert.equal(lock.holder, '恢复抓取', '老持有者把新持有者的锁放掉了');
    assert.equal(lock.busy, true);
    await assert.rejects(() => lock.run('演练', async () => {}), /已经有「恢复抓取」/);

    newHolderDone();
    await fresh;
    assert.equal(lock.busy, false);
  });

  test('默认阈值撑得住一次合法的长批次', async () => {
    // 一批 25 个请求，每个最坏 30 秒超时 → 十几分钟是合法的。所以判据必须是
    // 「多久没吭声」，不是「持有了多久」。
    const { DEFAULT_STALE_AFTER_MS } = await import('../src/crawl/exclusive.js');
    assert.ok(DEFAULT_STALE_AFTER_MS >= 2 * 60_000, '阈值太短，正常抓取会被误判为死');
  });
});
