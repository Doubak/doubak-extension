import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryFileStore } from '../src/storage/file-store.js';
import { IndexWriter, assertValidEntry } from '../src/bundle/index-writer.js';
import { EMPTY_SHA256, sha256Hex } from '../src/core/digest.js';

const dec = new TextDecoder();
const BID = '20260729T101500Z-a3f9c1';
const FILE = `index-${BID}.ndjson`;

/** @param {object} [over] */
function entry(over = {}) {
  return {
    capture_id: `${BID}#000001`,
    warc_record_id: 'urn:uuid:3f2a8c11-0d4e-4a91-9b77-1c2e5a8f0011',
    segment: `data-${BID}-00001.warc.gz`,
    offset: 328,
    length: 581,
    url: 'https://www.douban.com/people/82160871/statuses?p=1&_spm_id=ODIx',
    url_key: 'https://www.douban.com/people/82160871/statuses?p=1',
    url_key_rules: 'v1',
    intent: 'broadcast.timeline',
    route_key: 'broadcast.timeline',
    surface: 'html',
    verdict: 'ok',
    capture_fidelity: 'decoded_body+observed_headers',
    observed_at: '2026-07-29T10:15:03+08:00',
    http_status: 200,
    content_type: 'text/html; charset=utf-8',
    content_sha256: 'a2955762e545c225e8321b75b508be5cb4db22b8f849ce4772b59af52a3f27ee',
    parent_capture_id: null,
    cursor: { kind: 'page', value: 1 },
    ...over,
  };
}

/** @type {MemoryFileStore} */
let store;
/** @type {IndexWriter} */
let writer;
beforeEach(() => {
  store = new MemoryFileStore();
  writer = new IndexWriter({ store, filename: FILE });
});

describe('写入', () => {
  test('一行一个 JSON 对象，以 \\n 结尾', async () => {
    await writer.append(entry());
    await writer.append(entry({ capture_id: `${BID}#000002` }));

    const text = dec.decode(await store.read(FILE));
    assert.ok(text.endsWith('\n'));
    const lines = text.trimEnd().split('\n');
    assert.equal(lines.length, 2);
    for (const l of lines) assert.doesNotThrow(() => JSON.parse(l));
  });

  test('字段顺序固定 —— 便于 diff 与肉眼阅读', async () => {
    await writer.append(entry());
    const line = dec.decode(await store.read(FILE)).trimEnd();
    const keys = Object.keys(JSON.parse(line));
    assert.equal(keys[0], 'capture_id');
    assert.equal(keys[1], 'warc_record_id');
    assert.ok(keys.indexOf('intent') < keys.indexOf('verdict'));
    assert.ok(keys.indexOf('verdict') < keys.indexOf('observed_at'));
  });

  test('未知字段被保留而不是丢弃', async () => {
    // 规范要求读者容忍未知字段且重写时不得丢弃，我们自己也照做。
    await writer.append(entry({ future_field: '将来的东西' }));
    const parsed = JSON.parse(dec.decode(await store.read(FILE)).trimEnd());
    assert.equal(parsed.future_field, '将来的东西');
  });

  test('省略的可选字段不写成 null', async () => {
    const e = entry();
    delete e.note;
    delete e.cursor;
    await writer.append(e);
    const parsed = JSON.parse(dec.decode(await store.read(FILE)).trimEnd());
    assert.ok(!('note' in parsed));
    assert.ok(!('cursor' in parsed));
  });

  test('中文内容不被转义成 \\uXXXX —— 要保持可 grep', async () => {
    await writer.append(entry({ note: '看过《银翼杀手》' }));
    const text = dec.decode(await store.read(FILE));
    assert.match(text, /看过《银翼杀手》/);
  });
});

describe('写入时校验 —— 不合规就不写', () => {
  test('缺必填字段直接抛', async () => {
    for (const field of [
      'capture_id', 'warc_record_id', 'segment', 'offset', 'length',
      'url', 'intent', 'route_key', 'surface', 'verdict',
      'capture_fidelity', 'observed_at',
    ]) {
      const e = entry();
      delete e[field];
      await assert.rejects(() => writer.append(e), new RegExp(field), `${field} 应当必填`);
    }
  });

  test('校验失败时什么都不写', async () => {
    // 宁可抓取停下，也不要写出一份事后才发现不合规的档案。
    await assert.rejects(() => writer.append(entry({ verdict: 'maybe' })));
    assert.equal(await store.exists(FILE), false);
    assert.equal(writer.lineCount, 0);
  });

  test('verdict 是封闭词表，拼错必须失败', async () => {
    await assert.rejects(() => writer.append(entry({ verdict: 'OK' })), /未知的 verdict/);
    await assert.rejects(() => writer.append(entry({ verdict: 'blocked ' })), /未知的 verdict/);
    await assert.rejects(() => writer.append(entry({ verdict: '' })), /未知的 verdict|必填/);
  });

  test('六个合法 verdict 都能写', async () => {
    const all = ['ok', 'blocked', 'challenge', 'login', 'gone', 'soft404'];
    for (const [i, v] of all.entries()) {
      await writer.append(entry({ verdict: v, capture_id: `${BID}#${String(i + 1).padStart(6, '0')}` }));
    }
    assert.equal(writer.lineCount, all.length);
    assert.deepEqual(Object.keys(writer.counts().by_verdict).sort(), all.slice().sort());
  });

  test('surface 只能是 html 或 api', async () => {
    await assert.rejects(() => writer.append(entry({ surface: 'both' })), /未知的 surface/);
  });

  test('capture_fidelity 是封闭词表', async () => {
    await assert.rejects(
      () => writer.append(entry({ capture_fidelity: 'perfect' })),
      /capture_fidelity/,
    );
  });

  test('observed_at 必须带时区偏移', async () => {
    await assert.rejects(
      () => writer.append(entry({ observed_at: '2026-07-29 10:15:03' })),
      /时区偏移/,
    );
    await assert.rejects(
      () => writer.append(entry({ observed_at: '2026-07-29T10:15:03' })),
      /时区偏移/,
    );
    await writer.append(entry({ observed_at: '2026-07-29T02:15:03Z' }));
  });

  test('零长度载荷不得记为 ok', async () => {
    // 真实旧档案里有 7 个零字节文件，磁盘上没有任何失败痕迹。
    await assert.rejects(
      () => writer.append(entry({ content_sha256: EMPTY_SHA256, verdict: 'ok' })),
      /零长度/,
    );
    // 但如实标注就允许——空的封锁页本来就该存下来
    await writer.append(entry({ content_sha256: EMPTY_SHA256, verdict: 'blocked' }));
    assert.equal(writer.lineCount, 1);
  });

  test('offset / length 必须是合理的整数', async () => {
    await assert.rejects(() => writer.append(entry({ offset: -1 })), /offset/);
    await assert.rejects(() => writer.append(entry({ offset: 1.5 })), /offset/);
    await assert.rejects(() => writer.append(entry({ length: 0 })), /length/);
    await writer.append(entry({ offset: 0 }));
  });

  test('assertValidEntry 可单独使用', () => {
    assert.doesNotThrow(() => assertValidEntry(entry()));
    assert.throws(() => assertValidEntry(null), /必须是对象/);
  });
});


describe('汇总', () => {
  test('计数按 verdict / surface / intent 分桶', async () => {
    await writer.append(entry({ capture_id: `${BID}#000001`, verdict: 'ok', surface: 'html' }));
    await writer.append(entry({ capture_id: `${BID}#000002`, verdict: 'ok', surface: 'api' }));
    await writer.append(
      entry({ capture_id: `${BID}#000003`, verdict: 'gone', surface: 'html', intent: 'note.item' }),
    );

    const c = writer.counts();
    assert.deepEqual(c.by_verdict, { ok: 2, gone: 1 });
    assert.deepEqual(c.by_surface, { html: 2, api: 1 });
    assert.deepEqual(c.by_intent, { 'broadcast.timeline': 2, 'note.item': 1 });
  });

  test('counts 返回副本，改它不影响内部状态', async () => {
    await writer.append(entry());
    const c = writer.counts();
    c.by_verdict.ok = 999;
    assert.equal(writer.counts().by_verdict.ok, 1);
  });

  test('每段的行数可查，供 manifest 的 record_count 交叉核对', async () => {
    const segA = `data-${BID}-00001.warc.gz`;
    const segB = `data-${BID}-00002.warc.gz`;
    await writer.append(entry({ capture_id: `${BID}#000001`, segment: segA }));
    await writer.append(entry({ capture_id: `${BID}#000002`, segment: segA }));
    await writer.append(entry({ capture_id: `${BID}#000003`, segment: segB }));

    const per = writer.perSegmentCounts();
    assert.equal(per.get(segA), 2);
    assert.equal(per.get(segB), 1);
  });

  test('finalize 给出与磁盘一致的摘要与行数', async () => {
    await writer.append(entry({ capture_id: `${BID}#000001` }));
    await writer.append(entry({ capture_id: `${BID}#000002` }));

    const meta = await writer.finalize();
    const bytes = await store.read(FILE);
    assert.equal(meta.filename, FILE);
    assert.equal(meta.line_count, 2);
    assert.equal(meta.sha256, await sha256Hex(bytes));
  });

  test('一行都没写时 finalize 也能用', async () => {
    const meta = await writer.finalize();
    assert.equal(meta.line_count, 0);
    assert.equal(meta.sha256, EMPTY_SHA256);
  });
});
