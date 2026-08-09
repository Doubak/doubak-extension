import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryFileStore } from '../src/storage/file-store.js';
import { BundleWriter } from '../src/bundle/bundle-writer.js';
import { recoverBundle } from '../src/bundle/recovery.js';
import { indexFilename, parseCaptureId } from '../src/core/ids.js';
import { gunzip } from '../src/core/warc.js';
import { TEST_PRODUCER } from './helpers/producer.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** @param {object} [over] */
function capture(over = {}) {
  return {
    url: 'https://www.douban.com/people/82160871/statuses?p=1',
    intent: 'broadcast.timeline',
    routeKey: 'broadcast.timeline',
    surface: /** @type {const} */ ('html'),
    verdict: 'ok',
    captureFidelity: 'decoded_body+observed_headers',
    body: enc.encode('<html>正文</html>'),
    httpStatus: 200,
    headers: [['Content-Type', 'text/html; charset=utf-8']],
    contentType: 'text/html; charset=utf-8',
    ...over,
  };
}

/** 写 n 条捕获，返回 store 与 bundleId。 */
async function writtenBundle(n = 3, opts = {}) {
  const store = new MemoryFileStore();
  const writer = new BundleWriter({ producer: TEST_PRODUCER, store, account: { user_id: '82160871' }, ...opts });
  const locs = [];
  for (let i = 0; i < n; i++) locs.push(await writer.writeCapture(capture()));
  return { store, bundleId: writer.bundleId, locs };
}

async function readIndexLines(store, bundleId) {
  const name = indexFilename(bundleId);
  if (!(await store.exists(name))) return [];
  return dec
    .decode(await store.read(name))
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe('自洽的 bundle 不需要修', () => {
  test('干净收尾后恢复是空操作', async () => {
    const { store, bundleId } = await writtenBundle(3);
    const before = store.snapshot();

    const res = await recoverBundle({ store, bundleId });

    assert.deepEqual(res.repairs, [], '不该有任何修复');
    assert.equal(res.indexLineCount, 3);
    assert.equal(res.lastSeq, 3);
    assert.deepEqual(store.snapshot(), before, '文件内容不该被动过');
  });

  test('幂等：连跑两次结果一致', async () => {
    const { store, bundleId } = await writtenBundle(3);
    const first = await recoverBundle({ store, bundleId });
    const snapshot = store.snapshot();
    const second = await recoverBundle({ store, bundleId });

    assert.deepEqual(second.repairs, []);
    assert.equal(second.lastSeq, first.lastSeq);
    assert.deepEqual(store.snapshot(), snapshot);
  });

  test('空 bundle 也能恢复', async () => {
    const store = new MemoryFileStore();
    const writer = new BundleWriter({ producer: TEST_PRODUCER, store, account: { user_id: '1' } });
    const res = await recoverBundle({ store, bundleId: writer.bundleId });
    assert.equal(res.lastSeq, 0);
    assert.equal(res.lastCaptureId, null);
  });
});

describe('崩在 WARC 写入途中 —— 段尾是撕裂的记录', () => {
  test('截断到最后一条被索引确认的记录', async () => {
    const { store, bundleId, locs } = await writtenBundle(3);
    const seg = locs[2].segment;

    // 模拟：第 4 条记录写了一半就断电
    const partial = new Uint8Array(200).fill(0x1f);
    await store.append(seg, partial);
    const sizeWithGarbage = await store.size(seg);

    const res = await recoverBundle({ store, bundleId });

    assert.equal(res.repairs.length, 1);
    assert.equal(res.repairs[0].kind, 'segment_tail');
    assert.equal(res.repairs[0].droppedBytes, 200);
    assert.equal(await store.size(seg), sizeWithGarbage - 200);
    assert.equal(res.lastSeq, 3, '已确认的三条不受影响');
  });

  test('修完之后，索引里的每条记录仍能取出并解压', async () => {
    const { store, bundleId, locs } = await writtenBundle(4);
    await store.append(locs[3].segment, new Uint8Array(77));

    await recoverBundle({ store, bundleId });

    for (const e of await readIndexLines(store, bundleId)) {
      const member = await store.read(e.segment, e.offset, e.length);
      const record = dec.decode(await gunzip(member));
      assert.match(record, /WARC-Type: response/);
    }
  });
});

describe('崩在 WARC 与 index 之间 —— 孤儿记录', () => {
  test('段尾的孤儿记录被丢弃', async () => {
    // 这是「先写 WARC 后写 index」刻意接受的失败模式：孤儿记录只是浪费
    // 空间，而且可以靠截断干净地去掉。
    const store = new MemoryFileStore();
    const writer = new BundleWriter({ producer: TEST_PRODUCER, store, account: { user_id: '1' } });
    await writer.writeCapture(capture());
    await writer.writeCapture(capture());

    // 让第 3 条的 index 写入失败：WARC 已落盘，index 没有
    await assert.rejects(() => writer.writeCapture(capture({ verdict: '非法取值' })));

    const before = await readIndexLines(store, writer.bundleId);
    assert.equal(before.length, 2, 'index 只认两条');

    const res = await recoverBundle({ store, bundleId: writer.bundleId });

    assert.equal(res.repairs.length, 1);
    assert.equal(res.repairs[0].kind, 'segment_tail');
    assert.equal(res.lastSeq, 2);
    assert.ok(res.repairs[0].droppedBytes > 0);
  });

  test('恢复后续写不会产生重复序号', async () => {
    // 关键性质：孤儿记录被截掉了，所以复用它的序号不会与磁盘上任何东西冲突。
    const store = new MemoryFileStore();
    const w1 = new BundleWriter({ producer: TEST_PRODUCER, store, account: { user_id: '1' } });
    await w1.writeCapture(capture());
    await w1.writeCapture(capture());
    await assert.rejects(() => w1.writeCapture(capture({ verdict: '非法' })));

    const res = await recoverBundle({ store, bundleId: w1.bundleId });

    const w2 = new BundleWriter({ producer: TEST_PRODUCER,
      store,
      account: { user_id: '1' },
      bundleId: w1.bundleId,
      startSeq: res.lastSeq,
      resume: res.resume,
    });
    // 续写要落到已有的段上，不能重开段
    await w2.writeCapture(capture());

    const entries = await readIndexLines(store, w1.bundleId);
    const seqs = entries.map((e) => parseCaptureId(e.capture_id).seq);
    assert.deepEqual(seqs, [1, 2, 3]);
    assert.equal(new Set(seqs).size, seqs.length, '不允许重复序号');
  });
});

describe('崩在 index 写入途中 —— 半行', () => {
  test('截断到最后一个完整行', async () => {
    const { store, bundleId } = await writtenBundle(3);
    const name = indexFilename(bundleId);

    // 模拟：第 4 行只写出了一部分
    await store.append(name, enc.encode('{"capture_id":"2026'));

    const res = await recoverBundle({ store, bundleId });

    const kinds = res.repairs.map((r) => r.kind);
    assert.ok(kinds.includes('index_partial_line'));
    assert.equal(res.indexLineCount, 3);

    const text = dec.decode(await store.read(name));
    assert.ok(text.endsWith('\n'));
    for (const line of text.trimEnd().split('\n')) {
      assert.doesNotThrow(() => JSON.parse(line), '每行都应可解析');
    }
  });

  test('整个 index 只有半行时清空', async () => {
    const store = new MemoryFileStore();
    const writer = new BundleWriter({ producer: TEST_PRODUCER, store, account: { user_id: '1' } });
    const bundleId = writer.bundleId;
    await store.append(indexFilename(bundleId), enc.encode('{"partial'));

    const res = await recoverBundle({ store, bundleId });
    assert.equal(res.indexLineCount, 0);
    assert.equal(res.lastSeq, 0);
  });
});

describe('开段后立即崩溃 —— 段里没有任何被索引的记录', () => {
  test('删掉这种段，续抓时会重新开', async () => {
    const { store, bundleId } = await writtenBundle(2);

    // 造一个只有 warcinfo、没有捕获的段
    const ghost = `data-${bundleId}-00009.warc.gz`;
    await store.append(ghost, new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0]));

    const res = await recoverBundle({ store, bundleId });

    assert.ok(res.repairs.some((r) => r.kind === 'segment_orphaned' && r.file === ghost));
    assert.equal(await store.exists(ghost), false);
    assert.equal(res.lastSeq, 2, '已有的捕获不受影响');
  });
});

describe('真正的损坏必须响亮地失败', () => {
  test('索引指向段外区域 —— 抛错而不是悄悄继续', async () => {
    const { store, bundleId, locs } = await writtenBundle(2);
    // 把段砍掉一半，让索引指向不存在的区域
    await store.truncate(locs[1].segment, locs[1].offset);

    await assert.rejects(
      () => recoverBundle({ store, bundleId }),
      /档案已损坏|指向段外/,
      '这不是崩溃残留，不能当成可修复的情况',
    );
  });

  test('索引位置解压失败 —— 抛错', async () => {
    const { store, bundleId, locs } = await writtenBundle(2);
    const seg = locs[0].segment;

    // 把第一条记录的压缩数据改坏（长度不变，所以不会被截断逻辑发现）。
    // 注意要改压缩体而不是 gzip 头——头里的 MTIME/OS 字段改了也照样解得开。
    const bytes = await store.read(seg);
    const mid = locs[0].offset + Math.floor(locs[0].length / 2);
    bytes[mid] ^= 0xff;
    bytes[mid + 1] ^= 0xff;
    await store.replace(seg, bytes);

    await assert.rejects(() => recoverBundle({ store, bundleId }), /档案已损坏|gzip/);
  });
});

describe('组合场景', () => {
  test('段尾撕裂 + index 半行 同时发生', async () => {
    // 实际断电时这两者会一起出现：正在写第 N 条的 WARC，上一条的 index
    // 恰好也没刷完。
    const { store, bundleId, locs } = await writtenBundle(4);

    await store.append(locs[3].segment, new Uint8Array(120).fill(0xab));
    await store.append(indexFilename(bundleId), enc.encode('{"capture_id":"半'));

    const res = await recoverBundle({ store, bundleId });

    const kinds = res.repairs.map((r) => r.kind).sort();
    assert.deepEqual(kinds, ['index_partial_line', 'segment_tail']);
    assert.equal(res.indexLineCount, 4);

    // 修完之后一切自洽
    for (const e of await readIndexLines(store, bundleId)) {
      const member = await store.read(e.segment, e.offset, e.length);
      assert.match(dec.decode(await gunzip(member)), /WARC\/1\.1/);
    }
    assert.deepEqual((await recoverBundle({ store, bundleId })).repairs, []);
  });

  test('跨多个段时只动最后一个段', async () => {
    const { store, bundleId, locs } = await writtenBundle(12, { maxSegmentBytes: 600 });
    const segments = [...new Set(locs.map((l) => l.segment))];
    assert.ok(segments.length > 1, '本用例需要多个段');

    const first = segments[0];
    const firstBefore = await store.read(first);
    await store.append(locs.at(-1).segment, new Uint8Array(50));

    const res = await recoverBundle({ store, bundleId });

    assert.equal(res.repairs.length, 1);
    assert.equal(res.repairs[0].file, locs.at(-1).segment);
    assert.deepEqual(await store.read(first), firstBefore, '前面的段不该被动');
  });
});
