/**
 * 个人相册两条路线（相册列表与单相册视图），对着真实页面验。
 *
 * 夹具来自真实账号 elmsley：
 * - `photos-home.html`: 个人相册列表（声称 112 个，本页 18 个）
 * - `photos-album.html`: 单个相册视图（声称 1055 张，本页 18 张，共 59 页）
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  profileForRoute,
  classifyResponse,
  extractDetailLinks,
  extractItemPairs,
  extractClaimedCount,
  extractPagination,
} from '../src/crawl/classifier.js';
import { buildRoutes, PRIORITY } from '../src/crawl/routes.js';
import { routeName } from '../src/ui/route-names.js';

const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf-8');

const PHOTOS_HOME = fixture('photos-home.html');
const PHOTOS_ALBUM = fixture('photos-album.html');

const classify = (key, html, url) =>
  classifyResponse({
    finalUrl: url,
    status: 200,
    bodyText: html,
    route: profileForRoute(key),
    sizeStats: null,
  });

describe('相册：路线定义', () => {
  const routes = buildRoutes({ username: 'elmsley' });
  const listRoute = routes.find((r) => r.key === 'photo.album_list');
  const itemRoute = routes.find((r) => r.key === 'photo.album');

  test('两条路线均已注册且优先级高于标记列表', () => {
    assert.ok(listRoute, '缺少 photo.album_list');
    assert.ok(itemRoute, '缺少 photo.album');
    assert.equal(listRoute.intent, 'photo.album_list');
    assert.equal(itemRoute.intent, 'photo.album');
    assert.ok(listRoute.priority < PRIORITY.INTERESTS);
    assert.ok(itemRoute.priority < PRIORITY.INTERESTS);
  });

  test('相册列表路线带 entryUrl 与 18 步长分页', () => {
    assert.equal(listRoute.entryUrl({ offset: 0 }), 'https://www.douban.com/people/elmsley/photos?start=0');
    assert.deepEqual(listRoute.pagination, { kind: 'start', step: 18, first: 0 });
  });

  test('单个相册路线没有 entryUrl，通过 nextPageUrl 翻页', () => {
    assert.equal(itemRoute.entryUrl, undefined);
    assert.equal(itemRoute.ordered, false, '相册集合不应被判为有序');
    assert.deepEqual(itemRoute.pagination, { kind: 'start', step: 18, first: 0 });

    const next = itemRoute.nextPageUrl({ url: 'https://www.douban.com/photos/album/100276481/' }, 18);
    assert.equal(next, 'https://www.douban.com/photos/album/100276481/?m_start=18');
  });

  test('nextPageUrl 遇到非相册 URL 返回 null', () => {
    assert.equal(itemRoute.nextPageUrl({ url: 'https://www.douban.com/people/elmsley/' }, 18), null);
    assert.equal(itemRoute.nextPageUrl({}, 18), null);
    assert.equal(itemRoute.nextPageUrl({ url: '' }, 0), null);
  });

  test('界面中文名称正确', () => {
    assert.equal(routeName('photo.album_list'), '相册');
    assert.equal(routeName('photo.album'), '相册内容');
  });
});

describe('相册列表页（真实页面 elmsley）', () => {
  const URL_ = 'https://www.douban.com/people/elmsley/photos?start=0';
  const profile = profileForRoute('photo.album_list');

  test('判定通过，条目数为 18', () => {
    const cls = classify('photo.album_list', PHOTOS_HOME, URL_);
    assert.equal(cls.verdict, 'ok');
    assert.equal(cls.itemCount, 18);
  });

  test('声称相册总数正确读出为 112', () => {
    const claimed = extractClaimedCount(PHOTOS_HOME, profile);
    assert.ok(claimed);
    assert.equal(claimed.count, 112);
  });

  test('分页器读出为第 1 页，共 7 页', () => {
    const pg = extractPagination(PHOTOS_HOME, profile);
    assert.deepEqual(pg, { page: 1, totalPages: 7 });
  });

  test('抽出 18 个相册详情页链接，且格式规范', () => {
    const links = extractDetailLinks(PHOTOS_HOME, profile);
    assert.equal(links.length, 18);
    assert.ok(links.every((u) => /^https:\/\/www\.douban\.com\/photos\/album\/\d+\/$/.test(u)));
    assert.equal(links[0], 'https://www.douban.com/photos/album/100276481/');
  });

  test('成对抽出 18 个相册 ID 与对应更新/创建日期', () => {
    const pairs = extractItemPairs(PHOTOS_HOME, profile);
    assert.equal(pairs.ids.length, 18);
    assert.equal(pairs.times.length, 18);
    assert.equal(pairs.idless, 0);
    assert.equal(pairs.ids[0], '100276481');
    assert.equal(pairs.times[0], '2025-02-09');
  });
});

describe('相册照片页（真实页面 100276481）', () => {
  const URL_ = 'https://www.douban.com/photos/album/100276481/?m_start=0';
  const profile = profileForRoute('photo.album');

  test('判定通过，照片条目数为 18', () => {
    const cls = classify('photo.album', PHOTOS_ALBUM, URL_);
    assert.equal(cls.verdict, 'ok');
    assert.equal(cls.itemCount, 18);
  });

  test('声称照片总数读出为 1055', () => {
    const claimed = extractClaimedCount(PHOTOS_ALBUM, profile);
    assert.ok(claimed);
    assert.equal(claimed.count, 1055);
  });

  test('分页器读出为第 1 页，共 59 页', () => {
    const pg = extractPagination(PHOTOS_ALBUM, profile);
    assert.deepEqual(pg, { page: 1, totalPages: 59 });
  });

  test('成对抽出 18 个照片 ID，时间为 null', () => {
    const pairs = extractItemPairs(PHOTOS_ALBUM, profile);
    assert.equal(pairs.ids.length, 18);
    assert.equal(pairs.times.length, 18);
    assert.equal(pairs.idless, 0);
    assert.ok(pairs.times.every((t) => t === null));
    assert.equal(pairs.ids[0], '2918226736');
  });
});
