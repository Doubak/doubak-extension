/**
 * 一条分页路线到底靠什么停下来。
 *
 * 设计与实测数据在 DESIGN.md §3.3c。这一组测试的作用是**逼着新增路线的人做这个
 * 决定**：停早了是静默截断，停晚了是白发请求，而两者都不会报错。
 *
 * 五种判据：
 *
 *   reached_floor   走到上次的水位线（仅增量）
 *   stalled         连续 3 页没有新条目，或连续 2 页一条都没有（兜底，人人都有）
 *   empty_page      `step: 'items'` 且这一页空 → 步长 0
 *   last_page       这一页自己说「第 K 页 / 共 N 页」且 K ≥ N
 *   no_next_page    派生路线算不出下一页的地址
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildRoutes } from '../src/crawl/routes.js';
import { profileForRoute } from '../src/crawl/classifier.js';

const routes = buildRoutes({ username: 'u' });
const paginated = routes.filter((r) => r.pagination);
const loopSrc = readFileSync(new URL('../src/crawl/loop.js', import.meta.url), 'utf-8');
const nextPageFn = loopSrc.slice(
  loopSrc.indexOf('_enqueueNextPage(item, route'),
  loopSrc.indexOf('function itemTimeRange'),
);

/** 一条路线拿得到哪几种判据。 */
function terminators(r) {
  const p = profileForRoute(r.key) ?? {};
  const t = ['stalled'];
  if (r.pagination?.step === 'items') t.push('empty_page');
  if (p.paginator) t.push('last_page');
  if (r.nextPageUrl) t.push('no_next_page');
  return t;
}

describe('每条分页路线都说得出自己靠什么收尾', () => {
  test('五种判据都在代码里真的存在', () => {
    for (const reason of ['reached_floor', 'stalled', 'empty_page', 'last_page', 'no_next_page']) {
      assert.match(nextPageFn, new RegExp(`reason: '${reason}'`), `${reason} 不在 _enqueueNextPage 里`);
    }
  });

  test('**每条分页路线至少要有一个「兜底之外」的判据，或者明说只靠兜底**', () => {
    // 只有 `stalled` 不是错——广播与标记列表就是这样，而且那是刻意的（豆瓣的计数
    // 不可信，连续性证明才是判据）。但那必须是个**决定**，不是忘了配。
    //
    // 名单写死在这里，加一条分页路线就会红。红的时候要回答的问题是：
    // 这条线走到头的时候，我们怎么知道它到头了？
    const ONLY_STALL = new Set(['broadcast.timeline']);
    const byFamily = new Map();
    for (const r of paginated) {
      const fam = r.key.replace(/\.(movie|book|music|game|drama)(\.(collect|wish|do))?$/, '.*');
      if (!byFamily.has(fam)) byFamily.set(fam, terminators(r));
    }
    assert.deepEqual(
      [...byFamily.keys()].sort(),
      ['broadcast.timeline', 'doulist.item', 'doulist.list', 'interest.*', 'note.list', 'review.list'],
      '分页路线的名单变了 —— 新加的那条靠什么收尾？见 DESIGN.md §3.3c',
    );
    for (const [fam, t] of byFamily) {
      if (ONLY_STALL.has(fam) || fam === 'interest.*') {
        assert.deepEqual(t, ['stalled'], `${fam} 应当只靠兜底（刻意的）`);
      } else {
        assert.ok(t.length > 1, `${fam} 只有兜底判据，是刻意的还是忘了配？`);
      }
    }
  });

  test('`step: items` 的路线才拿得到 empty_page', () => {
    for (const r of paginated) {
      const has = terminators(r).includes('empty_page');
      assert.equal(has, r.pagination.step === 'items', `${r.key} 对不上`);
    }
  });
});

describe('翻页器只给量准了的那条路线 —— 它不是一个统一的信号', () => {
  test('只有豆列详情页配了 paginator 锚点', () => {
    // 实测（真实档案，8 条分页路线）：
    //   广播          184/184 页有翻页器，值恒为 9223372036854775807（Long.MAX，哨兵）
    //   标记·影视      183/183，值 89/90/50/51/2
    //   标记·书        53/53 有翻页器，**却一次都没有这个属性**
    //   标记·舞台剧    0/30，连翻页器都没有
    //   豆列详情页     多页的那几份每页都有，值 2/3，与实际内容页数逐份吻合
    //
    // 所以「读翻页器」不能做成全局开关。
    const withPaginator = routes.filter((r) => profileForRoute(r.key)?.paginator).map((r) => r.key);
    assert.deepEqual(withPaginator, ['doulist.item']);
  });

  test('**标记列表刻意不用它：那个数是豆瓣的声称数除以每页条数**', () => {
    // 规范 §2 禁止拿声称数去【授予】完整性——豆瓣的计数有时在审查层之前算、有时在
    // 之后算（实测 游戏/玩过 声称 293、渲染 288）。拿它当终止条件，就是用一个不可信
    // 的计数决定「不用再往下读了」，而方向恰好是会截断的那个。
    // 注意路线的 **key** 是 `interest.movie.collect`，而 `interest.list.movie.collect`
    // 是它的 **intent**。第一版写这条测试时把两者搞混了，`find` 返回 undefined，
    // 于是断言在「标记列表还在吧」那一步就红了——而不是在它想验的那一点上。
    const marks = routes.find((r) => r.key.startsWith('interest.movie'));
    assert.ok(marks, '标记列表路线还在吧');
    assert.equal(profileForRoute(marks.key)?.paginator, undefined,
      '标记列表不该配 paginator —— 理由见 DESIGN.md §3.3c');
  });

  test('广播那个值是 Long.MAX —— 拿它判会读到一句谎话', () => {
    // 9223372036854775807 = 2^63-1。豆瓣在说「页数无限」。
    // 即使误用也不会截断（K ≥ N 永远不成立），但它证明这个属性可以是哨兵而不是计数。
    assert.equal(profileForRoute('broadcast.timeline')?.paginator, undefined);
    assert.match(
      readFileSync(new URL('../DESIGN.md', import.meta.url), 'utf-8'),
      /9223372036854775807/,
      '这个值要记在设计文档里 —— 下一个想「全站读翻页器」的人得先看到它',
    );
  });

  test('判据只往「更早收手」的方向用', () => {
    // 没有翻页器时必须退回原来的走法。反过来（没有 ⇒ 只有一页）是从 6 份豆列推出来
    // 的，而猜错的后果是每份豆列只存前 25 条且不报错。
    assert.match(nextPageFn, /if \(pg &&/, '必须先确认翻页器存在');
    assert.ok(
      nextPageFn.indexOf('pg.page >= pg.totalPages') < nextPageFn.indexOf('const nextUrl'),
      '这道判断要排在算下一页地址之前，否则省不掉那个请求',
    );
  });
});
