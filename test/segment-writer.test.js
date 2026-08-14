import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryFileStore } from '../src/storage/file-store.js';
import { SegmentWriter, DEFAULT_MAX_SEGMENT_BYTES } from '../src/bundle/segment-writer.js';
import { buildWarcRecord, gunzip } from '../src/core/warc.js';
import { newWarcRecordId, captureId } from '../src/core/ids.js';
import { sha256Hex } from '../src/core/digest.js';
import { gunzipSegmentText } from './helpers/gunzip-segment.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const BID = '20260729T101500Z-a3f9c1';
const AT = new Date('2026-07-29T02:15:03Z');

/** @param {string} body */
function record(body) {
  return buildWarcRecord({
    type: 'response',
    recordId: newWarcRecordId(),
    date: AT,
    targetUri: 'https://www.douban.com/x',
    block: enc.encode(body),
  });
}

/** @param {object} [over] */
function makeWriter(over = {}) {
  const store = new MemoryFileStore();
  const writer = new SegmentWriter({
    store,
    bundleId: BID,
    kind: 'data',
    software: 'doubak-extension/0.0.1',
    now: () => AT,
    ...over,
  });
  return { store, writer };
}

describe('开段', () => {
  test('第一次写入才开段 —— 不预先创建空文件', async () => {
    const { store, writer } = makeWriter();
    assert.equal(writer.currentSegment, null);
    assert.deepEqual(await store.list(), []);

    await writer.append(record('第一条'), captureId(BID, 1));
    assert.equal(writer.currentSegment, `data-${BID}-00001.warc.gz`);
  });

  test('段首是 warcinfo，且不计入 record_count', async () => {
    // warcinfo 描述「这个文件是什么」，不是一次捕获，所以不进 index，
    // record_count 也不该算它——这样它才等于指向该段的 index 行数。
    const { writer } = makeWriter();
    await writer.append(record('一'), captureId(BID, 1));
    await writer.append(record('二'), captureId(BID, 2));

    const [seg] = await writer.finalize();
    assert.equal(seg.record_count, 2, 'warcinfo 不算在内');
  });

  test('warcinfo 里带本段文件名与 bundle_id', async () => {
    const { store, writer } = makeWriter();
    await writer.append(record('x'), captureId(BID, 1));

    const raw = await store.read(`data-${BID}-00001.warc.gz`);
    // 整段解压要用多 member 的解压器：`gunzip()` 走 DecompressionStream，按规范
    // 只认单个 member（见 test/helpers/gunzip-segment.js）。
    const whole = gunzipSegmentText(raw);
    assert.match(whole, /WARC-Type: warcinfo/);
    assert.match(whole, new RegExp(`WARC-Filename: data-${BID}-00001\\.warc\\.gz`));
    assert.match(whole, new RegExp(`isPartOf: ${BID}`));
  });

  test('段文件已存在时拒绝覆盖', async () => {
    const { store, writer } = makeWriter();
    await store.append(`data-${BID}-00001.warc.gz`, enc.encode('别人的数据'));
    await assert.rejects(
      () => writer.append(record('x'), captureId(BID, 1)),
      /拒绝覆盖/,
    );
  });
});

describe('偏移量', () => {
  test('offset 是写入前的文件长度，length 是压缩后字节数', async () => {
    const { store, writer } = makeWriter();

    const sizeBefore = await store.size(`data-${BID}-00001.warc.gz`);
    assert.equal(sizeBefore, 0);

    const loc1 = await writer.append(record('第一条'), captureId(BID, 1));
    const afterFirst = await store.size(loc1.segment);

    const loc2 = await writer.append(record('第二条'), captureId(BID, 2));

    // 第一条的 offset 是 warcinfo 之后的位置
    assert.ok(loc1.offset > 0, 'warcinfo 占了开头');
    assert.equal(loc1.offset + loc1.length, afterFirst);
    assert.equal(loc2.offset, afterFirst, '第二条紧接第一条');
  });

  test('按记录的 offset/length 取出来能解压回原记录', async () => {
    // 这就是 index.ndjson 的 offset/length 的全部意义。
    const { store, writer } = makeWriter();
    const bodies = ['第一条记录', 'second', '第三条 mixed'];
    const locs = [];
    const recs = [];

    for (const [i, b] of bodies.entries()) {
      const r = record(b);
      recs.push(r);
      locs.push(await writer.append(r, captureId(BID, i + 1)));
    }

    for (const [i, loc] of locs.entries()) {
      const member = await store.read(loc.segment, loc.offset, loc.length);
      assert.deepEqual(await gunzip(member), recs[i], `第 ${i + 1} 条`);
      assert.match(dec.decode(await gunzip(member)), new RegExp(bodies[i]));
    }
  });

  test('偏移量连续无缝隙', async () => {
    const { store, writer } = makeWriter();
    const locs = [];
    for (let i = 1; i <= 10; i++) locs.push(await writer.append(record(`记录${i}`), captureId(BID, i)));

    for (let i = 1; i < locs.length; i++) {
      assert.equal(
        locs[i].offset,
        locs[i - 1].offset + locs[i - 1].length,
        `第 ${i + 1} 条应紧接上一条`,
      );
    }
    const last = locs.at(-1);
    assert.equal(await store.size(last.segment), last.offset + last.length);
  });
});

describe('轮转', () => {
  test('超过上限就换新段', async () => {
    const { store, writer } = makeWriter({ maxBytes: 400 });

    for (let i = 1; i <= 12; i++) await writer.append(record(`记录内容 ${i}`.repeat(4)), captureId(BID, i));

    const files = await store.list();
    assert.ok(files.length > 1, `应当轮转出多个段，实际 ${files.length} 个`);
    assert.deepEqual(files, files.slice().sort(), '文件名字典序即写入序');
    assert.equal(files[0], `data-${BID}-00001.warc.gz`);
    assert.equal(files[1], `data-${BID}-00002.warc.gz`);
  });

  test('每段都不超过上限（除非单条记录本身就超）', async () => {
    const { store, writer } = makeWriter({ maxBytes: 500 });
    for (let i = 1; i <= 20; i++) await writer.append(record(`abc ${i}`.repeat(3)), captureId(BID, i));

    const segs = await writer.finalize();
    for (const s of segs.slice(0, -1)) {
      assert.ok(s.bytes <= 500 + 200, `${s.filename} 体积 ${s.bytes} 明显超出上限`);
    }
    void store;
  });

  test('一条记录绝不跨段', async () => {
    // index.ndjson 的 offset/length 表达的是「某个文件里的一段字节」，
    // 跨文件就没法表达了。
    const { store, writer } = makeWriter({ maxBytes: 300 });
    const locs = [];
    const recs = [];
    for (let i = 1; i <= 15; i++) {
      const r = record(`第 ${i} 条记录的内容`);
      recs.push(r);
      locs.push(await writer.append(r, captureId(BID, i)));
    }

    for (const [i, loc] of locs.entries()) {
      const segSize = await store.size(loc.segment);
      assert.ok(
        loc.offset + loc.length <= segSize,
        `第 ${i + 1} 条越出了段边界`,
      );
      assert.deepEqual(await gunzip(await store.read(loc.segment, loc.offset, loc.length)), recs[i]);
    }
  });

  test('单条记录大于上限时独占一段，而不是无限开新段', async () => {
    // 轮转判定必须带「段里已经有记录」这个条件，否则一条放不下的记录
    // 会让写入器一直开新段。
    const { store, writer } = makeWriter({ maxBytes: 100 });

    const big = record('超大内容'.repeat(500));
    const loc = await writer.append(big, captureId(BID, 1));
    await writer.append(record('小'), captureId(BID, 2));

    const files = await store.list();
    assert.ok(files.length <= 2, `不该爆炸式开段，实际 ${files.length} 个`);
    assert.deepEqual(await gunzip(await store.read(loc.segment, loc.offset, loc.length)), big);
  });

  test('新段同样以 warcinfo 开头，且文件名对应自己', async () => {
    const { store, writer } = makeWriter({ maxBytes: 400 });
    for (let i = 1; i <= 12; i++) await writer.append(record(`内容 ${i}`.repeat(4)), captureId(BID, i));

    const second = `data-${BID}-00002.warc.gz`;
    const whole = gunzipSegmentText(await store.read(second));
    assert.match(whole, /WARC-Type: warcinfo/);
    assert.match(whole, new RegExp(`WARC-Filename: ${second.replace(/\./g, '\\.')}`));
  });
});

describe('finalize 汇总', () => {
  test('体积与摘要与磁盘上的字节一致', async () => {
    const { store, writer } = makeWriter({ maxBytes: 400 });
    for (let i = 1; i <= 10; i++) await writer.append(record(`内容 ${i}`.repeat(3)), captureId(BID, i));

    const segs = await writer.finalize();
    for (const s of segs) {
      const actual = await store.read(s.filename);
      assert.equal(s.bytes, actual.length, `${s.filename} 体积不符`);
      assert.equal(s.sha256, await sha256Hex(actual), `${s.filename} 摘要不符`);
    }
  });

  test('record_count 之和等于写入的记录数', async () => {
    const { writer } = makeWriter({ maxBytes: 400 });
    const n = 17;
    for (let i = 1; i <= n; i++) await writer.append(record(`内容 ${i}`.repeat(3)), captureId(BID, i));

    const segs = await writer.finalize();
    assert.equal(segs.reduce((sum, s) => sum + s.record_count, 0), n);
  });

  test('first/last capture_id 对应各段的首尾', async () => {
    const { writer } = makeWriter({ maxBytes: 400 });
    const ids = [];
    for (let i = 1; i <= 12; i++) {
      const cid = captureId(BID, i);
      ids.push(cid);
      await writer.append(record(`内容 ${i}`.repeat(4)), cid);
    }

    const segs = await writer.finalize();
    assert.equal(segs[0].first_capture_id, ids[0]);
    assert.equal(segs.at(-1).last_capture_id, ids.at(-1));

    // 各段首尾相接，不重不漏
    let seen = 0;
    for (const s of segs) {
      assert.equal(s.first_capture_id, ids[seen]);
      seen += s.record_count;
      assert.equal(s.last_capture_id, ids[seen - 1]);
    }
    assert.equal(seen, ids.length);
  });

  test('还没写过任何东西时 finalize 返回空', async () => {
    const { writer } = makeWriter();
    assert.deepEqual(await writer.finalize(), []);
  });
});

describe('参数校验', () => {
  test('拒绝非法 maxBytes', () => {
    assert.throws(() => makeWriter({ maxBytes: 0 }), /正整数/);
    assert.throws(() => makeWriter({ maxBytes: -1 }), /正整数/);
    assert.throws(() => makeWriter({ maxBytes: 1.5 }), /正整数/);
  });

  test('拒绝缺少 captureId 或非 Uint8Array', async () => {
    const { writer } = makeWriter();
    await assert.rejects(() => writer.append(/** @type {any} */ ('x'), captureId(BID, 1)), /Uint8Array/);
    await assert.rejects(() => writer.append(record('x'), ''), /captureId/);
  });

  test('默认上限是 256 MB', () => {
    assert.equal(DEFAULT_MAX_SEGMENT_BYTES, 256 * 1024 * 1024);
  });
});
