/**
 * 「这一份东西我是不是已经抓到过了」——三张跳过名单。
 *
 * 这一组守的是**跳过**，而跳过是这套代码里最难发现出错的一类动作：它不产生捕获行、
 * 不在日志里滚动、覆盖率页上只是一个不再增长的数字。名单多收一条，那一条就再也
 * 不会被抓；名单少收一条，只是白抓一遍。两个方向的代价差着一个量级。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyKnownCaptures, addKnownCaptures, knownCaptureLists,
  LONGFORM_ROUTES, SUBJECT_ROUTE,
} from '../src/crawl/known-captures.js';

/** 一条索引行。默认是成功的——不成功是各条测试自己说的事。 */
const row = (route_key, url, extra = {}) => ({
  route_key, url, url_key: url, verdict: 'ok', ...extra,
});

/** 一趟：喂若干份档案的索引行，拿到摊平的三张名单。 */
const lists = (...bundles) => {
  const acc = emptyKnownCaptures();
  for (const rows of bundles) addKnownCaptures(acc, rows);
  return knownCaptureLists(acc);
};

const PHOTO = 'https://img1.doubanio.com/view/group_topic/l/public/p742324445.jpg';

describe('三档分开', () => {
  test('作品详情页、长文正文、图各归各档', () => {
    const r = lists([
      row(SUBJECT_ROUTE, 'https://movie.douban.com/subject/1001/'),
      row('note.item', 'https://www.douban.com/note/872015292/'),
      row('review.item', 'https://www.douban.com/review/8381069/'),
      row('asset.status_photo', PHOTO),
    ]);
    assert.deepEqual(r.subjects, ['https://movie.douban.com/subject/1001/']);
    assert.deepEqual(r.longform.map((x) => x.routeKey).sort(), ['note.item', 'review.item']);
    assert.deepEqual(r.assets, [PHOTO]);
  });

  test('**列表页一个都不许收** —— 收了这次一页都抓不成', () => {
    // 列表页的 URL 每次都一样（`collect?start=0`），把它算成「已经抓过」，
    // 下一趟就一条都不会去请求——不是少抓几条，是整趟抓取空转。
    const r = lists([
      row('interest.movie.collect', 'https://movie.douban.com/people/me/collect?start=0'),
      row('broadcast.timeline', 'https://www.douban.com/people/me/statuses'),
      row('note.list', 'https://www.douban.com/people/me/notes?start=0'),
      row('profile.overview', 'https://www.douban.com/people/me/'),
    ]);
    assert.deepEqual(r, { subjects: [], longform: [], assets: [] });
  });

  test('三种 `asset.*` 都算图，判据是前缀不是一张写死的名单', () => {
    const r = lists([
      row('asset.status_photo', 'https://img1.doubanio.com/a.jpg'),
      row('asset.longform_embed', 'https://img2.doubanio.com/b.jpg'),
      row('asset.subject_cover', 'https://img3.doubanio.com/c.jpg'),
      // 将来新增的一条。默认落进「抓过就不再抓」，而那对图是对的。
      row('asset.album_photo', 'https://img4.doubanio.com/d.jpg'),
    ]);
    assert.equal(r.assets.length, 4);
  });
});

describe('失败的必须还能重试', () => {
  // 这是整套跳过名单唯一必须保住的性质：名单里只放确实成功的那些。
  // 放错了不会报错——那一份东西只是再也不会被抓，而档案里也没有它。
  for (const verdict of ['blocked', 'challenge', 'login', 'gone', 'soft404', 'failed', undefined]) {
    test(`\`${verdict ?? '没有 verdict'}\` 不算「已经有了」`, () => {
      const r = lists([
        row(SUBJECT_ROUTE, 'https://movie.douban.com/subject/1001/', { verdict }),
        row('note.item', 'https://www.douban.com/note/1/', { verdict }),
        row('asset.status_photo', PHOTO, { verdict }),
      ]);
      assert.deepEqual(r, { subjects: [], longform: [], assets: [] });
    });
  }

  test('`gone` 尤其要紧 —— 条目可能又回来了', () => {
    // 同一个 URL 先 gone 后 ok：认 ok 的那次。反过来（先 ok 后 gone）仍然算有，
    // 因为字节确实在档案里——「已经有了」问的是档案，不是豆瓣现在还在不在。
    const r = lists(
      [row(SUBJECT_ROUTE, 'https://movie.douban.com/subject/1001/', { verdict: 'gone' })],
      [row(SUBJECT_ROUTE, 'https://movie.douban.com/subject/1001/')],
    );
    assert.deepEqual(r.subjects, ['https://movie.douban.com/subject/1001/']);
  });
});

describe('跨档案累加', () => {
  test('**按账号合并，不按链** —— 三份档案里的东西合成一张名单', () => {
    // 实测过的坑：按链取时，`previous_bundle_id` 为 null 的档案各自成链，
    // 「最新那条链」常常只有一份——那一份要是刚跑了一小段的增量，
    // 此前几千个详情页就全都不认识了。
    const r = lists(
      [row(SUBJECT_ROUTE, 'https://movie.douban.com/subject/1/')],
      [row(SUBJECT_ROUTE, 'https://movie.douban.com/subject/2/')],
      [row(SUBJECT_ROUTE, 'https://movie.douban.com/subject/3/')],
    );
    assert.equal(r.subjects.length, 3);
  });

  test('同一张图在三份档案里出现，只记一次', () => {
    // 这正是真实档案里的样子：p742324445.jpg 被 ba57a3 / 0fb09c / 157e63
    // 各抓了一遍。名单要去重，否则 markCaptured 白做三次。
    const r = lists([row('asset.status_photo', PHOTO)], [row('asset.status_photo', PHOTO)],
      [row('asset.status_photo', PHOTO)]);
    assert.deepEqual(r.assets, [PHOTO]);
  });

  test('一份读不出来不影响其余的 —— 调用方跳过那一份就行', () => {
    // offscreen 那边每份档案各自 try/catch。累加器是跨调用的，所以前面读进去的
    // 不会因为后面一份坏掉而丢。
    const acc = emptyKnownCaptures();
    addKnownCaptures(acc, [row(SUBJECT_ROUTE, 'https://movie.douban.com/subject/1/')]);
    try {
      addKnownCaptures(acc, (function* () { throw new Error('段文件坏了'); })());
    } catch { /* 调用方吞掉，当这份档案不存在 */ }
    addKnownCaptures(acc, [row(SUBJECT_ROUTE, 'https://movie.douban.com/subject/2/')]);
    assert.equal(knownCaptureLists(acc).subjects.length, 2);
  });
});

describe('长文的路线跟着 URL 一起走', () => {
  test('`/topic/` 形状的日记仍然是 note.item', () => {
    // 实测这个账号 3 篇日记里就有一篇是 `www.douban.com/topic/496284296/`。
    // 按 URL 形状猜的话它会被排进 review.item——判定描述、优先级、门控全不一样，
    // 而且不会报错。所以 route_key 是从索引行里原样取的。
    const r = lists([
      row('note.item', 'https://www.douban.com/topic/496284296/'),
      row('note.item', 'https://www.douban.com/note/872015292/'),
      row('review.item', 'https://www.douban.com/review/8381069/'),
    ]);
    const byUrl = Object.fromEntries(r.longform.map((x) => [x.url, x.routeKey]));
    assert.equal(byUrl['https://www.douban.com/topic/496284296/'], 'note.item');
    assert.equal(byUrl['https://www.douban.com/note/872015292/'], 'note.item');
    assert.equal(byUrl['https://www.douban.com/review/8381069/'], 'review.item');
  });

  test('两条长文路线都认', () => {
    assert.deepEqual([...LONGFORM_ROUTES].sort(), ['note.item', 'review.item']);
  });
});

describe('过得了那条只认 JSON 的通道', () => {
  test('摊成数组，不是 Set / Map', () => {
    // `chrome.runtime.sendMessage` 只认 JSON：Set 与 Map 过去会**静默变成 `{}`**。
    // 不是报错，是一个值悄悄变了形状，而后果是跳过名单空了、这一趟把什么都重抓一遍。
    const r = lists([
      row(SUBJECT_ROUTE, 'https://movie.douban.com/subject/1/'),
      row('note.item', 'https://www.douban.com/note/1/'),
      row('asset.status_photo', PHOTO),
    ]);
    const wire = JSON.parse(JSON.stringify(r));
    assert.deepEqual(wire, r, '过一遍 JSON 之后必须一模一样');
    assert.ok(Array.isArray(wire.subjects) && Array.isArray(wire.assets));
    assert.deepEqual(wire.longform, [{ url: 'https://www.douban.com/note/1/', routeKey: 'note.item' }]);
  });
});

describe('没有 url_key 的行不算', () => {
  test('缺 url_key 或缺 route_key 都跳过', () => {
    // 半截的行不该让任何东西被跳过：`undefined` 进了名单，
    // 下一趟 markCaptured 一个 undefined，谁都对不上，但也没人会发现。
    const r = lists([
      { route_key: SUBJECT_ROUTE, verdict: 'ok' },
      { url_key: 'https://movie.douban.com/subject/1/', verdict: 'ok' },
      null,
    ]);
    assert.deepEqual(r, { subjects: [], longform: [], assets: [] });
  });
});
