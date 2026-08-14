/**
 * 环境自检。
 *
 * 整个项目建立在「这些 Web API 是原生的，不需要任何库」这个判断上
 * （见 docs/toolchain.md）。如果哪天跑测试的 Node 太旧或缺了某个 API，
 * 应当在这里响亮地失败，而不是在某个写入器测试里以一条费解的报错出现。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSegmentText } from './helpers/gunzip-segment.js';

test('运行时具备 core/ 所需的全部 Web API', () => {
  assert.equal(typeof CompressionStream, 'function', '缺少 CompressionStream，无法写 warc.gz');
  assert.equal(typeof DecompressionStream, 'function', '缺少 DecompressionStream，测试无法验证 gzip');
  assert.equal(typeof crypto?.subtle?.digest, 'function', '缺少 crypto.subtle，无法算 SHA-256');
  assert.equal(typeof crypto?.randomUUID, 'function', '缺少 crypto.randomUUID，无法生成 WARC-Record-ID');
  assert.equal(typeof TextEncoder, 'function');
});

test('gzip 往返可用，且产出的是标准 gzip member', async () => {
  const original = 'WARC/1.1\r\n测试中文\r\n';

  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  void writer.write(new TextEncoder().encode(original));
  void writer.close();
  const compressed = new Uint8Array(await new Response(cs.readable).arrayBuffer());

  // gzip 魔数。段文件要能被 gzip/zcat 直接处理，这两个字节必须对。
  assert.equal(compressed[0], 0x1f);
  assert.equal(compressed[1], 0x8b);

  const ds = new DecompressionStream('gzip');
  const w2 = ds.writable.getWriter();
  void w2.write(compressed);
  void w2.close();
  assert.equal(await new Response(ds.readable).text(), original);
});

/** @param {string} s */
const gz = async (s) => {
  const cs = new CompressionStream('gzip');
  const w = cs.writable.getWriter();
  void w.write(new TextEncoder().encode(s));
  void w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
};

/** @param {Uint8Array} bytes */
const decompressionStream = async (bytes) => {
  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter();
  w.write(bytes).catch(() => {});
  w.close().catch(() => {});
  return new Response(ds.readable).text();
};

/** 两条首尾相接的 member —— 段文件最小的样子。 */
async function joinedMembers() {
  const a = await gz('第一条\n');
  const b = await gz('第二条\n');
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a, 0);
  joined.set(b, a.length);
  return { a, b, joined };
}

test('多个 gzip member 拼接后仍是合法的 .gz —— zcat / pywb 靠这条', async () => {
  // 段文件的核心性质：每条记录独立成一个 member，拼起来整体仍可读。
  // 这是 **RFC 1952** 的性质，所以要用一个真正实现了多 member 的解压器来验。
  const { joined } = await joinedMembers();
  assert.equal(gunzipSegmentText(joined), '第一条\n第二条\n');
});

test('每个 member 都能单独解开 —— 读取器按 offset/length 就是这么取的', async () => {
  const { a, b } = await joinedMembers();
  assert.equal(await decompressionStream(a), '第一条\n');
  assert.equal(await decompressionStream(b), '第二条\n');
});

/**
 * 这个运行时的 `DecompressionStream` 实现规范了吗——**探能力，不看版本号**。
 *
 * 浏览器一直实现着，Node 到 24.19.0 才实现。而这个仓库承诺 Node ≥ 20，所以在旧
 * Node 上只能「带原因跳过」，不能让整个套件红——那会把一条测试的口味变成安装门槛。
 * 跳过在本地是合理的；CI 用 `node-version: '24'`（浮动到最新），所以那边一定真跑。
 */
const singleMemberOnly = await (async () => {
  const a = await gz('a');
  const joined = new Uint8Array(a.length * 2);
  joined.set(a, 0);
  joined.set(a, a.length);
  try {
    await decompressionStream(joined);
    return false;
  } catch {
    return true;
  }
})();

test('**DecompressionStream 只认单个 member**，喂整段一定抛', {
  skip: singleMemberOnly
    ? false
    : `这个运行时的 DecompressionStream 还没实现规范里的「结束后不许有多余输入」`
      + `（${process.version}，Node 24.19.0 才补上）。浏览器一直都抛，所以这条约束仍然成立，`
      + '只是在这里验不了。',
}, async () => {
  // 这条不是在描述缺陷，是在钉住一条约束，因为它决定了读取器的写法。
  //
  // WHATWG Compression Streams 规定「压缩数据结束之后还有输入就抛 TypeError」，
  // 三家浏览器一直都这么做（Chrome “Junk found after end of compressed data”、
  // Firefox “Unexpected input after the end of stream”、Safari “Extra bytes past
  // the end”）。**Node 是唯一不抛的那个**，直到 24.19.0 补齐（nodejs/node#58247）。
  //
  // 也就是说，原来那条「整体解压」的断言在浏览器里从来就没成立过，只是靠 Node
  // 当时的宽松绿着——而这个扩展只跑在浏览器里。Node 那次升级没有搞坏测试，
  // 是把一盏假绿灯照了出来。
  //
  // 所以 `gunzip()` 只能拿来解**一条** member。要整段读，用 node:zlib 或 warcio。
  const { joined } = await joinedMembers();
  await assert.rejects(() => decompressionStream(joined));
});
