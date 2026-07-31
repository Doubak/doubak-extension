/**
 * 链：挑下界、核对完整性。
 *
 * 这一组测试守的是**漏抓**。挑错下界的后果是静默的：定高了就漏，而漏掉的东西
 * 事后无从发现——那正是这个项目最怕的那种错。所以每一条规则都单独钉。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  chainEntryFromManifest, newestFirst, pickFloors, floorsFor, findChainHoles, chainCoverage,
  sameAccount, renamedBundles, diffAgainstChain, chainOf, splitChains, routeChainCoverage,
  bundlesWithKnownSubjects,
} from '../src/crawl/chain.js';

const ME = '82160871';
const MY_NAME = 'mewcatcher';

/** 造一条路线的 crawl_state。 */
function route(key, { hw = null, lw = null, advanced = false, contiguous = advanced,
  floorTime = null, floorFrom = null, ids = [] } = {}) {
  return {
    route_key: key,
    intent: key,
    high_water_time: hw,
    high_water_raw: hw ? hw.replace('T', ' ').slice(0, 19) : null,
    high_water_ids: ids,
    low_water_time: lw,
    floor_time: floorTime,
    floor_from_bundle_id: floorFrom,
    enumeration: 'bounded',
    contiguous,
    gaps: contiguous ? [] : [{ reason: 'aborted' }],
    advanced,
  };
}

/** 造一份档案。 */
function bundle(id, routes, { at = null, account = ME, username = MY_NAME, prev = null } = {}) {
  return {
    bundleId: id,
    completedAt: at,
    accountUserId: account,
    accountUsername: username,
    previousBundleId: prev,
    crawlState: routes,
  };
}

describe('挑下界：按路线，不按档案', () => {
  test('取最近一份 advanced=true 的水位线', () => {
    const picks = pickFloors([
      bundle('B2', [route('broadcast.timeline', { hw: '2026-08-15T00:00:00+08:00', advanced: true })],
        { at: '2026-08-15T10:00:00+08:00' }),
      bundle('B1', [route('broadcast.timeline', { hw: '2026-07-31T00:00:00+08:00', advanced: true })],
        { at: '2026-07-31T10:00:00+08:00' }),
    ], { accountUserId: ME });

    assert.equal(picks.get('broadcast.timeline').floorTime, '2026-08-15T00:00:00+08:00');
    assert.equal(picks.get('broadcast.timeline').fromBundleId, 'B2');
  });

  test('有缺口的那条线**不提供**下界，要继续往回找', () => {
    // 这是整个设计的核心：`advanced` 是逐路线的。真实例子——某份档案里广播抓完了，
    // 而作品详情页因为一次中断留下缺口。
    const picks = pickFloors([
      bundle('B2', [
        route('broadcast.timeline', { hw: '2026-08-15T00:00:00+08:00', advanced: true }),
        route('interest.item', { advanced: false, contiguous: false }),
      ], { at: '2026-08-15T10:00:00+08:00' }),
      bundle('B1', [
        route('broadcast.timeline', { hw: '2026-07-31T00:00:00+08:00', advanced: true }),
        route('interest.movie.collect', { hw: '2026-07-31T00:00:00+08:00', advanced: true }),
      ], { at: '2026-07-31T10:00:00+08:00' }),
    ], { accountUserId: ME });

    assert.equal(picks.get('broadcast.timeline').fromBundleId, 'B2');
    // 电影列表在 B2 里压根没跑，下界来自更早的 B1
    assert.equal(picks.get('interest.movie.collect').fromBundleId, 'B1');
    // 作品详情页两处都没有 advanced=true → 没有下界 = 从头重走
    assert.equal(picks.has('interest.item'), false);
  });

  test('同一次抓取里，不同路线的下界可以来自不同档案', () => {
    const picks = pickFloors([
      bundle('B3', [route('a', { hw: '2026-09-01T00:00:00+08:00', advanced: true })], { at: '2026-09-01T00:00:00Z' }),
      bundle('B2', [route('b', { hw: '2026-08-01T00:00:00+08:00', advanced: true })], { at: '2026-08-01T00:00:00Z' }),
      bundle('B1', [route('c', { hw: '2026-07-01T00:00:00+08:00', advanced: true })], { at: '2026-07-01T00:00:00Z' }),
    ], { accountUserId: ME });

    assert.deepEqual(
      [...picks].map(([k, v]) => [k, v.fromBundleId]).sort(),
      [['a', 'B3'], ['b', 'B2'], ['c', 'B1']],
    );
  });

  test('没有下界的路线不出现在结果里 —— 那是「从头重走」，不是「下界为 null」', () => {
    const picks = pickFloors([
      bundle('B1', [route('x', { advanced: false, contiguous: false })]),
    ], { accountUserId: ME });
    assert.equal(picks.size, 0);
  });

  test('advanced=true 但水位线为空 → 不当下界（防御）', () => {
    // 不该发生（`canAdvance` 要求 highWater 非空），但真发生了的话，
    // 拿一个空下界去比会静默地把所有东西都当成「已经抓过」。
    const picks = pickFloors([
      bundle('B1', [route('x', { hw: null, advanced: true })]),
    ], { accountUserId: ME });
    assert.equal(picks.size, 0);
  });
});

describe('只认同一个账号 —— 错的方向是漏抓', () => {
  test('别人的档案不给我当基准', () => {
    const picks = pickFloors([
      bundle('OTHER', [route('broadcast.timeline', { hw: '2026-09-01T00:00:00+08:00', advanced: true })],
        { at: '2026-09-01T00:00:00Z', account: '99999999' }),
      bundle('MINE', [route('broadcast.timeline', { hw: '2026-07-01T00:00:00+08:00', advanced: true })],
        { at: '2026-07-01T00:00:00Z', account: ME }),
    ], { accountUserId: ME });

    assert.equal(picks.get('broadcast.timeline').fromBundleId, 'MINE');
  });

  test('**改过名就不接着抓** —— 每条路线的 URL 里都嵌着用户名', () => {
    // 下界本身是没问题的（它是个时间，改名不影响）。断掉的是别的东西：
    //
    //   https://www.douban.com/people/<用户名>/statuses?p=1
    //   https://movie.douban.com/people/<用户名>/collect
    //
    // 改名之后新抓取的 url_key 与旧档案里的全都对不上，跨档案去重与版本历史
    // 都拼不起来——而那两件事正是链存在的意义。所以要重新打一份全量基准。
    const picks = pickFloors([
      bundle('OLD', [route('r', { hw: '2026-09-01T00:00:00+08:00', advanced: true })],
        { username: '旧名字' }),
    ], { accountUserId: ME, accountUsername: MY_NAME });
    assert.equal(picks.size, 0, '改名之后不该接着上次抓');
  });

  test('改名这件事要能说给用户听', () => {
    // 不解释的话，用户看到的现象是「明明抓过了，怎么又从头来」——那看起来就是个 bug。
    const entries = [
      bundle('OLD', [route('r', { hw: 'x', advanced: true })], { username: '旧名字' }),
      bundle('OTHER', [route('r', { hw: 'x', advanced: true })], { account: '999', username: '别人' }),
    ];
    const renamed = renamedBundles(entries, { accountUserId: ME, accountUsername: MY_NAME });
    assert.deepEqual(renamed, [{ bundleId: 'OLD', was: '旧名字' }]);
  });

  test('同一个人、同一个名字 → 认', () => {
    assert.equal(
      sameAccount(bundle('B', []), { accountUserId: ME, accountUsername: MY_NAME }),
      true,
    );
  });

  test('账号不明的也不认 —— 「不知道」不是「是同一个」', () => {
    const picks = pickFloors([
      bundle('UNKNOWN', [route('x', { hw: '2026-09-01T00:00:00+08:00', advanced: true })],
        { at: '2026-09-01T00:00:00Z', account: null }),
    ], { accountUserId: ME });
    assert.equal(picks.size, 0);
  });

  test('不传账号时不过滤 —— 但那是调用方的责任，注释里写着「强烈建议传」', () => {
    const picks = pickFloors([
      bundle('OTHER', [route('x', { hw: '2026-09-01T00:00:00+08:00', advanced: true })],
        { account: '99999999' }),
    ]);
    assert.equal(picks.size, 1);
  });
});

describe('排序：没有 completed_at 时靠 bundle_id', () => {
  test('bundle_id 以时间戳开头，字典序就是时间序', () => {
    const ids = newestFirst([
      bundle('20260701T000000Z-aaaaaa', []),
      bundle('20260901T000000Z-bbbbbb', []),
      bundle('20260801T000000Z-cccccc', []),
    ]).map((e) => e.bundleId);
    assert.deepEqual(ids, [
      '20260901T000000Z-bbbbbb', '20260801T000000Z-cccccc', '20260701T000000Z-aaaaaa',
    ]);
  });

  test('**混着两种形式也要排对** —— 直接比字符串是错的', () => {
    // 这条是拿真实数据验出来的：
    //
    //   '2026-07-31T05:13:33Z'    ← completed_at（带连字符）
    //   '20260731T043423Z-d40c1d' ← bundle_id（紧凑）
    //
    // 逐字符比到第 5 位是 '-'(0x2D) 对 '0'(0x30)，于是带连字符的永远排前面：
    // 一份 05:13 完成的档案被判成比 04:34 那份还旧。中止的档案没有 completed_at，
    // 混着两种形式在真实数据里一定会出现。
    const ids = newestFirst([
      bundle('20260731T043423Z-d40c1d', []),                                   // 只有 id
      bundle('20260731T051333Z-786e5c', [], { at: '2026-07-31T05:13:33Z' }),   // 有 completed_at
    ]).map((e) => e.bundleId);
    assert.deepEqual(ids, ['20260731T051333Z-786e5c', '20260731T043423Z-d40c1d']);
  });

  test('认不出时间的排最后，但不崩', () => {
    const ids = newestFirst([
      bundle('乱七八糟', []),
      bundle('20260731T051333Z-786e5c', []),
    ]).map((e) => e.bundleId);
    assert.equal(ids[0], '20260731T051333Z-786e5c');
  });

  test('有 completed_at 就用它', () => {
    const ids = newestFirst([
      bundle('B1', [], { at: '2026-09-01T00:00:00Z' }),
      bundle('B2', [], { at: '2026-07-01T00:00:00Z' }),
    ]).map((e) => e.bundleId);
    assert.deepEqual(ids, ['B1', 'B2']);
  });
});

describe('核对链：缺一环要说出来', () => {
  test('基准不在了 → 报一处洞', () => {
    const holes = findChainHoles([
      bundle('B2', [route('broadcast.timeline', {
        hw: '2026-08-15T00:00:00+08:00', advanced: true,
        floorTime: '2026-07-31T00:00:00+08:00', floorFrom: 'B1',
      })]),
      // B1 被删了
    ]);
    assert.equal(holes.length, 1);
    assert.equal(holes[0].kind, 'absent');
    assert.equal(holes[0].missing, 'B1');
    assert.match(holes[0].detail, /照样有效/, '不能因此把在场的那份说成无效');
  });

  test('基准在，但水位线对不上 → 中间那段没人抓过', () => {
    const holes = findChainHoles([
      bundle('B2', [route('r', {
        advanced: true, hw: '2026-08-15T00:00:00+08:00',
        floorTime: '2026-07-31T00:00:00+08:00', floorFrom: 'B1',
      })]),
      bundle('B1', [route('r', { advanced: true, hw: '2026-07-01T00:00:00+08:00' })]),
    ]);
    assert.equal(holes.length, 1);
    assert.equal(holes[0].kind, 'mismatch');
    assert.match(holes[0].detail, /没有人抓过/);
  });

  test('对得上就没有洞', () => {
    const holes = findChainHoles([
      bundle('B2', [route('r', {
        advanced: true, hw: '2026-08-15T00:00:00+08:00',
        floorTime: '2026-07-31T00:00:00+08:00', floorFrom: 'B1',
      })]),
      bundle('B1', [route('r', { advanced: true, hw: '2026-07-31T00:00:00+08:00' })]),
    ]);
    assert.deepEqual(holes, []);
  });

  test('首次全量（没有下界）不算洞', () => {
    const holes = findChainHoles([
      bundle('B1', [route('r', { advanced: true, hw: '2026-07-31T00:00:00+08:00' })]),
    ]);
    assert.deepEqual(holes, []);
  });

  test('洞是按路线算的 —— 一条断了不影响另一条', () => {
    const holes = findChainHoles([
      bundle('B2', [
        route('a', { advanced: true, hw: '2026-08-15T00:00:00+08:00', floorTime: '2026-07-31T00:00:00+08:00', floorFrom: 'GONE' }),
        route('b', { advanced: true, hw: '2026-08-15T00:00:00+08:00', floorTime: '2026-07-31T00:00:00+08:00', floorFrom: 'B1' }),
      ]),
      bundle('B1', [route('b', { advanced: true, hw: '2026-07-31T00:00:00+08:00' })]),
    ]);
    assert.equal(holes.length, 1);
    assert.equal(holes[0].routeKey, 'a');
  });
});

describe('合起来：链覆盖到哪儿', () => {
  test('区间是整条链的并集', () => {
    const cov = chainCoverage([
      bundle('B2', [route('r', {
        hw: '2026-08-15T00:00:00+08:00', lw: '2026-07-31T00:00:00+08:00',
        advanced: true, floorTime: '2026-07-31T00:00:00+08:00', floorFrom: 'B1',
      })], { at: '2026-08-15T00:00:00Z' }),
      bundle('B1', [route('r', {
        hw: '2026-07-31T00:00:00+08:00', lw: '2014-01-10T00:00:00+08:00', advanced: true,
      })], { at: '2026-07-31T00:00:00Z' }),
    ]);
    const r = cov.get('r');
    assert.equal(r.newest, '2026-08-15T00:00:00+08:00');
    assert.equal(r.oldest, '2014-01-10T00:00:00+08:00');
    assert.deepEqual(r.bundles, ['B2', 'B1']);
    assert.equal(r.contiguous, true);
  });

  test('**不算「一共抓了多少条」** —— 边界闭区间去重，必然重叠', () => {
    // 加出来的数只会误导。这个项目的论点本来就是「计数不能证明完整性，
    // 连续性才能」，所以这里根本不提供那个字段。
    const cov = chainCoverage([bundle('B1', [route('r', { advanced: true, hw: 'x' })])]);
    assert.equal('captured' in cov.get('r'), false);
    assert.equal('total' in cov.get('r'), false);
  });

  test('最新那份自己不连续 → 链不连续', () => {
    const cov = chainCoverage([
      bundle('B2', [route('r', { advanced: false, contiguous: false })], { at: '2026-08-15T00:00:00Z', prev: 'B1' }),
      bundle('B1', [route('r', { hw: '2026-07-31T00:00:00+08:00', advanced: true })], { at: '2026-07-31T00:00:00Z' }),
    ]);
    assert.equal(cov.get('r').contiguous, false, '「从今天起往回」这句话不成立');
  });

  test('**基准有缺口、但新的那份从头走了一遍 → 链是连续的**', () => {
    // 这条是「每一份都连续」那个规则错在哪儿的直接反例：B1 那条线有缺口，所以
    // B2 用不了它当下界，于是 B2 自己从头走了一遍（floor_time 为 null）。
    // 那时 B2 一份就覆盖了全部，B1 的缺口无关紧要。
    const cov = chainCoverage([
      bundle('B2', [route('r', {
        hw: '2026-08-15T00:00:00+08:00', lw: '2014-01-10T00:00:00+08:00', advanced: true,
      })], { at: '2026-08-15T00:00:00Z', prev: 'B1' }),
      bundle('B1', [route('r', { advanced: false, contiguous: false })], { at: '2026-07-31T00:00:00Z' }),
    ]);
    assert.equal(cov.get('r').contiguous, true);
  });

  test('接着上次抓 → 要求基准在场且也连续', () => {
    const chain = [
      bundle('B2', [route('r', {
        hw: '2026-08-15T00:00:00+08:00', advanced: true,
        floorTime: '2026-07-31T00:00:00+08:00', floorFrom: 'B1',
      })], { at: '2026-08-15T00:00:00Z', prev: 'B1' }),
      bundle('B1', [route('r', { hw: '2026-07-31T00:00:00+08:00', advanced: true })],
        { at: '2026-07-31T00:00:00Z' }),
    ];
    assert.equal(chainCoverage(chain).get('r').contiguous, true);

    // 基准没了 → 断
    assert.equal(chainCoverage([chain[0]]).get('r').contiguous, false);
  });

  test('有下界却说不出来自哪一份 → 证明不了', () => {
    const cov = chainCoverage([
      bundle('B1', [route('r', {
        hw: 'x', advanced: true, floorTime: '2026-07-31T00:00:00+08:00', floorFrom: null,
      })]),
    ]);
    assert.equal(cov.get('r').contiguous, false);
  });

  test('链上有洞 → 不连续，并把洞带出来', () => {
    const cov = chainCoverage([
      bundle('B2', [route('r', {
        hw: '2026-08-15T00:00:00+08:00', advanced: true,
        floorTime: '2026-07-31T00:00:00+08:00', floorFrom: 'GONE',
      })]),
    ]);
    assert.equal(cov.get('r').contiguous, false);
    assert.equal(cov.get('r').holes.length, 1);
  });
});

describe('从 manifest 摘出来', () => {
  test('认得规范里那几个字段', () => {
    const e = chainEntryFromManifest({
      bundle_id: 'B1',
      completed_at: '2026-08-15T10:00:00+08:00',
      previous_bundle_id: 'B0',
      account: { user_id: ME, username: 'mewcatcher' },
      crawl_state: [route('r', { advanced: true, hw: 'x' })],
    });
    assert.equal(e.bundleId, 'B1');
    assert.equal(e.accountUserId, ME);
    assert.equal(e.previousBundleId, 'B0');
    assert.equal(e.crawlState.length, 1);
  });

  test('字段缺了也不炸', () => {
    const e = chainEntryFromManifest({ bundle_id: 'B1' });
    assert.equal(e.accountUserId, null);
    assert.deepEqual(e.crawlState, []);
  });
});

describe('交给 runner 的形状', () => {
  test('floorsFor 给出 Map<routeKey, floorTime>', () => {
    const picks = pickFloors([
      bundle('B1', [route('r', { hw: '2026-07-31T00:00:00+08:00', advanced: true })]),
    ], { accountUserId: ME });
    const floors = floorsFor(picks);
    assert.equal(floors.get('r'), '2026-07-31T00:00:00+08:00');
  });
});

describe('跟链上更早的档案比：新增 vs 又抓了一次', () => {
  const cap = (urlKey, id, at, verdict = 'ok') =>
    ({ url_key: urlKey, capture_id: id, observed_at: at, verdict });

  const B1 = {
    bundleId: 'B1', completedAt: '2026-07-31T00:00:00Z',
    entries: [cap('https://m/1/', 'B1#1', '2026-07-31T00:00:00Z'),
      cap('https://m/2/', 'B1#2', '2026-07-31T00:01:00Z')],
  };
  const B2 = {
    bundleId: 'B2', completedAt: '2026-08-15T00:00:00Z',
    entries: [cap('https://m/2/', 'B2#1', '2026-08-15T00:00:00Z'),
      cap('https://m/3/', 'B2#2', '2026-08-15T00:01:00Z')],
  };

  test('更早的档案里出现过 = 又抓了一次', () => {
    const d = diffAgainstChain(B2, [B1]);
    assert.deepEqual(d.repeated, ['https://m/2/']);
  });

  test('只在这一份里出现 = 新增', () => {
    const d = diffAgainstChain(B2, [B1]);
    assert.equal(d.repeated.includes('https://m/3/'), false);
  });

  test('**比当前这份更新**的档案不算「更早」', () => {
    // 从最新那份往回看时，更新的那些还不存在——把它们算进来会把「新增」误标成
    // 「又抓了一次」。
    const d = diffAgainstChain(B1, [B2]);
    assert.deepEqual(d.repeated, []);
  });

  test('第一份档案里什么都是新增', () => {
    assert.deepEqual(diffAgainstChain(B1, []).repeated, []);
  });

  test('自己不跟自己比', () => {
    assert.deepEqual(diffAgainstChain(B2, [B2, B1]).repeated, ['https://m/2/']);
  });
});

describe('版本历史：同一个 URL 的多次捕获', () => {
  const cap = (urlKey, id, at) => ({ url_key: urlKey, capture_id: id, observed_at: at, verdict: 'ok' });

  test('多次抓到的才进版本历史', () => {
    const d = diffAgainstChain(
      { bundleId: 'B2', completedAt: '2026-08-15T00:00:00Z', entries: [cap('u1', 'B2#1', '2026-08-15T00:00:00Z')] },
      [{ bundleId: 'B1', completedAt: '2026-07-31T00:00:00Z',
        entries: [cap('u1', 'B1#1', '2026-07-31T00:00:00Z'), cap('u2', 'B1#2', '2026-07-31T00:01:00Z')] }],
    );
    assert.equal(d.versions.length, 1);
    assert.equal(d.versions[0].urlKey, 'u1');
    assert.equal(d.versions[0].versions.length, 2);
  });

  test('只有一个版本的不返回 —— 否则等于把整份索引再传一遍', () => {
    const d = diffAgainstChain(
      { bundleId: 'B1', completedAt: 'x', entries: [cap('u1', 'B1#1', 'x')] }, [],
    );
    assert.deepEqual(d.versions, []);
  });

  test('版本从新到旧 —— 先想看最近那一版', () => {
    const d = diffAgainstChain(
      { bundleId: 'B2', completedAt: '2026-08-15T00:00:00Z', entries: [cap('u', 'B2#1', '2026-08-15T00:00:00Z')] },
      [{ bundleId: 'B1', completedAt: '2026-07-31T00:00:00Z', entries: [cap('u', 'B1#1', '2026-07-31T00:00:00Z')] }],
    );
    assert.deepEqual(d.versions[0].versions.map((v) => v.bundleId), ['B2', 'B1']);
  });

  test('版本多的排前面', () => {
    const many = { bundleId: 'B3', completedAt: '2026-09-01T00:00:00Z',
      entries: [cap('u1', 'B3#1', '2026-09-01T00:00:00Z'), cap('u2', 'B3#2', '2026-09-01T00:01:00Z')] };
    const mid = { bundleId: 'B2', completedAt: '2026-08-15T00:00:00Z',
      entries: [cap('u1', 'B2#1', '2026-08-15T00:00:00Z')] };
    const old = { bundleId: 'B1', completedAt: '2026-07-31T00:00:00Z',
      entries: [cap('u1', 'B1#1', '2026-07-31T00:00:00Z'), cap('u2', 'B1#2', '2026-07-31T00:01:00Z')] };
    const d = diffAgainstChain(many, [mid, old]);
    assert.equal(d.versions[0].urlKey, 'u1', 'u1 有 3 个版本，该排前面');
    assert.equal(d.versions[0].versions.length, 3);
  });
});

describe('一堆档案不等于一条链', () => {
  test('previous_bundle_id 为 null 的各自是一条链的起点', () => {
    // 真实情况：增量做出来之前的每一次抓取都是独立的全量。用户屏幕上看到的是
    // 「合起来 4 份档案，从最近的一份往回接」——那是假的，它们互不相干。
    const entries = [
      bundle('B4', [route('r', { hw: 'd', advanced: true })], { at: '2026-07-31T05:00:00Z' }),
      bundle('B3', [route('r', { hw: 'c', advanced: true })], { at: '2026-07-31T04:00:00Z' }),
      bundle('B2', [route('r', { hw: 'b', advanced: true })], { at: '2026-07-31T01:00:00Z' }),
      bundle('B1', [route('r', { hw: 'a', advanced: true })], { at: '2026-07-30T13:00:00Z' }),
    ];
    const chains = splitChains(entries);
    assert.equal(chains.length, 4, '四次互不相干的全量应当是四条链');
    for (const c of chains) assert.equal(c.length, 1);
  });

  test('真的链起来的才算一条', () => {
    const entries = [
      bundle('B3', [route('r', { hw: 'c', advanced: true })], { at: '2026-09-01T00:00:00Z', prev: 'B2' }),
      bundle('B2', [route('r', { hw: 'b', advanced: true })], { at: '2026-08-01T00:00:00Z', prev: 'B1' }),
      bundle('B1', [route('r', { hw: 'a', advanced: true })], { at: '2026-07-01T00:00:00Z' }),
      bundle('SOLO', [route('r', { hw: 'x', advanced: true })], { at: '2026-06-01T00:00:00Z' }),
    ];
    const chains = splitChains(entries);
    assert.equal(chains.length, 2);
    assert.deepEqual(chains[0].map((e) => e.bundleId), ['B3', 'B2', 'B1']);
    assert.deepEqual(chains[1].map((e) => e.bundleId), ['SOLO']);
  });

  test('一份不相干的档案有缺口，不该污染另一条链', () => {
    // 用户屏幕上每一行都写着「没走完」，包括那些各自明明验证通过的——因为把
    // 四次独立全量当成了一条链，最差的那一份污染了全部。
    const good = bundle('GOOD', [route('r', {
      hw: '2026-08-15T00:00:00+08:00', lw: '2014-01-10T00:00:00+08:00', advanced: true,
    })], { at: '2026-08-15T00:00:00Z' });
    const bad = bundle('BAD', [route('r', { advanced: false, contiguous: false })],
      { at: '2026-07-01T00:00:00Z' });

    const chains = splitChains([good, bad]);
    assert.equal(chainCoverage(chains[0]).get('r').contiguous, true, '好的那条不该被拖下水');
  });

  test('previous_bundle_id 指向一份不在的档案 → 链就到此为止', () => {
    const chain = chainOf([
      bundle('B2', [route('r')], { prev: 'GONE' }),
    ], 'B2');
    assert.deepEqual(chain.map((e) => e.bundleId), ['B2']);
  });

  test('环形数据不会把我们转死', () => {
    const chain = chainOf([
      bundle('A', [route('r')], { prev: 'B' }),
      bundle('B', [route('r')], { prev: 'A' }),
    ], 'A');
    assert.equal(chain.length, 2);
  });
});

describe('「这一页我是不是已经有了」按账号问，不按链问', () => {
  /**
   * 报上来的现象：只加了一本想读的书，增量抓取却在抓游戏详情页。
   *
   * 成因是把两个问题混了：
   *
   * | 问题 | 用什么回答 |
   * |---|---|
   * | 从今天往回一直到 X 有没有断 | 链 |
   * | 这一页我是不是已经有了 | **这个账号名下的全部档案** |
   *
   * 作品详情页没有时间序，链对它毫无意义。按链算的话，`previous_bundle_id` 为
   * null 的档案各自成链，「最新那条链」常常只有一份——那一份要是刚跑了一小段的
   * 增量，此前几千个详情页就全都不认识了。
   */
  const me = { accountUserId: ME, accountUsername: MY_NAME };

  test('不在同一条链上的档案照样算数', () => {
    const big = bundle('BIG', [], { at: '2026-07-31T05:00:00Z' });        // 独立全量，几千个详情页
    const small = bundle('SMALL', [], { at: '2026-07-31T12:00:00Z' });    // 独立的小增量
    // 两份各自成链
    assert.equal(splitChains([big, small]).length, 2);
    // 但「已经抓过的详情页」两份都算
    assert.deepEqual(
      bundlesWithKnownSubjects([big, small], me).map((e) => e.bundleId).sort(),
      ['BIG', 'SMALL'],
    );
  });

  test('别人的档案不算', () => {
    const mine = bundle('MINE', []);
    const theirs = bundle('THEIRS', [], { account: '99999999', username: '别人' });
    assert.deepEqual(
      bundlesWithKnownSubjects([mine, theirs], me).map((e) => e.bundleId),
      ['MINE'],
    );
  });

  test('改过名的也不算 —— 那时 URL 里的用户名对不上', () => {
    const renamed = bundle('OLD', [], { username: '旧名字' });
    assert.deepEqual(bundlesWithKnownSubjects([renamed], me), []);
  });
});
