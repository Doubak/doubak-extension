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

  /**
   * 路线定义上的 `enumeration` 是静态常量（标记列表恒为 `'full'`），而它只对**首次**
   * 全量成立。真实档案 `20260806T083926Z-f72157` 里 12 条路线踩到了这个：
   *
   *     interest.movie.collect   claimed=1336  captured=15
   *     floor_time=2026-08-02    enumeration="full"
   *
   * 只读了第一页就撞上下界，却声称「整份都枚举过了」。下游拿它和首次全量做差，会
   * 得出「用户删了 1321 条看过」——规范 §5.4.3 说这个方向「静默地把没删的当成删了，
   * 而且事后无从发现」。
   */
  test('**有下界就不是 full**——增量抓取一律 bounded', () => {
    const s = state({ enumeration: 'full', floorTime: '2026-08-02T00:00:00+08:00' });
    s.observePage(page(['2026-08-04 12:00:00']));
    s.markFinished();
    assert.equal(s.toCrawlState(BID).enumeration, 'bounded');
  });

  test('没有下界时不受影响，首次全量仍是 full', () => {
    const s = state({ enumeration: 'full', floorTime: null });
    s.observePage(page(['2026-08-04 12:00:00']));
    s.markFinished();
    assert.equal(s.toCrawlState(BID).enumeration, 'full');
  });

  test('路线定义上的静态值原样留着，只有报出去的那个是推导的', () => {
    // 混成一个字段的话，「这条线本来是什么性质」就没地方读了。
    const s = state({ enumeration: 'full', floorTime: '2026-08-02T00:00:00+08:00' });
    assert.equal(s.enumeration, 'full');
    assert.equal(s.effectiveEnumeration, 'bounded');
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

describe('叶子路线也要计数 —— 否则「作品详情页」永远显示 0', () => {
  test('recordLeafCapture 一次加一条', () => {
    const s = new RouteState({ routeKey: 'interest.item', intent: 'interest.item', enumeration: 'full' });
    s.recordLeafCapture();
    s.recordLeafCapture();
    assert.equal(s.capturedCount, 2);
  });

  test('接着历史计数往上加 —— 恢复之后不归零', () => {
    const s = new RouteState({
      routeKey: 'interest.item', intent: 'interest.item', enumeration: 'full', priorCount: 500,
    });
    s.recordLeafCapture();
    assert.equal(s.capturedCount, 501);
  });
});

describe('抽取器自检看的是「本次会话抽到过 ID 没有」', () => {
  test('声称有条目却一个 ID 都没抽到 → 记缺口', () => {
    // 这道自检当初抓到过真问题：舞台剧的 idAnchor 漏了 /location/drama/N，
    // 于是 coverage 写着「声称 3 / 抓到 0 / 连续性 ✔ 已验证」。
    const s = new RouteState({ routeKey: 'r', intent: 'i', enumeration: 'full' });
    s.observePage({ ids: [], claimed: { count: 3, raw: '3' }, captureId: 'c1', observedAt: 'x' });
    s.markFinished();
    assert.ok(s.gaps.some((g) => g.reason === 'no_items_observed'));
  });

  test('接了历史计数也不会把这道自检说哑 —— 判的是本次会话', () => {
    // 用 capturedCount 判的话，priorCount 一非零，自检就永远沉默。
    const s = new RouteState({
      routeKey: 'r', intent: 'i', enumeration: 'full', priorCount: 1000,
    });
    s.observePage({ ids: [], claimed: { count: 3, raw: '3' }, captureId: 'c1', observedAt: 'x' });
    s.markFinished();
    assert.ok(
      s.gaps.some((g) => g.reason === 'no_items_observed'),
      '恢复之后抽取器坏掉就查不出来了',
    );
  });

  test('全是重复条目也算「抽取器在工作」，不该误报', () => {
    // 恢复之后只读到一页重复内容是完全正常的：newIds 合法地是 0。
    // 只数 newIds 的话这里会误报「抽取器坏了」。
    const s = new RouteState({ routeKey: 'r', intent: 'i', enumeration: 'full' });
    s.observePage({ ids: ['a', 'b'], claimed: { count: 3, raw: '3' }, captureId: 'c1', observedAt: 'x' });
    s.observePage({ ids: ['a', 'b'], claimed: { count: 3, raw: '3' }, captureId: 'c2', observedAt: 'x' });
    s.markFinished();
    assert.equal(s.gaps.some((g) => g.reason === 'no_items_observed'), false);
  });
});

describe('「已回溯到」不能被一条离群的旧条目钉死', () => {
  /**
   * 真实数据（20260731T015446Z-d8e1b2 的广播列表，20 页，严格新→旧）：
   *
   *     第 9 页  → 2025-12-09
   *     第 10 页 → 2018-08-18   ← 离群，整页只有这一条这么旧
   *     第 11 页 → 2025-08-29
   *
   * `lowWater` 是全局最小值，从第 10 页起就永远是 2018-08-18。界面上那一列
   * 于是**再也不动**——而抓取还有一大半没跑完，用户合理地怀疑它卡住了。
   *
   * 那个值本身没说谎（我们确实抓到了一条 2018 的），只是它回答的不是
   * 「抓到哪儿了」。
   */

  /** 造一页：20 条，都在 `day` 那天，外加 `outlier`（若给）。 */
  function page(day, outlier) {
    const times = Array.from({ length: 20 }, (_, i) => `${day} 1${i % 9}:00:00`);
    if (outlier) times.push(outlier);
    return times;
  }

  function crawl(pages) {
    const s = new RouteState({ routeKey: 'broadcast.timeline', intent: 'b', enumeration: 'bounded' });
    let n = 0;
    for (const times of pages) {
      s.observePage({
        ids: times.map(() => `id${n++}`), times, captureId: `c${n}`, observedAt: 'x',
      });
    }
    return s;
  }

  test('离群值钉死 lowWater —— 那是事实，保持原样', () => {
    const s = crawl([
      page('2026-01-10'), page('2025-12-09', '2018-08-18 19:13:23'), page('2025-08-29'),
    ]);
    assert.match(s.lowWater.iso, /^2018-08-18/, 'lowWater 就该是全局最小值');
  });

  test('但进度要继续往前走', () => {
    const s = crawl([
      page('2026-01-10'), page('2025-12-09', '2018-08-18 19:13:23'), page('2025-08-29'),
    ]);
    assert.match(s.progressTime.iso, /^2025-08-29/, `进度被离群值钉住了：${s.progressTime?.iso}`);
  });

  test('进度只往前不回头 —— 来回跳比不动更让人不安', () => {
    const s = crawl([page('2026-01-10'), page('2025-08-29'), page('2025-12-09')]);
    assert.match(s.progressTime.iso, /^2025-08-29/, '进度回头了');
  });

  test('没有离群值时，进度与最旧那条大致同步', () => {
    const s = crawl([page('2026-01-10'), page('2025-12-09')]);
    assert.match(s.progressTime.iso, /^2025-12-09/);
  });

  test('一页里全是同一天也不出岔子', () => {
    const s = crawl([page('2026-01-10')]);
    assert.match(s.progressTime.iso, /^2026-01-10/);
  });

  test('没有时间的页面不动进度', () => {
    const s = new RouteState({ routeKey: 'r', intent: 'i', enumeration: 'full' });
    s.observePage({ ids: ['a'], times: [], captureId: 'c', observedAt: 'x' });
    assert.equal(s.progressTime, null);
  });

  test('进度跟着 checkpoint 走 —— 恢复之后不该退回去重数', () => {
    const s = crawl([page('2026-01-10'), page('2025-12-09')]);
    const back = RouteState.restore(
      { routeKey: 'broadcast.timeline', intent: 'b', enumeration: 'bounded' },
      s.serialize(),
    );
    assert.equal(back.progressTime?.iso, s.progressTime.iso);
    assert.equal(back.lowWater?.iso, s.lowWater.iso);
  });
});

describe('下界必须活过恢复', () => {
  /**
   * 这是本会话里发现的最严重的一个 bug，而且它是**恢复一次就悄悄发生的**。
   *
   * 实测档案 20260807T083529Z-0fb09c：用户跑的是「增量 + 重抓作品详情页」，中途重载
   * 了扩展再继续。恢复之后每条路线的下界都成了 null，于是 manifest 写出来是
   *
   *     interest.book.wish  enumeration=full  advanced=true  声称 82 / 抓到 15
   *
   * 每条列表只走了一页——那对增量是对的——**却声称自己完整枚举了整份列表**。
   * 按 canonical/INGESTION.md §3，这个组合给下游的是 whole_route 权限，也就是有资格
   * 断定那 67 本书被删了。
   *
   * 假的完整性声明是这份规范里最不能出的错。而这次它不是判断写错了，是**一个字段
   * 没被存进 checkpoint**。
   */
  test('**serialize 必须带上下界**', () => {
    const s = state({
      enumeration: 'full',
      floorTime: '2026-08-01T00:00:00+08:00',
      floorFromBundleId: '20260801T005010Z-3eef52',
    });
    const saved = s.serialize();
    assert.equal(saved.floor_time, '2026-08-01T00:00:00+08:00');
    assert.equal(saved.floor_from_bundle_id, '20260801T005010Z-3eef52');
  });

  test('**恢复之后 enumeration 仍然是 bounded**', () => {
    // 下界丢了 → effectiveEnumeration 退回 full → 假的完整性声明。
    const before = state({ enumeration: 'full', floorTime: '2026-08-01T00:00:00+08:00' });
    before.observePage(page(['2026-08-04 12:00:00']));

    // 恢复时调用方通常什么都不知道：resolveFloors 只在开抓时跑一次。
    const after = RouteState.restore(
      { routeKey: 'interest.book.wish', intent: 'i', enumeration: 'full' },
      before.serialize(),
    );
    assert.equal(after.floorTime, '2026-08-01T00:00:00+08:00');
    assert.equal(after.effectiveEnumeration, 'bounded');
    assert.equal(after.toCrawlState(BID).enumeration, 'bounded');
  });

  test('存档点里的下界优先于调用方传进来的', () => {
    // 恢复路径上调用方那个值是空的，所以存档点才是权威。
    const saved = state({ enumeration: 'full', floorTime: '2026-08-01T00:00:00+08:00' }).serialize();
    const after = RouteState.restore(
      { routeKey: 'r', intent: 'i', enumeration: 'full', floorTime: null },
      saved,
    );
    assert.equal(after.floorTime, '2026-08-01T00:00:00+08:00');
  });

  test('首次全量恢复之后仍然是 full —— 不许一律降级', () => {
    // 反向也要守：把 bounded 当成安全默认值一律套上，会让真正的全量抓取失去
    // 「可以推断删除」这个能力，而那是它唯一比增量多出来的东西。
    const saved = state({ enumeration: 'full', floorTime: null }).serialize();
    const after = RouteState.restore({ routeKey: 'r', intent: 'i', enumeration: 'full' }, saved);
    assert.equal(after.floorTime, null);
    assert.equal(after.effectiveEnumeration, 'full');
  });
});
