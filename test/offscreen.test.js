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
// 同步读一份给源码约束用：`readFile` 返回 Promise，拿它去 assert.match
// 不会报类型错，只会静默地永远不匹配。
import { readFileSync } from 'node:fs';

import { serializeScope } from '../src/offscreen/host.js';
import { handleOpfsRpc, WRITE_OPS } from '../src/storage/opfs-rpc.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { PAUSE_REASONS } from '../src/crawl/resume-policy.js';
import { readRepoFile, readPanelSourceSync } from './helpers/fake-dom.js';

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
    // 例外分两类，都是「不该打扰用户」：
    //
    // ① `userVisible: false` 的——按定义就是不通知的那些（崩溃恢复、网络断了）。
    //    这一类**从策略表推导**，不手写：将来再加一条自动恢复的原因，这里会自动
    //    放行，而不是让人先撞一次红再回来补名单。
    // ② `user_paused`——通知用户他自己刚按了暂停，是纯粹的噪音。
    const { policyFor: pf } = await import('../src/crawl/resume-policy.js');
    const silent = new Set([
      ...PAUSE_REASONS.filter((r) => !pf(r).userVisible),
      'user_paused',
    ]);
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
    const panel = readPanelSourceSync();
    const holders = [...off.matchAll(/lock\s*\n?\s*\.?run\(\s*'([^']+)'/g)].map((m) => m[1]);
    assert.ok(holders.length >= 3, `没找到几个锁的持有者：${holders}`);
    for (const h of new Set(holders)) {
      assert.ok(panel.includes(`${h}:`), `锁「${h}」在界面上没有说法，会退回「没有进行中的抓取」`);
    }
  });
});

describe('增量：offscreen 这一侧的接线', () => {
  /**
   * 判断逻辑全在 `src/crawl/chain.js`（纯函数，有 22 条测试）。offscreen 只负责
   * 把 manifest 读进来、在正确的时刻交给 runner——而**接线断了不会有任何报错**，
   * 只会静默地每次都全量。所以在源码层面钉住。
   */

  test('开工时把挑下界的回调交给 runner', async () => {
    const src = await readRepoFile('src/offscreen/offscreen.js');
    assert.match(src, /resolveFloors:\s*\(account\)\s*=>\s*incrementalOptions/);
  });

  test('用户选了全量就一个下界都不挑', async () => {
    const src = await readRepoFile('src/offscreen/offscreen.js');
    assert.match(src, /msg\.mode === CRAWL_MODES\.FULL/);
  });

  test('用户选了「重抓可以编辑的内容」，两档都不跳过已有的', async () => {
    // 跳过的话完全达不到目的——他要的正是新版本（评分、短评会变，日记可以编辑）。
    //
    // **两档一起断言**：只改作品详情页那一档不会报错，只会让「重新抓取可以编辑的
    // 内容」这句话对日记不成立——一个界面上写着、实际做不到的承诺。
    const src = await readRepoFile('src/offscreen/offscreen.js');
    assert.match(src, /knownSubjectUrlKeys: refresh \? \[\]/);
    assert.match(src, /knownLongformUrlKeys: refresh \? \[\]/);
    assert.match(src, /refreshSubjectUrls: refresh \?/);
    assert.match(src, /refreshLongform: refresh \?/);
  });

  test('**图那一档不跟着模式走** —— 两种增量下都跳过', async () => {
    // 重抓一张已有的图拿回来的必然是同一批字节（图片地址是内容地址），所以它不是
    // 一个「要不要」的选项。写成跟着 `refresh` 走的话，选了重抓可编辑内容的用户
    // 会白下载几百张一模一样的图，而界面上没有任何一句话解释那是在干嘛。
    const src = await readRepoFile('src/offscreen/offscreen.js');
    assert.match(src, /knownAssetUrlKeys: known\.assets,/);
    assert.equal(
      /knownAssetUrlKeys: refresh/.test(src), false,
      '图这一档不该跟着「重抓可编辑内容」走——重抓拿回来的是同一批字节',
    );
  });

  test('已经抓过的东西**按账号取，不按链取**', async () => {
    // 按链取的话，`previous_bundle_id` 为 null 的档案各自成链，「最新那条链」常常
    // 只有一份——那一份要是刚跑了一小段的增量，此前几千个详情页就全都不认识了。
    // 真实现象：只加了一本想读的书，增量却在抓游戏详情页。
    const src = await readRepoFile('src/offscreen/offscreen.js');
    // 断言的是**喂给 knownCaptures 的那批档案是按账号选的**，而不是某一行长什么样
    // ——原来钉死了整个表达式，把它提成一个变量就红了，而性质一点没变。
    assert.match(src, /const mine = bundlesForAccount\(entries, me\)/);
    assert.match(src, /knownCaptures\(mine\)/);
    assert.equal(/knownCaptures\(\s*chainOf\(/.test(src), false, '别再按链取');
  });

  test('**分档规则不写在这儿** —— 写在这儿就只能拿正则去守', async () => {
    // offscreen.js 在 node 里 import 不进来（`chrome.*`、Worker），所以写在它里面
    // 的逻辑只能靠「拿正则比对源码」来守——而那种判据挡不住语义错误：把
    // `verdict !== 'ok'` 写成 `!== 'okk'` 照样匹配得上一条宽松的正则。
    //
    // 规则搬进 `crawl/known-captures.js` 之后，「gone 的还会不会重试」这种问题
    // 可以真的跑一遍看（test/known-captures.test.js）。这里只剩接线，
    // 而接线正是正则守得住的那种东西。与 backlog.js 是同一个分层理由。
    const src = await readRepoFile('src/offscreen/offscreen.js');
    assert.match(src, /from '\.\.\/crawl\/known-captures\.js'/);
    assert.match(src, /addKnownCaptures\(acc, await reader\.index\(\)\)/);
    assert.match(src, /return knownCaptureLists\(acc\)/);
    // 反面：分档判据一条都不该留在这个文件里。留一份副本，两份迟早不一样，
    // 而不一样的那一天没有任何东西会响。
    for (const leak of [/route_key === 'interest\.item'/, /startsWith\('asset\.'\)/,
      /'note\.item'/, /'review\.item'/]) {
      assert.equal(leak.test(src), false, `分档判据漏在 offscreen.js 里了：${leak}`);
    }
  });

  test('一份档案读不出来只跳过那一份 —— 不是整趟退回全量', async () => {
    // 累加器跨档案共用，try/catch 在循环里面：前面读进去的不会因为后面一份坏掉
    // 而丢。放到循环外面的话，最后一份档案坏掉会让**整张跳过名单**变空，
    // 于是这一趟把几千个作品详情页重抓一遍——而它只会表现为「怎么这么慢」。
    const src = await readRepoFile('src/offscreen/offscreen.js');
    const fn = src.slice(src.indexOf('async function knownCaptures'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    const forAt = body.indexOf('for (const e of entries)');
    const tryAt = body.indexOf('try {');
    assert.ok(forAt >= 0 && tryAt > forAt, 'try 该在循环里面，一份坏掉不连累其余的');
    assert.match(body, /catch/);
  });

  test('用 chain.js 的纯函数，不在这儿自己判', async () => {
    const src = await readRepoFile('src/offscreen/offscreen.js');
    assert.match(src, /from '\.\.\/crawl\/chain\.js'/);
    assert.match(src, /pickFloors\(/);
    // 账号必须传进去：别人的档案不能当基准，而判错的方向是**漏抓**
    assert.match(src, /accountUserId:\s*account\?\.userId/);
  });

  test('没收尾的档案不当基准 —— 它没有连续性证明', async () => {
    const src = await readRepoFile('src/offscreen/offscreen.js');
    assert.match(src, /hasManifest\(\)/);
  });

  test('**下界挑出来之后，就不许再被丢掉**', async () => {
    // 实测代价：这段代码原来整个包在一个 try 里，下界挑好了但后面
    // knownCaptures / backlogAssets 任何一处抛了，就一起退回全量——
    // 一次本该几分钟的增量变成 4 小时、5880 条捕获的全量。
    //
    // 而且**产出的档案永久地宣称自己是一条链的起点**：previous_bundle_id 写成
    // null 之后没法补，档案跑过就冻结了。链在那里断掉，后来的人只看到
    // 「这里有一次全量」，看不出它本该接在谁后面。
    const src = await readRepoFile('src/offscreen/offscreen.js');
    const fn = src.slice(src.indexOf('async function incrementalOptions'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));

    // 挑下界之后的那一段里，两样锦上添花的东西必须**各自**兜底。
    //
    // 判据是「它们落在不同的 try 块里」，而不是「附近有 try 字样」——后者
    // 写松了：把两个合并回同一个 try，隔壁那个 catch 仍然在附近，测试照样过。
    // 这一版是被那次反向验证逼出来的。
    const after = body.slice(body.indexOf('if (picks.size === 0)'));
    const blocks = after.split('try {');
    const seg = (part) => blocks.findIndex((b) => b.includes(`await ${part}(`));
    const a = seg('knownCaptures');
    const b = seg('backlogAssets');
    assert.ok(a > 0 && b > 0, '两样都该在自己的 try 里');
    assert.notEqual(a, b, '两样在同一个 try 里 —— 一个失败会把另一个和下界一起拖下水');
    for (const part of ['knownCaptures', 'backlogAssets']) {
      const i = after.indexOf(`await ${part}(`);
      assert.match(after.slice(i, i + 400), /catch/, `${part} 没有兜底`);
    }
    // 它们的失败只该降级，不该变成「没有下界」。
    assert.ok(!/catch[^}]*return \{\}/.test(after), '锦上添花失败时不许 return {}');
  });

  test('**退回全量必须说出来** —— 原来是完全静默的', async () => {
    // 原来 incrementalOptions 内部 catch 掉、返回 {}，runner 那边看到的是一次
    // 「成功但没有下界」的调用，于是既不报 incremental_failed 也不报 incremental。
    // 用户看到的现象是「我选了增量，它跑了四个小时」，而界面上一句解释都没有。
    const src = await readRepoFile('src/offscreen/offscreen.js');
    const fn = src.slice(src.indexOf('async function incrementalOptions'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));

    // 每一条退回全量的路径都要先说一句为什么。唯一允许出现裸 `return {}` 的地方
    // 是 fallback 这个小助手本身——它前面正好就是那句解释。
    const helperEnd = body.indexOf('};', body.indexOf('const fallback ='));
    const rest = body.slice(helperEnd);
    assert.deepEqual([...rest.matchAll(/return \{\};/g)].map((m) => m[0]), [],
      '有一条退回全量的路径绕开了 fallback，也就绕开了那句解释');
    assert.ok([...rest.matchAll(/return fallback\(/g)].length >= 3, '至少三条退回路径');
    assert.match(body, /relayEvent\(\{ type: 'incremental_skipped'/);
  });

  test('读不出来就退回全量 —— 少抓不可接受，多抓只是慢', async () => {
    const src = await readRepoFile('src/offscreen/offscreen.js');
    const fn = src.slice(src.indexOf('async function incrementalOptions'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.match(body, /catch/, '整段要有兜底');
    assert.match(body, /return \{\}/, '兜底的结论是「没有下界」');
  });
});

describe('错误码要过得了 offscreen 那道界', () => {
  const src = readFileSync(new URL('../src/offscreen/offscreen.js', import.meta.url), 'utf-8');
  const host = readFileSync(new URL('../src/offscreen/host.js', import.meta.url), 'utf-8');

  test('offscreen 报错时把 reason 一起送出去', () => {
    // 只送 error 字符串的话，`SessionError('session_expired')` 到了另一边就只是
    // 一句话。上层无从分辨「这次操作失败了」与「会话失效了，整场都得停」——
    // 而这两件事该走的界面完全不同。
    const i = src.lastIndexOf('} catch (e) {');
    const body = src.slice(i, i + 900);
    assert.match(body, /reason:/, 'offscreen 的错误响应里没有 reason');
  });

  test('host 把 reason 挂回抛出的 Error 上', () => {
    // 中间这一层丢了它，前面送出来也白搭。
    assert.match(host, /\(err\)\.reason = r\.reason/);
  });
});
