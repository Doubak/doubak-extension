/**
 * service worker ↔ offscreen 边界上的纯逻辑。
 *
 * 这条边界的危险之处在于**它不会报错**。`chrome.runtime.sendMessage` 只认
 * JSON，所以 `Map` 过去会静默变成 `{}`、`Uint8Array` 会静默变成
 * `{"0":1,"1":2,…}`。没有异常，没有警告，只有一个值悄悄变了形状。
 *
 * 而那种错误的后果一点都不小：`floors` 变成空的，意味着一次本该到某天为止的
 * 增量抓取变成从头全量重抓。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { serializeScope } from '../src/offscreen/host.js';
import { handleOpfsRpc, WRITE_OPS } from '../src/storage/opfs-rpc.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { PAUSE_REASONS } from '../src/crawl/resume-policy.js';
import { readRepoFile } from './helpers/fake-dom.js';

/** offscreen 那侧的还原逻辑。与 offscreen.js 里的 reviveScope 同构。 */
function reviveScope(options = {}) {
  const o = { ...options };
  if (Array.isArray(o.floors)) o.floors = new Map(o.floors);
  return o;
}

/** 模拟这条通道真正做的事：JSON 序列化。 */
const overTheWire = (v) => JSON.parse(JSON.stringify(v));

describe('抓取范围过 JSON 边界', () => {
  test('Map 拆开再装回来，内容不变', () => {
    const floors = new Map([
      ['broadcast.timeline', '2026-07-01T00:00:00.000Z'],
      ['interest.movie.collect', null],
    ]);
    const revived = reviveScope(overTheWire(serializeScope({ username: 'x', floors })));

    assert.ok(revived.floors instanceof Map);
    assert.deepEqual([...revived.floors], [...floors]);
    assert.equal(revived.username, 'x');
  });

  test('不拆的话 Map 会静默变成空对象 —— 这就是那个坑', () => {
    // 记下来，因为它不报错。表现出来是「增量抓取变成全量重抓」，而那看起来
    // 只像是「怎么这么慢」。
    const floors = new Map([['broadcast.timeline', '2026-07-01T00:00:00.000Z']]);
    const naive = overTheWire({ floors });
    assert.deepEqual(naive.floors, {});
    assert.equal(naive.floors instanceof Map, false);
  });

  test('没有 floors 时不会凭空造一个', () => {
    const s = serializeScope({ username: 'x', onlyRoutes: ['a'] });
    assert.equal('floors' in s, false);
    assert.deepEqual(reviveScope(overTheWire(s)), { username: 'x', onlyRoutes: ['a'] });
  });

  test('serializeScope 不改动传进来的对象', () => {
    // 调用方还要用那个 Map（本地也要传给 runner），改了它就会有两处不一致。
    const floors = new Map([['a', 'b']]);
    const input = { floors };
    serializeScope(input);
    assert.ok(input.floors instanceof Map);
  });
});

describe('OPFS RPC 的读写分界', () => {
  const storeFor = async () => new MemoryFileStore();

  test('只读入口拒绝所有写操作', async () => {
    // 这条限制在 **Worker 一侧**执行。客户端的限制只是约定，Worker 的拒绝才是
    // 保证——面板压根不该有能力破坏偏移量。
    for (const op of WRITE_OPS) {
      await assert.rejects(
        () => handleOpfsRpc({ op, dir: 'd', name: 'f', bytes: new Uint8Array(1), length: 0 },
          { allowWrites: false, storeFor }),
        /只读/,
        `${op} 该被拒绝`,
      );
    }
  });

  test('只读入口照常放行读操作', async () => {
    const s = new MemoryFileStore();
    await s.replace('f', new TextEncoder().encode('hi'));
    const one = async () => s;

    assert.equal((await handleOpfsRpc({ op: 'size', name: 'f' }, { allowWrites: false, storeFor: one })).result, 2);
    assert.equal((await handleOpfsRpc({ op: 'exists', name: 'f' }, { allowWrites: false, storeFor: one })).result, true);
    assert.deepEqual((await handleOpfsRpc({ op: 'list' }, { allowWrites: false, storeFor: one })).result, ['f']);
  });

  test('读操作转移 buffer 所有权，不复制', async () => {
    // 导出时一块 4 MiB，逐块复制没必要付。
    const s = new MemoryFileStore();
    await s.replace('f', new Uint8Array([1, 2, 3]));
    const r = await handleOpfsRpc({ op: 'read', name: 'f' },
      { allowWrites: true, storeFor: async () => s });
    assert.deepEqual(r.transfer, [r.result.buffer]);
  });

  test('读写入口接受写操作', async () => {
    const s = new MemoryFileStore();
    const one = async () => s;
    await handleOpfsRpc({ op: 'append', name: 'f', bytes: new TextEncoder().encode('ab') },
      { allowWrites: true, storeFor: one });
    assert.equal(await s.size('f'), 2);
  });

  test('写操作收到非字节会明确报错', async () => {
    // 结构化克隆之后如果对面转的是裸 ArrayBuffer，要包回来；而收到别的东西就
    // 得响亮地失败，不能把一个 JSON 化了的数组当字节写进段文件——那会产出一个
    // 结构上有效但内容是垃圾的 WARC。
    await assert.rejects(
      () => handleOpfsRpc({ op: 'append', name: 'f', bytes: { 0: 1, 1: 2 } },
        { allowWrites: true, storeFor }),
      /需要 Uint8Array/,
    );
    // 裸 ArrayBuffer 要认
    const s = new MemoryFileStore();
    await handleOpfsRpc({ op: 'append', name: 'f', bytes: new Uint8Array([7, 8]).buffer },
      { allowWrites: true, storeFor: async () => s });
    assert.deepEqual(await s.read('f'), new Uint8Array([7, 8]));
  });

  test('读操作转移、写操作不转移', async () => {
    // 不对称是刻意的：读方向的 buffer 是 Worker 刚分配、之后再也不碰的，转移安全；
    // 写方向的 buffer 属于调用方，转移会把它 detach 掉。
    const s = new MemoryFileStore();
    await s.replace('f', new Uint8Array([1, 2, 3]));
    const one = async () => s;

    const r = await handleOpfsRpc({ op: 'read', name: 'f' }, { allowWrites: true, storeFor: one });
    assert.deepEqual(r.transfer, [r.result.buffer]);

    const w = await handleOpfsRpc({ op: 'append', name: 'f', bytes: new Uint8Array([4]) },
      { allowWrites: true, storeFor: one });
    assert.equal(w.transfer, undefined, '写操作不该带 transfer');
  });

  test('不认识的操作直接抛', async () => {
    await assert.rejects(
      () => handleOpfsRpc({ op: '把档案发到我服务器' }, { allowWrites: true, storeFor }),
      /未知操作/,
    );
  });
});

describe('通知文案', () => {
  test('每个「等人处理」的停机原因都有专门的文案', async () => {
    // 兜底文案会把原因原文直接摊给用户。那对未知情况是对的（至少他能把这行字
    // 发给我们），但对**已知**的停机原因来说是偷懒——用户需要的是下一步动作。
    const src = await readFile(new URL('../src/ui/notify.js', import.meta.url), 'utf-8');
    // 两个例外，都是「用户已经知道了」：崩溃恢复应当安静（它不该吓人），
    // 用户自己按的暂停更不需要通知他自己按了暂停。
    const silent = new Set(['crash', 'user_paused']);
    for (const reason of PAUSE_REASONS) {
      if (silent.has(reason)) continue;
      assert.ok(src.includes(`${reason}:`), `notify.js 缺少 ${reason} 的文案`);
    }
  });

  test('文案说下一步动作，不说错误码', async () => {
    const src = await readFile(new URL('../src/ui/notify.js', import.meta.url), 'utf-8');
    // 只查两张文案表里的字符串，不查注释——注释里正需要写「不要说错误码」。
    const tables = src.slice(
      src.indexOf('const NEEDS_ACTION_TITLE'),
      src.indexOf('/** @param {string} reason */'),
    );
    for (const line of tables.split('\n')) {
      if (!line.includes('错误')) continue;
      assert.ok(/不是错误/.test(line), `文案里不该出现「错误」：${line.trim()}`);
    }
    // 而且每条正文都得给出下一步能做的事
    assert.ok(tables.includes('请') || tables.includes('需要'), '文案里没有一句可执行的下一步');
  });

  test('需要处理的通知不许自己消失', async () => {
    // 用户没看见 = 抓取继续停着。
    const src = await readFile(new URL('../src/ui/notify.js', import.meta.url), 'utf-8');
    assert.match(src, /requireInteraction: true/);
  });

  test('完成通知提醒去导出', async () => {
    // 没导出之前档案不算用户的：它挂在扩展的存储里，卸载扩展或清站点数据都会
    // 把它一次性抹掉，而且不会问一句。
    const src = await readFile(new URL('../src/ui/notify.js', import.meta.url), 'utf-8');
    const done = src.slice(src.indexOf('export async function notifyDone'));
    assert.match(done.slice(0, 1200), /导出/);
  });
});

describe('通知去重', () => {
  test('同一个原因只弹一次', async () => {
    // 心跳每 30 秒醒一次，每次都会重新判断「该不该恢复」。不去重的话同一件事每
    // 半分钟糊到用户脸上一次，而它还带 requireInteraction 不会自己消失。
    //
    // 那不只是烦：**被轰炸的用户会去关掉通知权限**，然后连真正要紧的那条也收不到，
    // 于是这个功能反而让「把人叫回来」更难了。
    const { notifyNeedsAction, clearAttention, NOTIFIED_KEY } =
      await import('../src/ui/notify.js');
    const { MemoryKvStore } = await import('../src/storage/kv-store.js');

    const created = [];
    const badges = [];
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true, writable: true,
      value: {
        notifications: {
          create: async (id, o) => created.push(o.title),
          clear: async () => {},
        },
        action: {
          setBadgeText: async ({ text }) => badges.push(text),
          setBadgeBackgroundColor: async () => {},
          setTitle: async () => {},
        },
        runtime: { getURL: (p) => p },
      },
    });

    try {
      const kv = new MemoryKvStore();
      await notifyNeedsAction('blocked', { kv });
      await notifyNeedsAction('blocked', { kv });
      await notifyNeedsAction('blocked', { kv });
      assert.equal(created.length, 1, `同一个原因弹了 ${created.length} 次`);

      // 换了原因就该说
      await notifyNeedsAction('challenge', { kv });
      assert.equal(created.length, 2);

      // 角标不受去重限制——它是常亮的兜底，重设同样的值没有代价
      assert.ok(badges.length >= 4);

      // 解决之后再发生同一件事，必须重新提醒：那是一次全新的事件
      await clearAttention({ kv });
      assert.equal(await kv.get(NOTIFIED_KEY), undefined, '去重状态要一起清掉');
      await notifyNeedsAction('challenge', { kv });
      assert.equal(created.length, 3);
    } finally {
      if (saved) Object.defineProperty(globalThis, 'chrome', saved);
      else delete globalThis.chrome;
    }
  });

  test('不传 kv 就不去重 —— 刻意不静默生效', async () => {
    // 静默去重会让测试以为去重生效了，而实际上取决于调用方有没有传 kv。
    const { notifyNeedsAction } = await import('../src/ui/notify.js');
    const created = [];
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true, writable: true,
      value: {
        notifications: { create: async (id, o) => created.push(o.title), clear: async () => {} },
        action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
        runtime: { getURL: (p) => p },
      },
    });
    try {
      await notifyNeedsAction('blocked');
      await notifyNeedsAction('blocked');
      assert.equal(created.length, 2);
    } finally {
      if (saved) Object.defineProperty(globalThis, 'chrome', saved);
      else delete globalThis.chrome;
    }
  });
});

describe('「正在做什么」由做事的那一端报出来', () => {
  /**
   * 开工要先确认账号——两次真实请求、要过节奏闸门，可能好几秒。这段时间既没有
   * runner 也没有 checkpoint，界面照着状态渲染就只能说「没有进行中的抓取」，
   * 而用户刚点了开始。
   *
   * 让界面自己记一个乐观状态是行不通的：两秒一次的轮询读到真实状态之后立刻把它
   * 盖掉（那正是报上来的现象），而且它活不过面板刷新。所以状态要从后端来。
   */

  test('offscreen 的 status 把锁的持有者带出来', async () => {
    const src = await readRepoFile('src/offscreen/offscreen.js');
    assert.match(src, /busyWith:\s*lock\.holder/);
  });

  test('background 把它透传给界面 —— 断在这里就等于没做', async () => {
    // 这一层真的漏过：offscreen 报了，background 的 status 分支没带上。
    const src = await readRepoFile('src/background.js');
    assert.match(src, /busyWith:\s*st\?\.busyWith/);
  });

  test('每个会占锁的操作都有对应的界面说法', async () => {
    const off = await readRepoFile('src/offscreen/offscreen.js');
    const panel = await readRepoFile('src/ui/panel.js');
    const holders = [...off.matchAll(/lock\s*\n?\s*\.?run\(\s*'([^']+)'/g)].map((m) => m[1]);
    assert.ok(holders.length >= 3, `没找到几个锁的持有者：${holders}`);
    for (const h of new Set(holders)) {
      assert.ok(panel.includes(`${h}:`), `锁「${h}」在界面上没有说法，会退回「没有进行中的抓取」`);
    }
  });
});
