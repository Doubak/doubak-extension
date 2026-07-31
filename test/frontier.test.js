import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  Frontier,
  StallDetector,
  RouteProgress,
  transitionFor,
  MAX_NETWORK_RETRIES,
} from '../src/crawl/frontier.js';

/** @param {object} [over] */
function item(over = {}) {
  return {
    url: 'https://www.douban.com/people/x/statuses?p=1',
    urlKey: 'https://www.douban.com/people/x/statuses?p=1',
    routeKey: 'broadcast.timeline',
    intent: 'broadcast.timeline',
    ...over,
  };
}

describe('判定 → 状态的映射（判错方向的代价是账号）', () => {
  test('ok / gone / soft404 都算处理完，继续走', () => {
    for (const v of ['ok', 'gone', 'soft404']) {
      const t = transitionFor(v);
      assert.equal(t.state, 'done', v);
      assert.equal(t.stopRun, false);
    }
  });

  test('blocked 与 challenge 转等待人工，且【绝不重试】', () => {
    // 在软封锁上重试正是把限流升级成封号的标准路径。
    for (const v of ['blocked', 'challenge']) {
      const t = transitionFor(v);
      assert.equal(t.state, 'awaiting_human', v);
      assert.equal(t.retryable, false, `${v} 不允许重试`);
      assert.equal(t.stopRun, false, '暂停不是停机');
    }
  });

  test('login 是停止条件，整场停机', () => {
    const t = transitionFor('login');
    assert.equal(t.state, 'terminal_stop');
    assert.equal(t.stopRun, true);
    assert.equal(t.reason, 'session_expired');
  });

  test('判不出来 → failed，不是 done', () => {
    // 「大概没事」是这套系统里最危险的一句话。
    const t = transitionFor(null);
    assert.equal(t.state, 'failed');
    assert.equal(t.reason, 'unclassified');
  });

  test('未知 verdict 当作不可信，不得当作 ok', () => {
    const t = transitionFor('rate_limited_someday');
    assert.equal(t.state, 'failed');
    assert.notEqual(t.state, 'done');
  });
});

describe('失败页阻塞该路线，不跳过', () => {
  // 跳过会破坏「这条线以上全部已抓」的不变量，而那正是连续性证明的基础。

  test('有失败条目时，同路线不再取出新条目', () => {
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a' }));
    f.enqueue(item({ urlKey: 'b' }));

    const first = f.next();
    f.settle(first, null); // 判不出来 → failed

    assert.equal(f.next(), null, '同路线应当被阻塞');
  });

  test('别的路线不受影响', () => {
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a', routeKey: 'broadcast.timeline' }));
    f.enqueue(item({ urlKey: 'b', routeKey: 'interest.movie.collect' }));

    f.settle(f.next(), null);

    const other = f.next();
    assert.ok(other, '另一条路线应当照常推进');
    assert.equal(other.routeKey, 'interest.movie.collect');
  });

  test('等待人工的条目同样阻塞', () => {
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a' }));
    f.enqueue(item({ urlKey: 'b' }));

    f.settle(f.next(), 'challenge');
    assert.equal(f.next(), null, '等人处理期间不该继续抓这条线');
  });

  test('人工处理完毕后可以恢复', () => {
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a' }));
    f.enqueue(item({ urlKey: 'b' }));
    f.settle(f.next(), 'blocked');

    const resumed = f.resumeAfterHuman();
    assert.equal(resumed, 1);
    assert.ok(f.next(), '恢复后应当能继续');
  });
});

describe('重试只给网络错误', () => {
  test('网络错误可有限重试', () => {
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a' }));

    const it = f.next();
    const r = f.settleNetworkError(it, '连接超时');
    assert.equal(r.willRetry, true);
    assert.equal(it.state, 'pending');
  });

  test('超过次数就判失败', () => {
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a' }));

    let it;
    for (let i = 0; i <= MAX_NETWORK_RETRIES; i++) {
      it = f.next();
      f.settleNetworkError(it, '超时');
    }
    it = f.next();
    assert.equal(it, null, '重试用尽后该条目应当变成失败并阻塞路线');
  });

  test('风控不走重试路径', () => {
    // settle() 处理判定，settleNetworkError() 处理网络错误，两者不混用。
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a' }));
    const it = f.next();
    f.settle(it, 'blocked');
    assert.equal(it.state, 'awaiting_human', '不是 pending，也就不会被重试');
  });
});

describe('停机', () => {
  test('login 导致整场停机，队列不再产出', () => {
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a' }));
    f.enqueue(item({ urlKey: 'b', routeKey: 'other' }));

    f.settle(f.next(), 'login');

    assert.equal(f.stopped, true);
    assert.equal(f.stopReason, 'session_expired');
    assert.equal(f.next(), null, '停机后所有路线都不再产出');
  });

  test('停机后不接受新入队', () => {
    const f = new Frontier();
    f.stop('session_expired');
    assert.equal(f.enqueue(item({ urlKey: 'x' })), false);
  });
});

describe('同优先级内深度优先：先把手上这条跑完', () => {
  test('不在同优先级的几条路线之间来回轮转', () => {
    // 15 条标记列表优先级完全一样。翻页会把下一页**追加到队尾**，于是按入队顺序
    // 取的话就成了：每条各抓一页、再各抓一页……十五条一起慢慢爬。中途一停，得到
    // 的是十五份半截列表——每一份都不完整，连续性都证明不了。
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a1', routeKey: 'A', priority: 40 }));
    f.enqueue(item({ urlKey: 'b1', routeKey: 'B', priority: 40 }));

    // 抓完 A 的第 1 页，它入队第 2 页（追加到队尾）
    const a1 = f.next();
    assert.equal(a1.routeKey, 'A');
    f.settle(a1, 'ok');
    f.enqueue(item({ urlKey: 'a2', routeKey: 'A', priority: 40 }));

    const nxt = f.next();
    assert.equal(nxt.routeKey, 'A', '该继续跑 A 的第 2 页，而不是跳去开 B');
  });

  test('一条跑完了才开下一条', () => {
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a1', routeKey: 'A', priority: 40 }));
    f.enqueue(item({ urlKey: 'b1', routeKey: 'B', priority: 40 }));

    f.settle(f.next(), 'ok'); // A 第 1 页完，没有下一页 = A 跑完了
    const nxt = f.next();
    assert.equal(nxt.routeKey, 'B', 'A 没活了就该开 B');
  });

  test('优先级仍然压过一切 —— 深度优先只在同一层内生效', () => {
    // 广播（10）就算还没开工，也要排在已经开工的标记列表（40）前面。
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'i1', routeKey: 'interest', priority: 40 }));
    f.settle(f.next(), 'ok');
    f.enqueue(item({ urlKey: 'i2', routeKey: 'interest', priority: 40 }));
    f.enqueue(item({ urlKey: 'b1', routeKey: 'broadcast', priority: 10 }));

    assert.equal(f.next().routeKey, 'broadcast', '优先级必须压过深度优先');
  });

  test('同一条路线内部仍是先进先出 —— 分页必须按页序走', () => {
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'p1', routeKey: 'A', priority: 40 }));
    f.enqueue(item({ urlKey: 'p2', routeKey: 'A', priority: 40 }));
    const first = f.next();
    assert.equal(first.urlKey, 'p1');
  });
});

describe('clearStop：「继续」这个按钮的落点', () => {
  test('停机之后能重新产出 —— 否则「继续」就是个假按钮', () => {
    // 真实症状：用户点暂停，再点继续，得到的是一条「需要你处理：user_paused」的通知。
    // 因为 frontier 还停着，下一批立刻又返回同一个停机原因。
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a' }));
    f.stop('user_paused');
    assert.equal(f.next(), null);

    const r = f.clearStop();
    assert.equal(r.wasStopped, true);
    assert.equal(f.stopped, false);
    assert.equal(f.stopReason, null, '原因也要清 —— 留着它下次会被当成还停着');
    assert.ok(f.next(), '继续之后必须真的能继续');
  });

  test('顺手把等人处理的条目放回队列', () => {
    // 「继续」的语义就是「我处理完了」。留在 awaiting_human 里的话，那条路线
    // 从此永久堵死——而 awaiting_human 是**连带阻塞**整条路线的。
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a' }));
    f.enqueue(item({ urlKey: 'b' }));
    f.settle(f.next(), 'challenge');
    f.stop('user_paused');

    const r = f.clearStop();
    assert.equal(r.resumed, 1);
    assert.equal(f.counts().awaiting_human, 0);
  });

  test('可以只清停机、不动等人处理的条目', () => {
    // 崩溃恢复走的是这条：验证码还没解决，不该假装解决了。
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a' }));
    f.enqueue(item({ urlKey: 'b' }));
    f.settle(f.next(), 'challenge');
    f.stop('user_paused');

    const r = f.clearStop({ resumeHuman: false });
    assert.equal(r.resumed, 0);
    assert.equal(f.counts().awaiting_human, 1);
  });

  test('本来就没停 → wasStopped 为 false，调用方据此区分「已经在跑了」', () => {
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a' }));
    const r = f.clearStop();
    assert.equal(r.wasStopped, false);
  });

  test('清完之后能重新入队 —— 停机期间 enqueue 是被拒的', () => {
    const f = new Frontier();
    f.stop('user_paused');
    assert.equal(f.enqueue(item({ urlKey: 'x' })), false);
    f.clearStop();
    assert.equal(f.enqueue(item({ urlKey: 'x' })), true);
  });
});

describe('去重', () => {
  test('同一个 url_key 不重复入队', () => {
    const f = new Frontier();
    assert.equal(f.enqueue(item({ urlKey: 'same' })), true);
    assert.equal(f.enqueue(item({ urlKey: 'same' })), false);
    assert.equal(f.counts().pending, 1);
  });

  test('url 不同但 url_key 相同也算重复', () => {
    // 跟踪参数不该让同一页被抓两次。
    const f = new Frontier();
    f.enqueue(item({ url: 'https://x/?a=1&_spm_id=A', urlKey: 'https://x/?a=1' }));
    const added = f.enqueue(item({ url: 'https://x/?a=1&_spm_id=B', urlKey: 'https://x/?a=1' }));
    assert.equal(added, false);
  });
});

describe('崩溃恢复', () => {
  test('在途条目回到待抓 —— 它们没写完', () => {
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a' }));
    f.next(); // 变成 in_flight，此时崩溃

    const restored = Frontier.restore(f.snapshot());
    assert.equal(restored.counts().in_flight, 0);
    assert.equal(restored.counts().pending, 1);
  });

  test('恢复后不会把已入队的重新加一遍', () => {
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a' }));
    const restored = Frontier.restore(f.snapshot());
    assert.equal(restored.enqueue(item({ urlKey: 'a' })), false);
  });

  test('已完成与失败的状态被保留', () => {
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a' }));
    f.enqueue(item({ urlKey: 'b', routeKey: 'r2' }));
    f.settle(f.next(), 'ok');
    f.settle(f.next(), null);

    const c = Frontier.restore(f.snapshot()).counts();
    assert.equal(c.done, 1);
    assert.equal(c.failed, 1);
  });
});

describe('停滞检测：终止靠它，不靠「本页没有新条目」', () => {
  test('整页重复是正常的，不立刻停', () => {
    // 头部插入会把条目推向后面的页，重复是设计所要的方向。
    const d = new StallDetector(3);
    assert.equal(d.observePage(['1', '2', '3']).stalled, false);
    assert.equal(d.observePage(['1', '2', '3']).stalled, false, '一页重复不算停滞');
    assert.equal(d.observePage(['1', '2', '3']).stalled, false, '两页也不算');
    assert.equal(d.observePage(['1', '2', '3']).stalled, true, '连续三页才算');
  });

  test('中途出现新条目就重置计数', () => {
    const d = new StallDetector(3);
    d.observePage(['1']);
    d.observePage(['1']); // 无进展 1
    d.observePage(['1']); // 无进展 2
    assert.equal(d.observePage(['2']).stalled, false, '有新条目，重新计数');
    assert.equal(d.consecutiveNoProgress, 0);
  });

  test('短页不等于末页 —— 实测列表中段就有空洞', () => {
    // 真实档案里游戏列表第 7、14、17 页只渲染 14、14、13 条（槽位 15），
    // 那是被审查抑制的条目留下的中段空洞。把短页当末页会拦腰截断列表。
    const d = new StallDetector(3);
    const full = (n, from) => Array.from({ length: n }, (_, i) => String(from + i));

    assert.equal(d.observePage(full(15, 0)).stalled, false);
    assert.equal(d.observePage(full(14, 15)).stalled, false, '短页仍有新条目，继续');
    assert.equal(d.observePage(full(15, 29)).stalled, false);
    assert.equal(d.uniqueCount, 44);
  });

  test('统计新增与重复', () => {
    const d = new StallDetector();
    const r = d.observePage(['1', '2', '3']);
    assert.equal(r.newIds, 3);
    assert.equal(r.duplicates, 0);

    const r2 = d.observePage(['2', '3', '4']);
    assert.equal(r2.newIds, 1);
    assert.equal(r2.duplicates, 2, '跨页重复是免费的，记下来即可');
  });

  test('可查询某个 ID 是否见过', () => {
    const d = new StallDetector();
    d.observePage(['a']);
    assert.equal(d.hasSeen('a'), true);
    assert.equal(d.hasSeen('b'), false);
  });

  test('拒绝非法阈值', () => {
    assert.throws(() => new StallDetector(0), /正整数/);
    assert.throws(() => new StallDetector(1.5), /正整数/);
  });
});

describe('路线推进与水位线', () => {
  /** @param {object} [over] */
  const progress = (over = {}) =>
    new RouteProgress({ routeKey: 'broadcast.timeline', enumeration: 'bounded', ...over });

  test('干净走完 → 连续，可推进水位线', () => {
    const p = progress();
    p.markFinished();
    assert.equal(p.contiguous, true);
    assert.equal(p.canAdvance, true);
  });

  test('有缺口 → 不许推进', () => {
    const p = progress();
    p.recordGap('fetch_failed', '第 3 页连续失败');
    p.markFinished();
    assert.equal(p.canAdvance, false);
  });

  test('被打断 → 不许推进', () => {
    // 重复是免费的，空洞是永久且不可检测的。
    const p = progress();
    p.markStopped('blocked');
    assert.equal(p.canAdvance, false);
    assert.equal(p.gaps.length, 1);
  });

  test('没走完就不许推进', () => {
    const p = progress();
    assert.equal(p.canAdvance, false, '既没 markFinished 也没缺口，一样不许推进');
  });

  test('枚举方式被记住 —— 它决定下游能否推断删除', () => {
    assert.equal(progress({ enumeration: 'bounded' }).enumeration, 'bounded');
    assert.equal(progress({ enumeration: 'full' }).enumeration, 'full');
  });
});

describe('未解决条目的查询', () => {
  test('路线上还有未完成的就报 true', () => {
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a' }));
    assert.equal(f.hasUnresolved('broadcast.timeline'), true);

    f.settle(f.next(), 'ok');
    assert.equal(f.hasUnresolved('broadcast.timeline'), false);
  });

  test('失败的条目算未解决 —— 它阻塞路线完成', () => {
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a' }));
    f.settle(f.next(), null);
    assert.equal(f.hasUnresolved('broadcast.timeline'), true);
  });
});

describe('判断「还有活吗」不能用 next()', () => {
  test('hasReady 不改变任何状态', async () => {
    // next() 会把取出的条目标成 in_flight。拿它当判断用会白白消耗一个条目，
    // 让它永远卡在 in_flight，进而堵死整条路线——这个 bug 真的写出来过。
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a' }));

    assert.equal(f.hasReady(), true);
    assert.deepEqual(f.counts(), {
      pending: 1, in_flight: 0, done: 0, failed: 0, awaiting_human: 0, terminal_stop: 0,
    });

    // 连查十次也不该消耗掉它
    for (let i = 0; i < 10; i++) f.hasReady();
    assert.equal(f.counts().pending, 1);
    assert.ok(f.next(), '还取得出来');
  });

  test('对比：next() 确实会改状态', async () => {
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a' }));
    f.next();
    assert.equal(f.counts().in_flight, 1);
    assert.equal(f.hasReady(), false, 'in_flight 的条目会挡住同路线');
  });

  test('队列空时 hasReady 为 false', () => {
    assert.equal(new Frontier().hasReady(), false);
  });

  test('全部完成后 hasReady 为 false', () => {
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a' }));
    f.settle(f.next(), 'ok');
    assert.equal(f.hasReady(), false);
  });

  test('被阻塞的路线不算 ready，别的路线算', () => {
    const f = new Frontier();
    f.enqueue(item({ urlKey: 'a', routeKey: 'r1' }));
    f.enqueue(item({ urlKey: 'b', routeKey: 'r1' }));
    f.enqueue(item({ urlKey: 'c', routeKey: 'r2' }));
    f.settle(f.next(), null); // r1 失败，阻塞 r1

    assert.equal(f.hasReady(), true, 'r2 还能跑');
    f.settle(f.next(), 'ok'); // 跑掉 r2
    assert.equal(f.hasReady(), false, 'r1 被堵住，没别的可跑了');
  });
});
