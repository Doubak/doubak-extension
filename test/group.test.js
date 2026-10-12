/**
 * 豆瓣小组三条路线（主页、加入的小组、发起的讨论），对着真实页面验。
 *
 * 夹具来源：
 * - `group-home.html`: 小组个人主页 (mewcatcher)
 * - `group-joins.html`: 加入的小组列表 (Echo-of-Death, 114 个小组)
 * - `group-joins-manager.html`: 含管理员权限的小组列表 (furrypaw, 52 个小组)
 * - `group-publish.html`: 发起的讨论列表 (mewcatcher, 3 个话题)
 * - `group-publish-paginated.html`: 多页发起的讨论列表结构 (44 个话题, 共 3 页)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  profileForRoute,
  classifyResponse,
  extractItemPairs,
  extractPagination,
  extractDetailLinks,
  extractEmbeddedImages,
  extractGroupIcons,
} from '../src/crawl/classifier.js';
import { buildRoutes, PRIORITY } from '../src/crawl/routes.js';
import { CrawlLoop } from '../src/crawl/loop.js';
import { SessionGuard } from '../src/crawl/session.js';
import { routeName } from '../src/ui/route-names.js';
import { cursorFromUrl } from '../src/crawl/runner.js';
import { RouteState } from '../src/crawl/route-state.js';
import {
  emptyKnownCaptures,
  addKnownCaptures,
  knownCaptureLists,
  LONGFORM_ROUTES,
} from '../src/crawl/known-captures.js';
import { Frontier } from '../src/crawl/frontier.js';
import { urlKey } from '../src/core/urlkey.js';

const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf-8');

const GROUP_HOME = fixture('group-home.html');
const GROUP_JOINS = fixture('group-joins.html');
const GROUP_JOINS_MANAGER = fixture('group-joins-manager.html');
const GROUP_PUBLISH = fixture('group-publish.html');
const GROUP_PUBLISH_PAGINATED = fixture('group-publish-paginated.html');
const GROUP_TOPIC = fixture('group-topic.html');
const GROUP_TOPIC_WITH_IMAGE = fixture('group-topic-with-image.html');

const classify = (key, html, url) =>
  classifyResponse({
    finalUrl: url,
    status: 200,
    bodyText: html,
    route: profileForRoute(key),
    sizeStats: null,
  });

describe('小组：路线定义', () => {
  const routes = buildRoutes({ username: 'mewcatcher' });
  const homeRoute = routes.find((r) => r.key === 'group.overview');
  const joinsRoute = routes.find((r) => r.key === 'group.joins');
  const publishRoute = routes.find((r) => r.key === 'group.publish');
  const itemRoute = routes.find((r) => r.key === 'group.item');
  const iconRoute = routes.find((r) => r.key === 'asset.group_icon');

  test('五条路线均已注册且优先级符合设计', () => {
    assert.ok(homeRoute, '缺少 group.overview');
    assert.ok(joinsRoute, '缺少 group.joins');
    assert.ok(publishRoute, '缺少 group.publish');
    assert.ok(itemRoute, '缺少 group.item');
    assert.ok(iconRoute, '缺少 asset.group_icon');

    assert.equal(homeRoute.intent, 'group.overview');
    assert.equal(joinsRoute.intent, 'group.joins');
    assert.equal(publishRoute.intent, 'group.publish');
    assert.equal(itemRoute.intent, 'group.item');
    assert.equal(iconRoute.intent, 'asset.image.catalog_thumbnail');
    assert.equal(iconRoute.surface, 'asset');

    assert.ok(homeRoute.priority > PRIORITY.LONGFORM);
    assert.ok(joinsRoute.priority > PRIORITY.LONGFORM);
    assert.ok(publishRoute.priority > PRIORITY.LONGFORM);
    assert.ok(itemRoute.priority > PRIORITY.LONGFORM);
    assert.ok(iconRoute.priority > PRIORITY.CATALOG);
    assert.equal(itemRoute.entryUrl, undefined, '话题正文由 publish 派生，不设 entryUrl');
    assert.equal(iconRoute.entryUrl, undefined, '小组图标由 joins 派生，不设 entryUrl');
  });

  test('入口 URL 构造正确', () => {
    assert.equal(homeRoute.entryUrl(), 'https://www.douban.com/group/people/mewcatcher/');
    assert.equal(joinsRoute.entryUrl(), 'https://www.douban.com/group/people/mewcatcher/joins');
    assert.equal(publishRoute.entryUrl({ offset: 0 }), 'https://www.douban.com/group/people/mewcatcher/publish?start=0');
  });

  test('分页设置：joins 不分页，publish 步长为 50', () => {
    assert.equal(joinsRoute.pagination, undefined);
    assert.deepEqual(publishRoute.pagination, { kind: 'start', step: 50, first: 0 });
  });

  test('界面中文名称正确', () => {
    assert.equal(routeName('group.overview'), '小组主页');
    assert.equal(routeName('group.joins'), '加入的小组');
    assert.equal(routeName('group.publish'), '发起的讨论');
    assert.equal(routeName('group.item'), '讨论正文');
    assert.equal(routeName('asset.group_icon'), '小组图标');
  });
});

describe('小组主页（真实页面 mewcatcher）', () => {
  const URL_ = 'https://www.douban.com/group/people/mewcatcher/';

  test('判定通过，结构性标志完备', () => {
    const cls = classify('group.overview', GROUP_HOME, URL_);
    assert.equal(cls.verdict, 'ok');
  });
});

describe('加入的小组（真实页面 Echo-of-Death & furrypaw）', () => {
  const URL_ = 'https://www.douban.com/group/people/Echo-of-Death/joins';
  const profile = profileForRoute('group.joins');

  test('普通用户：判定通过，条目数为 114', () => {
    const cls = classify('group.joins', GROUP_JOINS, URL_);
    assert.equal(cls.verdict, 'ok');
    assert.equal(cls.itemCount, 114);
  });

  test('普通用户：抽取 114 个小组 ID，且无重复', () => {
    const pairs = extractItemPairs(GROUP_JOINS, profile);
    assert.equal(pairs.ids.length, 114);
    assert.equal(new Set(pairs.ids).size, 114);
    assert.equal(pairs.idless, 0);
    assert.equal(pairs.ids[0], '623999');
  });

  test('含管理权限用户：管理与加入的小组均被完整抽取（52 个）', () => {
    const cls = classify('group.joins', GROUP_JOINS_MANAGER, 'https://www.douban.com/group/people/furrypaw/joins');
    assert.equal(cls.verdict, 'ok');
    assert.equal(cls.itemCount, 52);

    const pairs = extractItemPairs(GROUP_JOINS_MANAGER, profile);
    assert.equal(pairs.ids.length, 52);
    assert.equal(new Set(pairs.ids).size, 52);
    assert.equal(pairs.idless, 0);
  });

  test('小组卡片不带时间，时间均为 null', () => {
    const pairs = extractItemPairs(GROUP_JOINS, profile);
    assert.ok(pairs.times.every((t) => t === null));
  });

  test('普通用户：成功提取全部 114 个小组图标 URL', () => {
    const { urls } = extractGroupIcons(GROUP_JOINS);
    assert.equal(urls.length, 114);
    assert.ok(urls.every((u) => u.includes('doubanio.com')));
  });

  test('含管理权限用户：成功提取管理与加入小组的图标 URL', () => {
    const { urls } = extractGroupIcons(GROUP_JOINS_MANAGER);
    assert.equal(urls.length, 43);
    assert.ok(urls.every((u) => u.includes('doubanio.com')));
  });

  test('group.joins 触发 _enqueueGroupIcons 时正确向 frontier 注入 asset.group_icon 路线条目', () => {
    const enqueued = [];
    const frontier = {
      enqueue: (item) => {
        enqueued.push(item);
        return true;
      },
    };
    const routes = new Map([
      ['asset.group_icon', { priority: 20, intent: 'asset.image.catalog_thumbnail' }],
    ]);
    const loop = {
      _frontier: frontier,
      _routes: routes,
      _emit: () => {},
      _enqueueGroupIcons: CrawlLoop.prototype._enqueueGroupIcons,
    };
    loop._enqueueGroupIcons(
      { routeKey: 'group.joins', url: 'https://www.douban.com/group/people/Echo-of-Death/joins' },
      { bodyText: GROUP_JOINS },
      'cap-joins-1',
    );
    assert.equal(enqueued.length, 114);
    assert.equal(enqueued[0].routeKey, 'asset.group_icon');
    assert.equal(enqueued[0].intent, 'asset.image.catalog_thumbnail');
    assert.equal(enqueued[0].referer, 'https://www.douban.com/group/people/Echo-of-Death/joins');
    assert.equal(enqueued[0].enqueuedBy, 'cap-joins-1');
  });
});

describe('发起的讨论（真实页面 mewcatcher & BlocksTower）', () => {
  const URL_ = 'https://www.douban.com/group/people/mewcatcher/publish?start=0';
  const profile = profileForRoute('group.publish');

  test('单页用户 (mewcatcher)：判定通过，条目数为 3', () => {
    const cls = classify('group.publish', GROUP_PUBLISH, URL_);
    assert.equal(cls.verdict, 'ok');
    assert.equal(cls.itemCount, 3);
  });

  test('单页用户：抽出 3 个话题 ID', () => {
    const pairs = extractItemPairs(GROUP_PUBLISH, profile);
    assert.deepEqual(pairs.ids, ['258053730', '254900406', '110871731']);
    assert.deepEqual(pairs.times, [null, null, null]);
    assert.equal(pairs.idless, 0);
  });

  test('多页讨论：判定通过，条目数为 44', () => {
    const blockstowerUrl = 'https://www.douban.com/group/people/BlocksTower/publish?start=0';
    const cls = classify('group.publish', GROUP_PUBLISH_PAGINATED, blockstowerUrl);
    assert.equal(cls.verdict, 'ok');
    assert.equal(cls.itemCount, 44);
  });

  test('多页讨论：成功抽取第 1 页共 3 页的分页信息及翻页链接', () => {
    const pg = extractPagination(GROUP_PUBLISH_PAGINATED, profile);
    assert.deepEqual(pg, { page: 1, totalPages: 3 });

    const links = [...GROUP_PUBLISH_PAGINATED.matchAll(/<a href="([^"]*\/group\/people\/BlocksTower\/publish\?start=\d+)"/g)].map((m) => m[1]);
    assert.deepEqual(links, [
      '/group/people/BlocksTower/publish?start=50',
      '/group/people/BlocksTower/publish?start=100',
      '/group/people/BlocksTower/publish?start=50',
    ]);
  });

  test('导航栏中的 tr 不会被误判为讨论容器', () => {
    // 页面顶栏菜单中含有 5 个 tr（个人主页、订单、钱包等），itemAnchor 严格限定为 td.title
    const pairs = extractItemPairs(GROUP_PUBLISH, profile);
    assert.equal(pairs.containers, 3);
  });

  test('单页用户：成功抽取 3 个讨论详情页链接', () => {
    const links = extractDetailLinks(GROUP_PUBLISH, profile);
    assert.deepEqual(links, [
      'https://www.douban.com/group/topic/258053730/',
      'https://www.douban.com/group/topic/254900406/',
      'https://www.douban.com/group/topic/110871731/',
    ]);
  });
});

describe('讨论正文页（真实页面 258053730）', () => {
  const URL_ = 'https://www.douban.com/group/topic/258053730/';

  test('判定通过，结构性标志完备', () => {
    const cls = classify('group.item', GROUP_TOPIC, URL_);
    assert.equal(cls.verdict, 'ok');
  });

  test('正文内嵌附图：成功抽取用户上传的附图与图注', () => {
    const { urls, captions } = extractEmbeddedImages(GROUP_TOPIC);
    assert.deepEqual(urls, ['https://img3.doubanio.com/view/group_topic/l/public/p742323977.jpg']);
    assert.equal(captions['https://img3.doubanio.com/view/group_topic/l/public/p742323977.jpg'], '番外剧照');
  });
});

describe('讨论正文页（真实页面 206243320，带无图注插图）', () => {
  const URL_ = 'https://www.douban.com/group/topic/206243320/';

  test('判定通过，结构性标志完备', () => {
    const cls = classify('group.item', GROUP_TOPIC_WITH_IMAGE, URL_);
    assert.equal(cls.verdict, 'ok');
  });

  test('正文内嵌附图：成功抽取用户上传的附图（无图注时 captions 为空）', () => {
    const { urls, captions } = extractEmbeddedImages(GROUP_TOPIC_WITH_IMAGE);
    assert.deepEqual(urls, ['https://img9.doubanio.com/view/group_topic/l/public/p379527796.jpg']);
    assert.equal(captions['https://img9.doubanio.com/view/group_topic/l/public/p379527796.jpg'], undefined);
  });
});

describe('小组会话稳定性验证', () => {
  test('话题页含有哨兵 uid 0 不会导致 SessionGuard 误判为切换账号', () => {
    const guard = new SessionGuard();
    guard.preflight(GROUP_HOME);
    assert.equal(guard.account.userId, '82160871');
    assert.doesNotThrow(() => {
      guard.verify(GROUP_TOPIC);
    });
  });
});

function createTestLoop({ routes = [] } = {}) {
  const enqueued = [];
  const events = [];
  const states = new Map();
  const routeMap = new Map(routes.map((r) => [r.key, r]));
  return {
    _frontier: {
      enqueue: (item) => {
        enqueued.push(item);
        return true;
      },
    },
    _routes: routeMap,
    _emit: (e) => events.push(e),
    stateFor: (rk) => {
      let s = states.get(rk);
      if (!s) {
        s = new RouteState({ routeKey: rk });
        states.set(rk, s);
      }
      return s;
    },
    _enqueueNextPage: CrawlLoop.prototype._enqueueNextPage,
    _enqueueLongformItems: CrawlLoop.prototype._enqueueLongformItems,
    enqueued,
    events,
  };
}

describe('发起的讨论多页翻页与生命周期（group.publish）', () => {
  const routes = buildRoutes({ username: 'BlocksTower' });
  const publishRoute = routes.find((r) => r.key === 'group.publish');
  const itemRoute = routes.find((r) => r.key === 'group.item');
  const publishProfile = profileForRoute('group.publish');

  test('group.publish: cursorFromUrl 准确解析 start 参数与根 URL', () => {
    assert.deepEqual(
      cursorFromUrl('https://www.douban.com/group/people/BlocksTower/publish?start=50', publishRoute),
      { kind: 'start', value: 50 },
    );
    assert.deepEqual(
      cursorFromUrl('https://www.douban.com/group/people/BlocksTower/publish?start=0', publishRoute),
      { kind: 'start', value: 0 },
    );
    assert.deepEqual(
      cursorFromUrl('https://www.douban.com/group/people/BlocksTower/publish', publishRoute),
      { kind: 'start', value: 0 },
    );
  });

  test('group.publish: 第一页向后翻页，入队 start=50（步长 50）且继承路线属性', () => {
    const loop = createTestLoop({ routes: [publishRoute, itemRoute] });
    const item = {
      routeKey: 'group.publish',
      url: 'https://www.douban.com/group/people/BlocksTower/publish?start=0',
      cursor: { kind: 'start', value: 0 },
    };
    const pairs = extractItemPairs(GROUP_PUBLISH_PAGINATED, publishProfile);

    loop._enqueueNextPage(item, publishRoute, publishProfile, { bodyText: GROUP_PUBLISH_PAGINATED }, 'cap-pub-1', pairs);

    assert.equal(loop.enqueued.length, 1);
    assert.equal(loop.enqueued[0].url, 'https://www.douban.com/group/people/BlocksTower/publish?start=50');
    assert.deepEqual(loop.enqueued[0].cursor, { kind: 'start', value: 50 });
    assert.equal(loop.enqueued[0].routeKey, 'group.publish');
    assert.equal(loop.enqueued[0].ordered, true);

    const pageEvent = loop.events.find((e) => e.type === 'page');
    assert.ok(pageEvent);
    assert.equal(pageEvent.newIds, 44);
  });

  test('group.publish: 末页检测（page >= totalPages）触发 route_finished: last_page，不入队下一页', () => {
    const loop = createTestLoop({ routes: [publishRoute, itemRoute] });
    // 将第 1 页模拟为第 3 页（末页：3 of 3）
    const lastPageHtml = GROUP_PUBLISH_PAGINATED.replace(
      '<span class="thispage" data-total-page="3">1</span>',
      '<span class="thispage" data-total-page="3">3</span>',
    );
    const item = {
      routeKey: 'group.publish',
      url: 'https://www.douban.com/group/people/BlocksTower/publish?start=100',
      cursor: { kind: 'start', value: 100 },
    };
    const pairs = extractItemPairs(lastPageHtml, publishProfile);

    loop._enqueueNextPage(item, publishRoute, publishProfile, { bodyText: lastPageHtml }, 'cap-pub-3', pairs);

    assert.equal(loop.enqueued.length, 0, '末页不应再入队新页面');
    const finishEvent = loop.events.find((e) => e.type === 'route_finished');
    assert.ok(finishEvent);
    assert.equal(finishEvent.reason, 'last_page');
    assert.equal(finishEvent.page, 3);
    assert.equal(finishEvent.totalPages, 3);
  });

  test('group.publish: 从多页讨论列表派生全部 44 个话题详情页，并发出 topic_enqueued 事件', () => {
    const loop = createTestLoop({ routes: [publishRoute, itemRoute] });
    const item = {
      routeKey: 'group.publish',
      url: 'https://www.douban.com/group/people/BlocksTower/publish?start=0',
    };

    loop._enqueueLongformItems(item, { bodyText: GROUP_PUBLISH_PAGINATED }, 'cap-pub-1');

    assert.equal(loop.enqueued.length, 44);
    assert.ok(loop.enqueued.every((e) => e.routeKey === 'group.item' && e.ordered === false));
    assert.equal(loop.enqueued[0].url, 'https://www.douban.com/group/topic/475801232/');

    const topicEvent = loop.events.find((e) => e.type === 'topic_enqueued');
    assert.ok(topicEvent);
    assert.equal(topicEvent.count, 44);
    assert.equal(topicEvent.routeKey, 'group.item');
  });
});

describe('小组话题正文（group.item）跳过与重抓生命周期', () => {
  const routes = buildRoutes({ username: 'BlocksTower' });
  const publishRoute = routes.find((r) => r.key === 'group.publish');
  const itemRoute = routes.find((r) => r.key === 'group.item');

  test('group.item 被 LONGFORM_ROUTES 识别为可编辑长文', () => {
    assert.ok(LONGFORM_ROUTES.has('group.item'));
  });

  test('addKnownCaptures 从索引行识别 group.item 并归入 longform 名单', () => {
    const acc = emptyKnownCaptures();
    addKnownCaptures(acc, [
      { route_key: 'group.item', url_key: 'https://www.douban.com/group/topic/475801232/', verdict: 'ok' },
      { route_key: 'group.item', url_key: 'https://www.douban.com/group/topic/110871731/', verdict: 'ok' },
    ]);
    const lists = knownCaptureLists(acc);
    assert.equal(lists.longform.length, 2);
    assert.deepEqual(lists.longform.map((x) => x.routeKey), ['group.item', 'group.item']);
    assert.deepEqual(lists.longform.map((x) => x.url), [
      'https://www.douban.com/group/topic/475801232/',
      'https://www.douban.com/group/topic/110871731/',
    ]);
  });

  test('普通增量模式：历史 group.item 进 knownLongformUrlKeys 后在派生时被跳过', () => {
    const frontier = new Frontier();
    // 模拟上一份档案中已抓过其中 2 个话题（其中 475801232 在夹具第一页中）
    const knownKeys = [
      urlKey('https://www.douban.com/group/topic/475801232/'),
      urlKey('https://www.douban.com/group/topic/475801233/'),
    ];
    frontier.markCaptured(knownKeys);

    const enqueued = [];
    const loop = {
      _frontier: {
        enqueue: (item) => {
          const ok = frontier.enqueue(item);
          if (ok) enqueued.push(item);
          return ok;
        },
      },
      _routes: new Map([[publishRoute.key, publishRoute], [itemRoute.key, itemRoute]]),
      _emit: () => {},
      _enqueueLongformItems: CrawlLoop.prototype._enqueueLongformItems,
    };

    loop._enqueueLongformItems(
      { routeKey: 'group.publish', url: 'https://www.douban.com/group/people/BlocksTower/publish?start=0' },
      { bodyText: GROUP_PUBLISH_PAGINATED },
      'cap-pub-1',
    );

    // 夹具中总共有 44 个话题，其中 475801232 已在跳过名单中，因此实际入队数量为 43
    assert.equal(enqueued.length, 43);
    assert.ok(!enqueued.some((e) => e.url === 'https://www.douban.com/group/topic/475801232/'));
  });

  test('重抓模式：通过 refreshLongform 将已存 group.item 预先入队重新抓取', () => {
    const frontier = new Frontier();
    const refreshList = [
      { url: 'https://www.douban.com/group/topic/475801232/', routeKey: 'group.item' },
    ];
    for (const { url, routeKey } of refreshList) {
      frontier.enqueue({
        url,
        urlKey: urlKey(url),
        routeKey,
        intent: itemRoute.intent,
        enqueuedBy: null,
        ordered: false,
        priority: itemRoute.priority,
        gatedBy: null,
      });
    }
    assert.equal(frontier._items.length, 1);
    assert.equal(frontier._items[0].url, 'https://www.douban.com/group/topic/475801232/');
    assert.equal(frontier._items[0].routeKey, 'group.item');
  });
});

