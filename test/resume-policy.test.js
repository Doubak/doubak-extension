import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideResume,
  requiredCooldownMs,
  policyFor,
  PAUSE_REASONS,
  CRASH_SENTINEL_REASON,
} from '../src/crawl/resume-policy.js';

const NOW = Date.parse('2026-07-29T12:00:00+08:00');

/** @param {object} [over] */
function checkpoint(over = {}) {
  return {
    spec_version: 'bundle/1.0',
    bundle_id: '20260729T101500Z-a3f9c1',
    paused_at: '2026-07-29T11:00:00+08:00',
    pause_reason: 'crash',
    routes: [],
    frontier: [],
    ...over,
  };
}

describe('意外中断可以自动恢复', () => {
  test('崩溃/被杀/休眠 → 自动接着抓', () => {
    // 否则用户合上笔记本再打开，抓取就永远停在那儿了。
    const d = decideResume(checkpoint({ pause_reason: 'crash' }), { now: NOW });
    assert.equal(d.resume, true);
  });

  test('这条提示应当安静，不该吓人', () => {
    const d = decideResume(checkpoint({ pause_reason: 'crash' }), { now: NOW });
    assert.equal(d.userVisible, false, '「已从断点恢复，没有数据丢失」不需要打扰用户');
  });

  test('没有未完成的抓取就什么都不做', () => {
    const d = decideResume(null);
    assert.equal(d.resume, false);
    assert.equal(d.userVisible, false);
  });
});

describe('刻意停下的一律不自动恢复', () => {
  // 停下来是保护措施，自动恢复等于把这个保护绕过去。

  test('软封锁 —— 醒来就重试正是升级成封号的路径', () => {
    const d = decideResume(checkpoint({ pause_reason: 'blocked' }), { now: NOW });
    assert.equal(d.resume, false);
    assert.match(d.reason, /不会自动重试/);
    assert.equal(d.userVisible, true);
  });

  test('验证码 —— 必须人来解', () => {
    const d = decideResume(checkpoint({ pause_reason: 'challenge' }), { now: NOW });
    assert.equal(d.resume, false);
    assert.match(d.reason, /验证/);
  });

  test('会话失效 —— 需要重新登录', () => {
    const d = decideResume(checkpoint({ pause_reason: 'session_expired' }), { now: NOW });
    assert.equal(d.resume, false);
  });

  test('用户手动暂停 —— 他没按继续就不动', () => {
    const d = decideResume(checkpoint({ pause_reason: 'user_paused' }), { now: NOW });
    assert.equal(d.resume, false);
  });

  test('存储不足 —— 自动继续只会再撞一次', () => {
    const d = decideResume(checkpoint({ pause_reason: 'quota' }), { now: NOW });
    assert.equal(d.resume, false);
  });

  test('自动恢复的白名单很短，而且每一条都说得出理由', () => {
    // **这个白名单要一直短。** 往里加一条，就是在说「这种停法不需要人看一眼」
    // ——而绝大多数停法恰恰需要（风控、验证码、账号变了、空间不够）。
    //
    // 目前只有两条，共同点是：**用户什么都不用做，等着就好**。
    //   - crash        进程被杀 / 系统休眠，没有任何外部信号说我们该停
    //   - network_down 网络断了，恢复之后自己就好了
    const auto = PAUSE_REASONS.filter((r) => policyFor(r).autoResume);
    assert.deepEqual(auto.sort(), ['crash', 'network_down']);
    for (const r of auto) {
      assert.equal(
        policyFor(r).userVisible, false,
        `${r} 会自动恢复却还要弹通知——那是在为一件不需要用户做任何事的事打扰他`,
      );
    }
  });
});

describe('未知的停止原因保守处理', () => {
  test('不认识就不自动恢复', () => {
    // 与 verdict 的处理同理：判不出来就不能当作没事。
    const d = decideResume(checkpoint({ pause_reason: '将来新增的原因' }), { now: NOW });
    assert.equal(d.resume, false);
    assert.match(d.reason, /未知的停止原因/);
    assert.equal(d.userVisible, true);
  });

  test('缺 pause_reason 也不恢复', () => {
    const d = decideResume(checkpoint({ pause_reason: undefined }), { now: NOW });
    assert.equal(d.resume, false);
  });
});

describe('崩溃不该洗掉之前的降速', () => {
  // 否则「崩一次就恢复原速」会变成一个绕过退避的后门。

  test('此前退避过时，恢复前要等够冷却', () => {
    const cp = checkpoint({
      pause_reason: 'crash',
      paused_at: '2026-07-29T11:50:00+08:00', // 10 分钟前
      rate_state: { interval_ms: 3000, backoff_level: 1 }, // 需等 30 分钟
    });
    const d = decideResume(cp, { now: NOW });
    assert.equal(d.resume, false, '崩溃本身不能绕过退避冷却');
    assert.ok(d.cooldownMs > 0);
    assert.match(d.reason, /曾被限速/);
  });

  test('冷却等够了就恢复', () => {
    const cp = checkpoint({
      pause_reason: 'crash',
      paused_at: '2026-07-29T11:00:00+08:00', // 一小时前
      rate_state: { interval_ms: 3000, backoff_level: 1 }, // 需等 30 分钟
    });
    assert.equal(decideResume(cp, { now: NOW }).resume, true);
  });

  test('没退避过就不用等', () => {
    const cp = checkpoint({ pause_reason: 'crash', rate_state: { backoff_level: 0 } });
    assert.equal(requiredCooldownMs(cp, NOW), 0);
    assert.equal(decideResume(cp, { now: NOW }).resume, true);
  });

  test('退避层级越高等得越久', () => {
    const at = (level) =>
      requiredCooldownMs(
        checkpoint({ paused_at: '2026-07-29T11:59:00+08:00', rate_state: { backoff_level: level } }),
        NOW,
      );
    assert.ok(at(2) > at(1), '第二级应当比第一级等得久');
    assert.ok(at(9) >= at(3), '封顶后不再增加，但不该变短');
  });

  test('paused_at 无法解析时不阻塞恢复', () => {
    // 时间戳坏了不该让用户永远恢复不了——那是另一种失败模式。
    const cp = checkpoint({ paused_at: '乱码', rate_state: { backoff_level: 3 } });
    assert.equal(requiredCooldownMs(cp, NOW), 0);
  });
});

describe('崩溃哨兵', () => {
  test('默认原因就是 crash', () => {
    // 开始抓取时先写一个 crash 的 checkpoint，正常暂停或结束时再改写。
    // 「没来得及改写」本身就是崩溃的证据。
    assert.equal(CRASH_SENTINEL_REASON, 'crash');
    assert.equal(policyFor(CRASH_SENTINEL_REASON).autoResume, true);
  });

  test('这个默认值的方向是刻意选的', () => {
    // 宁可把一次正常结束误标成崩溃（多做一次幂等的恢复检查），
    // 也不要把一次崩溃误标成正常（数据对不上却无人察觉）。
    const d = decideResume(checkpoint({ pause_reason: CRASH_SENTINEL_REASON }), { now: NOW });
    assert.equal(d.resume, true);
    assert.equal(d.userVisible, false, '误报的代价必须足够小才敢这么设默认值');
  });
});
