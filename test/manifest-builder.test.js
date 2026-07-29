import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ManifestBuilder,
  coverageEntry,
  crawlStateEntry,
  SPEC_VERSION,
} from '../src/bundle/manifest-builder.js';

const BID = '20260729T101500Z-a3f9c1';
const AT = '2026-07-29T10:15:00+08:00';
const SEG = `data-${BID}-00001.warc.gz`;

function builder(over = {}) {
  return new ManifestBuilder({
    bundleId: BID,
    previousBundleId: null,
    account: { user_id: '82160871', username: 'mewcatcher' },
    producer: { name: 'doubak-extension', version: '0.0.1' },
    timezoneAssumption: 'Asia/Shanghai',
    createdAt: AT,
    ...over,
  });
}

const SEGMENTS = [
  { filename: SEG, bytes: 1337, sha256: 'a'.repeat(64), record_count: 2,
    first_capture_id: `${BID}#000001`, last_capture_id: `${BID}#000002` },
];
const INDEX = { filename: `index-${BID}.ndjson`, sha256: 'b'.repeat(64), line_count: 2 };

function buildOk(b = builder(), over = {}) {
  return b.build({ status: 'complete', completedAt: AT, segments: SEGMENTS, index: INDEX, ...over });
}

describe('基本结构', () => {
  test('产出符合规范的顶层字段', () => {
    const m = buildOk();
    assert.equal(m.spec_version, SPEC_VERSION);
    assert.equal(m.bundle_id, BID);
    assert.equal(m.previous_bundle_id, null);
    assert.equal(m.status, 'complete');
    assert.equal(m.timezone_assumption, 'Asia/Shanghai');
    assert.deepEqual(m.segments, SEGMENTS);
    assert.deepEqual(m.index, INDEX);
  });

  test('每次抓取产出新 bundle，用 previous_bundle_id 串成链', () => {
    const prev = '20260601T083000Z-77b201';
    const m = buildOk(builder({ previousBundleId: prev }));
    assert.equal(m.previous_bundle_id, prev);
  });

  test('序列化成带缩进的 JSON 并以换行结尾', () => {
    const bytes = ManifestBuilder.serialize(buildOk());
    const text = new TextDecoder().decode(bytes);
    assert.ok(text.endsWith('\n'));
    assert.doesNotThrow(() => JSON.parse(text));
    assert.match(text, /\n  "bundle_id"/);
  });
});

describe('构造时的必要检查', () => {
  test('缺 timezone_assumption 直接拒绝', () => {
    // 豆瓣页面上的时间不带时区，假定的时区必须记下来，否则将来假定被推翻时
    // 无法对存量重新解析。
    assert.throws(() => builder({ timezoneAssumption: '' }), /timezoneAssumption/);
  });

  test('缺 account.user_id 直接拒绝', () => {
    assert.throws(() => builder({ account: { username: 'x' } }), /user_id/);
  });

  test('createdAt 必须带时区偏移', () => {
    assert.throws(() => builder({ createdAt: '2026-07-29 10:15:00' }), /时区偏移/);
  });

  test('status=complete 必须有 completedAt', () => {
    assert.throws(
      () => builder().build({ status: 'complete', segments: SEGMENTS, index: INDEX }),
      /completedAt/,
    );
  });

  test('未知 status 被拒', () => {
    assert.throws(
      () => builder().build({ status: 'done', segments: SEGMENTS, index: INDEX }),
      /未知的 status/,
    );
  });
});

describe('coverage', () => {
  test('自动算 delta，且命名中性', () => {
    const e = coverageEntry({
      routeKey: 'interest.movie.collect',
      intent: 'interest.list.movie.collect',
      claimedCount: 1157,
      claimedSource: `${BID}#000002`,
      capturedCount: 1157,
    });
    assert.equal(e.delta, 0);
    assert.ok(!('discrepancy' in e), '不叫 discrepancy——它是差值不是错误');
  });

  test('真实档案里游戏那种差值可以如实记下', () => {
    const e = coverageEntry({
      routeKey: 'interest.game.collect',
      intent: 'interest.list.game.collect',
      claimedCount: 293,
      claimedSource: `${BID}#000002`,
      capturedCount: 288,
    });
    assert.equal(e.delta, -5);
  });

  test('claimed_count 为 null 时 delta 也是 null —— null ≠ 0', () => {
    const e = coverageEntry({
      routeKey: 'broadcast.timeline',
      intent: 'broadcast.timeline',
      claimedCount: null,
      capturedCount: 2839,
    });
    assert.equal(e.claimed_count, null);
    assert.equal(e.delta, null);
  });

  test('claimed_count 非 null 却没有 claimed_source —— 拒绝', () => {
    // 无从追溯的数字等于没有记：校验器要靠它回到 WARC 里那张页面。
    assert.throws(
      () =>
        coverageEntry({
          routeKey: 'x',
          intent: 'x',
          claimedCount: 100,
          capturedCount: 100,
        }),
      /claimed_source/,
    );
  });

  test('claimed_count 必须是整数或 null', () => {
    assert.throws(
      () => coverageEntry({ routeKey: 'x', intent: 'x', claimedCount: '100', capturedCount: 1 }),
      /整数或 null/,
    );
  });

  test('拒绝 completeness / reconciled 这类字段', () => {
    // 规范刻意不提供它们：不存在的字段无法被误用。这里拦住「顺手加上」。
    const b = builder();
    for (const bad of ['completeness', 'reconciled', 'is_complete']) {
      const e = { ...coverageEntry({ routeKey: 'x', intent: 'x', claimedCount: null, capturedCount: 1 }), [bad]: true };
      assert.throws(() => b.addCoverage(e), /不得含/, `应拦下 ${bad}`);
    }
  });

  test('合法的 coverage 进入 manifest', () => {
    const b = builder();
    b.addCoverage(coverageEntry({ routeKey: 'a', intent: 'a', claimedCount: null, capturedCount: 3 }));
    b.addCoverage(
      coverageEntry({ routeKey: 'b', intent: 'b', claimedCount: 5, claimedSource: `${BID}#000001`, capturedCount: 5 }),
    );
    assert.equal(buildOk(b).coverage.length, 2);
  });
});

describe('crawl_state —— 水位线不变量', () => {
  const base = {
    routeKey: 'broadcast.timeline',
    intent: 'broadcast.timeline',
    highWaterTime: '2026-07-26T12:34:00+08:00',
    highWaterRaw: '2026-07-26 12:34:00',
    floorTime: null,
    enumeration: /** @type {const} */ ('bounded'),
    contiguous: true,
    advanced: true,
    bundleId: BID,
  };

  test('连续无缺口时可以推进水位线', () => {
    const e = crawlStateEntry(base);
    assert.equal(e.advanced, true);
    assert.equal(e.high_water_time, '2026-07-26T12:34:00+08:00');
  });

  test('advanced=true 但 contiguous=false —— 拒绝', () => {
    // 否则下次抓取会从一个假的下界开始，中间那段永远补不回来。
    assert.throws(() => crawlStateEntry({ ...base, contiguous: false }), /contiguous=false/);
  });

  test('advanced=true 但有缺口 —— 拒绝', () => {
    assert.throws(
      () => crawlStateEntry({ ...base, gaps: [{ reason: 'fetch_failed' }] }),
      /缺口/,
    );
  });

  test('advanced=true 但 high_water_time 为 null —— 拒绝', () => {
    assert.throws(() => crawlStateEntry({ ...base, highWaterTime: null }), /high_water_time/);
  });

  test('被打断时 advanced=false，数据仍留着但下次从旧下界重走', () => {
    // 重复是免费的，空洞是永久且不可检测的。
    const e = crawlStateEntry({
      ...base,
      contiguous: false,
      advanced: false,
      gaps: [{ reason: 'blocked', detail: '第 42 页被拦' }],
    });
    assert.equal(e.advanced, false);
    assert.equal(e.gaps.length, 1);
  });

  test('enumeration 必须是 full 或 bounded', () => {
    assert.throws(
      () => crawlStateEntry({ ...base, enumeration: /** @type {any} */ ('maybe') }),
      /full 或 bounded/,
    );
    assert.equal(crawlStateEntry({ ...base, enumeration: 'full' }).enumeration, 'full');
  });

  test('时间必须带时区偏移', () => {
    assert.throws(
      () => crawlStateEntry({ ...base, highWaterTime: '2026-07-26 12:34:00' }),
      /时区偏移/,
    );
    assert.throws(
      () => crawlStateEntry({ ...base, floorTime: '2026-06-01 00:00:00', advanced: false }),
      /时区偏移/,
    );
  });

  test('floor_time 为 null 表示抓到最早', () => {
    assert.equal(crawlStateEntry(base).floor_time, null);
  });
});

describe('段与索引的交叉核对', () => {
  test('record_count 与 index 行数不符 —— 拒绝产出', () => {
    const per = new Map([[SEG, 3]]); // manifest 说 2
    assert.throws(
      () => builder().build({ status: 'complete', completedAt: AT, segments: SEGMENTS, index: INDEX, perSegmentIndexCounts: per }),
      /record_count 为 2.*行数为 3|失去对应关系/s,
    );
  });

  test('对上了就通过', () => {
    const per = new Map([[SEG, 2]]);
    assert.doesNotThrow(() =>
      builder().build({ status: 'complete', completedAt: AT, segments: SEGMENTS, index: INDEX, perSegmentIndexCounts: per }),
    );
  });

  test('index 引用了 manifest 没列出的段 —— 拒绝', () => {
    const per = new Map([[SEG, 2], ['data-other-00001.warc.gz', 1]]);
    assert.throws(
      () => builder().build({ status: 'complete', completedAt: AT, segments: SEGMENTS, index: INDEX, perSegmentIndexCounts: per }),
      /未列出的段/,
    );
  });

  test('不传 perSegmentIndexCounts 则跳过该检查', () => {
    assert.doesNotThrow(() => buildOk());
  });
});

describe('可选字段', () => {
  test('counts 与 notes 给了才出现', () => {
    const withCounts = buildOk(builder(), { counts: { by_verdict: { ok: 2 } }, notes: '备注' });
    assert.deepEqual(withCounts.counts, { by_verdict: { ok: 2 } });
    assert.equal(withCounts.notes, '备注');

    const without = buildOk();
    assert.ok(!('counts' in without));
    assert.ok(!('notes' in without));
  });
});
