import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  exportBundle, fileStoreSink, NOT_PART_OF_BUNDLE, DEFAULT_CHUNK_BYTES, subdirectorySink,
} from '../src/bundle/exporter.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { sha256Hex } from '../src/core/digest.js';
import { BundleWriter } from '../src/bundle/bundle-writer.js';
import { bundleDirName } from '../src/core/ids.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 造一个像样的档案目录：段文件 + 索引 + manifest（带真摘要）+ 内部 checkpoint。 */
async function makeBundle({ segBytes = 5000 } = {}) {
  const store = new MemoryFileStore();

  const seg = new Uint8Array(segBytes);
  for (let i = 0; i < seg.length; i++) seg[i] = i % 251;
  await store.replace('data-000001.warc.gz', seg);

  const index = enc.encode('{"capture_id":"#000001"}\n{"capture_id":"#000002"}\n');
  await store.replace('index.ndjson', index);

  await store.replace('manifest.json', enc.encode(JSON.stringify({
    spec_version: 'bundle/1.0.0',
    segments: [
      { filename: 'data-000001.warc.gz', bytes: seg.length, sha256: await sha256Hex(seg) },
    ],
    index: { filename: 'index.ndjson', sha256: await sha256Hex(index), line_count: 2 },
  })));

  await store.replace('README.txt', enc.encode('说明\n'));
  // 抓取内部状态，不该跟着档案走
  await store.replace('checkpoint.json', enc.encode('{"pause_reason":"crash"}'));

  return { store, seg, index };
}

describe('导出', () => {
  test('整份复制并逐个校验通过', async () => {
    const { store, seg } = await makeBundle();
    const dest = new MemoryFileStore();

    const r = await exportBundle({ store, sink: fileStoreSink(dest) });

    assert.equal(r.problems.length, 0);
    assert.equal(r.verified, true);
    assert.deepEqual(await dest.read('data-000001.warc.gz'), seg);
    assert.equal(dec.decode(await dest.read('README.txt')), '说明\n');
  });

  test('checkpoint.json 不跟着档案走', async () => {
    // 它是抓取过程的内部状态，不是档案的一部分。带出去会让人以为导出的
    // 这份能拿去接着抓。
    const { store } = await makeBundle();
    const dest = new MemoryFileStore();

    await exportBundle({ store, sink: fileStoreSink(dest) });

    assert.equal(await dest.exists('checkpoint.json'), false);
    assert.ok(NOT_PART_OF_BUNDLE.has('checkpoint.json'));
    // 但源头那份不许动——导出是只读操作
    assert.equal(await store.exists('checkpoint.json'), true);
  });

  test('分块搬运，一次不超过 chunkBytes', async () => {
    // 真实段文件上限 256 MiB。整份读进内存会在低配机器上直接崩，而崩的
    // 时间点正是用户刚点完「导出」的时候。
    const { store, seg } = await makeBundle({ segBytes: 5000 });
    const dest = new MemoryFileStore();

    /** @type {number[]} */
    const chunks = [];
    const sink = fileStoreSink(dest);
    const inner = sink.open.bind(sink);
    sink.open = async (name) => {
      const h = await inner(name);
      return { write: (b) => { chunks.push(b.length); return h.write(b); }, close: h.close };
    };

    await exportBundle({ store, sink, chunkBytes: 1024 });

    assert.ok(chunks.length >= 5, `段文件该被切成多块，实际 ${chunks.length} 块`);
    assert.ok(Math.max(...chunks) <= 1024, `有一块超了：${Math.max(...chunks)}`);
    assert.deepEqual(await dest.read('data-000001.warc.gz'), seg);
  });

  test('目的地被截断 → 报字节数对不上，且不算「已校验」', async () => {
    // 这是导出真正会出的错：配额耗尽、U 盘拔了、写入被中断。而用户导完
    // 就会删掉 OPFS 那份——悄悄少几个字节等于唯一的副本没了。
    const { store } = await makeBundle();
    const dest = new MemoryFileStore();
    const sink = fileStoreSink(dest);
    const inner = sink.open.bind(sink);
    sink.open = async (name) => {
      const h = await inner(name);
      if (name !== 'data-000001.warc.gz') return h;
      // 只写前一半，模拟写到一半没了
      return { write: (b) => h.write(b.slice(0, Math.floor(b.length / 2))), close: h.close };
    };

    const r = await exportBundle({ store, sink });

    assert.equal(r.verified, false);
    assert.equal(r.problems.length, 1);
    assert.equal(r.problems[0].name, 'data-000001.warc.gz');
    assert.equal(r.problems[0].sizeOk, false);
    assert.match(r.problems[0].reason, /字节数对不上/);
  });

  test('字节数对但内容被改 → 摘要抓得出来', async () => {
    const { store } = await makeBundle();
    const dest = new MemoryFileStore();
    const sink = fileStoreSink(dest);

    await exportBundle({ store, sink });
    // 导完之后动一个字节，再单独验一遍
    const data = await dest.read('data-000001.warc.gz');
    data[100] ^= 0xff;
    await dest.replace('data-000001.warc.gz', data);

    const r2 = await exportBundle({ store: dest, sink: fileStoreSink(new MemoryFileStore()) });
    assert.equal(r2.verified, false);
    assert.match(r2.problems[0].reason, /摘要对不上/);
  });

  test('校验回读的是目的地，不是源头', async () => {
    // 源头对不对根本不是问题所在——问题是字节有没有真的落到用户的盘上。
    const { store } = await makeBundle();
    const dest = new MemoryFileStore();
    const sink = fileStoreSink(dest);

    let readsFromSource = 0;
    const origRead = store.read.bind(store);
    store.read = (...a) => { readsFromSource += 1; return origRead(...a); };

    let readsFromDest = 0;
    const sinkRead = sink.read;
    sink.read = (n) => { readsFromDest += 1; return sinkRead(n); };

    const r = await exportBundle({ store, sink });

    assert.equal(r.verified, true);
    assert.equal(readsFromDest, 4, '每个导出的文件都该被回读一次');
    assert.ok(readsFromSource > 0);
  });

  test('manifest 声明了却没导出的文件必须被逮到', async () => {
    // 这种残缺在结果列表里根本不出现，因此不会被逐文件的检查逮到——
    // 只能反过来从 manifest 的声明去找。
    const { store } = await makeBundle();
    await store.remove('data-000001.warc.gz');
    const dest = new MemoryFileStore();

    const r = await exportBundle({ store, sink: fileStoreSink(dest) });

    assert.equal(r.verified, false);
    assert.equal(r.problems.length, 1);
    assert.equal(r.problems[0].name, 'data-000001.warc.gz');
    assert.match(r.problems[0].reason, /manifest 声明了/);
  });

  test('manifest.json 与 README.txt 没有自摘要，不该把整次导出拖成「未校验」', async () => {
    // manifest 装不下自己的摘要，README 是生成的说明文字。这两个没有摘要
    // 可对是常态，不是缺陷。
    const { store } = await makeBundle();
    const dest = new MemoryFileStore();

    const r = await exportBundle({ store, sink: fileStoreSink(dest) });

    assert.equal(r.verified, true);
    const m = r.files.find((f) => f.name === 'manifest.json');
    assert.equal(m.sizeOk, true);
    assert.equal(m.digestOk, null);
  });

  test('没有 manifest：照样导出，但如实说只验了字节数', async () => {
    // 抓取还没收尾时本来就没有 manifest。用户照样有权把手上的东西导出去，
    // 但界面不许因此显示成「已校验」。
    const { store } = await makeBundle();
    await store.remove('manifest.json');
    const dest = new MemoryFileStore();

    const r = await exportBundle({ store, sink: fileStoreSink(dest) });

    assert.equal(r.problems.length, 0);
    assert.equal(r.verified, false, '没验过摘要就不能叫「已校验」');
    assert.equal(r.verifiedSizeOnly, true);
    for (const f of r.files) {
      assert.equal(f.sizeOk, true);
      assert.equal(f.digestOk, null);
    }
  });

  test('manifest 坏了不阻止导出', async () => {
    // 手上这份再残破，也比留在随时可能被清掉的 OPFS 里强。
    const { store } = await makeBundle();
    await store.replace('manifest.json', enc.encode('{ 这不是 JSON'));
    const dest = new MemoryFileStore();

    const r = await exportBundle({ store, sink: fileStoreSink(dest) });
    assert.equal(r.problems.length, 0);
    assert.equal(r.verified, false);
    assert.equal(r.verifiedSizeOnly, true);
  });

  test('verify:false 明确标成「按要求跳过了校验」，不冒充通过', async () => {
    const { store } = await makeBundle();
    const dest = new MemoryFileStore();

    const r = await exportBundle({ store, sink: fileStoreSink(dest), verify: false });

    assert.equal(r.verified, false);
    assert.equal(r.verifiedSizeOnly, false);
    for (const f of r.files) assert.equal(f.reason, '按要求跳过了校验');
  });

  test('目的地读不回来 → 报「无法校验」，不报通过', async () => {
    const { store } = await makeBundle();
    const dest = new MemoryFileStore();
    const sink = fileStoreSink(dest);
    delete sink.read;

    const r = await exportBundle({ store, sink });

    assert.equal(r.verified, false);
    assert.equal(r.problems.length, 0, '读不回来不是「导错了」，是「验不了」');
    for (const f of r.files) assert.equal(f.reason, '目的地读不回来，无法校验');
  });

  test('目的地非空时默认拒绝，且给得出是哪些文件', async () => {
    // 目的地是用户在文件选择器里随手点的一个目录，完全可能是文档目录。
    // 同名即覆盖，而覆盖掉的东西没有回收站。
    const { store } = await makeBundle();
    const dest = new MemoryFileStore();
    await dest.replace('我的论文.docx', enc.encode('x'));

    await assert.rejects(
      () => exportBundle({ store, sink: fileStoreSink(dest) }),
      (e) => {
        assert.equal(e.code, 'destination_not_empty');
        assert.deepEqual(e.existing, ['我的论文.docx']);
        assert.match(e.message, /我的论文\.docx/);
        return true;
      },
    );
    // 拒绝就是真的什么都没写
    assert.deepEqual(await dest.list(), ['我的论文.docx']);
  });

  test('overwrite:true 时才照写', async () => {
    const { store } = await makeBundle();
    const dest = new MemoryFileStore();
    await dest.replace('旧文件.txt', enc.encode('x'));

    const r = await exportBundle({ store, sink: fileStoreSink(dest), overwrite: true });
    assert.equal(r.verified, true);
    assert.equal(await dest.exists('data-000001.warc.gz'), true);
  });

  test('空目录直接拒绝', async () => {
    await assert.rejects(
      () => exportBundle({ store: new MemoryFileStore(), sink: fileStoreSink(new MemoryFileStore()) }),
      /空的/,
    );
  });

  test('只有 checkpoint 的目录也算空', async () => {
    const store = new MemoryFileStore();
    await store.replace('checkpoint.json', enc.encode('{}'));
    await assert.rejects(
      () => exportBundle({ store, sink: fileStoreSink(new MemoryFileStore()) }),
      /空的/,
    );
  });

  test('空文件也要建出来', async () => {
    // 崩溃恢复之后是可能出现空段文件的。少一个文件和少一段内容一样是残缺。
    const { store } = await makeBundle();
    await store.replace('data-000002.warc.gz', new Uint8Array(0));
    const dest = new MemoryFileStore();

    await exportBundle({ store, sink: fileStoreSink(dest) });

    assert.equal(await dest.exists('data-000002.warc.gz'), true);
    assert.equal(await dest.size('data-000002.warc.gz'), 0);
  });

  test('取消：抛出来，且已经关掉了句柄', async () => {
    const { store } = await makeBundle({ segBytes: 100_000 });
    const dest = new MemoryFileStore();
    const ac = new AbortController();

    let closed = 0;
    const sink = fileStoreSink(dest);
    const inner = sink.open.bind(sink);
    sink.open = async (name) => {
      const h = await inner(name);
      return {
        write: async (b) => { await h.write(b); ac.abort(); },
        close: async () => { closed += 1; return h.close(); },
      };
    };

    await assert.rejects(
      () => exportBundle({ store, sink, chunkBytes: 1024, signal: ac.signal }),
      /取消/,
    );
    // 半开的句柄在 File System Access 那边会把文件留在未落盘状态，
    // 比一个明确写坏了的文件更难查。
    assert.equal(closed, 1);
  });

  test('进度回调覆盖两个阶段，且 done 单调不减', async () => {
    const { store } = await makeBundle({ segBytes: 10_000 });
    const dest = new MemoryFileStore();
    /** @type {object[]} */
    const seen = [];

    await exportBundle({
      store, sink: fileStoreSink(dest), chunkBytes: 1024,
      onProgress: (p) => seen.push(p),
    });

    assert.ok(seen.some((p) => p.phase === 'copy'));
    assert.ok(seen.some((p) => p.phase === 'verify'));
    const copy = seen.filter((p) => p.phase === 'copy' && p.file === 'data-000001.warc.gz');
    for (let i = 1; i < copy.length; i++) assert.ok(copy[i].done >= copy[i - 1].done);
    assert.equal(copy.at(-1).done, copy.at(-1).total);
  });

  test('默认块大小是个合理值', () => {
    assert.ok(DEFAULT_CHUNK_BYTES >= 1024 * 1024);
    assert.ok(DEFAULT_CHUNK_BYTES <= 32 * 1024 * 1024);
  });
});

describe('导出整条链：每份各占一个子目录', () => {
  /**
   * 每份档案都有 `manifest.json` 与 `README.txt`。平铺到同一个目录里，后一份会
   * 覆盖前一份——**这不是理论问题**：真实使用中用户的下载目录里就只剩了最后一次
   * 导出的 manifest，早先几份的全被盖掉，以至于事后想核对哪份接在哪份后面都做不到。
   */

  /** 假的 FileSystemDirectoryHandle：只实现导出用得到的那几个方法。 */
  function fakeDir() {
    /** @type {Map<string, Map<string, Uint8Array>>} 子目录名 → 文件 */
    const subs = new Map();
    /** @type {Map<string, Uint8Array>} 本级文件 */
    const own = new Map();
    const mk = (files) => ({
      async getFileHandle(name, opts) {
        if (!files.has(name) && !opts?.create) throw new Error('没有这个文件');
        return {
          async createWritable() {
            const parts = [];
            return {
              async write(b) { parts.push(b); },
              async close() {
                const n = parts.reduce((a, p) => a + p.length, 0);
                const buf = new Uint8Array(n);
                let o = 0;
                for (const p of parts) { buf.set(p, o); o += p.length; }
                files.set(name, buf);
              },
            };
          },
          async getFile() {
            return { arrayBuffer: async () => files.get(name).buffer };
          },
        };
      },
      async *keys() { yield* files.keys(); },
      async getDirectoryHandle(name) {
        if (!subs.has(name)) subs.set(name, new Map());
        return mk(subs.get(name));
      },
    });
    return { handle: mk(own), subs, own };
  }

  async function bundleStore(id) {
    const store = new MemoryFileStore();
    const w = new BundleWriter({
      store, bundleId: id, account: { user_id: '1', username: 'e' },
      now: () => new Date('2026-07-31T00:00:00Z'),
    });
    await w.writeCapture({
      url: 'https://www.douban.com/people/e/', intent: 'profile.overview',
      routeKey: 'profile.overview', surface: 'html', verdict: 'ok',
      captureFidelity: 'decoded_body+observed_headers', httpStatus: 200,
      headers: [['Content-Type', 'text/html']], contentType: 'text/html',
      body: new TextEncoder().encode(`<html>${id}</html>`),
    });
    await w.finalize();
    return store;
  }

  test('两份档案导进两个子目录，manifest 不互相覆盖', async () => {
    const { handle, subs } = fakeDir();
    const ids = ['20260731T051333Z-786e5c', '20260731T122837Z-afb38b'];
    for (const id of ids) {
      const sink = await subdirectorySink(handle, bundleDirName(id));
      const r = await exportBundle({ store: await bundleStore(id), sink, overwrite: true });
      assert.equal(r.problems.length, 0, `${id} 导出有问题`);
    }

    assert.deepEqual([...subs.keys()].sort(), ids.map(bundleDirName).sort());
    for (const id of ids) {
      const files = subs.get(bundleDirName(id));
      assert.ok(files.has('manifest.json'), `${id} 少了 manifest`);
      const m = JSON.parse(new TextDecoder().decode(files.get('manifest.json')));
      assert.equal(m.bundle_id, id, '两份的 manifest 串了');
    }
  });

  test('子目录名与 OPFS 里一致 —— 搬回来时不用改名', async () => {
    const { handle, subs } = fakeDir();
    const id = '20260731T051333Z-786e5c';
    await subdirectorySink(handle, bundleDirName(id));
    assert.ok(subs.has(`doubak-bundle-${id}`));
  });
});
