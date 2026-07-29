/**
 * 谁能在哪个执行上下文里跑 —— 用源码钉住。
 *
 * ## 为什么需要这么一条测试
 *
 * `createSyncAccessHandle()`（OPFS 唯一的原地读写手段）**只在专用 Worker 里
 * 可用**。窗口没有，service worker 也没有。而这件事在 Node 里跑单元测试时
 * 完全看不出来——所有测试用的都是 `MemoryFileStore`，压根碰不到那条路径。
 *
 * 于是这类 bug 的特征是：**测试全绿，装进浏览器一点就炸**。这已经真的发生过
 * 一次（面板直接 `import OpfsFileStore`，档案预览和导出在真浏览器里当场抛
 * 「createSyncAccessHandle 不可用」）。
 *
 * 单元测试抓不到的东西，就用源码层面的约束抓。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

/** @param {string} rel */
const read = (rel) => readFile(new URL(rel, root), 'utf-8');

describe('执行上下文约束', () => {
  test('窗口侧代码不许直接 import OpfsFileStore', async () => {
    // 窗口里 createSyncAccessHandle 不可用。窗口要读 OPFS 只能经由
    // WorkerFileStore 转发给专用 Worker。
    const files = (await readdir(new URL('src/ui/', root))).filter((f) => f.endsWith('.js'));
    assert.ok(files.length > 0, '没找到窗口侧代码，这条测试失去了意义');

    for (const f of files) {
      const src = await read(`src/ui/${f}`);
      assert.equal(
        /from\s+['"][^'"]*opfs-store\.js['"]/.test(src),
        false,
        `src/ui/${f} 直接引了 opfs-store —— 窗口里用不了，得走 WorkerFileStore`,
      );
    }
  });

  test('WorkerFileStore 不许出现在 Worker 侧', async () => {
    // 反方向也得挡：Worker 里直接用 OpfsFileStore 就好，再绕一层 RPC 是把
    // 消息发给自己。
    const src = await read('src/storage/opfs-worker.js');
    assert.equal(src.includes('worker-file-store.js'), false);
  });

  test('专用 Worker 才用 OpfsFileStore', async () => {
    // 允许直接用它的只有：storage/ 自己、selftest 的 Worker，以及
    // background.js（那一处是已知待修，见下一条）。
    const allowed = new Set([
      'src/storage/opfs-worker.js',
      'selftest/worker.js',
      'src/background.js',
    ]);

    /** @param {URL} dir @param {string} prefix */
    async function walk(dir, prefix) {
      const out = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.isDirectory()) out.push(...await walk(new URL(`${e.name}/`, dir), `${prefix}${e.name}/`));
        else if (e.name.endsWith('.js')) out.push(`${prefix}${e.name}`);
      }
      return out;
    }

    const files = [
      ...await walk(new URL('src/', root), 'src/'),
      ...await walk(new URL('selftest/', root), 'selftest/'),
    ].filter((f) => f !== 'src/storage/opfs-store.js');

    for (const f of files) {
      const src = await read(f);
      if (!/from\s+['"][^'"]*opfs-store\.js['"]/.test(src)) continue;
      assert.ok(allowed.has(f), `${f} 引了 opfs-store，但它不在允许名单里`);
    }
  });

  test('background.js 用 OPFS 这件事有明确记录，不是被忘了', async () => {
    // service worker 也**不是**专用 Worker，所以抓取的写入路径同样跑不通。
    // 修法是 offscreen document + 专用 Worker（DESIGN.md F-10）。
    // 这条测试的作用不是让它通过，而是保证这个缺口在文档里留着字——
    // 一个没写下来的已知缺口，三个月后就变成一个未知缺口。
    const src = await read('src/background.js');
    assert.match(
      src,
      /offscreen/i,
      'background.js 通过 OPFS 写档案，但 service worker 里 createSyncAccessHandle 不可用；' +
        '必须在文件里写明这一点与 offscreen 方案',
    );

    const design = await read('DESIGN.md');
    assert.match(design, /offscreen/i);
  });
});
