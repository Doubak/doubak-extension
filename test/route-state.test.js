import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RouteState } from '../src/crawl/route-state.js';

const BID = '20260729T101500Z-a3f9c1';

/** @param {object} [over] */
function state(over = {}) {
  return new RouteState({
    routeKey: 'broadcast.timeline',
    intent: 'broadcast.timeline',
    enumeration: 'bounded',
    ...over,
  });
}

/** @param {string[]} times @param {string[]} [ids] */
function page(times, ids = times.map((_, i) => `id${i}`)) {
  return { ids, times, captureId: `${BID}#000001`, observedAt: '2026-07-29T12:00:00+08:00' };
}

describe('水位线', () => {
  test('取本次见过的最新一条', () => {
    // 豆瓣列表是新→旧，正常情况下第一页第一条就是最新的。
    const s = state();
    s.observePage(page(['2026-07-26 12:34:00', '2026-07-25 10:00:00']));
    assert.equal(s.highWater.iso, '2026-07-26T12:34:00+08:00');
    assert.equal(s.highWater.raw, '2026-07-26 12:34:00', '原始字符串原样保留');
  });

  test('不假设页面顺序，取最大值', () => {
    const s = state();
    s.observePage(page(['2026-07-20 08:00:00', '2026-07-26 12:34:00']));
    assert.equal(s.highWater.iso, '2026-07-26T12:34:00+08:00');
  });

  test('跨页仍取全局最新', () => {
    const s = state();
    s.observePage(page(['2026-07-26 12:34:00']));
    s.observePage(page(['2026-07-01 00:00:00']));
    assert.equal(s.highWater.iso, '2026-07-26T12:34:00+08:00');
  });

  test('同一秒的多条都记下来，供下次去重', () => {
    const s = state();
    s.observePage(page(
      ['2026-07-26 12:34:00', '2026-07-26 12:34:00'],
      ['sid-a', 'sid-b'],
    ));
    assert.deepEqual(s.highWaterIds.sort(), ['sid-a', 'sid-b']);
  });

  test('时间带显式时区偏移 —— 海外用户不会偏移数小时', () => {
    const s = state();
    s.observePage(page(['2026-07-26 12:34:00']));
    assert.match(s.highWater.iso, /\+08:00$/);
  });
});

describe('下界：增量抓取的终点', () => {
  test('走到下界就算干净完成', () => {
    const s = state({ floorTime: '2026-07-20T00:00:00+08:00' });
    const r = s.observePage(page(['2026-07-25 10:00:00', '2026-07-19 08:00:00']));
    assert.equal(r.reachedFloor, true);
  });

  test('用闭区间 —— 正好等于下界也算到达', () => {
    // 用严格小于会漏掉边界上那一秒的条目。宁可重复，不可遗漏。
    const s = state({ floorTime: '2026-07-20T00:00:00+08:00' });
    const r = s.observePage(page(['2026-07-20 00:00:00']));
    assert.equal(r.reachedFloor, true);
  });

  test('比下界新则继续', () => {
    const s = state({ floorTime: '2026-07-20T00:00:00+08:00' });
    const r = s.observePage(page(['2026-07-25 10:00:00']));
    assert.equal(r.reachedFloor, false);
  });

  test('没有下界就永不触发 —— 首次全量抓到最早', () => {
    const s = state({ floorTime: null });
    const r = s.observePage(page(['2010-01-01 00:00:00']));
    assert.equal(r.reachedFloor, false);
  });
});

describe('水位线只在干净完成时才允许推进', () => {
  test('干净走完 → advanced', () => {
    const s = state();
    s.observePage(page(['2026-07-26 12:34:00']));
    s.markFinished();

    const cs = s.toCrawlState(BID);
    assert.equal(cs.advanced, true);
    assert.equal(cs.contiguous, true);
  });

  test('被打断 → 不推进', () => {
    // 已抓到的数据照样留在 WARC 里，但下次仍从旧下界重走。
    const s = state();
    s.observePage(page(['2026-07-26 12:34:00']));
    s.markStopped('blocked');

    const cs = s.toCrawlState(BID);
    assert.equal(cs.advanced, false);
    assert.equal(cs.gaps.length, 1);
  });

  test('有缺口 → 不推进', () => {
    const s = state();
    s.observePage(page(['2026-07-26 12:34:00']));
    s.recordGap('fetch_failed', '第 3 页失败');
    s.markFinished();
    assert.equal(s.toCrawlState(BID).advanced, false);
  });

  test('不推进时仍然报告见到的水位线', () => {
    // 把它抹成 null 会丢掉一条有用的观测；advanced=false 已经足以告诉下游
    // 「别拿它当下次的下界」。
    const s = state();
    s.observePage(page(['2026-07-26 12:34:00']));
    s.markStopped('blocked');

    const cs = s.toCrawlState(BID);
    assert.equal(cs.high_water_time, '2026-07-26T12:34:00+08:00');
    assert.equal(cs.advanced, false);
  });

  test('一条时间都没见到就不能推进', () => {
    const s = state();
    s.markFinished();
    assert.equal(s.canAdvance, false);
  });
});

describe('无法解析的时间要记成缺口，不能静默跳过', () => {
  test('解析失败 → 缺口 → 不许推进水位线', () => {
    // 解析不了可能意味着豆瓣换了格式，而水位线一旦算错，下次增量就会从
    // 错误的位置开始——那是永久且不可检测的空洞。
    const s = state();
    s.observePage(page(['2026-07-26 12:34:00', '今天 14:23']));
    s.markFinished();

    assert.equal(s.gaps.length, 1);
    assert.match(s.gaps[0].reason, /unparsable_time/);
    assert.equal(s.canAdvance, false, '有缺口就不许推进');
  });

  test('能解析的那些照样生效', () => {
    const s = state();
    s.observePage(page(['2026-07-26 12:34:00', '乱码']));
    assert.equal(s.highWater.iso, '2026-07-26T12:34:00+08:00');
  });
});

describe('覆盖率：观测，不是判据', () => {
  test('声明数量只记第一次读到的', () => {
    // 实测每张列表页上都有这个数字。逐页复读能发现总数变了，但写进 coverage
    // 的应当是开始时那一个，否则「声称」与「实抓」比的不是同一时刻的东西。
    const s = state({ routeKey: 'interest.movie.collect', intent: 'interest.list.movie.collect' });
    s.observePage({ ...page(['2026-07-26 12:34:00']), claimed: { count: 1157, raw: '(1157)' } });
    s.observePage({ ...page(['2026-07-25 12:00:00'], ['x']), claimed: { count: 1160, raw: '(1160)' } });

    assert.equal(s.toCoverage().claimed_count, 1157);
  });

  test('取不到声明数量就是 null —— null 与 0 是两件事', () => {
    const s = state(); // 广播没有可信总数
    s.observePage(page(['2026-07-26 12:34:00']));

    const cov = s.toCoverage();
    assert.equal(cov.claimed_count, null);
    assert.equal(cov.delta, null);
    assert.notEqual(cov.claimed_count, 0);
  });

  test('声明数量必须带出处', () => {
    const s = state();
    s.observePage({ ...page(['2026-07-26 12:34:00']), claimed: { count: 100, raw: '(100)' } });
    const cov = s.toCoverage();
    assert.equal(cov.claimed_source, `${BID}#000001`, '要能回到读出这个数字的那张页面');
  });

  test('差值如实记录，不当成错误', () => {
    // 真实档案里游戏那种 −5 的差值：豆瓣的计数器知道一些它不肯展示的条目。
    const s = state({ routeKey: 'interest.game.collect', intent: 'interest.list.game.collect' });
    s.observePage({
      ...page(Array(15).fill('2026-07-26 12:34:00'), Array.from({ length: 15 }, (_, i) => `g${i}`)),
      claimed: { count: 20, raw: '(20)' },
    });

    const cov = s.toCoverage();
    assert.equal(cov.captured_count, 15);
    assert.equal(cov.delta, -5);
    assert.ok(!('completeness' in cov), '规范刻意不提供完整性字段');
  });
});

describe('枚举方式决定下游能否推断删除', () => {
  test('bounded 与 full 都会被如实写出', () => {
    const b = state({ enumeration: 'bounded' });
    b.observePage(page(['2026-07-26 12:34:00']));
    b.markFinished();
    assert.equal(b.toCrawlState(BID).enumeration, 'bounded');

    const f = state({ enumeration: 'full' });
    f.observePage(page(['2026-07-26 12:34:00']));
    f.markFinished();
    assert.equal(f.toCrawlState(BID).enumeration, 'full');
  });
});

describe('一个条目都没观测到时，「跑完了」不是证据', () => {
  /**
   * 这一组来自一次真实抓取的报告：3 条舞台剧全抓到了，coverage 却写着
   *
   *     声称 3 / 抓到 0 / 差值 −3 / 连续性 ✔ 已验证
   *
   * 根因是 `interest.list` 的 `idAnchor` 只写了 `/subject/N`，漏掉舞台剧的
   * `/location/drama/N`。而停滞检测靠「本页有没有新 ID」判断进展——抽不到 ID 就等于
   * 没有终止条件，第 3 页就停，然后因为没有缺口而声称已验证。
   *
   * 对 89 页的电影列表，那就是**第 3 页截断 + 声称已验证**。
   */
  test('声称有条目却抽不到 ID → 记缺口，连续性不成立', () => {
    const s = new RouteState({ routeKey: 'interest.drama.collect', intent: 'i', enumeration: 'full' });
    s.observePage({ ids: [], times: [], claimed: { count: 3, raw: '(3)' }, captureId: 'c#1', observedAt: 'x' });
    s.markFinished();

    assert.equal(s.contiguous, false, '不能声称已验证');
    assert.equal(s.gaps.length, 1);
    assert.equal(s.gaps[0].reason, 'no_items_observed');
    assert.match(s.gaps[0].detail, /改版|idAnchor/, '要指向最可能的原因');
    assert.equal(s.canAdvance, false);
  });

  test('真的空列表照旧成立 —— 空不是错', () => {
    // 判据是 `claimed > 0`，不是「抓过页面」。一个 0 条的收藏夹是完全正常的。
    const s = new RouteState({ routeKey: 'interest.music.collect', intent: 'i', enumeration: 'full' });
    s.observePage({ ids: [], times: [], claimed: { count: 0, raw: '(0)' }, captureId: 'c#1', observedAt: 'x' });
    s.markFinished();

    assert.equal(s.contiguous, true);
    assert.deepEqual(s.gaps, []);
  });

  test('抽到了就正常推进', () => {
    const s = new RouteState({ routeKey: 'interest.drama.collect', intent: 'i', enumeration: 'full' });
    s.observePage({
      ids: ['34912679', '10944608', '35999593'],
      times: ['2025-05-05', '2023-11-29', '2023-02-04'],
      claimed: { count: 3, raw: '(3)' }, captureId: 'c#1', observedAt: 'x',
    });
    s.markFinished();

    assert.equal(s.capturedCount, 3);
    assert.equal(s.contiguous, true);
    assert.equal(s.canAdvance, true);
    // 水位线是最新那条，进度是最旧那条
    assert.equal(s.highWater.iso.slice(0, 10), '2025-05-05');
    assert.equal(s.lowWater.iso.slice(0, 10), '2023-02-04');
  });

  test('没有声明数量时不误报 —— 有些路线没有那个数字', () => {
    const s = new RouteState({ routeKey: 'broadcast.timeline', intent: 'i', enumeration: 'bounded' });
    s.observePage({ ids: [], times: [], claimed: null, captureId: 'c#1', observedAt: 'x' });
    s.markFinished();
    assert.deepEqual(s.gaps, [], '广播没有可信总数，不能拿它来判抽取器坏了');
  });
});
