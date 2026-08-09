import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { BundleReader } from '../src/bundle/bundle-reader.js';
import { BundleWriter } from '../src/bundle/bundle-writer.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { coverageEntry, crawlStateEntry } from '../src/bundle/manifest-builder.js';
import { TEST_PRODUCER } from './helpers/producer.js';

const enc = new TextEncoder();

/** 写一个有内容的 bundle，然后读回来。 */
async function roundTrip({ withEvidence = false } = {}) {
  const store = new MemoryFileStore();
  const writer = new BundleWriter({ producer: TEST_PRODUCER,
    store,
    account: { user_id: '82160871', username: 'mewcatcher' },
  });

  const html = await writer.writeCapture({
    url: 'https://www.douban.com/people/82160871/statuses?p=1',
    intent: 'broadcast.timeline',
    routeKey: 'broadcast.timeline',
    surface: 'html',
    verdict: 'ok',
    captureFidelity: 'decoded_body+observed_headers',
    httpStatus: 200,
    headers: [['Content-Type', 'text/html; charset=utf-8']],
    contentType: 'text/html; charset=utf-8',
    body: enc.encode('<html><body>看过《银翼杀手》，很好。</body></html>'),
  });

  const img = await writer.writeCapture({
    url: 'https://img9.doubanio.com/x.jpg',
    intent: 'asset.image.user_upload',
    routeKey: 'broadcast.timeline',
    surface: 'html',
    verdict: 'ok',
    captureFidelity: 'decoded_body+observed_headers',
    httpStatus: 200,
    headers: [['Content-Type', 'image/jpeg']],
    contentType: 'image/jpeg',
    kind: 'assets',
    body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  });

  const blocked = await writer.writeCapture({
    url: 'https://www.douban.com/people/82160871/statuses?p=2',
    intent: 'broadcast.timeline',
    routeKey: 'broadcast.timeline',
    surface: 'html',
    verdict: 'blocked',
    captureFidelity: 'decoded_body+observed_headers',
    httpStatus: 200,
    headers: [['Content-Type', 'text/html']],
    body: enc.encode('<html>访问过于频繁</html>'),
  });

  if (withEvidence) {
    writer.addCoverage(
      coverageEntry({
        routeKey: 'broadcast.timeline',
        intent: 'broadcast.timeline',
        claimedCount: null,
        capturedCount: 2,
      }),
    );
    writer.addCrawlState(
      crawlStateEntry({
        routeKey: 'broadcast.timeline',
        intent: 'broadcast.timeline',
        highWaterTime: '2026-07-26T12:34:00+08:00',
        floorTime: null,
        enumeration: 'bounded',
        contiguous: true,
        advanced: true,
        bundleId: writer.bundleId,
      }),
    );
  }

  await writer.finalize();
  const reader = await BundleReader.open(store, writer.bundleId);
  return { store, writer, reader, ids: { html: html.captureId, img: img.captureId, blocked: blocked.captureId } };
}

describe('顺着 index 把字节取回来', () => {
  test('这条路径就是规范承诺第三方能走的那条', async () => {
    const { reader, ids } = await roundTrip();
    const r = await reader.readCapture(ids.html);

    assert.match(r.warcRecord, /^WARC\/1\.1/);
    assert.equal(r.status, 'HTTP/1.1 200');
    assert.match(r.bodyText, /看过《银翼杀手》/);
  });

  test('中文正文按字节切，不按字符', async () => {
    // 中文一个字符占三个字节，按字符切会错位——这是最容易犯的一个错。
    const { reader, ids } = await roundTrip();
    const r = await reader.readCapture(ids.html);
    assert.equal(r.bodyText, '<html><body>看过《银翼杀手》，很好。</body></html>');
  });

  test('二进制载荷原样取回', async () => {
    const { reader, ids } = await roundTrip();
    const r = await reader.readCapture(ids.img);
    assert.deepEqual([...r.body], [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  });

  test('响应头能解出来', async () => {
    const { reader, ids } = await roundTrip();
    const r = await reader.readCapture(ids.html);
    const ct = r.headers.find(([k]) => k.toLowerCase() === 'content-type');
    assert.match(ct[1], /text\/html/);
  });

  test('索引里没有的 capture_id 明确报错', async () => {
    const { reader } = await roundTrip();
    await assert.rejects(() => reader.readCapture('不存在'), /索引里没有/);
  });
});

describe('验一验：不信声明，直接去段文件里取字节', () => {
  test('自洽的档案全部通过', async () => {
    const { reader } = await roundTrip();
    const v = await reader.verify();
    assert.equal(v.checked, 3);
    assert.equal(v.ok, 3);
    assert.deepEqual(v.problems, []);
  });

  test('段被改坏时能查出来', async () => {
    const { store, reader } = await roundTrip();
    // 把某个段的中间改坏
    const segs = (await store.list()).filter((f) => f.startsWith('data-'));
    const bytes = await store.read(segs[0]);
    const mid = Math.floor(bytes.length / 2);
    bytes[mid] ^= 0xff;
    bytes[mid + 1] ^= 0xff;
    await store.replace(segs[0], bytes);

    const v = await reader.verify();
    assert.ok(v.problems.length > 0, '坏掉的记录必须被查出来');
  });

  test('可以只抽查前 N 条 —— 大档案的快速检查', async () => {
    const { reader } = await roundTrip();
    const v = await reader.verify({ limit: 1 });
    assert.equal(v.checked, 1);
  });
});

describe('概览', () => {
  test('按判定与路线分组统计', async () => {
    const { reader } = await roundTrip();
    const s = await reader.summary();

    assert.equal(s.captures, 3);
    assert.equal(s.byVerdict.ok, 2);
    assert.equal(s.byVerdict.blocked, 1, '封锁页也在档案里，且如实标注');
    assert.equal(s.byRoute['broadcast.timeline'].count, 3);
    assert.ok(s.totalBytes > 0);
  });

  test('刻意不给百分比', async () => {
    // 豆瓣的计数不可信，完整性看 crawl_state 里的连续性证明，
    // 不是「抓到的条数 ÷ 声称的条数」。
    const { reader } = await roundTrip({ withEvidence: true });
    const s = await reader.summary();
    assert.ok(!('percent' in s));
    assert.ok(!('completeness' in s));
    assert.equal(s.crawlState[0].contiguous, true, '完整性看这个');
  });

  test('带出 coverage 与 crawl_state 供界面显示', async () => {
    const { reader } = await roundTrip({ withEvidence: true });
    const s = await reader.summary();

    assert.equal(s.coverage.length, 1);
    assert.equal(s.coverage[0].claimed_count, null, 'null 与 0 是两件事');
    assert.equal(s.crawlState[0].advanced, true);
  });

  test('账号与档案编号', async () => {
    const { reader, writer } = await roundTrip();
    const s = await reader.summary();
    assert.equal(s.bundleId, writer.bundleId);
    assert.equal(s.account.user_id, '82160871');
    assert.equal(s.status, 'complete');
  });
});

describe('拒绝含糊', () => {
  test('目录里没有 manifest 就明确说不是 bundle', async () => {
    const store = new MemoryFileStore();
    const reader = new BundleReader({ store, bundleId: '20260729T101500Z-a3f9c1' });
    await assert.rejects(() => reader.manifest(), /不是一个 bundle/);
  });

  test('index 有坏行时抛错，不静默跳过', async () => {
    // 一行读不出来意味着索引与段文件可能已经失去对应关系，
    // 那是必须让人知道的事。
    const { store, writer } = await roundTrip();
    const name = `index-${writer.bundleId}.ndjson`;
    const text = new TextDecoder().decode(await store.read(name));
    await store.replace(name, enc.encode(text + '{ 这不是 JSON\n'));

    const reader = new BundleReader({ store, bundleId: writer.bundleId });
    await assert.rejects(() => reader.index(), /无法解析/);
  });

  test('没有 index 文件时返回空，不抛', async () => {
    // 刚开始的空档案是正常状态。
    const store = new MemoryFileStore();
    const writer = new BundleWriter({ producer: TEST_PRODUCER, store, account: { user_id: '1' } });
    await writer.finalize();
    const reader = new BundleReader({ store, bundleId: writer.bundleId });
    assert.deepEqual(await reader.index(), []);
  });
});

describe('进行中的档案（还没有 manifest）', () => {
  test('summary 照样能给出概览，不报「不是一个 bundle」', async () => {
    // `manifest.json` 只在 finalize() 时写一次，所以**整个抓取过程中它都不存在**
    // ——而抓取要跑几小时，用户一定会在那期间打开档案页。
    //
    // 早先这里直接抛「这个目录里没有 manifest.json，不是一个 bundle」。那句话对
    // 正在写的档案是错的，而且听起来像档案坏了——最糟的一种误报：它会让用户以为
    // 几小时的抓取白费，甚至去删掉一份其实完好的档案。
    const { store, writer } = await roundTrip();
    const bundleId = writer.bundleId;
    await store.remove('manifest.json');

    const reader = new BundleReader({ store, bundleId });
    const s = await reader.summary();

    assert.equal(s.hasManifest, false);
    assert.equal(s.status, 'in_progress');
    assert.equal(s.bundleId, bundleId, '编号退回到构造时传入的');
    assert.ok(s.captures > 0, 'index 每页都落盘，条数是准的');
  });

  test('拿不到的字段如实给 null，不编', async () => {
    const { store, writer } = await roundTrip();
    const bundleId = writer.bundleId;
    await store.remove('manifest.json');
    const s = await new BundleReader({ store, bundleId }).summary();

    assert.equal(s.account, null);
    assert.equal(s.createdAt, null);
    assert.equal(s.completedAt, null);
    // 覆盖率证据是收尾时才攒的。给空数组而不是编一个，免得界面显示出一份看起来
    // 很完整的假证据。
    assert.deepEqual(s.coverage, []);
    assert.deepEqual(s.crawlState, []);
    assert.deepEqual(s.segments, []);
  });

  test('体积是下界，且标明它不精确', async () => {
    // 段文件里除了记录还有 gzip 头尾。宁可少报也不多报——多报会让用户以为已经
    // 抓了更多东西。
    const { store, writer } = await roundTrip();
    const bundleId = writer.bundleId;
    const withManifest = await new BundleReader({ store, bundleId }).summary();
    await store.remove('manifest.json');
    const without = await new BundleReader({ store, bundleId }).summary();

    assert.equal(withManifest.totalBytesExact, true);
    assert.equal(without.totalBytesExact, false);
    assert.ok(without.totalBytes > 0);
    assert.ok(without.totalBytes <= withManifest.totalBytes, '估值不该超过真值');
  });

  test('manifest() 本身仍然严格 —— 不完整的目录不许冒充 bundle', async () => {
    const { store, writer } = await roundTrip();
    const bundleId = writer.bundleId;
    await store.remove('manifest.json');
    await assert.rejects(() => new BundleReader({ store, bundleId }).manifest(), /不是一个 bundle/);
  });

  test('逐条取出并解压在没有 manifest 时照样能跑', async () => {
    // 「验一验」在抓取进行中也该能用：它走的是 index → 段文件那条路，与 manifest
    // 无关。
    const { store, writer } = await roundTrip();
    const bundleId = writer.bundleId;
    await store.remove('manifest.json');
    const v = await new BundleReader({ store, bundleId }).verify();
    assert.equal(v.problems.length, 0);
    assert.ok(v.checked > 0);
  });
});

describe('摘要要说清这一份接在谁后面', () => {
  test('增量档案带 previousBundleId', async () => {
    // 增量档案的「捕获条数」只有新增的那些，看起来会小得离谱。界面要靠这个字段
    // 说清那是正常的——否则用户会以为抓漏了。
    const store = new MemoryFileStore();
    const w = new BundleWriter({ producer: TEST_PRODUCER,
      store,
      bundleId: '20260815T000000Z-bbbbbb',
      previousBundleId: '20260731T000000Z-aaaaaa',
      account: { user_id: '1', username: 'e' },
      now: () => new Date('2026-08-15T00:00:00Z'),
    });
    await w.finalize();

    const s = await new BundleReader({ store, bundleId: '20260815T000000Z-bbbbbb' }).summary();
    assert.equal(s.previousBundleId, '20260731T000000Z-aaaaaa');
  });

  test('全量档案是 null，不是 undefined —— 界面要能直接判', async () => {
    const store = new MemoryFileStore();
    const w = new BundleWriter({ producer: TEST_PRODUCER,
      store, bundleId: '20260731T000000Z-aaaaaa',
      account: { user_id: '1', username: 'e' }, now: () => new Date('2026-07-31T00:00:00Z'),
    });
    await w.finalize();
    const s = await new BundleReader({ store, bundleId: '20260731T000000Z-aaaaaa' }).summary();
    assert.equal(s.previousBundleId, null);
  });
});
