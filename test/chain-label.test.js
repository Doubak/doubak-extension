/**
 * 覆盖率页「合起来」那一行的措辞。
 *
 * 增量之后最容易说错的一件事：**「实抓 3 条」可能完全正常**（那只是这次新增的），
 * 而「完整」是整条链的属性。两者混起来，用户会对着一个正常的数字以为出事了，
 * 或者对着一条断掉的链以为没事。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { chainRow, chainHeadline, holeText } from '../src/ui/chain-label.js';

describe('一条路线在链上的那一行', () => {
  test('区间只到天 —— 精确到秒是噪音', () => {
    const r = chainRow({
      routeKey: 'broadcast.timeline',
      oldest: '2014-01-10T22:56:49+08:00',
      newest: '2026-08-15T06:04:23+08:00',
      bundles: ['B2', 'B1'],
      contiguous: true,
    });
    assert.equal(r.span, '2014-01-10 ─ 2026-08-15');
    assert.equal(r.name, '广播');
    assert.equal(r.bundles, 2);
    assert.equal(r.verdict, '✔ 已验证');
  });

  test('没有时间水位线 → 「不适用」，不是「—」', () => {
    // 作品详情页不分页、条目之间没有时间序，`advanced` 恒为 false。
    // 那**不是「没抓到」**，两者是完全不同的事——写成「—」会被读成后者。
    const r = chainRow({ routeKey: 'interest.item', bundles: ['B1'], contiguous: false });
    assert.equal(r.span, null);
    assert.match(r.spanNote, /不适用/);
    assert.match(r.spanNote, /没有时间水位线/);
  });

  test('链上有洞 → 说「有 N 处缺口」，不说「未验证」', () => {
    const r = chainRow({
      routeKey: 'broadcast.timeline',
      oldest: '2014-01-10T00:00:00+08:00',
      newest: '2026-08-15T00:00:00+08:00',
      bundles: ['B2'],
      contiguous: false,
      holes: [{ routeKey: 'broadcast.timeline', kind: 'absent' }],
    });
    assert.equal(r.verdict, '有 1 处缺口');
  });

  test('**绝不会写「已验证 · 有缺口」**', () => {
    const r = chainRow({
      routeKey: 'r', bundles: ['B1'], contiguous: false, holes: [{}],
    });
    assert.equal(r.verdict.includes('已验证'), false);
  });

  test('链是完整的就说已验证', () => {
    const r = chainRow({
      routeKey: 'r', oldest: '2014-01-10T00:00:00+08:00',
      newest: '2026-08-15T00:00:00+08:00', bundles: ['B2', 'B1'],
      contiguous: true, holes: [],
    });
    assert.equal(r.verdict, '✔ 已验证');
  });

  test('界面上不出现内部路线标识', () => {
    assert.equal(chainRow({ routeKey: 'interest.game.do', bundles: [] }).name, '游戏 · 在玩');
  });
});

describe('整条链的一句话', () => {
  test('只有一份就直说还没有增量', () => {
    assert.match(chainHeadline([{ bundleId: 'B1' }]), /还没有增量/);
  });

  test('多份就说跨几份', () => {
    assert.match(chainHeadline([{ bundleId: 'B2' }, { bundleId: 'B1' }]), /2 份/);
  });

  test('一份都没有', () => {
    assert.match(chainHeadline([]), /还没有/);
    assert.match(chainHeadline(undefined), /还没有/);
  });
});

describe('链断了那句话', () => {
  test('说清是哪条路线断的', () => {
    const s = holeText({ routeKey: 'broadcast.timeline', missing: 'B1', kind: 'absent', detail: '' });
    assert.match(s, /广播/);
    assert.match(s, /链断了/);
    assert.equal(s.includes('broadcast.timeline'), false, '界面上不出现内部标识');
  });
});

describe('**刻意不提供**「合起来一共抓了多少」', () => {
  test('那一行里没有总数字段', () => {
    // 下界比较是闭区间（宁可重复不可遗漏），相邻两份在边界上必然重叠。加起来会
    // 比真实条目数多，而多多少取决于边界那一秒有几条——一个看起来精确、实际
    // 没有意义的数字。这一页的论点本来就是「计数不能证明完整性，连续性才能」。
    const r = chainRow({ routeKey: 'r', bundles: ['B2', 'B1'], contiguous: true });
    for (const bad of ['captured', 'total', 'count', 'claimed']) {
      assert.equal(bad in r, false, `不该有 ${bad} 这个字段`);
    }
  });
});
