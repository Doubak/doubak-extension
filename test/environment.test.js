/**
 * 环境自检。
 *
 * 整个项目建立在「这些 Web API 是原生的，不需要任何库」这个判断上
 * （见 docs/toolchain.md）。如果哪天跑测试的 Node 太旧或缺了某个 API，
 * 应当在这里响亮地失败，而不是在某个写入器测试里以一条费解的报错出现。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

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

test('多个 gzip member 拼接后可被整体解压', async () => {
  // 这是段文件的核心性质：每条记录独立成一个 gzip member，
  // 拼起来仍是合法的 .gz —— 既能整体读，也能按偏移量单独读某一条。
  /** @param {string} s */
  const gz = async (s) => {
    const cs = new CompressionStream('gzip');
    const w = cs.writable.getWriter();
    void w.write(new TextEncoder().encode(s));
    void w.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  };

  const a = await gz('第一条\n');
  const b = await gz('第二条\n');
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a, 0);
  joined.set(b, a.length);

  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter();
  void w.write(joined);
  void w.close();
  assert.equal(await new Response(ds.readable).text(), '第一条\n第二条\n');
});
