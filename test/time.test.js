import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DOUBAN_TZ,
  DOUBAN_TZ_OFFSET_MINUTES,
  isRfc3339WithOffset,
  toRfc3339,
  nowRfc3339,
  parseDoubanTimestamp,
  hasReachedFloor,
} from '../src/core/time.js';

describe('RFC 3339 格式化', () => {
  test('总是带显式偏移量', () => {
    assert.equal(toRfc3339(new Date('2026-07-28T02:15:00Z'), 0), '2026-07-28T02:15:00Z');
    assert.equal(toRfc3339(new Date('2026-07-28T02:15:00Z'), 480), '2026-07-28T10:15:00+08:00');
    assert.equal(toRfc3339(new Date('2026-07-28T02:15:00Z'), -300), '2026-07-27T21:15:00-05:00');
  });

  test('负偏移与半小时时区', () => {
    assert.equal(toRfc3339(new Date('2026-07-28T00:00:00Z'), 330), '2026-07-28T05:30:00+05:30');
    assert.equal(toRfc3339(new Date('2026-07-28T00:00:00Z'), -210), '2026-07-27T20:30:00-03:30');
  });

  test('产出的字符串能通过规范的校验', () => {
    assert.ok(isRfc3339WithOffset(toRfc3339(new Date(), 480)));
    assert.ok(isRfc3339WithOffset(nowRfc3339()));
  });

  test('拒绝裸时间', () => {
    // 规范禁止无时区的时间戳；校验器也会因此报错。
    assert.equal(isRfc3339WithOffset('2026-07-28 10:15:00'), false);
    assert.equal(isRfc3339WithOffset('2026-07-28T10:15:00'), false);
    assert.equal(isRfc3339WithOffset(''), false);
  });

  test('拒绝无效 Date', () => {
    assert.throws(() => toRfc3339(new Date('乱码')), /无效的 Date/);
  });
});

describe('解析豆瓣的裸时间', () => {
  test('只标注，不转换 —— 墙上时间一个数字都不动', () => {
    // 这是最关键的一条：真实档案里的
    //   <span class="created_at" title="2024-05-12 14:43:19">
    // 必须原样变成 14:43:19+08:00，而不是被换算成别的钟点。
    const r = parseDoubanTimestamp('2024-05-12 14:43:19');
    assert.equal(r.iso, '2024-05-12T14:43:19+08:00');
    assert.equal(r.raw, '2024-05-12 14:43:19');
    assert.equal(r.tz, DOUBAN_TZ);
  });

  test('原始字符串永远保留', () => {
    const raw = '  2026-07-26 12:34:00  ';
    assert.equal(parseDoubanTimestamp(raw).raw, '2026-07-26 12:34:00');
  });

  test('结果与本机时区无关', () => {
    // 海外用户跑抓取时，水位线绝不能因为本机时区而偏移。
    const prev = process.env.TZ;
    try {
      const results = [];
      for (const tz of ['UTC', 'America/New_York', 'Asia/Shanghai', 'Pacific/Kiritimati']) {
        process.env.TZ = tz;
        results.push(parseDoubanTimestamp('2024-05-12 14:43:19'));
      }
      const isos = new Set(results.map((r) => r.iso));
      const epochs = new Set(results.map((r) => r.epochMs));
      assert.equal(isos.size, 1, '不同本机时区下 iso 必须一致');
      assert.equal(epochs.size, 1, '不同本机时区下 epochMs 必须一致');
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });

  test('epochMs 对应正确的 UTC 时刻', () => {
    // 14:43:19 +08:00 === 06:43:19 UTC
    const r = parseDoubanTimestamp('2024-05-12 14:43:19');
    assert.equal(new Date(r.epochMs).toISOString(), '2024-05-12T06:43:19.000Z');
  });

  test('接受省略秒与 T 分隔', () => {
    assert.equal(parseDoubanTimestamp('2026-07-26 12:34').iso, '2026-07-26T12:34:00+08:00');
    assert.equal(parseDoubanTimestamp('2026-07-26T12:34:00').iso, '2026-07-26T12:34:00+08:00');
  });

  test('偏移量可覆盖，便于将来推翻时区假定后重算存量', () => {
    assert.equal(parseDoubanTimestamp('2024-05-12 14:43:19', 0).iso, '2024-05-12T14:43:19Z');
  });

  test('拒绝不存在的日期，而不是悄悄滚到下个月', () => {
    // Date.UTC 会把 2026-02-31 变成 3 月 3 日。静默滚动正是要避免的行为。
    assert.throws(() => parseDoubanTimestamp('2026-02-31 00:00:00'), /日期不存在/);
    assert.throws(() => parseDoubanTimestamp('2026-13-01 00:00:00'), /日期不存在|无法解析/);
    assert.throws(() => parseDoubanTimestamp('2026-07-26 25:00:00'), /日期不存在|无法解析/);
  });

  test('闰日合法', () => {
    assert.equal(parseDoubanTimestamp('2024-02-29 12:00:00').iso, '2024-02-29T12:00:00+08:00');
  });

  test('拒绝无法解析的输入', () => {
    for (const bad of ['', '今天 14:23', '7月26日', '2026/07/26 12:34:00', 'null']) {
      assert.throws(() => parseDoubanTimestamp(bad), /无法解析的豆瓣时间/, `不该接受 ${bad}`);
    }
    assert.throws(() => parseDoubanTimestamp(/** @type {any} */ (null)), /必须是 string/);
  });

  test('时区常量就是 UTC+8', () => {
    assert.equal(DOUBAN_TZ_OFFSET_MINUTES, 480);
  });
});

describe('水位线比较', () => {
  const floor = parseDoubanTimestamp('2026-06-01 00:00:00').epochMs;

  test('用闭区间 —— 正好等于下界也算到达', () => {
    // 宁可重复，不可遗漏：同一秒可能有多条，用 < 会漏掉边界上的那些。
    assert.equal(hasReachedFloor(floor, floor), true);
  });

  test('比下界新则继续抓', () => {
    const newer = parseDoubanTimestamp('2026-06-01 00:00:01').epochMs;
    assert.equal(hasReachedFloor(newer, floor), false);
  });

  test('比下界旧则停', () => {
    const older = parseDoubanTimestamp('2026-05-31 23:59:59').epochMs;
    assert.equal(hasReachedFloor(older, floor), true);
  });

  test('无下界时永不停 —— 首次全量抓到最早', () => {
    assert.equal(hasReachedFloor(0, null), false);
    assert.equal(hasReachedFloor(Date.now(), null), false);
  });
});
