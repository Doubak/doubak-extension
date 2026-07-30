/**
 * 捕获列表每一行的措辞。
 *
 * ## 为什么值得一组测试
 *
 * 因为它**很容易悄悄说错**。index 里有两类时间，含义完全不同：
 *
 * | 字段 | 是什么 |
 * |---|---|
 * | `item_time_range` | 这一页**内容**覆盖的时间区间 |
 * | `observed_at` | **抓取**这一页的时刻 |
 *
 * 混起来的后果不是「不好看」：用户以为看到的是「第 7 页是 7 月中旬的广播」，实际看到的
 * 是「这一页是今天抓的」——而后者在一次抓取里几十行几乎全一样，等于没有信息，还给出了
 * 一个错误的印象。这件事真的被当成 bug 报过来。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { captureTitle, captureSubtitle } from '../src/ui/capture-label.js';

const rn = (k) => ({
  'broadcast.timeline': '广播',
  'interest.drama.collect': '舞台剧 · 看过',
  'interest.item': '作品详情页',
}[k] ?? k);

describe('标题：哪条线的第几页', () => {
  test('page 游标写成「第 N 页」', () => {
    assert.equal(
      captureTitle({ route_key: 'broadcast.timeline', cursor: { kind: 'page', value: 7 } }, rn),
      '广播 · 第 7 页',
    );
  });

  test('offset 游标写成「第 N 条起」，**不是**第 N 页', () => {
    // 这两者差一个数量级：步长 15 的列表里，offset 105 是第 8 页。写成「第 105 页」
    // 会让人以为抓了 105 页。
    assert.equal(
      captureTitle({ route_key: 'interest.drama.collect', cursor: { kind: 'start', value: 105 } }, rn),
      '舞台剧 · 看过 · 第 105 条起',
    );
  });

  test('没有游标就只写路线名', () => {
    assert.equal(captureTitle({ route_key: 'interest.item' }, rn), '作品详情页');
    assert.equal(captureTitle({ route_key: 'interest.item', cursor: null }, rn), '作品详情页');
  });

  test('游标值为 0 也要显示 —— 0 是合法的起点', () => {
    // `if (c.value)` 会把 0 当成没有。列表页的第一页 offset 就是 0。
    assert.match(
      captureTitle({ route_key: 'interest.drama.collect', cursor: { kind: 'start', value: 0 } }, rn),
      /第 0 条起/,
    );
  });

  test('界面上不出现内部路线标识', () => {
    const s = captureTitle({ route_key: 'broadcast.timeline', cursor: { kind: 'page', value: 1 } }, rn);
    assert.equal(s.includes('broadcast.timeline'), false);
  });
});

describe('副标题：说内容时间，不拿抓取时间冒充', () => {
  test('有内容时间就说内容时间', () => {
    const s = captureSubtitle({
      item_count: 20,
      item_time_range: { oldest: '2026-07-12 08:11:00', newest: '2026-07-18 22:04:00' },
      observed_at: '2026-07-30T20:43:13+10:00',
    });
    assert.equal(s, '20 条 · 2026-07-12 → 2026-07-18');
    // 抓取时间**不该出现**——这一行已经有更有用的东西可说了
    assert.equal(s.includes('2026-07-30'), false);
    assert.equal(s.includes('抓于'), false);
  });

  test('同一天的不写成「X → X」', () => {
    const s = captureSubtitle({
      item_count: 15,
      item_time_range: { oldest: '2024-03-02 10:00:00', newest: '2024-03-02 18:00:00' },
    });
    assert.equal(s, '15 条 · 2024-03-02');
  });

  test('内容时间只到天 —— 列表里精确到秒是噪音', () => {
    const s = captureSubtitle({
      item_count: 1,
      item_time_range: { oldest: '2026-07-12 08:11:00', newest: '2026-07-12 08:11:00' },
    });
    assert.equal(s.includes('08:11'), false);
  });
});

describe('没有内容时间：抓取时刻精确到秒，且说清是哪一种情况', () => {
  test('这条路线本来就没有条目时间（作品详情页）', () => {
    const s = captureSubtitle({
      item_count: null, item_time_range: null, observed_at: '2026-07-30T20:43:16+10:00',
    });
    // 精确到秒：一次抓取里几十行的**日期**全一样，只有秒能把它们区分开。
    assert.equal(s, '抓于 2026-07-30 20:43:16');
  });

  test('旧档案：字段是后加的 —— 要说「没有记录」，不能拿抓取时间冒充', () => {
    // 这是那次报告的实际情形：4 份档案抓在这两个字段加进规范之前。原来只显示一个
    // 日期，而那是抓取日期——看起来像「第 7 页的广播是今天发的」。
    //
    // 「我们当时没记」与「本来就没有」是两回事。把前者说成后者，等于替一份旧档案
    // 担保它其实没担保过的东西。
    const s = captureSubtitle({ observed_at: '2026-07-30T20:42:53+10:00' });
    assert.match(s, /抓于 2026-07-30 20:42:53/);
    assert.match(s, /没有记录内容时间/);
  });

  test('两种情形的措辞必须不同', () => {
    const newFormat = captureSubtitle({ item_count: null, item_time_range: null, observed_at: 'x' });
    const oldBundle = captureSubtitle({ observed_at: 'x' });
    assert.notEqual(newFormat, oldBundle);
    assert.equal(newFormat.includes('没有记录'), false, '新格式不该说「没有记录」');
  });

  test('时间戳去掉 T 与时区偏移，留到秒', () => {
    assert.match(captureSubtitle({ observed_at: '2026-07-30T20:42:53+10:00' }), /2026-07-30 20:42:53/);
    assert.match(captureSubtitle({ observed_at: '2026-07-30T20:42:53Z' }), /2026-07-30 20:42:53/);
  });

  test('连抓取时间都没有也不崩', () => {
    assert.doesNotThrow(() => captureSubtitle({}));
  });
});

describe('item_count 的 0 与 null 不能显示成一样', () => {
  test('0 是「数过了，是空的」—— 翻页终点的正常形态', () => {
    const s = captureSubtitle({ item_count: 0, item_time_range: null, observed_at: 'x' });
    assert.match(s, /0 条/);
    assert.match(s, /到这儿就没有了/, '空页说明这条线走完了，那是有用的信息');
  });

  test('null 是「这条路线没有条目概念」—— 一个字都不提条数', () => {
    const s = captureSubtitle({ item_count: null, item_time_range: null, observed_at: 'x' });
    assert.equal(/条/.test(s), false);
  });
});
