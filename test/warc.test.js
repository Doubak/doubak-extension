import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  warcDate,
  buildWarcRecord,
  buildHttpResponseBlock,
  buildWarcinfoRecord,
  gzipMember,
  gunzip,
} from '../src/core/warc.js';
import { sha1Base32 } from '../src/core/digest.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const AT = new Date('2026-07-28T02:15:03.456Z');
const RID = 'urn:uuid:3f2a8c11-0d4e-4a91-9b77-1c2e5a8f0011';

describe('WARC 日期', () => {
  test('UTC、秒级、以 Z 结尾', () => {
    assert.equal(warcDate(AT), '2026-07-28T02:15:03Z');
  });

  test('拒绝无效 Date', () => {
    assert.throws(() => warcDate(new Date('乱码')), /无效的 Date/);
  });
});

describe('WARC 记录结构', () => {
  test('以 WARC/1.1 开头，头之后空一行，末尾两个 CRLF', () => {
    const rec = buildWarcRecord({
      type: 'response',
      recordId: RID,
      date: AT,
      block: enc.encode('BODY'),
    });
    const text = dec.decode(rec);
    assert.ok(text.startsWith('WARC/1.1\r\n'));
    assert.ok(text.includes('\r\n\r\nBODY'));
    assert.ok(text.endsWith('BODY\r\n\r\n'));
  });

  test('记录 ID 用尖括号包裹', () => {
    // WARC 规范要求；index.ndjson 里存的则是不带尖括号的裸 URI。
    const rec = buildWarcRecord({ type: 'response', recordId: RID, date: AT, block: new Uint8Array(0) });
    assert.match(dec.decode(rec), new RegExp(`WARC-Record-ID: <${RID}>\r\n`));
  });

  test('Content-Length 是字节数而非字符数', () => {
    // 中文一个字符占三个字节。用 string.length 会让段文件从这条记录起
    // 全部错位——这是最容易犯且后果最严重的一个错。
    const body = '看过《银翼杀手》'; // 8 个字符
    const bytes = enc.encode(body);
    assert.notEqual(body.length, bytes.length);

    const rec = buildWarcRecord({ type: 'response', recordId: RID, date: AT, block: bytes });
    assert.match(dec.decode(rec), new RegExp(`Content-Length: ${bytes.length}\r\n`));
  });

  test('Content-Length 与实际载荷字节数一致', () => {
    const bytes = enc.encode('混合 content 中英文 mixed');
    const rec = buildWarcRecord({ type: 'response', recordId: RID, date: AT, block: bytes });
    const text = dec.decode(rec);

    const declared = Number(/Content-Length: (\d+)/.exec(text)[1]);
    const headEnd = rec.indexOf(0x0d); // 找不到就是结构坏了
    assert.ok(headEnd > 0);

    // 载荷 = 去掉头部与结尾两个 CRLF 之后的部分
    const sep = dec.decode(rec).indexOf('\r\n\r\n') + 4;
    const payloadLen = rec.length - sep - 4;
    assert.equal(declared, payloadLen);
    assert.equal(declared, bytes.length);
  });

  test('按给定顺序输出额外的头', () => {
    const rec = buildWarcRecord({
      type: 'response',
      recordId: RID,
      date: AT,
      block: new Uint8Array(0),
      targetUri: 'https://www.douban.com/x',
      contentType: 'application/http;msgtype=response',
      headers: [
        ['WARC-Block-Digest', 'sha1:AAA'],
        ['WARC-Payload-Digest', 'sha1:BBB'],
      ],
    });
    const text = dec.decode(rec);
    assert.ok(text.indexOf('WARC-Target-URI') < text.indexOf('WARC-Block-Digest'));
    assert.ok(text.indexOf('WARC-Block-Digest') < text.indexOf('WARC-Payload-Digest'));
    assert.ok(text.indexOf('WARC-Payload-Digest') < text.indexOf('Content-Type'));
    assert.ok(text.indexOf('Content-Type') < text.indexOf('Content-Length'));
  });

  test('拒绝会破坏格式的输入', () => {
    const base = { type: 'response', recordId: RID, date: AT, block: new Uint8Array(0) };
    assert.throws(() => buildWarcRecord({ ...base, recordId: 'not-a-urn' }), /urn:uuid/);
    assert.throws(() => buildWarcRecord({ ...base, type: '' }), /WARC-Type/);
    assert.throws(
      () => buildWarcRecord({ ...base, block: /** @type {any} */ ('字符串') }),
      /Uint8Array/,
    );
    // 头值里塞换行会伪造出额外的头，必须挡住
    assert.throws(
      () => buildWarcRecord({ ...base, headers: [['X', 'a\r\nEvil: 1']] }),
      /不得含换行/,
    );
  });
});

describe('HTTP 响应块', () => {
  test('状态行 + 头 + 空行 + 原样载荷', () => {
    const block = buildHttpResponseBlock({
      statusLine: 'HTTP/1.1 200 OK',
      headers: [['Content-Type', 'text/html; charset=utf-8']],
      body: enc.encode('<html>中文</html>'),
    });
    const text = dec.decode(block);
    assert.ok(text.startsWith('HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n'));
    assert.ok(text.endsWith('<html>中文</html>'));
  });

  test('载荷逐字节原样，不做任何改写', () => {
    // 「捕获时不做归一化」是铁律。这里塞一段非 UTF-8 的字节，
    // 出来必须一模一样。
    const raw = new Uint8Array([0xff, 0xfe, 0x00, 0x41, 0x80]);
    const block = buildHttpResponseBlock({
      statusLine: 'HTTP/1.1 200 OK',
      headers: [],
      body: raw,
    });
    assert.deepEqual(block.slice(block.length - raw.length), raw);
  });

  test('挡住头值里的换行', () => {
    assert.throws(
      () =>
        buildHttpResponseBlock({
          statusLine: 'HTTP/1.1 200 OK',
          headers: [['X', 'a\nY: b']],
          body: new Uint8Array(0),
        }),
      /不得含换行/,
    );
  });
});

describe('warcinfo', () => {
  test('含 software / format / isPartOf / conformsTo 与文件名', () => {
    const rec = buildWarcinfoRecord({
      recordId: RID,
      date: AT,
      filename: 'data-20260728T101500Z-a3f9c1-00001.warc.gz',
      bundleId: '20260728T101500Z-a3f9c1',
      software: 'doubak-extension/0.0.1',
    });
    const text = dec.decode(rec);
    assert.match(text, /WARC-Type: warcinfo/);
    assert.match(text, /WARC-Filename: data-20260728T101500Z-a3f9c1-00001\.warc\.gz/);
    assert.match(text, /Content-Type: application\/warc-fields/);
    assert.match(text, /isPartOf: 20260728T101500Z-a3f9c1/);
    assert.match(text, /conformsTo: https:\/\/spec\.doubak\.com\/bundle\/v1\//);
  });
});

describe('gzip member', () => {
  test('是标准 gzip，可往返', async () => {
    const rec = buildWarcRecord({ type: 'response', recordId: RID, date: AT, block: enc.encode('中文载荷') });
    const member = await gzipMember(rec);
    assert.equal(member[0], 0x1f);
    assert.equal(member[1], 0x8b);
    assert.deepEqual(await gunzip(member), rec);
  });

  test('多条记录拼接后既能整体解压，也能按偏移量单独取', async () => {
    // 这是段文件与 index.ndjson 的 offset/length 得以成立的根本性质。
    const recs = ['第一条记录', 'second record', '第三条 mixed 记录'].map((s) =>
      buildWarcRecord({ type: 'response', recordId: RID, date: AT, block: enc.encode(s) }),
    );

    /** @type {{offset:number,length:number}[]} */
    const locs = [];
    /** @type {Uint8Array[]} */
    const members = [];
    let offset = 0;
    for (const r of recs) {
      const m = await gzipMember(r);
      locs.push({ offset, length: m.length });
      members.push(m);
      offset += m.length;
    }

    const segment = new Uint8Array(offset);
    let at = 0;
    for (const m of members) {
      segment.set(m, at);
      at += m.length;
    }

    // 整体解压 == 三条记录首尾相接
    const whole = await gunzip(segment);
    const expectedWhole = new Uint8Array(recs.reduce((n, r) => n + r.length, 0));
    let w = 0;
    for (const r of recs) {
      expectedWhole.set(r, w);
      w += r.length;
    }
    assert.deepEqual(whole, expectedWhole);

    // 按 index 里记的 offset/length 单独取第二条
    const one = await gunzip(segment.slice(locs[1].offset, locs[1].offset + locs[1].length));
    assert.deepEqual(one, recs[1]);
    assert.match(dec.decode(one), /second record/);
  });

  test('偏移量错位时解压失败 —— 撕裂的尾部因此可被检测', async () => {
    const rec = buildWarcRecord({ type: 'response', recordId: RID, date: AT, block: enc.encode('x') });
    const member = await gzipMember(rec);
    await assert.rejects(() => gunzip(member.slice(3)));
    await assert.rejects(() => gunzip(member.slice(0, member.length - 5)));
  });

  test('拒绝非 Uint8Array', async () => {
    await assert.rejects(() => gzipMember(/** @type {any} */ ('字符串')), /Uint8Array/);
  });
});

describe('与摘要配合', () => {
  test('WARC-Block-Digest 覆盖整个 HTTP 块，Payload-Digest 只覆盖正文', async () => {
    const body = enc.encode('<html>正文</html>');
    const block = buildHttpResponseBlock({
      statusLine: 'HTTP/1.1 200 OK',
      headers: [['Content-Type', 'text/html']],
      body,
    });

    const blockDigest = await sha1Base32(block);
    const payloadDigest = await sha1Base32(body);
    assert.notEqual(blockDigest, payloadDigest);

    const rec = buildWarcRecord({
      type: 'response',
      recordId: RID,
      date: AT,
      block,
      contentType: 'application/http;msgtype=response',
      headers: [
        ['WARC-Block-Digest', blockDigest],
        ['WARC-Payload-Digest', payloadDigest],
      ],
    });

    const text = dec.decode(rec);
    assert.ok(text.includes(`WARC-Block-Digest: ${blockDigest}`));
    assert.ok(text.includes(`WARC-Payload-Digest: ${payloadDigest}`));
  });
});
