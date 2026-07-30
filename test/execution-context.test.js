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

/**
 * 去掉注释再查。
 *
 * 必须的：这些文件的注释里**正需要**写「offscreen 拿不到 chrome.storage」，
 * 而一个只会字符串匹配的检查会把那句解释本身当成违规。
 *
 * @param {string} src
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
}

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

  test('service worker 用 ScheduleStore，不用完整的 RunStore', async () => {
    // `RunStore.loadCheckpoint()` 要开 bundle 目录读 `checkpoint.json`——而 SW
    // 开不了。第一版给它一个会抛的 `openBundle`，那只是把「静默不可用」变成
    // 「响亮不可用」：「开始抓取」照样直接失败，因为那条路径本来就要读 checkpoint。
    //
    // 分工必须按**需要的数据量**分：调度只要三个字段（停机原因、时间、退避），
    // 而那三个字段已经镜像进 IDB 指针了。
    const code = stripComments(await read('src/background.js'));
    assert.match(code, /ScheduleStore/);
    assert.equal(/new RunStore\(/.test(code), false, 'SW 不该构造完整的 RunStore');
    assert.equal(code.includes('openBundle'), false, 'SW 压根不该有开档案的能力');
  });

  test('恢复时 service worker 不把 checkpoint 传过去', async () => {
    // SW 手上只有三个字段的调度摘要，而 `runner.resume()` 要的是全本（游标、
    // frontier、退避）。传摘要过去会静默丢掉游标——表现是「恢复之后从头重抓」。
    const sw = stripComments(await read('src/background.js'));
    assert.equal(/op: 'resume', checkpoint/.test(sw), false);

    const off = stripComments(await read('src/offscreen/offscreen.js'));
    assert.match(off, /loadCheckpoint\(\)/, 'offscreen 要自己去档案里读全本');
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

  test('offscreen 只用 chrome.runtime，其余能力走标准 Web API', async () => {
    // offscreen document 虽然是扩展页面，可用的扩展 API 却只有一小部分。这件事
    // 咬过两次，两次的症状都与真实原因毫无关系：
    //
    //   点「开始抓取」 → 「chrome.storage.local 不可用」
    //
    // 那句话在 service worker 里根本不可能出现（`storage` 权限声明着、一直用得
    // 好好的），所以第一反应是去查权限配置。真正抛它的是 offscreen 那一侧。
    //
    // 这种错 Node 测试永远抓不到——那里压根没有「执行上下文」这个概念。所以在
    // 源码层面钉死。
    const src = await read('src/offscreen/offscreen.js');
    const code = stripComments(src);

    const used = new Set((code.match(/chrome\.[a-zA-Z]+/g) ?? []));
    assert.deepEqual([...used].sort(), ['chrome.runtime'],
      'offscreen 里出现了 chrome.runtime 之外的 API —— 它在那个上下文里很可能是 undefined');

    // 具体挡一下最容易顺手写出来的那个
    assert.equal(code.includes('chrome.storage'), false,
      'offscreen 拿不到 chrome.storage，抓取状态要用 IdbKvStore');
    assert.match(src, /IdbKvStore/);
  });

  test('抓取状态不许借道 service worker —— 那会形成请求/响应环', async () => {
    // service worker 正 await offscreen 的「开始抓取」响应，offscreen 又 await
    // service worker 帮它写 checkpoint。它在浏览器里的表现是 `setCurrentRun()`
    // 看起来成功了、紧接着的 `getCurrentRun()` 却拿不到东西，报出「还没有
    // setCurrentRun」——一句完全指不到真实原因的话。
    //
    // IndexedDB 没有这个问题：普通 DOM/Worker API，两边直接用、看同一份数据。
    for (const f of ['src/offscreen/offscreen.js', 'src/background.js']) {
      const code = stripComments(await read(f));
      assert.equal(code.includes('ProxyKvStore'), false, `${f} 又在借道了`);
      assert.match(code, /IdbKvStore/, `${f} 应当直接用 IndexedDB`);
    }
  });

  test('service worker 与 offscreen 用同一个库，否则各写各的', async () => {
    // 两边必须看到同一份 checkpoint：offscreen 写、service worker 读（决定该不该
    // 恢复）。库名或 store 名不一致的话，恢复永远找不到东西，而且**不会报错**。
    const idb = await read('src/storage/idb-kv-store.js');
    assert.match(idb, /export const DB_NAME/);
    for (const f of ['src/offscreen/offscreen.js', 'src/background.js']) {
      const code = stripComments(await read(f));
      // 不许自己传 dbName —— 传了就有机会传成两个不一样的
      assert.equal(/new IdbKvStore\(\s*\{/.test(code), false,
        `${f} 给 IdbKvStore 传了参数，两边就有可能指向不同的库`);
    }
  });

  test('传输层的权限兜底在查不了时返回 null，而不是假装有权限', async () => {
    // `chrome.permissions` 在 offscreen 里也不可用，所以那道兜底在抓取上下文里
    // 是**失效**的。这可以接受——主动那道 `permissions.onRemoved` 在 service
    // worker 里仍然有效——但前提是「查不了」必须退化成 null，绝不能退化成
    // 「有权限」或者「没权限」。前者悄悄关掉检查，后者会把每个网络抖动都说成
    // 权限问题。
    const src = stripComments(await read('src/crawl/permissions.js'));
    assert.match(src, /if \(!api\?\.contains\) return null;/);
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
