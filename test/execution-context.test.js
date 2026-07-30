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

  test('只有专用 Worker 直接用 OpfsFileStore', async () => {
    // 允许名单**只有专用 Worker**。service worker 与窗口都得经由 RPC。
    //
    // background.js 曾经在这份名单里（带着「已知待修」的记号），现在不在了——
    // 抓取搬进 offscreen document 之后，它连开 bundle 的能力都不该有。
    const allowed = new Set([
      'src/storage/opfs-rpc.js',      // 分发逻辑，两个 Worker 入口共用
      'src/storage/opfs-worker.js',   // 只读入口（面板）
      'src/storage/opfs-rw-worker.js',// 读写入口（offscreen）
      'selftest/worker.js',
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

  test('service worker 不直接读写档案', async () => {
    // service worker 也**不是**专用 Worker，`createSyncAccessHandle()` 在里面
    // 用不了。所以它连 OpfsFileStore 都不该 import——那是 offscreen 的事。
    const src = await read('src/background.js');
    assert.equal(/from\s+['"][^'"]*opfs-store\.js['"]/.test(src), false);
    assert.equal(src.includes('WorkerFileStore'), false, 'service worker 里没有 Worker 可用');
    // 它必须经由 offscreen
    assert.match(src, /offscreen\/host\.js/);
  });

  test('字节绝不跨 chrome.runtime.sendMessage', async () => {
    // 那条通道只认 JSON：`Uint8Array` 过去会变成 `{"0":1,"1":2,…}`。整条抓取链
    // 之所以搬进 offscreen，就是为了让字节根本不用过这条界。
    //
    // 这里挡的是最可能被写出来的那种回退：有人为了「只把落盘搬过去」，往
    // host.js 里加一个带 bytes 的命令。
    const host = await read('src/offscreen/host.js');
    assert.equal(/bytes/.test(host), false, 'host.js 里出现了 bytes —— 字节不许走这条通道');
  });

  test('offscreen 的入口模块不会被 service worker 拉进来', async () => {
    // offscreen.js 一加载就起 Worker、注册消息监听器。那些副作用绝不能在
    // service worker 里发生，所以协议常量必须住在一个没有副作用的模块里。
    const host = await read('src/offscreen/host.js');
    assert.equal(host.includes("'./offscreen.js'"), false);
    assert.match(host, /protocol\.js/);

    const protocol = await read('src/offscreen/protocol.js');
    // 只许有导出常量，不许有任何顶层调用
    assert.equal(/^\s*(chrome|self|new |await )/m.test(protocol), false);
  });
});
