/**
 * 详细日志开关。
 *
 * ## 为什么这个开关存在，而不是把日志删掉
 *
 * `background.js` 与 `offscreen.js` 里那三十来行 `debugLog` 原来标着
 * `TODO(debug): 发布前删`。处理这个 TODO 时回头看它的战绩：合盖睡眠后锁被永久
 * 占住 26 小时、123 张封面全是 418、「像是同时跑了好几个实例」其实是并发保护在
 * 工作、一次推进空转 780 秒——**每一条都是用户把控制台贴过来才定位到的**。
 *
 * 删掉等于在扩展即将见到真实用户的那一刻，关掉唯一的远程诊断通道。所以那个 TODO
 * 的正确解法是「默认关、需要时能打开」，不是「删」。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEBUG_LOG_KEY, makeDebugLog, loadDebugFlag, setDebugFlag, debugEnabled,
} from '../src/core/debug-log.js';

/** @param {Record<string, unknown>} init */
function fakeKv(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    get: async (k) => m.get(k),
    set: async (k, v) => { m.set(k, v); },
  };
}

/** 收走 console.log，返回收到的行。 */
function capture(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a);
  try { fn(); } finally { console.log = real; }
  return lines;
}

describe('默认必须是关的', () => {
  test('没读过存储时不输出', async () => {
    // 发布版控制台该是干净的。而「默认开」的代价不是吵——是**每个用户**的控制台
    // 里都躺着他的用户名、抓过哪些页面。
    await loadDebugFlag(fakeKv());
    assert.equal(debugEnabled(), false);
    assert.deepEqual(capture(() => makeDebugLog('[x]')('喂')), []);
  });

  test('**读存储失败也当关着**', async () => {
    // 失败方向：最坏是「用户开了但没生效」，他会再点一次。反过来会让发布版无条件
    // 刷日志，那正是这个开关要避免的事。
    await setDebugFlag(fakeKv(), true); // 先打开，确认下面真的把它关回去了
    assert.equal(debugEnabled(), true);

    const broken = { get: async () => { throw new Error('IDB 挂了'); } };
    assert.equal(await loadDebugFlag(broken), false);
    assert.equal(debugEnabled(), false);
  });

  test('存的不是 true 一律当关着', async () => {
    // 'true'、1、{} 都不算。松一点的判断会让一个残留的旧值把日志打开。
    for (const v of ['true', 1, {}, 'yes', null, undefined]) {
      await loadDebugFlag(fakeKv({ [DEBUG_LOG_KEY]: v }));
      assert.equal(debugEnabled(), false, `${JSON.stringify(v)} 不该算开`);
    }
  });
});

describe('打开之后', () => {
  test('输出带上下文前缀', async () => {
    // service worker 与 offscreen 的日志混在同一个控制台里，没有前缀就分不清
    // 是谁说的——而这两边的行为差别正是最容易看错的地方。
    await loadDebugFlag(fakeKv({ [DEBUG_LOG_KEY]: true }));
    assert.deepEqual(capture(() => makeDebugLog('[doubak]')('心跳')), [['[doubak]', '心跳']]);
    assert.deepEqual(
      capture(() => makeDebugLog('[doubak/offscreen]')('存量补抓', 121)),
      [['[doubak/offscreen]', '存量补抓', 121]],
    );
  });

  test('写开关会落盘，也会当场生效', async () => {
    const kv = fakeKv();
    await loadDebugFlag(kv);
    assert.equal(debugEnabled(), false);

    await setDebugFlag(kv, true);
    assert.equal(debugEnabled(), true, '当场没生效，用户会以为按钮坏了');
    assert.equal(kv.m.get(DEBUG_LOG_KEY), true, '没落盘，重启就丢');

    await setDebugFlag(kv, false);
    assert.equal(debugEnabled(), false);
    assert.equal(kv.m.get(DEBUG_LOG_KEY), false);
  });

  test('三个上下文用同一个键', () => {
    // 分成三个键的话，用户在面板上打开，另外两边照旧沉默——而那两边才是出事的地方。
    assert.equal(DEBUG_LOG_KEY, 'doubak.debugLog');
  });
});

describe('接线', () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf-8');

  test('**那批 TODO(debug) 已经处理完了**', () => {
    // 8 处，散在 5 个文件里。写死计数器那几处是一次性的验证辅助（没有任何东西
    // 读 debugStats），直接删；日志那两处改成开关。
    for (const p of [
      'src/background.js', 'src/offscreen/offscreen.js',
      'src/bundle/segment-writer.js', 'src/bundle/bundle-writer.js',
      'src/storage/file-store.js',
    ]) {
      assert.ok(!read(p).includes('TODO(debug)'), `${p} 里还有 TODO(debug)`);
    }
  });

  test('两个上下文都不再自己定义 DEBUG 常量', () => {
    // 各自一个 `const DEBUG = true` 的问题是：开关只能靠改代码，而且两边会漂移。
    for (const p of ['src/background.js', 'src/offscreen/offscreen.js']) {
      const src = read(p);
      assert.ok(!/const DEBUG = true/.test(src), `${p} 还写着 const DEBUG = true`);
      assert.match(src, /makeDebugLog\(/);
      assert.match(src, /loadDebugFlag\(/, `${p} 没在启动时读开关，那开关永远不生效`);
    }
  });

  test('面板上有开关，而且说清了在哪看、什么时候生效', () => {
    const js = read('src/ui/panel.js');
    const html = read('src/ui/panel.html');
    assert.match(html, /id="toggle-debug"/);
    assert.match(js, /setDebugFlag\(getDebugKv\(\), !debugEnabled\(\)\)/);
    // 另外两个上下文要等下次启动。不说的话用户点完看不到输出，会以为开关坏了。
    assert.match(js, /下一轮心跳|等下次启动/);
  });

  test('**开关坏了不许把面板带崩**', () => {
    // `new IdbKvStore()` 在拿不到 IndexedDB 时会抛（那是对的：抓取状态必须能
    // 持久化）。在模块顶层构造它，等于让一个排查用的开关有本事让 refresh() 一次
    // 都跑不起来——用户看到的是空白页，而原因与他要做的事毫无关系。
    const js = read('src/ui/panel.js');
    assert.ok(!/^const debugKv = new IdbKvStore\(\);$/m.test(js), '别在顶层构造');
    assert.match(js, /function getDebugKv\(\)/);
    assert.match(js, /catch \{ \/\* 保持默认的关 \*\/ \}/);
  });

  test('写计数器那几处是真的删干净了', () => {
    for (const [p, dead] of [
      ['src/bundle/segment-writer.js', ['_debug', 'debugStats']],
      ['src/bundle/bundle-writer.js', ['_debug', 'debugStats']],
      ['src/storage/file-store.js', ['_stats']],
    ]) {
      const src = read(p);
      for (const d of dead) assert.ok(!src.includes(d), `${p} 里还留着 ${d}`);
    }
  });
});
