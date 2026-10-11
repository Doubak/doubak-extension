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
} from '../src/crawl/classifier.js';
import { buildRoutes, PRIORITY } from '../src/crawl/routes.js';
import { routeName } from '../src/ui/route-names.js';

const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf-8');

const GROUP_HOME = fixture('group-home.html');
const GROUP_JOINS = fixture('group-joins.html');
const GROUP_JOINS_MANAGER = fixture('group-joins-manager.html');
const GROUP_PUBLISH = fixture('group-publish.html');
const GROUP_PUBLISH_PAGINATED = fixture('group-publish-paginated.html');

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

  test('三条路线均已注册且优先级符合设计', () => {
    assert.ok(homeRoute, '缺少 group.overview');
    assert.ok(joinsRoute, '缺少 group.joins');
    assert.ok(publishRoute, '缺少 group.publish');

    assert.equal(homeRoute.intent, 'group.overview');
    assert.equal(joinsRoute.intent, 'group.joins');
    assert.equal(publishRoute.intent, 'group.publish');

    assert.ok(homeRoute.priority > PRIORITY.LONGFORM);
    assert.ok(joinsRoute.priority > PRIORITY.LONGFORM);
    assert.ok(publishRoute.priority > PRIORITY.LONGFORM);
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
    const cls = classify('group.publish', GROUP_PUBLISH_PAGINATED, URL_);
    assert.equal(cls.verdict, 'ok');
    assert.equal(cls.itemCount, 44);
  });

  test('多页讨论：成功抽取第 1 页共 3 页的分页信息', () => {
    const pg = extractPagination(GROUP_PUBLISH_PAGINATED, profile);
    assert.deepEqual(pg, { page: 1, totalPages: 3 });
  });

  test('导航栏中的 tr 不会被误判为讨论容器', () => {
    // 页面顶栏菜单中含有 5 个 tr（个人主页、订单、钱包等），itemAnchor 严格限定为 td.title
    const pairs = extractItemPairs(GROUP_PUBLISH, profile);
    assert.equal(pairs.containers, 3);
  });
});
