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
    const lock = new Exclusive();
    let t = 1000;
    const first = lock.run('抓取', () => sleep(30), () => t);
    t = 46_000;

    await assert.rejects(() => lock.run('演练', async () => {}, () => t), (e) => {
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
