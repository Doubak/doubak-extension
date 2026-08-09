/**
 * 作品详情页的去重，以及「同一个 URL 被抓两次」时写入端撑不撑得住。
 *
 * ## 为什么会抓两次
 *
 * 一部电影可以同时出现在两张列表上——刚看完，「看过」里有了，「想看」里还没删。
 * 两张列表都会派生出同一个作品详情页。
 *
 * 同一次会话里 frontier 按 `url_key` 全局去重，所以只抓一次。但 checkpoint
 * **只保留未完成的条目**（已完成的在 index 里，重复记录会带来两个可能不一致的
 * 真相来源），于是崩溃恢复之后去重集合里没有那些已抓完的 URL——只要有一张列表页
 * 在崩溃时正好在飞，恢复后重抓它，它派生的作品详情页就会被再抓一遍。
 *
 * ## 结论：重抓是安全的，不必去消除它
 *
 * 规范要求 `capture_id` 唯一，**不要求 URL 唯一**——同一个 URL 的多次捕获正是
 * WARC 存在的理由（重抓、内容随时间变化）。而两次捕获之间豆瓣页面**可能真的变了**
 * （评分、短评），两份都留着比只留一份更符合「捕获更多而非更少」。
 *
 * 所以这组测试钉的是「重抓不会把档案写坏」，而不是「永远不重抓」。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Frontier } from '../src/crawl/frontier.js';
import { extractSubjectLinks } from '../src/crawl/classifier.js';
import { urlKey } from '../src/core/urlkey.js';
import { BundleWriter } from '../src/bundle/bundle-writer.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { BundleReader } from '../src/bundle/bundle-reader.js';
import { TEST_PRODUCER } from './helpers/producer.js';

const enc = new TextEncoder();
const BUNDLE_ID = '20260731T000000Z-abcdef';

const subjectItem = (url) => ({
  url,
  urlKey: urlKey(url),
  routeKey: 'interest.item',
  intent: 'interest.item',
  ordered: false,
  priority: 90,
});

describe('同一次会话里：一部电影在两张列表上，只抓一次', () => {
  test('「想看」和「看过」派生出同一个 url_key', () => {
    const wish = '<a href="https://movie.douban.com/subject/1292052/">肖申克</a>';
    // 列表页上的链接常带跟踪参数，`url_key` 会剥掉
    const collect = '<a href="https://movie.douban.com/subject/1292052/?from=mine">肖申克</a>';

    const a = extractSubjectLinks(wish)[0];
    const b = extractSubjectLinks(collect)[0];
    assert.ok(a && b);
    assert.equal(urlKey(a), urlKey(b), '跟踪参数不该让同一部电影被当成两部');
  });

  test('第二次入队被挡掉', () => {
    const f = new Frontier();
    const u = 'https://movie.douban.com/subject/1292052/';
    assert.equal(f.enqueue(subjectItem(u)), true);
    assert.equal(f.enqueue(subjectItem(u)), false, '同一部电影不该排两次队');
    assert.equal(f.counts().pending, 1);
  });

  test('去重是全局的，不分是哪条列表派生的', () => {
    // `interest.item` 只有一条路线，所有媒介的作品详情页都进它。
    const f = new Frontier();
    f.enqueue({ ...subjectItem('https://movie.douban.com/subject/1/'), enqueuedBy: 'cap-wish' });
    const again = f.enqueue({
      ...subjectItem('https://movie.douban.com/subject/1/'), enqueuedBy: 'cap-collect',
    });
    assert.equal(again, false);
  });
});

describe('跨恢复：去重集合会丢，所以重抓是可达的', () => {
  test('抓完的条目不进 checkpoint，于是恢复后能再次入队', () => {
    // 这条测试记录的是**现状与它的理由**，不是缺陷。
    // checkpoint 只留未完成的条目是刻意的：已完成的在 index 里，重复记录会带来
    // 两个可能不一致的真相来源。代价就是跨恢复去重不住——而重抓是安全的（见下）。
    const f = new Frontier();
    const u = 'https://movie.douban.com/subject/1292052/';
    f.enqueue(subjectItem(u));
    f.settle(f.next(), 'ok');

    const surviving = f.snapshot().filter((it) => it.state !== 'done');
    assert.deepEqual(surviving, [], '抓完的不会进 checkpoint');

    const restored = new Frontier();
    for (const it of surviving) restored.enqueue(it);
    assert.equal(restored.enqueue(subjectItem(u)), true, '恢复之后它会被重新排队');
  });
});

describe('重抓写进档案：capture_id 唯一，URL 不必唯一', () => {
  /** 把同一个 URL 写两遍。 */
  async function writeTwice() {
    const store = new MemoryFileStore();
    const writer = new BundleWriter({ producer: TEST_PRODUCER,
      store,
      bundleId: BUNDLE_ID,
      account: { user_id: '82160871', username: 'example' },
      now: () => new Date('2026-07-31T00:00:00Z'),
    });
    const url = 'https://movie.douban.com/subject/20495023/';
    const common = {
      url,
      intent: 'interest.item',
      routeKey: 'interest.item',
      surface: 'html',
      verdict: 'ok',
      captureFidelity: 'decoded_body+observed_headers',
      httpStatus: 200,
      headers: [['Content-Type', 'text/html; charset=utf-8']],
      contentType: 'text/html; charset=utf-8',
      kind: 'catalog',
      itemCount: null,
    };
    const first = await writer.writeCapture({
      ...common, body: enc.encode('<html><h1>银翼杀手 2049</h1></html>'),
    });
    // 第二次抓到的内容**不一样**——用户刚标了「看过」并打了分。
    const second = await writer.writeCapture({
      ...common, body: enc.encode('<html><h1>银翼杀手 2049</h1><span>5 星</span></html>'),
    });
    const manifest = await writer.finalize();
    return { store, writer, manifest, first, second, url };
  }

  test('两次捕获拿到不同的 capture_id', async () => {
    const { first, second } = await writeTwice();
    assert.notEqual(first.captureId, second.captureId);
  });

  test('两条 index 记录都在，各自指向自己的字节', async () => {
    const { store } = await writeTwice();
    const reader = await BundleReader.open(store, BUNDLE_ID);
    const rows = (await reader.index()).filter((e) => e.url.includes('/subject/20495023/'));
    assert.equal(rows.length, 2, '两次捕获都要留在索引里');
    assert.notEqual(rows[0].offset, rows[1].offset);
    assert.notEqual(rows[0].capture_id, rows[1].capture_id);
    assert.notEqual(rows[0].content_sha256, rows[1].content_sha256, '内容不同，摘要就该不同');
    // url_key 相同是**对的**：它标识的是「哪个页面」，不是「哪次捕获」。
    assert.equal(rows[0].url_key, rows[1].url_key);
  });

  test('两条记录都能从段里取回来，内容各是各的', async () => {
    const { store } = await writeTwice();
    const reader = await BundleReader.open(store, BUNDLE_ID);
    const rows = (await reader.index()).filter((e) => e.url.includes('/subject/20495023/'));
    const bodies = [];
    for (const r of rows) bodies.push((await reader.readEntry(r)).bodyText);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].includes('5 星'), false, '第一次抓的时候还没打分');
    assert.equal(bodies[1].includes('5 星'), true, '第二次抓到的是打分之后的页面');
  });

  test('「验一验」对两条记录都能通过 —— 重抓不会让校验失败', async () => {
    const { store } = await writeTwice();
    const reader = await BundleReader.open(store, BUNDLE_ID);
    const r = await reader.verify();
    assert.equal(r.checked, 2);
    assert.equal(r.ok, 2, JSON.stringify(r.problems));
    assert.deepEqual(r.problems, []);
  });

  test('manifest 的记录数把两次都算上', async () => {
    const { manifest } = await writeTwice();
    const total = manifest.segments.reduce((n, s) => n + s.record_count, 0);
    assert.equal(total, 2);
  });
});
