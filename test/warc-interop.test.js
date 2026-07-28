/**
 * 互操作测试：用 **webrecorder 自己的解析器** 读我们写出来的 WARC。
 *
 * 规范承诺「pywb 与 ReplayWeb.page 必须能不加改造地打开这些段文件」。
 * 自己写的测试只能证明「我们的写入器和我们的理解一致」；只有让一个独立
 * 实现把字节读回来，才谈得上证明这个承诺。warcio 正是 ReplayWeb.page
 * 背后的那个解析器。
 *
 * warcio 是**可选的开发依赖**：没装就跳过，`npm test` 依然零安装可跑。
 * 装上则多一层保障：
 *
 *     npm install
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWarcRecord,
  buildHttpResponseBlock,
  buildWarcinfoRecord,
  gzipMember,
} from '../src/core/warc.js';
import { sha1Base32 } from '../src/core/digest.js';
import { newWarcRecordId } from '../src/core/ids.js';

const enc = new TextEncoder();
const AT = new Date('2026-07-28T02:15:03Z');

/** @type {any} */
let warcio = null;
/** @type {string | false} */
let skipReason = false;

before(async () => {
  try {
    warcio = await import('warcio');
  } catch {
    skipReason = '未安装 warcio（可选开发依赖）——跳过独立解析器验证。装上请跑 npm install';
  }
});

/** 把若干条记录压成一个段文件的字节。 */
async function buildSegment(records) {
  const members = [];
  let total = 0;
  for (const r of records) {
    const m = await gzipMember(r);
    members.push(m);
    total += m.length;
  }
  const seg = new Uint8Array(total);
  let at = 0;
  for (const m of members) {
    seg.set(m, at);
    at += m.length;
  }
  return seg;
}

/** 用 warcio 把一个段文件解析成记录数组。 */
async function parseWithWarcio(segmentBytes) {
  const parser = new warcio.WARCParser(new Blob([segmentBytes]).stream());
  const out = [];
  for await (const rec of parser) {
    out.push({
      warcType: rec.warcType,
      recordId: rec.warcHeader('WARC-Record-ID'),
      targetURI: rec.warcTargetURI,
      contentType: rec.warcHeader('Content-Type'),
      blockDigest: rec.warcHeader('WARC-Block-Digest'),
      statusline: rec.httpHeaders?.statusline ?? null,
      // warcio 的 httpHeaders.headers 是一个 Headers 实例，不能用展开语法取值
      httpHeader: (/** @type {string} */ name) =>
        rec.httpHeaders?.headers?.get(name) ?? null,
      content: await rec.readFully(),
    });
  }
  return out;
}

describe('与 webrecorder/warcio 的互操作', () => {
  test('response 记录能被独立解析器完整读出', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const body = enc.encode('<html><body>看过《银翼杀手》</body></html>');
    const block = buildHttpResponseBlock({
      statusLine: 'HTTP/1.1 200 OK',
      headers: [['Content-Type', 'text/html; charset=utf-8']],
      body,
    });
    const recordId = newWarcRecordId();
    const rec = buildWarcRecord({
      type: 'response',
      recordId,
      date: AT,
      targetUri: 'https://www.douban.com/people/82160871/statuses?p=1',
      contentType: 'application/http;msgtype=response',
      headers: [['WARC-Block-Digest', await sha1Base32(block)]],
      block,
    });

    const [parsed] = await parseWithWarcio(await buildSegment([rec]));

    assert.equal(parsed.warcType, 'response');
    // WARC 头里带尖括号，这正是规范要求的形式
    assert.equal(parsed.recordId, `<${recordId}>`);
    assert.equal(parsed.targetURI, 'https://www.douban.com/people/82160871/statuses?p=1');
    assert.equal(parsed.statusline, 'HTTP/1.1 200 OK');
    assert.equal(parsed.httpHeader('Content-Type'), 'text/html; charset=utf-8');
    assert.deepEqual(new Uint8Array(parsed.content), body);
  });

  test('中文正文逐字节还原 —— Content-Length 用字节数是对的', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // 如果 Content-Length 误用字符数，独立解析器会在这里读出截断的正文，
    // 或者干脆把下一条记录的开头当成正文的一部分。
    const text = '豆瓣广播：《银翼杀手2049》看过了，很好。'.repeat(20);
    const body = enc.encode(text);
    // 字节数远大于字符数，正是这个测试要守的地方
    assert.ok(body.length > text.length * 2);
    const block = buildHttpResponseBlock({
      statusLine: 'HTTP/1.1 200 OK',
      headers: [['Content-Type', 'text/html; charset=utf-8']],
      body,
    });
    const rec = buildWarcRecord({
      type: 'response',
      recordId: newWarcRecordId(),
      date: AT,
      targetUri: 'https://www.douban.com/x',
      contentType: 'application/http;msgtype=response',
      block,
    });

    const [parsed] = await parseWithWarcio(await buildSegment([rec]));
    assert.deepEqual(new Uint8Array(parsed.content), body);
    assert.equal(new TextDecoder().decode(parsed.content), text);
  });

  test('非 UTF-8 的二进制载荷原样还原', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // 图片段要存的就是这种东西；「捕获时不做任何改写」必须经得起独立验证。
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x80]);
    const block = buildHttpResponseBlock({
      statusLine: 'HTTP/1.1 200 OK',
      headers: [['Content-Type', 'image/png']],
      body,
    });
    const rec = buildWarcRecord({
      type: 'response',
      recordId: newWarcRecordId(),
      date: AT,
      targetUri: 'https://img9.doubanio.com/view/status/small/public/x.jpg',
      contentType: 'application/http;msgtype=response',
      block,
    });

    const [parsed] = await parseWithWarcio(await buildSegment([rec]));
    assert.deepEqual(new Uint8Array(parsed.content), body);
  });

  test('warcinfo + 多条 response 拼成的段，能被逐条读出且顺序不变', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const records = [
      buildWarcinfoRecord({
        recordId: newWarcRecordId(),
        date: AT,
        filename: 'data-20260728T101500Z-a3f9c1-00001.warc.gz',
        bundleId: '20260728T101500Z-a3f9c1',
        software: 'doubak-extension/0.0.1',
      }),
    ];
    const bodies = ['第一页', 'second page', '第三页 mixed'];
    for (const [i, s] of bodies.entries()) {
      const block = buildHttpResponseBlock({
        statusLine: 'HTTP/1.1 200 OK',
        headers: [['Content-Type', 'text/html; charset=utf-8']],
        body: enc.encode(s),
      });
      records.push(
        buildWarcRecord({
          type: 'response',
          recordId: newWarcRecordId(),
          date: AT,
          targetUri: `https://www.douban.com/people/x/statuses?p=${i + 1}`,
          contentType: 'application/http;msgtype=response',
          block,
        }),
      );
    }

    const parsed = await parseWithWarcio(await buildSegment(records));

    assert.equal(parsed.length, 4, '段里应当正好 4 条记录');
    assert.equal(parsed[0].warcType, 'warcinfo');
    for (const [i, s] of bodies.entries()) {
      assert.equal(parsed[i + 1].warcType, 'response');
      assert.equal(parsed[i + 1].targetURI, `https://www.douban.com/people/x/statuses?p=${i + 1}`);
      assert.equal(new TextDecoder().decode(parsed[i + 1].content), s);
    }
  });

  test('我们算的 WARC-Block-Digest 与 warcio 读到的一致', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const block = buildHttpResponseBlock({
      statusLine: 'HTTP/1.1 200 OK',
      headers: [['Content-Type', 'text/plain']],
      body: enc.encode('digest 检查'),
    });
    const digest = await sha1Base32(block);
    const rec = buildWarcRecord({
      type: 'response',
      recordId: newWarcRecordId(),
      date: AT,
      targetUri: 'https://www.douban.com/x',
      contentType: 'application/http;msgtype=response',
      headers: [['WARC-Block-Digest', digest]],
      block,
    });

    const [parsed] = await parseWithWarcio(await buildSegment([rec]));
    assert.equal(parsed.blockDigest, digest);
    assert.match(digest, /^sha1:[A-Z2-7]+$/);
  });
});
