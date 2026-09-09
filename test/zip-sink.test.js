/**
 * 「Firefox 导出的 zip，解开之后与 Chrome 导出的目录逐字节相同。」
 *
 * ## 为什么这一条是全部设计的支点
 *
 * Firefox 没有 File System Access，所以那边只能交出一个 zip。而整套说法——
 * 「它不是 Firefox 专用格式，只是个壳子」——**全部挂在这一条不变量上**：
 *
 * - 跨浏览器可用：解开就是 Chrome 那边「搬回来」认的那个文件夹；
 * - 下游可用：`bin/parse.js` / `bin/verify.js` / `validate.py` 收的都是目录；
 * - 界面上那句「解开之后与 Chrome 导出的完全一样」不是宣传，是可核对的事实。
 *
 * 它一旦不成立，前面三句就同时变成假话，而且**是静默的**：zip 照样能解开，
 * 只是里面的东西跟另一条路产出的不一样。所以这里逐字节对。
 *
 * 解压一律用**系统的 `unzip`**，不用我们自己的读回器：写出器和读回器同源，
 * 一起错的时候两边都看不出来。这与 NeoDB 那个包用的是同一条判据。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exportBundle, fileStoreSink } from '../src/bundle/exporter.js';
import { zipSink, subdirectoryZipSink } from '../src/bundle/zip-sink.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { ZipWriter } from '../src/vendor/export-adapters/zip.js';
import { sha256Hex } from '../src/core/digest.js';

const enc = new TextEncoder();

/** 系统上有没有 unzip。没有的话只能跳过——而跳过等于没测。 */
const HAS_UNZIP = (() => {
  try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

/** 造一份像样的档案：段是二进制（真实档案里 26% 是 JPEG），索引与 manifest 是文本。 */
async function makeBundle() {
  const store = new MemoryFileStore();
  const seg = new Uint8Array(9000);
  for (let i = 0; i < seg.length; i++) seg[i] = (i * 7) % 256; // 覆盖 0 与 255
  await store.replace('data-000001.warc.gz', seg);
  const index = enc.encode('{"capture_id":"#000001"}\n');
  await store.replace('index.ndjson', index);
  await store.replace('manifest.json', enc.encode(JSON.stringify({
    spec_version: 'bundle/1.4.0',
    segments: [{ filename: 'data-000001.warc.gz', bytes: seg.length, sha256: await sha256Hex(seg) }],
    index: { filename: 'index.ndjson', sha256: await sha256Hex(index), line_count: 1 },
  })));
  await store.replace('README.txt', enc.encode('说明\n'));
  return store;
}

/** 收集 ZipWriter 吐出来的字节。 */
function sink() {
  /** @type {Uint8Array[]} */
  const parts = [];
  const writer = new ZipWriter({ write: (c) => { parts.push(c); } });
  return {
    writer,
    bytes() {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) { out.set(p, at); at += p.length; }
      return out;
    },
  };
}

describe('zip 只是个壳子', () => {
  test('**解开之后与目录导出逐字节相同**', { skip: HAS_UNZIP ? false : '没有 unzip' }, async () => {
    const store = await makeBundle();

    // ① Chrome 那条路：写进一个目录
    const dir = new MemoryFileStore();
    const a = await exportBundle({ store, sink: fileStoreSink(dir) });

    // ② Firefox 那条路：写进一个 zip
    const s = sink();
    const b = await exportBundle({ store, sink: zipSink(s.writer) });
    await s.writer.finish();

    assert.equal(a.problems.length, 0);
    assert.equal(b.problems.length, 0);

    // ③ 解开，逐个文件比字节
    const tmp = mkdtempSync(join(tmpdir(), 'doubak-zipsink-'));
    const path = join(tmp, 'a.zip');
    writeFileSync(path, s.bytes());
    assert.match(execFileSync('unzip', ['-t', path], { encoding: 'utf8' }), /No errors detected/);
    execFileSync('unzip', ['-q', path, '-d', join(tmp, 'out')]);

    const names = (await dir.list()).sort();
    assert.ok(names.length >= 4, `目录那边只有 ${names.length} 个文件，判据多半坏了`);
    const inZip = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).trim().split('\n').sort();
    assert.deepEqual(inZip, names, 'zip 里的文件名与目录里的对不上');

    for (const name of names) {
      assert.deepEqual(
        new Uint8Array(readFileSync(join(tmp, 'out', name))),
        await dir.read(name),
        `${name} 的字节两条路不一样`,
      );
    }
  });

  test('一份档案一个子目录，名字与 OPFS、与 Chrome 导出的一致', { skip: HAS_UNZIP ? false : '没有 unzip' }, async () => {
    // 「搬回来的时候不用改名」——这是「壳子不是格式」的技术前提之一。
    const store = await makeBundle();
    const s = sink();
    await exportBundle({ store, sink: subdirectoryZipSink(s.writer, 'doubak-bundle-3eef52') });
    await s.writer.finish();

    const tmp = mkdtempSync(join(tmpdir(), 'doubak-zipsub-'));
    const path = join(tmp, 'a.zip');
    writeFileSync(path, s.bytes());
    const inZip = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).trim().split('\n');
    assert.ok(inZip.length >= 4);
    for (const n of inZip) assert.match(n, /^doubak-bundle-3eef52\//, `${n} 不在那个子目录里`);
  });

  test('路径分隔符一律是 `/`', async () => {
    // zip 规范只认它（4.4.17.1）。拼成反斜杠的话，解压工具会把它当成**文件名里
    // 带反斜杠的一个文件**，目录结构当场没了——而「解开就是那个目录」正是前提。
    const s = sink();
    const sk = subdirectoryZipSink(s.writer, 'doubak-bundle-x');
    const w = await sk.open('data-000001.warc.gz');
    await w.write(new Uint8Array([1]));
    await w.close();
    await s.writer.finish();
    const text = new TextDecoder('latin1').decode(s.bytes());
    assert.ok(text.includes('doubak-bundle-x/data-000001.warc.gz'));
    assert.ok(!text.includes('\\'), 'zip 里出现了反斜杠');
  });

  test('**没有 read/list，而导出器早就为这种情况写好了话**', async () => {
    // zip 是一次写完的流，回头读不了。exporter.js 的契约允许缺这两个，
    // 并且会如实说「目的地读不回来，无法校验」——不许假装校验过了。
    const store = await makeBundle();
    const s = sink();
    const r = await exportBundle({ store, sink: zipSink(s.writer) });
    await s.writer.finish();
    assert.equal(r.verified, false, '读不回来就不能自称校验过');
    assert.ok(r.files.some((f) => f.reason === '目的地读不回来，无法校验'));
  });

  test('目录那条路仍然校验得了 —— 两边的差别是**真的**', async () => {
    // 上一条如果是因为别的原因失败（比如 exportBundle 压根不校验了），
    // 它就变成一条永远绿的测试。这一条从反方向钉住。
    const store = await makeBundle();
    const dir = new MemoryFileStore();
    const r = await exportBundle({ store, sink: fileStoreSink(dir) });
    assert.equal(r.verified, true);
  });
});
