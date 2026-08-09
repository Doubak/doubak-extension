import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryFileStore } from '../src/storage/file-store.js';
import { BundleWriter, renderReadme } from '../src/bundle/bundle-writer.js';
import { SPEC_VERSION } from '../src/core/spec-constants.js';
import { coverageEntry, crawlStateEntry } from '../src/bundle/manifest-builder.js';
import { gunzip } from '../src/core/warc.js';
import { parseCaptureId, indexFilename } from '../src/core/ids.js';
import { sha256Hex } from '../src/core/digest.js';
import { TEST_PRODUCER } from './helpers/producer.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const AT = new Date('2026-07-29T02:15:03Z');

/** @param {object} [over] */
function capture(over = {}) {
  return {
    url: 'https://www.douban.com/people/82160871/statuses?p=1&_spm_id=ODIx',
    intent: 'broadcast.timeline',
    routeKey: 'broadcast.timeline',
    surface: /** @type {const} */ ('html'),
    verdict: 'ok',
    captureFidelity: 'decoded_body+observed_headers',
    body: enc.encode('<html>看过《银翼杀手》</html>'),
    httpStatus: 200,
    headers: [['Content-Type', 'text/html; charset=utf-8']],
    contentType: 'text/html; charset=utf-8',
    ...over,
  };
}

/** @param {object} [over] */
function makeWriter(over = {}) {
  const store = new MemoryFileStore();
  const writer = new BundleWriter({ producer: TEST_PRODUCER,
    store,
    account: { user_id: '82160871', username: 'mewcatcher' },
    now: () => AT,
    ...over,
  });
  return { store, writer };
}

/** 读回 index.ndjson 的所有行。 */
async function readIndex(store, bundleId) {
  const text = dec.decode(await store.read(indexFilename(bundleId)));
  return text.trimEnd().split('\n').map((l) => JSON.parse(l));
}

describe('写入一次捕获', () => {
  test('返回的 offset/length 能取回原始 WARC 记录', async () => {
    const { store, writer } = makeWriter();
    const loc = await writer.writeCapture(capture());

    const member = await store.read(loc.segment, loc.offset, loc.length);
    const record = dec.decode(await gunzip(member));
    assert.match(record, /WARC-Type: response/);
    assert.match(record, /看过《银翼杀手》/);
    assert.match(record, /WARC-Target-URI: https:\/\/www\.douban\.com/);
  });

  test('index 行与 WARC 记录一一对应', async () => {
    const { store, writer } = makeWriter();
    const loc = await writer.writeCapture(capture());
    const [entry] = await readIndex(store, writer.bundleId);

    assert.equal(entry.capture_id, loc.captureId);
    assert.equal(entry.segment, loc.segment);
    assert.equal(entry.offset, loc.offset);
    assert.equal(entry.length, loc.length);

    const record = dec.decode(await gunzip(await store.read(loc.segment, loc.offset, loc.length)));
    assert.ok(record.includes(`<${entry.warc_record_id}>`), 'WARC 里应能找到 index 记的记录 ID');
  });

  test('url 保留跟踪参数，url_key 剥掉', async () => {
    const { store, writer } = makeWriter();
    await writer.writeCapture(capture());
    const [entry] = await readIndex(store, writer.bundleId);

    assert.match(entry.url, /_spm_id=ODIx/, 'url 是事实，原样保留');
    assert.doesNotMatch(entry.url_key, /_spm_id/, 'url_key 是索引，剥掉跟踪参数');
    assert.equal(entry.url_key_rules, 'v1');
  });

  test('content_sha256 是响应体本身的摘要', async () => {
    const { store, writer } = makeWriter();
    const body = enc.encode('特定内容');
    await writer.writeCapture(capture({ body }));
    const [entry] = await readIndex(store, writer.bundleId);
    assert.equal(entry.content_sha256, await sha256Hex(body));
  });

  test('序号从 1 开始递增', async () => {
    const { store, writer } = makeWriter();
    for (let i = 0; i < 3; i++) await writer.writeCapture(capture());
    const entries = await readIndex(store, writer.bundleId);
    assert.deepEqual(entries.map((e) => parseCaptureId(e.capture_id).seq), [1, 2, 3]);
  });

  test('崩溃恢复可从指定序号接着分配', async () => {
    const { writer } = makeWriter({ startSeq: 12043 });
    const loc = await writer.writeCapture(capture());
    assert.equal(parseCaptureId(loc.captureId).seq, 12044);
  });

  test('拒绝非 Uint8Array 的 body 与未知段类型', async () => {
    const { writer } = makeWriter();
    await assert.rejects(() => writer.writeCapture(capture({ body: '字符串' })), /Uint8Array/);
    await assert.rejects(() => writer.writeCapture(capture({ kind: 'other' })), /未知的段类型/);
  });
});

describe('落盘顺序 —— 不可调换', () => {
  test('WARC 记录先落盘，index 行后落盘', async () => {
    // 先写 index 会留下指向不存在记录的索引项，下游按 offset 读会读到
    // 一段别的东西。反过来最坏只是一条孤儿记录。
    const store = new MemoryFileStore();
    /** @type {string[]} */
    const log = [];
    const origAppend = store.append.bind(store);
    store.append = async (name, bytes) => {
      log.push(name.endsWith('.ndjson') ? 'index' : 'warc');
      return origAppend(name, bytes);
    };

    const writer = new BundleWriter({ producer: TEST_PRODUCER,
      store,
      account: { user_id: '1' },
      now: () => AT,
    });
    await writer.writeCapture(capture());
    await writer.writeCapture(capture());

    // 第一次会多一条 warcinfo 的写入
    const firstIndex = log.indexOf('index');
    assert.ok(firstIndex > 0, 'index 写入不该排在最前');
    assert.equal(log[firstIndex - 1], 'warc', 'index 之前紧邻的必须是 WARC 写入');

    // 每条 index 之前都必须有对应的 WARC 写入
    let warcSeen = 0;
    let indexSeen = 0;
    for (const op of log) {
      if (op === 'warc') warcSeen += 1;
      else {
        indexSeen += 1;
        assert.ok(warcSeen >= indexSeen, 'WARC 写入必须先于对应的 index 行');
      }
    }
  });

  test('index 校验失败时 WARC 已写入但 index 没有 —— 留下的是孤儿记录', async () => {
    // 这是刻意接受的失败模式：孤儿记录只是浪费空间，悬空索引才是灾难。
    const { store, writer } = makeWriter();
    await assert.rejects(() => writer.writeCapture(capture({ verdict: '瞎写的' })), /verdict/);

    const files = await store.list();
    assert.ok(files.some((f) => f.endsWith('.warc.gz')), '段文件已经写了');
    assert.equal(await store.exists(indexFilename(writer.bundleId)), false, 'index 不该有这一行');
  });
});

describe('段的留存等级', () => {
  test('三种 kind 落在各自的段里', async () => {
    const { store, writer } = makeWriter();
    await writer.writeCapture(capture({ kind: 'data' }));
    await writer.writeCapture(capture({ kind: 'assets', intent: 'asset.image.user_upload' }));
    await writer.writeCapture(capture({ kind: 'catalog', intent: 'interest.item' }));

    const files = await store.list();
    assert.ok(files.some((f) => f.startsWith('data-')));
    assert.ok(files.some((f) => f.startsWith('assets-')));
    assert.ok(files.some((f) => f.startsWith('catalog-')));
  });

  test('删掉 catalog 段不影响 data 段 —— 「仅删除详情页」得以成立', async () => {
    const { store, writer } = makeWriter();
    await writer.writeCapture(capture({ kind: 'data' }));
    const catalogLoc = await writer.writeCapture(capture({ kind: 'catalog', intent: 'interest.item' }));
    const dataLoc = await writer.writeCapture(capture({ kind: 'data' }));

    await store.remove(catalogLoc.segment);

    // data 段里的记录仍然可按原偏移量取出
    const member = await store.read(dataLoc.segment, dataLoc.offset, dataLoc.length);
    assert.match(dec.decode(await gunzip(member)), /WARC-Type: response/);
  });
});

describe('finalize', () => {
  test('产出 manifest.json 与 README.txt', async () => {
    const { store, writer } = makeWriter();
    await writer.writeCapture(capture());
    const manifest = await writer.finalize();

    assert.equal(manifest.spec_version, SPEC_VERSION);
    assert.equal(manifest.bundle_id, writer.bundleId);
    assert.equal(manifest.status, 'complete');
    assert.ok(await store.exists('manifest.json'));
    assert.ok(await store.exists('README.txt'));
  });

  test('manifest 里的段摘要与磁盘一致', async () => {
    const { store, writer } = makeWriter();
    for (let i = 0; i < 3; i++) await writer.writeCapture(capture());
    const manifest = await writer.finalize();

    for (const seg of manifest.segments) {
      const bytes = await store.read(seg.filename);
      assert.equal(seg.bytes, bytes.length);
      assert.equal(seg.sha256, await sha256Hex(bytes));
    }
  });

  test('record_count 与 index 行数自动对齐', async () => {
    const { store, writer } = makeWriter();
    await writer.writeCapture(capture({ kind: 'data' }));
    await writer.writeCapture(capture({ kind: 'data' }));
    await writer.writeCapture(capture({ kind: 'catalog', intent: 'interest.item' }));

    const manifest = await writer.finalize();
    const entries = await readIndex(store, writer.bundleId);

    assert.equal(manifest.index.line_count, 3);
    const total = manifest.segments.reduce((n, s) => n + s.record_count, 0);
    assert.equal(total, entries.length);
  });

  test('counts 按 verdict / surface / intent 汇总', async () => {
    const { writer } = makeWriter();
    await writer.writeCapture(capture({ verdict: 'ok', surface: 'html' }));
    await writer.writeCapture(capture({ verdict: 'gone', surface: 'api', intent: 'note.item' }));

    const m = await writer.finalize();
    assert.deepEqual(m.counts.by_verdict, { ok: 1, gone: 1 });
    assert.deepEqual(m.counts.by_surface, { html: 1, api: 1 });
  });

  test('未完成的 bundle 用 in_progress，且没有 completed_at', async () => {
    const { writer } = makeWriter();
    await writer.writeCapture(capture());
    const m = await writer.finalize({ status: 'in_progress' });
    assert.equal(m.status, 'in_progress');
    assert.equal(m.completed_at, null);
  });

  test('coverage 与 crawl_state 进入 manifest', async () => {
    const { writer } = makeWriter();
    const loc = await writer.writeCapture(capture());

    writer.addCoverage(
      coverageEntry({
        routeKey: 'interest.game.collect',
        intent: 'interest.list.game.collect',
        claimedCount: 293,
        claimedSource: loc.captureId,
        capturedCount: 288,
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

    const m = await writer.finalize();
    assert.equal(m.coverage[0].delta, -5);
    assert.equal(m.crawl_state[0].advanced, true);
  });

  test('一条都没写时也能收尾', async () => {
    const { writer } = makeWriter();
    const m = await writer.finalize();
    assert.deepEqual(m.segments, []);
    assert.equal(m.index.line_count, 0);
  });
});

describe('README.txt', () => {
  const text = renderReadme('20260729T101500Z-a3f9c1');

  test('中英双语且自包含 —— 它是档案的一部分，不是文档', () => {
    assert.match(text, /这是什么/);
    assert.match(text, /What this is/);
    assert.match(text, /20260729T101500Z-a3f9c1/);
  });

  test('README 里的版本号必须与实际写入的一致', () => {
    // 原来这里是手写的 "bundle/1.0"，而 manifest 写的是 SPEC_VERSION。规范一升
    // 小版本，同一份档案里的两个版本号就对不上了——**而校验器会因此判整份档案
    // 不合格**（规范要求 README 声明的版本与 manifest 一致）。
    //
    // 断言写成「等于 SPEC_VERSION」而不是「等于 bundle/1.1」：钉死数字的话，
    // 这条测试下次照样会红，而红的原因依旧不是它想守的那件事。
    assert.match(text, new RegExp(`Spec version: ${SPEC_VERSION.replace('/', '\\/')}\\b`));
  });

  test('告诉读者用什么工具打开', () => {
    assert.match(text, /ReplayWeb\.page/);
    assert.match(text, /pywb/);
    assert.match(text, /jq/);
  });

  test('明确写出 coverage 不能当完整性依据', () => {
    assert.match(text, /不可】作为档案完整性的依据|MUST NOT be treated as proof/);
    assert.match(text, /crawl_state/);
  });

  test('说明 catalog 段可以单独删除及其代价', () => {
    assert.match(text, /删掉它不影响你自己写的内容/);
  });
});

describe('created_at 说的是「什么时候开始的」', () => {
  /**
   * 原来取自「构造 BundleWriter 的那一刻」。正常情况下那就是开始抓取的时刻，
   * 但**崩溃恢复会重新构造一个 BundleWriter**——于是它变成了「最后一次恢复的
   * 时刻」。
   *
   * 一份真实档案：
   *
   *     bundle_id             20260801T005010Z-3eef52   （08-01 00:50:10 UTC）
   *     manifest.created_at   2026-08-02T22:48:02+10:00
   *     manifest.completed_at 2026-08-02T22:56:24+10:00
   *
   * 差了两天。照那份 manifest 读，这次抓取只花了 8 分钟——而它实际跑了两天、
   * 跨越几十次恢复。`created_at` 是写进档案的溯源信息，不是显示文字。
   */
  test('恢复之后重建写入器，created_at 不跟着变', async () => {
    const store = new MemoryFileStore();
    const bundleId = '20260801T005010Z-3eef52';
    const account = { user_id: '1', username: 'x' };

    // 两天后「恢复」：now 完全不同，但 bundle_id 还是原来那个
    const writer = new BundleWriter({ producer: TEST_PRODUCER,
      store, account, bundleId,
      now: () => new Date('2026-08-02T12:48:02Z'),
    });
    await writer.writeCapture(capture());
    const m = await writer.finalize();

    assert.equal(
      Date.parse(m.created_at), Date.parse('2026-08-01T00:50:10Z'),
      `created_at 跟着恢复时刻跑了：${m.created_at}`,
    );
    assert.ok(
      Date.parse(m.completed_at) > Date.parse(m.created_at),
      '收尾时间应当晚于开始时间',
    );
  });

  test('新抓取时两者一致', async () => {
    const store = new MemoryFileStore();
    const at = new Date('2026-08-05T03:04:05Z');
    const writer = new BundleWriter({ producer: TEST_PRODUCER,
      store, account: { user_id: '1', username: 'x' }, now: () => at,
    });
    await writer.writeCapture(capture());
    const m = await writer.finalize();
    // bundle_id 只精确到秒，所以比到秒
    assert.equal(Date.parse(m.created_at), Date.parse('2026-08-05T03:04:05Z'));
  });

  test('bundle_id 认不出来时退回「现在」，不炸也不猜', async () => {
    const { bundleIdTime } = await import('../src/core/ids.js');
    assert.equal(bundleIdTime('乱七八糟'), null);
    assert.equal(bundleIdTime(''), null);
  });
});
