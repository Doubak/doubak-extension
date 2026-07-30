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
