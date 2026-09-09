/**
 * 目的地这一层：**「导出的字节交到哪儿」只判一次。**
 *
 * ## 这个文件守的是哪种错
 *
 * 2026-09-09 之前，三个写入点（整条链、单份档案、导出页的派生产物）各自写着
 * 「没有 `showDirectoryPicker` 就报错，请用 Chrome 或 Edge」。**那句话是对的，
 * 但它指的下一步是错的**——档案在这个浏览器里，换个浏览器根本拿不到。这与 #12
 * 是同一个形状：一句正确的拒绝，指向一条修不好的路。
 *
 * 所以这里有两类断言，缺一不可：
 *
 * - **正的**：zip 那条路真的走得通，解开之后是标准的档案目录（拿系统 `unzip` 验，
 *   不用我们自己的读回器——写出器与读回器同源，一起错的时候两边都看不出来）；
 * - **反的**：那句「请用 Chrome 或 Edge」不许在导出路径上长回来，而且判据要能
 *   区分「导出」与「导入」——导入那一侧今天**确实还没做**，把它一起禁掉就是
 *   写一条自己都不打算遵守的规则。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { exportBundle } from '../src/bundle/exporter.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { sha256Hex } from '../src/core/digest.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const src = (p) => readFile(new URL(`../src/ui/panel/${p}`, import.meta.url), 'utf8');

const HAS_UNZIP = (() => {
  try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

// ── 一个够用的假 OPFS ───────────────────────────────────────────
//
// `zipDestination` 要 `navigator.storage.getDirectory()` → `getFileHandle` →
// `createWritable` → `getFile`。真 OPFS 在 Node 里没有，而**这一层的错正好都在
// 接缝上**（中转目录先清没清、收尾之后 `getFile` 拿到的是不是完整的那一份），
// 所以假一个比只读源码强得多。
function fakeOpfs() {
  const files = new Map();
  const removed = [];
  const dirFor = (name) => ({
    async getFileHandle(fname) {
      const key = `${name}/${fname}`;
      if (!files.has(key)) files.set(key, []);
      return {
        async createWritable() {
          files.set(key, []);
          return {
            write: async (chunk) => { files.get(key).push(chunk.slice()); },
            close: async () => {},
          };
        },
        async getFile() {
          const parts = files.get(key);
          const total = parts.reduce((n, p) => n + p.length, 0);
          const buf = new Uint8Array(total);
          let at = 0;
          for (const p of parts) { buf.set(p, at); at += p.length; }
          return { size: buf.length, _bytes: buf };
        },
      };
    },
  });
  return {
    files,
    removed,
    storage: {
      getDirectory: async () => ({
        getDirectoryHandle: async (name) => dirFor(name),
        removeEntry: async (name) => { removed.push(name); },
      }),
    },
  };
}

/** 面板那一侧要 `document` 与 `URL.createObjectURL`。 */
function fakeWindow() {
  const clicks = [];
  const revoked = [];
  const timers = [];
  const el = () => ({
    href: '', download: '', rel: '',
    click() { clicks.push({ href: this.href, download: this.download }); },
    remove() {},
  });
  const prev = {
    document: globalThis.document,
    URL: globalThis.URL.createObjectURL,
    revoke: globalThis.URL.revokeObjectURL,
    setTimeout: globalThis.setTimeout,
    navigator: globalThis.navigator,
  };
  globalThis.document = { createElement: el, body: { append() {} } };
  globalThis.URL.createObjectURL = (f) => `blob:fake/${f.size}`;
  globalThis.URL.revokeObjectURL = (u) => revoked.push(u);
  globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return 0; };
  return {
    clicks,
    revoked,
    timers,
    restore() {
      globalThis.document = prev.document;
      globalThis.URL.createObjectURL = prev.URL;
      globalThis.URL.revokeObjectURL = prev.revoke;
      globalThis.setTimeout = prev.setTimeout;
      if (prev.navigator === undefined) delete globalThis.navigator;
      else Object.defineProperty(globalThis, 'navigator', { value: prev.navigator, configurable: true });
    },
  };
}

async function makeBundle() {
  const store = new MemoryFileStore();
  const seg = new Uint8Array(5000);
  for (let i = 0; i < seg.length; i++) seg[i] = (i * 11) % 256;
  await store.replace('data-000001.warc.gz', seg);
  const index = enc.encode('{"capture_id":"#000001"}\n');
  await store.replace('index.ndjson', index);
  await store.replace('manifest.json', enc.encode(JSON.stringify({
    spec_version: 'bundle/1.4.0',
    segments: [{ filename: 'data-000001.warc.gz', bytes: seg.length, sha256: await sha256Hex(seg) }],
    index: { filename: 'index.ndjson', sha256: await sha256Hex(index), line_count: 1 },
  })));
  return { store, seg };
}

describe('zip 那条路真的交得出东西', () => {
  test('导一份档案 → 收尾 → 交给下载，解开之后是 doubak-bundle-<编号>/', async (t) => {
    if (!HAS_UNZIP) return t.skip('系统上没有 unzip');
    const opfs = fakeOpfs();
    const w = fakeWindow();
    Object.defineProperty(globalThis, 'navigator', { value: opfs, configurable: true });
    try {
      const { zipDestination, shellReadme } = await import('../src/ui/panel/destination.js');
      const { store, seg } = await makeBundle();
      const dest = await zipDestination({
        zipName: 'doubak-archive-x.zip',
        readme: shellReadme('标准的档案目录'),
      });
      assert.equal(dest.kind, 'zip');

      const sink = await dest.sinkFor('doubak-bundle-20260909T082446Z-195f8e');
      const r = await exportBundle({ store, sink, overwrite: true });
      assert.equal(r.problems.length, 0);

      const handed = await dest.finish();
      assert.equal(handed.name, 'doubak-archive-x.zip');
      assert.ok(handed.bytes > seg.length);

      // **真的点了下载**，而且文件名就是那个 —— 少了这一步，前面全白做。
      assert.deepEqual(w.clicks.map((c) => c.download), ['doubak-archive-x.zip']);

      // 系统 unzip 认不认。这是判据，不是我们自己的读回器。
      const file = await (await (await opfs.storage.getDirectory())
        .getDirectoryHandle('doubak-export-staging')).getFileHandle('doubak-archive-x.zip');
      const bytes = (await file.getFile())._bytes;
      const dir = mkdtempSync(join(tmpdir(), 'doubak-dest-'));
      writeFileSync(join(dir, 'a.zip'), bytes);
      execFileSync('unzip', ['-q', 'a.zip'], { cwd: dir });

      const inner = 'doubak-bundle-20260909T082446Z-195f8e';
      assert.deepEqual(readdirSync(join(dir, inner)).sort(),
        ['data-000001.warc.gz', 'index.ndjson', 'manifest.json']);
      // 段文件逐字节相同 —— 「解开之后与目录导出一样」那条不变量的落点。
      assert.deepEqual(
        new Uint8Array(readFileSync(join(dir, inner, 'data-000001.warc.gz'))), seg,
      );
      // 根上那句「这是个壳子」。
      const note = readFileSync(join(dir, '先看这个.txt'), 'utf8');
      assert.match(note, /zip 壳子，不是另一种格式/);
      assert.ok(!/专用格式/.test(note), 'zip 里那句话把它说成了专用格式');
    } finally {
      w.restore();
    }
  });

  test('**开始时先清中转目录，不是结束时清**', async () => {
    // `<a download>` 点下去之后没有任何事件告诉我们浏览器读完了没有。此时删掉
    // OPFS 里那份，下载会**静默截断**——用户拿到一个能打开、但少了东西的 zip。
    const opfs = fakeOpfs();
    const w = fakeWindow();
    Object.defineProperty(globalThis, 'navigator', { value: opfs, configurable: true });
    try {
      const { zipDestination, STAGING_DIR } = await import('../src/ui/panel/destination.js');
      const dest = await zipDestination({ zipName: 'a.zip' });
      assert.deepEqual(opfs.removed, [STAGING_DIR], '开头没清');
      await dest.finish();
      assert.deepEqual(opfs.removed, [STAGING_DIR], '收尾时清掉了 —— 下载会被截断');
    } finally {
      w.restore();
    }
  });

  test('**撤销 object URL 是延后的**，不是紧接着 click', async () => {
    const opfs = fakeOpfs();
    const w = fakeWindow();
    Object.defineProperty(globalThis, 'navigator', { value: opfs, configurable: true });
    try {
      const { zipDestination, REVOKE_DELAY_MS } = await import('../src/ui/panel/destination.js');
      const dest = await zipDestination({ zipName: 'a.zip' });
      await dest.finish();
      assert.deepEqual(w.revoked, [], '当场撤销了 —— 下载会被掐断');
      const [t] = w.timers;
      assert.equal(t.ms, REVOKE_DELAY_MS);
      t.fn();
      assert.equal(w.revoked.length, 1, '一直没撤销，那个 File 就永远钉在内存里');
      // 一个 619 MB 的档案在实测 230 MB/s 下是几秒钟；留两个数量级。
      assert.ok(REVOKE_DELAY_MS >= 60_000, `撤销等得太短：${REVOKE_DELAY_MS} ms`);
    } finally {
      w.restore();
    }
  });

  test('中转目录**不叫 `doubak-bundle-*`**', async () => {
    // 那个前缀是档案扫描的判据（`bundleIdFromDirName`）。撞上的话，一个半截的
    // 中转文件会被当成一份档案列进选择器里。
    const { STAGING_DIR } = await import('../src/ui/panel/destination.js');
    const { bundleIdFromDirName } = await import('../src/core/ids.js');
    assert.equal(bundleIdFromDirName(STAGING_DIR), null);
  });
});

describe('那句「请用 Chrome 或 Edge」不许在导出路径上长回来', () => {
  test('三个写入点都不自己判 showDirectoryPicker', async () => {
    // 判据只认**自己判一次**这件事：`canPickDirectory()` 是唯一的入口，
    // 而它只在 destination.js 里读那个属性。
    for (const f of ['export.js', 'formats.js']) {
      const js = await src(f);
      assert.doesNotMatch(js, /typeof window\.showDirectoryPicker !== 'function'/,
        `${f} 又自己判了一次「有没有 File System Access」`);
      assert.doesNotMatch(js, /请用? ?Chrome 或 Edge/,
        `${f} 又把用户支去换浏览器了 —— 档案在这个浏览器里`);
      assert.match(js, /canPickDirectory\(\)/, `${f} 没走统一的那个判据`);
    }
    const d = await src('destination.js');
    assert.match(d, /typeof globalThis\.window\?\.showDirectoryPicker === 'function'/);
  });

  test('**每一个**选文件夹的调用都在那道判据后面，不是「文件里有那么一处」', async () => {
    // 第一版只断言 `canPickDirectory()` 在文件里出现过。突变验出来它是空的：
    // export.js 有两个写入点，把其中一个改回无条件弹选择器，测试照样全绿——
    // 而那个写入点在 Firefox 上会直接抛 TypeError，比原来那句「请用 Chrome」还糟。
    //
    // 判据换成**数量对得上**：有几处选文件夹，就得有几道判据。
    for (const [f, n] of [['export.js', 2], ['formats.js', 1]]) {
      const js = await src(f);
      const pickers = js.match(/window\.showDirectoryPicker\(/g) ?? [];
      const guards = js.match(/if \(canPickDirectory\(\)\)/g) ?? [];
      assert.equal(pickers.length, n, `${f} 里选文件夹的地方变成了 ${pickers.length} 处`);
      assert.equal(guards.length, pickers.length,
        `${f} 里有 ${pickers.length} 处选文件夹，却只有 ${guards.length} 道判据`);
      // 而且每一处都要有 zip 那条退路 —— 有判据没退路等于换个地方拒绝。
      assert.match(js, /await zipDestination\(\{/, `${f} 没有 zip 那条路`);
    }
  });

  test('**导入那一侧还没做，所以它照旧那么说**', async () => {
    // 这条不是给导入放行，是把「还没做」钉成一句会红的话：真做了之后这条测试
    // 会红，改它的人就必须来这儿把导出这边的规则一起扩过去。
    // 一条禁令写成「所有面板文件都不许」，而其中一个文件今天就在违反它，
    // 那条禁令活不过一次 CI。
    const js = await src('import.js');
    assert.match(js, /请使用 Chrome 或 Edge/,
      '导入那一侧改好了？那就把上面那条规则扩到 import.js，并删掉这条测试');
  });

  test('界面上一个字都不许说它是「Firefox 专用格式」', async () => {
    // 那句话是假的（解开就是同一个目录），而且正好把「你的数据在你自己手里」说反了。
    //
    // **只查会显示出来的字符串，不查注释**——注释里正需要写下这条禁令，把注释
    // 一起查进来就是逼着规则的解释从代码里消失。（2026-09-04 那次一模一样：新写的
    // 检查在自己的解释性注释上红了。）
    for (const f of ['export.js', 'formats.js', 'destination.js']) {
      const js = (await src(f))
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      assert.ok(!/专用格式/.test(js), `${f} 里出现了「专用格式」`);
    }
  });

  test('zip 的结果卡片有**自己的**话术，不复用「尚未收尾」那一句', async () => {
    // 「只核对了字节数」在目录那条路上的原因是「没有 manifest」，在 zip 那条路上
    // 的原因是「写出去就读不回来」——两个完全不同的下一步（一个是「抓完再导一次」，
    // 一个是「解开看看」）。说错原因的提示会把人送去修一个不存在的问题。
    const js = await src('export.js');
    assert.match(js, /kind === 'zip'/, '结果卡片没有 zip 这一支');
    assert.match(js, /读不回来[\s\S]{0,60}没有校验过/, '没说清为什么不能校验');
    assert.match(js, /不能续导/, '没说中断了要整个重来');
  });

  test('「要两倍空闲空间」出现在确认框里，不是只出现在结果卡片上', async () => {
    // 它是**决定之前**才有用的信息：导出跑完之后再说「刚才需要两倍空间」，
    // 用户已经无从选择了。判据是「它在 confirm 的参数里」，**不是源码里谁在前**
    // ——后者会随着函数怎么排而变，跟这件事没关系。
    const js = await src('export.js');
    const at = js.indexOf('if (!confirm(');
    assert.ok(at > 0);
    const arg = js.slice(at, js.indexOf(')) return;', at));
    assert.match(arg, /两倍于档案的空闲空间/, '确认框里没说要两倍空间');
    assert.match(arg, /打包成一个 zip/, '确认框里没说它会变成一个 zip');
  });
});
