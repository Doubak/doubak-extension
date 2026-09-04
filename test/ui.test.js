/**
 * 界面脚本的执行覆盖。
 *
 * ## 为什么这个文件必须存在
 *
 * `src/ui/*.js` 曾是整个项目里唯一**只被 `node --check` 看过一眼**的部分——也就是
 * 只验了语法。而最近两个用户可见的故障都出在这里，两个都语法完全正确：
 *
 * 1. `preflightShown is not defined` —— 改 `renderRoutes` 时替换区间连带删掉了
 *    `showPreflight` 与它的变量，只留下引用。
 * 2. 预检结果写进 `#routes`，与 `renderRoutes` 抢同一个容器。
 *
 * 两个都在**第一次 `refresh()`** 时暴露。所以这里做的事很简单：把脚本真的加载
 * 起来，把 refresh 走一遍，然后检查它写进了该写的地方。
 *
 * 用的是一个极简的假 DOM（`helpers/fake-dom.js`），不追求完整——完整的 DOM 会
 * 给出一个假的确信。它只回答一个问题：**这段脚本在一个有 DOM 的地方跑得起来吗。**
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeDom, readRepoFile , readPanelSource, readPanelSourceSync } from './helpers/fake-dom.js';
// `readRepoFile` 是异步的（返回 Promise）。同步读一份给那些只做源码约束的检查用——
// 拿 Promise 去 assert.match 不会报类型错，只会静默地永远不匹配。
import { readFileSync } from 'node:fs';

/** 每次都要新的模块实例——界面脚本有模块级状态（preflightShown、routeRows）。 */
let cacheBust = 0;

/**
 * 装好假 DOM，加载界面脚本，等它跑完第一轮。
 *
 * @param {object} opts
 * @param {'panel'} opts.which
 * @param {(msg: object) => any} opts.onMessage
 */
async function loadUi({ which, onMessage }) {
  const html = await readRepoFile(`src/ui/${which}.html`);
  const dom = await installFakeDom({ html, onMessage });
  // 加 query 让 ESM 缓存失效，拿到一份干净的模块状态
  await import(`../src/ui/${which}.js?t=${++cacheBust}`);
  // 顶层的 refresh() 是异步的，让微任务队列跑空
  await new Promise((r) => setTimeout(r, 5));
  return dom;
}

/** 空闲、有权限、空间充足。 */
const IDLE = (msg) => {
  if (msg.type === 'status') return { ok: true, running: false, checkpoint: null, runner: { active: false } };
  if (msg.type === 'preflight') {
    return {
      ok: true,
      permissions: { granted: true, missing: [] },
      storage: { usage: 0, quota: 100e9, available: 100e9, need: 1.2e9, enough: true },
    };
  }
  return { ok: true };
};

describe('面板脚本', () => {
  test('加载并跑完第一次 refresh，不抛任何异常', async () => {
    // 这一条就能抓住那两个真实故障。`preflightShown is not defined` 会在这里
    // 变成一个 unhandled rejection —— 所以下面顺手把它接住并断言。
    const errors = [];
    const onRejection = (e) => errors.push(e);
    process.on('unhandledRejection', onRejection);

    const dom = await loadUi({ which: 'panel', onMessage: IDLE });
    try {
      assert.deepEqual(errors.map(String), [], '第一次 refresh 里有异常');
      // 状态卡片真的被写了
      assert.match(dom.byId.get('state').textContent, /没有进行中的抓取/);
    } finally {
      process.off('unhandledRejection', onRejection);
      dom.restore();
    }
  });

  test('预检写进 #preflight，绝不碰 #routes', async () => {
    // 两者抢同一个容器过一次。`renderRoutes` 靠 `dataset.mode` 判断该不该重建，
    // 被别人写过之后那个判断就失效了。
    const dom = await loadUi({ which: 'panel', onMessage: IDLE });
    try {
      assert.match(dom.byId.get('preflight').textContent, /站点权限/);
      assert.equal(/站点权限/.test(dom.byId.get('routes').textContent), false);
      assert.match(dom.byId.get('routes').textContent, /还没有开始/);
    } finally {
      dom.restore();
    }
  });

  test('权限缺失时预检直说，并给出下一步', async () => {
    const dom = await loadUi({
      which: 'panel',
      onMessage: (msg) => {
        if (msg.type === 'preflight') {
          return {
            ok: true,
            permissions: { granted: false, missing: ['https://*.douban.com/*'] },
            storage: null,
          };
        }
        return IDLE(msg);
      },
    });
    try {
      const t = dom.byId.get('preflight').textContent;
      assert.match(t, /缺少/);
      assert.match(t, /扩展设置/, '要说下一步做什么，不是只报状态');
      // storage 为 null 是「查不了」，不许显示成「够用」
      assert.match(t, /查不了/);
    } finally {
      dom.restore();
    }
  });

  test('抓取中：路线表按 routeKey 建行，第二次刷新不重建', async () => {
    // 「不重建」就是「不闪」的实现方式。这里验的是它真的复用了同一个节点。
    let captured = 3;
    const dom = await loadUi({
      which: 'panel',
      onMessage: (msg) => {
        if (msg.type === 'status') {
          return {
            ok: true,
            running: true,
            checkpoint: null,
            runner: {
              active: true,
              bundleId: '20260730-000000-abcd',
              intervalMs: 1000,
              backoffLevel: 0,
              counts: { done: captured, pending: 1 },
              routes: [{
                routeKey: 'broadcast.timeline', captured,
                // 进度是 oldestSeen；newestSeen 是水位线，不用来显示进度
                oldestSeen: '2026-07-01T00:00:00Z',
                newestSeen: '2026-07-30T00:00:00Z',
                contiguous: false,
              }],
            },
          };
        }
        return IDLE(msg);
      },
    });

    try {
      const routes = dom.byId.get('routes');
      const table = routes.querySelector('table');
      assert.ok(table, '该建出一张表');
      const rowsBefore = table.querySelectorAll('tr');
      assert.equal(rowsBefore.length, 2, '表头 + 一行');
      assert.match(rowsBefore[1].textContent, /广播/);
      assert.match(rowsBefore[1].textContent, /2026-07-01/);

      // 数字变了，让界面的轮询回调再刷一次
      const trBefore = rowsBefore[1];
      captured = 4;
      await dom.tick();

      const trAfter = routes.querySelector('table').querySelectorAll('tr')[1];
      assert.equal(trAfter, trBefore, '路线行被重建了 —— 那就是用户看到的闪动');
      assert.match(trAfter.textContent, /4/, '数字该更新');
    } finally {
      dom.restore();
    }
  });

  test('停下来的抓取不显示「正在抓取」', async () => {
    // `active` 是「这次抓取还在内存里」，不是「正在发请求」。不分开的话，暂停之后
    // 界面还写着「正在抓取」，用户会以为按钮没生效然后反复去点。
    const dom = await loadUi({
      which: 'panel',
      onMessage: (msg) => {
        if (msg.type === 'status') {
          return {
            ok: true, running: false, checkpoint: null,
            runner: {
              active: true, stopped: true, stoppedBy: 'user_paused',
              bundleId: 'b', intervalMs: 1000, backoffLevel: 0,
              counts: { done: 5, pending: 3 }, routes: [],
            },
          };
        }
        return IDLE(msg);
      },
    });
    try {
      const t = dom.byId.get('state').textContent;
      assert.equal(/正在抓取/.test(t), false, '停下来了却还说「正在抓取」');
      assert.match(t, /已暂停/);
      // 而且要给出「继续」，不是「暂停」
      assert.match(dom.byId.get('actions').textContent, /继续/);
    } finally {
      dom.restore();
    }
  });

  test('写入失败停机时说出真实原因，并给出下一步', async () => {
    const dom = await loadUi({
      which: 'panel',
      onMessage: (msg) => {
        if (msg.type === 'status') {
          return {
            ok: true, running: false, checkpoint: null,
            runner: {
              active: true, stopped: true, stoppedBy: 'write_failed',
              bundleId: 'b', intervalMs: 1000, backoffLevel: 0,
              counts: { done: 5, pending: 3 }, routes: [],
            },
          };
        }
        return IDLE(msg);
      },
    });
    try {
      const t = dom.byId.get('state').textContent;
      assert.match(t, /写入档案时出错/);
      assert.equal(/write_failed/.test(t), false, '界面上不许出现内部标识');
    } finally {
      dom.restore();
    }
  });

  test('空闲时的「上一次结果」不能被两秒后的轮询抹掉', async () => {
    // 报上来的：打开插件先看到完整的上次结果，几秒之后整块空了。
    //
    // 成因是空闲分支末尾无条件 `renderRoutes([])`。第一次进空闲时它先清空、
    // 随后异步的 `showLastRun()` 把表填上——看起来对；但轮询每两秒来一次，
    // 而 `lastRunShown` 已经是 true，`showLastRun()` 不再跑，这一句却照常执行。
    const dom = await loadUi({ which: 'panel', onMessage: IDLE });
    try {
      // `showLastRun()` 要读 OPFS，假 DOM 里读不到——手工造出它填完之后的样子。
      // **`dataset.mode` 必须设成 'table'**：`renderRoutes([])` 只有在模式不是
      // 'empty' 时才会真的重建，模式不对的话这条测试无论修没修都绿。
      const routes = dom.byId.get('routes');
      routes.dataset.mode = 'table';
      const marker = dom.document.createElement('div');
      marker.textContent = '上一次抓取的结果';
      routes.replaceChildren(marker);
      assert.ok(routes.textContent.includes('上一次抓取的结果'));

      await dom.tick();
      assert.ok(
        routes.textContent.includes('上一次抓取的结果'),
        '轮询把上一次的结果抹掉了',
      );

      await dom.tick();
      assert.ok(routes.textContent.includes('上一次抓取的结果'), '第二次轮询也不许抹');
    } finally {
      dom.restore();
    }
  });

  test('从「抓取中」回到空闲时，先清掉旧表再让位给上一次的结果', async () => {
    // 反向的那一半：不能因为「不许动这张表」就把抓取期间的残留一直挂着。
    let running = true;
    const dom = await loadUi({
      which: 'panel',
      onMessage: (msg) => {
        if (msg.type === 'status') {
          return running
            ? {
                ok: true, running: true,
                runner: {
                  active: true, stopped: false, stoppedBy: null, bundleId: 'b',
                  intervalMs: 1000, backoffLevel: 0, counts: { done: 1, pending: 0 },
                  routes: [{ routeKey: 'broadcast.timeline', captured: 7, contiguous: false }],
                },
              }
            : IDLE(msg);
        }
        return IDLE(msg);
      },
    });
    try {
      const routes = dom.byId.get('routes');
      assert.ok(routes.textContent.includes('广播'), '抓取期间该显示进度');

      running = false;
      await dom.tick();
      assert.equal(routes.textContent.includes('7'), false, '抓取期间的残留该让位');
    } finally {
      dom.restore();
    }
  });

  test('确认账号那几秒不许显示成「没有进行中的抓取」', async () => {
    // 报上来的：点开始 → 「正在确认账号」→ 退回「没有进行中的抓取」→ 很久之后
    // 才变成「正在抓取」。中间那一跳是两秒一次的轮询读到真实状态之后盖掉了界面
    // 自己编的乐观状态。
    //
    // 开工要先抓一次个人主页确认账号，那是两次真实请求、要过节奏闸门。
    const dom = await loadUi({
      which: 'panel',
      onMessage: (msg) => {
        if (msg.type === 'status') {
          // 既没有 runner 也没有 checkpoint——但锁被「开始抓取」占着
          return { ok: true, running: false, checkpoint: null,
            runner: { active: false }, busyWith: '开始抓取' };
        }
        return IDLE(msg);
      },
    });
    try {
      const s = dom.byId.get('state').textContent;
      assert.match(s, /确认账号/);
      assert.equal(/没有进行中的抓取/.test(s), false);

      // 轮询再来一次也不许跳回去
      await dom.tick();
      assert.match(dom.byId.get('state').textContent, /确认账号/);
    } finally {
      dom.restore();
    }
  });

  test('后端忙着的时候不给「开始抓取」按钮 —— 按了也只会撞上互斥锁', async () => {
    const dom = await loadUi({
      which: 'panel',
      onMessage: (msg) => {
        if (msg.type === 'status') {
          return { ok: true, running: false, checkpoint: null,
            runner: { active: false }, busyWith: '开始抓取' };
        }
        return IDLE(msg);
      },
    });
    try {
      assert.equal(dom.byId.get('actions').textContent.includes('开始抓取'), false);
    } finally {
      dom.restore();
    }
  });

  test('界面上不出现锁的内部名字', async () => {
    const dom = await loadUi({
      which: 'panel',
      onMessage: (msg) => {
        if (msg.type === 'status') {
          return { ok: true, running: false, checkpoint: null,
            runner: { active: false }, busyWith: '演练' };
        }
        return IDLE(msg);
      },
    });
    try {
      // 演练有自己的说法，不该直接把锁的名字打上去
      assert.match(dom.byId.get('state').textContent, /演练/);
      assert.match(dom.byId.get('state').textContent, /零网络请求/);
    } finally {
      dom.restore();
    }
  });

  test('认不出来的忙碌状态也不许退回「没有进行中的抓取」', async () => {
    const dom = await loadUi({
      which: 'panel',
      onMessage: (msg) => {
        if (msg.type === 'status') {
          return { ok: true, running: false, checkpoint: null,
            runner: { active: false }, busyWith: '将来加的某件事' };
        }
        return IDLE(msg);
      },
    });
    try {
      assert.equal(/没有进行中的抓取/.test(dom.byId.get('state').textContent), false);
    } finally {
      dom.restore();
    }
  });

  test('点下去到后端报出忙碌之间的那一小段也不许跳', async () => {
    // 这是完整的时间线：点开始 → offscreen 还没建起来、锁还没被占（busyWith 是
    // null）→ 轮询来了一次 → 之后后端才开始报忙。
    //
    // 那一小段由 `pendingCommand` 兜底；一旦后端报得出来就以后端为准。
    let started = false;
    let releaseStart;
    const startDone = new Promise((r) => { releaseStart = r; });

    const dom = await loadUi({
      which: 'panel',
      onMessage: async (msg) => {
        if (msg.type === 'start') {
          started = true;
          await startDone;            // 模拟「确认账号」那几秒
          return { ok: true, bundleId: 'b' };
        }
        if (msg.type === 'status') {
          // **后端还什么都不知道**：没有 runner、没有 checkpoint、锁也还没占上
          return { ok: true, running: false, checkpoint: null,
            runner: { active: false }, busyWith: null };
        }
        return IDLE(msg);
      },
    });
    try {
      assert.match(dom.byId.get('state').textContent, /没有进行中的抓取/);

      // 点「开始抓取」，不等它完成
      const btn = [...dom.byId.get('actions').children].find((b) => b.textContent === '开始抓取');
      assert.ok(btn, '空闲时该有开始按钮');
      const clicked = btn.onclick();
      await new Promise((r) => setTimeout(r, 5));
      assert.ok(started, '命令应当已经发出去了');
      assert.equal(/没有进行中的抓取/.test(dom.byId.get('state').textContent), false);

      // 轮询在命令还没回来时插进来一次 —— 这正是把状态盖掉的那一下
      await dom.tick();
      assert.equal(
        /没有进行中的抓取/.test(dom.byId.get('state').textContent),
        false,
        '轮询把「正在确认账号」盖回了「没有进行中的抓取」',
      );

      releaseStart();
      await clicked;
      // 点击处理器末尾那次 `refresh()` 是不带 await 的，等它落定再拆假 DOM，
      // 否则它会在全局被还原之后才跑，报 `document is not defined`。
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      dom.restore();
    }
  });

  test('新抓取开始时，「上一次抓取」那行小字必须消失', async () => {
    // 报上来的：抓着新档案 d40c1d，表格下面还挂着
    // 「以上是上一次抓取（档案 …d8e1b2）的结果」。关掉标签页再打开就好了——
    // 那正是这类残留最典型的样子。
    //
    // 成因：那行小字原来是 `showLastRun()` 自己 append 的，而 `renderRoutes()`
    // 为了不闪只在**模式变化**时才重建，同模式下只改单元格，碰不到它。
    let running = false;
    const dom = await loadUi({
      which: 'panel',
      onMessage: (msg) => {
        if (msg.type === 'status') {
          return running
            ? {
                ok: true, running: true,
                runner: {
                  active: true, stopped: false, stoppedBy: null, bundleId: 'd40c1d',
                  intervalMs: 1000, backoffLevel: 0, counts: { done: 1, pending: 0 },
                  routes: [{ routeKey: 'broadcast.timeline', captured: 581, contiguous: false }],
                },
              }
            : IDLE(msg);
        }
        return IDLE(msg);
      },
    });
    try {
      // 手工造出 `showLastRun()` 填完之后的样子：表 + 那行小字
      const routes = dom.byId.get('routes');
      routes.dataset.mode = 'table';
      const tbl = dom.document.createElement('table');
      routes.replaceChildren(tbl);
      const note = dom.document.createElement('div');
      note.dataset.role = 'routes-note';
      note.textContent = '以上是上一次抓取（档案 d8e1b2）的结果，来自它的 manifest。';
      routes.append(note);

      running = true;
      await dom.tick();

      assert.ok(routes.textContent.includes('581'), '新抓取的进度该显示出来');
      assert.equal(
        routes.textContent.includes('上一次抓取'),
        false,
        '还挂着上一份档案的说明，而表格里已经是另一次抓取了',
      );
    } finally {
      dom.restore();
    }
  });

  test('每一种停机都要给得出下一步 —— 没有按钮就是死路', async () => {
    // `account_switched` 与 `quota` 原来一个按钮都不给：用户按提示做完了该做的事
    // （切回账号 / 清出空间），却没有任何地方能告诉豆备「我弄好了」，只能重装扩展。
    //
    // 唯一的例外是 `failures_pending`——它的动作在失败清单里，逐条重试。
    const { PAUSE_REASONS: reasons } = await import('../src/crawl/resume-policy.js');
    for (const key of reasons) {
      // 这两个不是「停在那里等人处理」：`failures_pending` 的动作在失败清单里逐条
      // 重试；`crash` 是崩溃哨兵，心跳会自己接手。
      if (key === 'failures_pending' || key === 'crash') continue;

      const dom = await loadUi({
        which: 'panel',
        onMessage: (msg) => {
          if (msg.type === 'status') {
            return {
              ok: true, running: false,
              runner: {
                active: true, stopped: true, stoppedBy: key, bundleId: 'b',
                intervalMs: 1000, backoffLevel: 0, counts: { done: 1, pending: 2 }, routes: [],
              },
            };
          }
          return IDLE(msg);
        },
      });
      try {
        const buttons = [...dom.byId.get('actions').children];
        assert.ok(buttons.length > 0, `停机原因「${key}」在界面上没有任何下一步可点`);
        assert.ok(buttons[0].textContent.trim().length > 0, `「${key}」的按钮没有文字`);
        // 界面上不许出现内部标识
        assert.equal(
          dom.byId.get('state').textContent.includes(key), false,
          `「${key}」把内部标识打在了屏幕上`,
        );
      } finally {
        dom.restore();
      }
    }
  });

  test('#vanished 与 #captures 都在，且渲染时不互相顶掉', async () => {
    // 「已经没有了」的那几条要有自己的地方：捕获列表只画前 500 行，而真实档案有
    // 3347 条——那 8 条 gone 排在后面，在列表里根本画不出来。
    const html = await readRepoFile('src/ui/panel.html');
    assert.match(html, /id="vanished"/);
    const js = readPanelSourceSync();
    assert.match(js, /function renderVanished\(\)/);

    // 两者共用同一份已加载的 index，不另开一条读取路径。
    //
    // 原来这条判据钉的是「`renderVanished()` 之后 200 个字符内出现 `$('captures')`」
    // ——也就是钉住了「它俩在同一个函数里、挨着写」。那个函数后来被拆开了（捕获
    // 列表收到按钮后面，而「已删除」必须一直看得见），判据就跟着红了，尽管它想说
    // 的那件事一点没变。**钉行为，别钉排版。**
    const fn = js.slice(js.indexOf('function renderVanished'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.match(body, /entries\.filter/, '要用已经读好的 index');
    assert.equal(/new BundleReader|reader\.index\(\)/.test(body), false,
      '不许自己再读一遍 index —— 那就是第二条读取路径');

    // 而且它**不跟着捕获列表收起来**：整份档案里最不可替代的就是「豆瓣上已经没有了」
    // 的那几条，收起来之后它只剩「判定分布」里的一个数字。
    const open = js.slice(js.indexOf('async function openBundle'));
    const openBody = open.slice(0, open.indexOf('\n}\n'));
    const vanishedAt = openBody.indexOf('renderVanished()');
    const gated = openBody.indexOf("if (openPane === 'captures')");
    assert.ok(vanishedAt > 0, 'openBundle 里没有画「已删除」那一块');
    assert.ok(gated > 0, '找不到收起/展开那道判断，这条判据失去了意义');
    assert.ok(vanishedAt < gated, '「已删除」被收到「翻看捕获」后面去了');
  });

  test('**档案只有一份清单** —— 导入、导出、删除、占用都在档案页', async () => {
    // 「存储」曾经自己占一页，列的却是与档案页同一批档案，只换了几列。两份清单
    // 意味着两处要各自记得失效，而用户还要在两页之间对「刚才看的是哪一份」。
    const html = await readRepoFile('src/ui/panel.html');
    assert.equal(html.includes('data-tab="storage"'), false, '存储又变回一个独立标签页了');
    assert.equal(html.includes('id="tab-storage"'), false);

    // 整批那几件事都在档案页里
    const archive = html.slice(html.indexOf('id="tab-archive"'), html.indexOf('id="tab-debug"'));
    for (const id of ['import', 'delete-all', 'storage', 'delete-this', 'export']) {
      assert.match(archive, new RegExp(`id="${id}"`), `档案页里没有 #${id}`);
    }

    // **仍然不许藏在调试页里。** 调试页里全是会改变抓取行为的东西（演练、绕过门控、
    // 小范围试跑），把日常操作摆在那儿等于训练用户往那儿去找东西。
    const debugSection = html.slice(html.indexOf('id="tab-debug"'));
    for (const id of ['storage', 'import', 'delete-all']) {
      assert.equal(debugSection.includes(`id="${id}"`), false, `#${id} 跑到调试页里去了`);
    }
  });

  test('档案页能删掉当前这一份 —— 那里才有上下文', async () => {
    const html = await readRepoFile('src/ui/panel.html');
    assert.match(html, /id="delete-this"/);
    // 不可逆的操作要看起来不一样
    assert.match(html, /id="delete-this"[^>]*|class="act danger"/);
    const js = readPanelSourceSync();
    assert.match(js, /\$\('delete-this'\)\.addEventListener/);
    // 结果要写在档案页自己的地方 —— 否则消息出现在用户看不见的标签页里
    assert.match(js, /deleteBundle\(currentBundleId, \{[\s\S]{0,200}report:/);
  });

  test('开抓前那一行不再说「增量还没接上」', async () => {
    const js = readPanelSourceSync();
    assert.equal(js.includes('增量还没接上'), false);
    assert.match(js, /function scopeText/);
  });

  test('覆盖率页有「合起来 / 这一份」两个视角，默认合起来', async () => {
    const js = readPanelSourceSync();
    assert.match(js, /let coverageView = 'chain'/, '默认该是合起来');
    assert.match(js, /renderChain\(/);
    const html = await readRepoFile('src/ui/panel.html');
    assert.match(html, /id="chain"/);
    assert.match(html, /id="coverage-view"/);
  });

  test('档案页标出增量、新增 / 已抓取多次、版本历史', async () => {
    const html = await readRepoFile('src/ui/panel.html');
    assert.match(html, /id="archive-chain"/);
    assert.match(html, /id="versions"/);

    const js = readPanelSourceSync();
    // 只读 index，不解压 —— 这两个问题的答案全在 index 里
    assert.match(js, /chainDiff/);
    assert.match(js, /function renderVersions/);
    assert.match(js, /已抓取多次/);
    // 增量档案的「捕获条数」看起来小得离谱，要说清那是正常的
    assert.match(js, /previousBundleId/);
  });

  test('抓取方式让用户选 —— 默认增量，但不替他做决定', async () => {
    const html = await readRepoFile('src/ui/panel.html');
    assert.match(html, /id="crawl-mode"/);
    const js = readPanelSourceSync();
    assert.match(js, /let crawlMode = CRAWL_MODES\.INCREMENTAL/, '默认该是增量');
    // **三个键从同一个模块来，不在这边重打一遍字面量。** 面板发一个字符串、
    // offscreen 比一个字符串，两边对不上时不报错——`mode === '打错的'` 只是取到
    // false，用户选了「重抓可编辑内容」却跑出一次普通增量，界面上一切正常。
    for (const k of ['INCREMENTAL', 'FULL', 'REFRESH']) {
      assert.ok(js.includes(`CRAWL_MODES.${k}`), `少了「${k}」这个选项`);
    }
    // 只看挑抓取方式的那一段。别处的 `'incremental'` 是**事件类型**（日志里那句
    // 「N 条路线接着上次抓」），与这三个键同名而不同物——整份源码一起扫会把它
    // 也算成违规，那种误报会让人把这条判据删掉。
    const region = js.slice(js.indexOf('let crawlMode'));
    const decl = region.slice(0, region.indexOf('\n}\n'));
    assert.equal(
      /'refresh-editable'|'incremental'|'full'/.test(decl), false,
      '挑抓取方式这一段里不该有字面量 —— 它得和 offscreen 用同一个常量',
    );
    // 选了什么要真的传下去
    assert.match(js, /send\(\{ type: 'start', mode: crawlMode \}\)/);
  });

  test('**抓完之后把档案页的清单作废** —— 中止那条路早就这么做了', async () => {
    // 两条路径同一类事件，却是两种行为：中止会把摘要与目录扫描一起清掉，
    // 正常跑完只清了摘要。于是抓完之后档案页左边看不见刚出炉的那一份——
    // 而导出正是此刻唯一该做的事。
    //
    // 判据钉在 `showLastRun()` 里：那是**唯一**每次回到空闲都会跑、而且手上正好
    // 有「最新那份档案的编号」的地方。
    const js = readPanelSourceSync();
    const fn = js.slice(js.indexOf('async function showLastRun'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.match(body, /bundleScanKnows\(id\)/, '要拿最新那一份去问缓存认不认识');
    assert.match(body, /invalidateStorageUsage\(\)/, '不认识就该把清单作废');
    assert.match(body, /refreshOpenTab\(\)/, '正开着档案页的话要当场重画');
    // 中止那条路径是这条规则的另一半，两边都得在。
    const ab = js.slice(js.indexOf('async function abortCrawl'));
    assert.match(ab.slice(0, ab.indexOf('\n}\n')), /invalidateStorageUsage\(\)/);
  });

  test('**并排的按钮之间要有缝** —— 装 `.act` 按钮的容器都得是 `.btn-row`', async () => {
    // 按钮是 inline-block，间距只能来自容器；而 JS 里 `el.append(a, b)` 之间没有
    // 空白文本节点，两个按钮就严丝合缝地贴在一起。
    //
    // 这个毛病**只有并排两个以上时才看得见**，所以它在三个容器里躺了很久：概览页
    // 多数时候只有一个按钮，直到覆盖率页的「合起来 / 这一份」与日志页的
    // 「复制日志 / 清空」被人一眼看出来。
    //
    // 判据不写死那三个 id，而是**自己去数**：面板里凡是拿到某个容器又往里塞
    // `.act` 按钮的地方，那个容器就得挂 `.btn-row`。下一排按钮漏挂时这里会红，
    // 而不是等某个人再用眼睛发现一次。
    const html = await readRepoFile('src/ui/panel.html');
    const js = readPanelSourceSync();

    // 按函数切开，然后**顺着变量走**：`const el = $('x')` 记下 el→x，
    // 哪个变量被赋了 `.act` 的 className 记下来，最后只认 `el.append(那个变量)`。
    //
    // 第一版只查「同一个函数里既取了容器又造了按钮」，误报三个——`$('log')`、
    // `$('notice')`、`$('failures')` 只是碰巧与按钮同处一个函数，按钮并不塞进它们。
    // 一条会误报的判据比没有判据更糟：下一个人会把它删掉。
    const fns = js.split(/\n(?=(?:export )?(?:async )?function )/);
    const containers = new Set();
    for (const fn of fns) {
      /** @type {Map<string, string>} 变量名 → 容器 id */
      const vars = new Map();
      for (const m of fn.matchAll(/const (\w+) = \$\('([\w-]+)'\)/g)) vars.set(m[1], m[2]);
      const buttons = new Set(
        [...fn.matchAll(/(\w+)\.className = (?:kind === 'danger' \? )?'act/g)].map((m) => m[1]),
      );
      if (!vars.size || !buttons.size) continue;
      for (const m of fn.matchAll(/(\w+)\.append\(([^)]*)\)/g)) {
        const id = vars.get(m[1]);
        if (!id) continue;
        if (m[2].split(',').some((a) => buttons.has(a.trim()))) containers.add(id);
      }
    }
    assert.ok(containers.size >= 3, `只扫到 ${containers.size} 个容器，扫描本身可能坏了`);

    const bad = [];
    for (const id of containers) {
      const tag = new RegExp(`<[a-z]+ id="${id}"[^>]*>`).exec(html)?.[0];
      // 不在 panel.html 里 = 它是 JS 造出来的节点，那由造它的地方负责。
      if (!tag) continue;
      if (!/class="[^"]*\bbtn-row\b/.test(tag)) bad.push(id);
    }
    assert.deepEqual(bad, [], `这些容器装了并排按钮却没挂 .btn-row：${bad.join(' ')}`);

    // 挂了还得真有缝：类本身要给出 gap，否则上面那条只是在数 class 名。
    const css = await readRepoFile('src/ui/panel.css');
    const rule = /\.btn-row \{([^}]*)\}/.exec(css);
    assert.ok(rule, 'CSS 里没有 .btn-row');
    assert.match(rule[1], /display: flex/);
    assert.match(rule[1], /gap: var\(--s\d\)/);

    // **写死在 HTML 里的那些按钮，上面那段一个都看不见** —— 它顺的是 JS 变量。
    // 档案页的四个（导出这一份 / 导出整条链 / 验一验 / 删除这一份）就是裸着的：
    // 标签之间的换行塌成一个词间空格，看起来「有点缝」，于是没人当成毛病。
    // 所以这里换一种数法：数嵌套。
    // 判据是**紧挨着**，不是「同一个父元素里有两个」：调试页的「打开自检页」与
    // 「打开详细日志」同属一个 <section>，中间隔着标题和说明块，各自单独成行——
    // 按数量算会把它们判成一排，而那种误报正是上面那半段栽过的跟头。
    const bare = [];
    let found = 0;
    {
      const src = html.replace(/<!--[\s\S]*?-->/g, '');
      const VOID = new Set(['br', 'img', 'input', 'meta', 'link', 'hr']);
      /** @type {{ tag: string, at: number }[]} */
      const stack = [];
      /** @type {{ parent: number, from: number, to: number }[]} 每个 .act 按钮 */
      const acts = [];
      for (const m of src.matchAll(/<(\/?)([a-z][\w-]*)([^>]*)>/g)) {
        const [, slash, tag, attrs] = m;
        if (slash) { while (stack.length && stack.pop().tag !== tag); continue; }
        if (VOID.has(tag) || attrs.endsWith('/')) continue;
        if (tag === 'button' && /\bclass="[^"]*\bact\b/.test(attrs) && stack.length) {
          const close = src.indexOf('</button>', m.index);
          acts.push({ parent: stack[stack.length - 1].at, from: m.index, to: close + 9 });
        }
        stack.push({ tag, at: m.index });
      }
      const rows = new Set();
      for (let i = 1; i < acts.length; i += 1) {
        const [a, b] = [acts[i - 1], acts[i]];
        // 同一个爹，而且两者之间只有空白 —— 那它们会落在同一行上
        if (a.parent === b.parent && src.slice(a.to, b.from).trim() === '') rows.add(a.parent);
      }
      found = rows.size;
      for (const at of rows) {
        const open = /<[a-z][\w-]*[^>]*>/.exec(src.slice(at))[0];
        if (!/class="[^"]*\bbtn-row\b/.test(open)) bare.push(open);
      }
    }
    assert.ok(found >= 2, `只数到 ${found} 处并排按钮，这个扫描八成坏了`);
    assert.deepEqual(bare, [], `HTML 里这些容器并排放了按钮却没挂 .btn-row：\n${bare.join('\n')}`);
  });

  test('那一对小标签要与上下两段分开 —— 它是门，不是其中一段的一部分', async () => {
    // 这里原来是 `<h2>捕获列表</h2>`。标题自带上留白，把「这一份档案的详情」与
    // 「逐条核对字节」分成两段；换成按钮之后那点留白一起没了，于是它紧贴着上面的
    // 操作结果和下面的捕获区，看起来像属于其中某一段。
    //
    // 现在那里是两个互斥的小标签（生的 / 熟的），分界靠 `.subtabs` 自己的下边框，
    // 不再借 `.btn-row` 的按钮间距——它已经不是一排按钮了。
    const html = await readRepoFile('src/ui/panel.html');
    const css = await readRepoFile('src/ui/panel.css');
    assert.match(html, /id="captures-bar"[^>]*class="[^"]*\bsubtabs\b/,
      '那一条要挂 subtabs');
    assert.match(html, /id="captures-bar"[^>]*role="tablist"/, '互斥的一组要报成 tablist');
    const rule = /\.subtabs \{([^}]*)\}/.exec(css);
    assert.ok(rule, 'CSS 里没有 .subtabs');
    assert.match(rule[1], /border-bottom/, '要有一条分界线，光靠 margin 看不出这是两段');
    assert.match(rule[1], /margin: var\(--s\d\)/);
  });

  test('**这两块互斥** —— 同时摊开会把这一页撑得没法看', async () => {
    // 判据不是「代码里写了 else」，而是那个状态本身只有一个值：`openPane` 是
    // 单个变量（null / captures / content），从形状上就装不下「两个都开」。
    const js = await readRepoFile('src/ui/panel/archive.js');
    assert.match(js, /let openPane = DEFAULT_PANE;/, '开着哪个应当是一个变量，不是两个布尔');
    assert.doesNotMatch(js, /capturesOpen|contentOpen/, '两个独立布尔就能表示「都开着」');
    // 默认值也只有一个出处：初始化与 `resetArchive()` 各写一个字面量的话，
    // 改了一处就是「第一次打开」与「重新打开」不一样，而后者只有测试碰得到。
    assert.equal((js.match(/DEFAULT_PANE/g) ?? []).length, 3,
      'DEFAULT_PANE 应当定义一次、用两次（初始化与 resetArchive）');
  });

  test('**每个选项都说清它跳过什么** —— 跳过是这里唯一看不见的动作', async () => {
    // 跳过不产生捕获行，日志里不滚动，覆盖率页上也只是一个不再增长的数字。
    // 选项里不写，用户就没有任何地方能知道它发生过——而「它是不是漏抓了」正是
    // 这个工具最该回答清楚的问题。
    const js = readPanelSourceSync();
    const opts = js.slice(js.indexOf('function renderCrawlMode'));
    const body = opts.slice(0, opts.indexOf('\n}\n'));
    assert.match(body, /凡是抓过的一律跳过/, '增量要说清它跳过已经抓到的东西');
    assert.match(body, /一份跳过名单都不带/, '全量要说清它什么都不跳过');
    assert.match(body, /图片仍然跳过/, '重抓可编辑内容时，要说清图不在其列');
    // **要说出理由，不只是结论。** 「图片仍然跳过」会立刻引出「那我怎么重抓图」，
    // 而答案是「这件事做了也没有用」——不写的话用户会去找那个并不存在的开关。
    assert.match(body, /内容地址|同一批字节/, '要说清为什么重抓图拿不到新东西');
  });

  test('中止要有额外确认，且说清不可逆的是什么', async () => {
    const js = readPanelSourceSync();
    assert.match(js, /async function abortCrawl/);
    assert.match(js, /confirm\(/, '必须先确认');
    // **不可逆的是这次抓取，不是数据** —— 说反了用户要么不敢按，要么按了才发现丢东西
    const fn = js.slice(js.indexOf('async function abortCrawl'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.match(body, /全部保留|均予保留|都会留下/, '要说清数据留着');
    assert.match(body, /无法继续|不能再继续/, '要说清这次抓取到此为止');
    assert.match(body, /增量/, '要说清重开不会从头来');
  });

  test('中止用危险样式 —— 不可逆的动作要看起来不一样', async () => {
    const js = readPanelSourceSync();
    assert.match(js, /abortCrawl\(r\.bundleId\), 'danger'/);
  });

  test('只有 checkpoint 时（offscreen 还没起来）也要能中止', async () => {
    // 刚打开插件就是这个状态：runner 还不存在，只有 checkpoint。而那正是用户最
    // 可能想说「这次不抓了」的时刻——原来那里只有一个「继续」。
    const dom = await loadUi({
      which: 'panel',
      onMessage: (msg) => {
        if (msg.type === 'status') {
          return {
            ok: true, running: false,
            checkpoint: { bundle_id: 'b1', pause_reason: 'user_paused' },
            runner: { active: false },
          };
        }
        return IDLE(msg);
      },
    });
    try {
      const labels = [...dom.byId.get('actions').children].map((b) => b.textContent);
      assert.ok(labels.some((l) => l.includes('继续')), '要能继续');
      assert.ok(labels.some((l) => l.includes('中止')), '也要能中止');
    } finally {
      dom.restore();
    }
  });

  test('恢复那几秒必须有交代 —— 不能点了没反应', async () => {
    // 报上来的：点继续之后界面五秒一动不动，然后忽然全出来了。
    // 成因是忙碌状态只在**空闲分支**里判，而这时走的是 checkpoint 分支。
    const js = readPanelSourceSync();
    const fn = js.slice(js.indexOf('async function refresh'));
    const idxBusy = fn.indexOf('const busy =');
    const idxActive = fn.indexOf("if (s.runner?.active || s.checkpoint)");
    assert.ok(idxBusy >= 0 && idxBusy < idxActive, '忙碌状态要在所有分支之前判');
  });

  test('切换档案时把上一份的结果框清干净 —— 包括 class', async () => {
    // 只清文字会留下一个**空的红框**：看起来像出了事，却什么都不说。
    const js = readPanelSourceSync();
    const fn = js.slice(js.indexOf('async function openBundle'));
    const body = fn.slice(0, fn.indexOf('const summaryEl'));
    assert.match(body, /export-result/);
    assert.match(body, /className = ''/, 'class 也要清');
  });

  test('版本历史只报个数，且个数是真的', async () => {
    const js = readPanelSourceSync();
    assert.match(js, /function renderVersions\(count\)/);
    // 早先回的是截断到 200 条的清单，界面拿它的长度当总数 → 永远写着「200 个」
    const off = await readRepoFile('src/offscreen/offscreen.js');
    assert.match(off, /versionCount: d\.versions\.length/);
    assert.equal(off.includes('versions.slice(0, 200)'), false, '别再截断然后拿长度当总数');
  });

  test('一行里的 URL 与右边的计数要分开', async () => {
    // `…/games5 个版本` —— 两段直接粘在一起。
    // 样式从 panel.html 的内联 <style> 搬到了 panel.css，断言不变。
    const css = await readRepoFile('src/ui/panel.css');
    assert.match(css, /\.cap \{[^}]*display: flex/);
    assert.match(css, /\.cap \{[^}]*gap:/);
  });

  test('帮助页要回答「我该点哪个」', async () => {
    // 一个工具面板最该有的一句话不是「这个按钮叫什么」，而是**「现在该点哪个」**。
    const html = await readRepoFile('src/ui/panel.html');
    const help = html.slice(html.indexOf('id="tab-help"'), html.indexOf('</section>', html.indexOf('id="tab-help"')));
    // 判据是**那条路径在**，不是标题叫什么。原来这里钉的是字面的「三步走」，
    // 而标题恰恰是改文风时第一个会动的东西——把措辞当判据，等于让一次纯语气的
    // 改写去红一条与语气无关的测试。
    assert.match(help, /<ol class="steps">/, '要有一条从零开始的、编号的路径');
    for (const step of ['登录豆瓣', '开始抓取', '导出']) {
      assert.ok(help.includes(step), `从零到有档案的路径里缺了「${step}」`);
    }
    // 三步里最容易被跳过的是导出——不导出的话档案随时会连人带号一起没了。
    assert.match(help, /导出/);
    assert.match(help, /卸载扩展|清除站点数据/, '要说清不导出的后果');
    // 那几个会让人犹豫的按钮要逐个解释。
    for (const b of ['增量抓取', '全量抓取', '导出整条链', '导入档案', '验一验', '删除这一份']) {
      assert.ok(help.includes(b), `帮助里没解释「${b}」`);
    }
    // 停机原因也要能在这儿查到——它们出现时用户最需要一句话告诉他怎么办。
    for (const r of ['豆瓣要求验证', '登录状态已失效', '豆瓣暂时限制了访问']) {
      assert.ok(help.includes(r), `帮助里没有「${r}」`);
    }

    // **导入说「不导」的每一种都要能在帮助里查到。**
    // 它们全都不是故障（已经有了、别的账号、档案残缺…），而一个用户看不懂的拒绝，
    // 与一次失败在感受上没有区别 —— 他会去重试，而重试不会有任何不同。
    for (const r of ['已经有了', '补齐', '重复', '编号撞了', '别的账号', '不能导']) {
      assert.ok(help.includes(r), `帮助里没解释导入为什么会说「${r}」`);
    }
    // 帮助页里不许再提「存储」那个标签页 —— 它已经并进档案页了。
    assert.equal(/<b>存储<\/b>/.test(help), false, '帮助里还在说有个「存储」标签页');
  });

  test('**身份带排在使用步骤前面**，去处排在最后', async () => {
    // 这两块原来是同一个「关于」，压在九节说明底下。而翻到帮助页的人多半是有话
    // 要说，「我装的是哪一版」正是他要说的第一句 —— 让他为此滚到页尾，等于把最
    // 有动力的那个人挡在外面。
    //
    // **比的是位置，不是「存在」。** 只断言 id 在不在，把它移回页尾照样绿。
    const html = await readRepoFile('src/ui/panel.html');
    const about = html.indexOf('<div id="about">');
    const steps = html.indexOf('<h2>使用步骤</h2>');
    const links = html.indexOf('<div id="links">');
    assert.ok(about > 0 && steps > 0 && links > 0, '帮助页少了 #about / 使用步骤 / #links');
    assert.ok(about < steps, '身份带（版本号在里面）跑到「使用步骤」后面去了');
    assert.ok(steps < links, '去处与致谢该在页尾');
    // 两个容器各只有一个 —— 同一个 id 出现两次时 `$()` 只会拿到第一个，
    // 另一处永远是空的，而空着看起来跟「这块没内容」一模一样。
    assert.equal(html.split('id="about"').length - 1, 1);
    assert.equal(html.split('id="links"').length - 1, 1);
  });

  test('**关于**：版本号真的来自 manifest，外链带 noopener', async () => {
    // 这一条原来是拿正则在源码里找 `getManifest`。那只证明字符串在文件里 ——
    // 谁也没验过它渲染出来的是什么。这里真的跑一遍，断言页面上的数字**跟着
    // manifest 变**：写死的版本号在那种测法下是绿的。
    const dom = await installFakeDom({ html: await readRepoFile('src/ui/panel.html') });
    try {
      dom.chrome.runtime.getManifest = () => ({ version: '7.8.9' });
      const help = await import(`../src/ui/panel/help.js?t=${Date.now()}${Math.random()}`);
      help.renderAbout();
      help.renderLinks();

      const about = dom.byId.get('about').textContent;
      assert.match(about, /v7\.8\.9/, '版本号没有跟着 manifest 走');
      assert.match(about, /第三方工具/, '要说清这不是豆瓣官方的东西');
      assert.match(about, /没有服务器/, '要说清数据不会离开这台机器');
      // **报错前先说清楚会带出去什么。** 不说的话，一个在意隐私的人不敢提 issue，
      // 而他恰恰是最该被听见的那类用户。
      assert.match(about, /日志[\s\S]*用户名/, '要提醒日志里有什么');

      const links = dom.byId.get('links').textContent;
      for (const u of ['doubak.com', 'sample.doubak.com', 'github.com/Doubak']) {
        assert.ok(links.includes(u), `去处里没有 ${u}`);
      }

      // 两块加起来要给出提 issue 与发邮件的去处，缺一不可。
      const anchors = [...dom.byId.get('about').querySelectorAll('a'),
        ...dom.byId.get('links').querySelectorAll('a')];
      const hrefs = anchors.map((a) => a.href);
      assert.ok(hrefs.some((h) => h.includes('doubak-extension/issues')), '要给提 issue 的去处');
      assert.ok(hrefs.some((h) => h.startsWith('mailto:')), '要给邮箱');

      for (const a of anchors) {
        if (a.href.startsWith('mailto:')) {
          // mailto 开新标签页会留下一个空白页。
          assert.equal(a.target, undefined, `${a.href} 不该开新标签页`);
        } else {
          // 不带 noopener 的话，对方页面能通过 window.opener 操作这一页。
          assert.equal(a.target, '_blank');
          assert.equal(a.rel, 'noreferrer noopener', `${a.href} 少了 rel`);
        }
      }
    } finally {
      dom.restore();
    }
  });

  test('拿不到版本号时明说「版本未知」，不是悄悄不显示', async () => {
    // 少一个数字，与从来没打算显示它，在页面上长得一模一样 —— 而这一页存在的
    // 理由就是让人有话可说，第一句话就是版本号。
    const dom = await installFakeDom({ html: await readRepoFile('src/ui/panel.html') });
    try {
      dom.chrome.runtime.getManifest = () => ({});
      const help = await import(`../src/ui/panel/help.js?t=${Date.now()}${Math.random()}`);
      help.renderAbout();
      assert.match(dom.byId.get('about').textContent, /版本未知/);
    } finally {
      dom.restore();
    }
  });

  test('页眉给一个去官网的口子，且与标签页分开', async () => {
    // 它不是这个面板的一页，点了会离开——排进标签页里会让人以为是第七个页面。
    const html = await readRepoFile('src/ui/panel.html');
    const nav = html.slice(html.indexOf('<nav id="tabs">'), html.indexOf('</nav>'));
    assert.match(nav, /class="to-site"[^>]*href="https:\/\/doubak\.com"/);
    assert.match(nav, /rel="noreferrer noopener"/);
    // 它是 <a> 不是 <button data-tab> —— 后者会被标签页切换逻辑当成一页。
    assert.ok(!/data-tab="[^"]*"[^>]*doubak\.com/.test(nav));
    const css = await readRepoFile('src/ui/panel.css');
    assert.match(css, /\.to-site \{[^}]*margin-left: auto/, '要推到最右边');
  });

  test('档案页：列表在左，详情在右', async () => {
    // 档案会越攒越多。竖着排的话选一份要先滚过整张列表，回头看详情又要滚回去。
    const html = await readRepoFile('src/ui/panel.html');
    const arch = html.slice(html.indexOf('id="tab-archive"'), html.indexOf('</section>', html.indexOf('id="tab-archive"')));
    assert.match(arch, /class="with-aside"/);
    assert.match(arch, /<aside id="bundle-pick">/);
    const css = await readRepoFile('src/ui/panel.css');
    assert.match(css, /\.with-aside \{[^}]*grid-template-columns/);
    // 窄窗口要退回上下排，否则两列各自挤成一条。
    assert.match(css, /max-width: 860px[\s\S]{0,600}\.with-aside \{ grid-template-columns: 1fr/);
  });

  test('**「翻看捕获 / 查看内容」在右栏里面**，不在两栏下面', async () => {
    // 它原来是整页宽的一块，排在网格之后。两栏一样高之后，左边那张档案清单
    // （十几份就够长）决定了行高，于是整页宽的东西被推到清单的下沿——想看这份
    // 档案的内容，得先滚过一张与它无关的清单。
    //
    // 判据数的是**嵌套深度**，不是字符位置：这一页的判据里已经有好几条因为钉着
    // 「谁在谁后面 200 个字符内」而在重排时误红过。
    const html = await readRepoFile('src/ui/panel.html');
    const clean = html.replace(/<!--[\s\S]*?-->/g, '');
    // **从那个 `<div` 本身开始数，不是从属性开始。** 从属性起算的话，第一个遇到
    // 的是它的子元素，深度一开始就是 0，于是第一个子元素一闭合就以为右栏结束了。
    const at = clean.indexOf('class="aside-main"');
    assert.ok(at > 0, '右栏那个容器不见了，这条判据失去了意义');
    const from = clean.lastIndexOf('<div', at);

    // 从 `.aside-main` 那个 <div> 开始走，深度回到 0 就是它结束了。
    let depth = 0;
    let end = clean.length;
    for (const m of clean.slice(from).matchAll(/<(\/?)div\b/g)) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) { end = from + m.index; break; }
    }
    const inside = clean.slice(from, end);
    for (const id of ['captures-bar', 'captures-section', 'content-section']) {
      assert.ok(inside.includes(`id="${id}"`), `#${id} 跑到右栏外面去了`);
    }
  });

  test('**两列布局里侧栏不粘、不自己滚**', async () => {
    // 它原来是 `position: sticky` + `max-height: 70vh; overflow: auto`。三处不好：
    // 滚页面时它原地不动（成了跟着你跑的东西）、一页两个滚动条、以及最坏的那处
    // ——70vh 之外的行看不见，而它们没有任何迹象说自己存在。正在抓的那一份沉到
    // 十七行底下那次，「清单看起来没刷新」的直接原因就是它。
    //
    // 判据钉在**宽窗口那一段**上：窄窗口里清单在详情上面，那里的 max-height 是
    // 有道理的，两者不是同一件事。
    const css = await readRepoFile('src/ui/panel.css');
    const wide = css.slice(0, css.indexOf('@media (max-width: 860px)'));
    const rule = wide.slice(wide.indexOf('.with-aside > aside {'));
    const body = rule.slice(0, rule.indexOf('}'));
    assert.equal(/position: sticky/.test(body), false, '侧栏又粘住了');
    assert.equal(/max-height|overflow/.test(body), false,
      '侧栏又自己滚了 —— 超出的那些行没有任何迹象说自己存在');
    // 而且两列一样高：网格默认 stretch，所以不能写 align-items: start。
    assert.equal(/\.with-aside \{[^}]*align-items: start/.test(css), false,
      'align-items: start 会让侧栏只有自己那点高度，右边长它不长');
  });

  test('**卡片的语气只有一套词**，而且每一个都在 CSS 里有规则', async () => {
    // 面板里曾经并存两套：`card err` / `good` / `run` 与 `card tone-error` /
    // `tone-ok` / `tone-busy`。CSS 里只有后一套有规则，于是**前一套那 35 处卡片
    // 一点颜色都没有**——「有 8 条在豆瓣上已经没有了」与一句普通说明长得一模一样。
    //
    // 这种毛病靠看是发现不了的：每一处单独看都像写对了，只有把类名与 CSS 放在
    // 一起数才看得出来。所以这条判据做的正是那件事——**两头对齐**，而不是
    // 「别再写 `card err`」那样只挡住一个方向。
    const js = readPanelSourceSync();
    const css = await readRepoFile('src/ui/panel.css');

    const used = [...js.matchAll(/['"`]card ([a-z-]+|\$\{[^}]*\})/g)].map((m) => m[1]);
    assert.ok(used.length > 20, `只找到 ${used.length} 处卡片类名，这条判据多半没在数它想数的东西`);

    const bad = used.filter((c) => !c.startsWith('tone-') && !c.startsWith('${'));
    assert.deepEqual(bad, [], `这些卡片用的是旧词，CSS 里没有对应规则：${[...new Set(bad)].join('、')}`);

    // 模板拼出来的那几处（`card tone-${tone}`）验的是词表本身：五种语气都要有规则。
    for (const tone of ['idle', 'busy', 'ok', 'warn', 'error']) {
      assert.match(css, new RegExp(`\\.tone-${tone}\\s*\\{`), `CSS 里没有 .tone-${tone}`);
    }
  });

  test('折叠块用原生 <details>，不自己写展开逻辑', async () => {
    // 键盘、读屏、Ctrl-F 找页内文字——原生的这些都照旧能用，自己写一套就要各自
    // 重来一遍，而这个面板里没有任何理由需要那样。
    const js = readPanelSourceSync();
    assert.match(js, /createElement\('details'\)/);
    const css = await readRepoFile('src/ui/panel.css');
    assert.match(css, /\.fold > summary/, '折叠块没有样式');
  });

  test('**JS 里不许出现行内样式**', async () => {
    // 原来有 17 处 `el.style.fontSize = '12px'` 之类，散在各处。样式一旦能在
    // JS 里随手写，就没有任何力量阻止下一块界面再发明一套——**统一不了的根源
    // 是没有唯一的地方，不是没人愿意统一**。
    const js = readPanelSourceSync();
    const hits = [...js.matchAll(/^.*\.style\.[a-zA-Z]/gm)].map((m) => m[0].trim());
    assert.deepEqual(hits, [], `这些地方在 JS 里写样式：\n${hits.join('\n')}`);
  });

  test('**HTML 里也不许**', async () => {
    const html = await readRepoFile('src/ui/panel.html');
    assert.ok(!/ style="/.test(html), 'panel.html 里还有 style= 属性');
  });

  test('**颜色只能来自 token**，不许在规则里写死十六进制', async () => {
    // 写死的话，改一次配色要全文搜一遍，而深色模式必然漏掉几处。
    const css = await readRepoFile('src/ui/panel.css');
    const body = css.slice(css.indexOf('* { box-sizing'));
    const hex = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    // 允许纯白/纯黑这种在主色按钮上作前景的极端值。
    const bad = hex.filter((h) => !/^#(fff|000|8881|8882|8883)$/i.test(h));
    assert.deepEqual(bad, [], `这些颜色没走 token：${bad.join(' ')}`);
  });

  test('**不许往兄弟节点里插** —— 没人负责清，切一次档案就多留一张', async () => {
    // 真实现象：打开一份 05:13 的全量档案，上面挂着**两张一模一样**的卡片，都写着
    // 「接在 11:21 那份后面」。一份 05:13 的档案不可能接在 11:21 后面——那两张是
    // 看别的档案时留下的，`.after()` 插进去之后没人管。
    const js = readPanelSourceSync();
    const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const bad of ['.after(', '.before(', 'insertAdjacent']) {
      assert.equal(code.includes(bad), false, `${bad} 插出来的节点没人负责清`);
    }
  });

  test('「这是一次增量抓取」有自己的容器，且切档案时会清掉', async () => {
    const html = await readRepoFile('src/ui/panel.html');
    assert.match(html, /id="archive-incremental"/);
    const js = readPanelSourceSync();
    // 切档案时清掉
    assert.match(js, /\['export-result', 'verify-result', 'archive-incremental'\]/);
    // 每次渲染前也清掉（同一份档案刷新两次不该出现两张）
    assert.match(js, /incEl\.replaceChildren\(\)/);
  });

  test('界面上不许出现 Markdown 记号 —— 那不会被渲染，只会原样显示', async () => {
    // 真实现象：卡片上出现「同一个网址的多次捕获**不是重复数据，是版本**」，
    // 星号原封不动地印在屏幕上。这里的文字是 `textContent`，不是 Markdown。
    // 要强调就用 <b>。
    const html = await readRepoFile('src/ui/panel.html');
    const visible = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
    assert.equal(visible.includes('**'), false, 'panel.html 的可见文字里有 Markdown 星号');

    // JS 里那些会进 textContent / createTextNode / confirm 的中文串
    const js = readPanelSourceSync();
    const bad = [];
    for (const line of js.split('\n')) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue; // 注释里随便写
      for (const m of line.matchAll(/'([^']*\*\*[^']*)'/g)) {
        if (/[\u4e00-\u9fa5]/.test(m[1])) bad.push(m[1].slice(0, 40));
      }
    }
    assert.deepEqual(bad, [], '这些字符串会原样显示星号');
  });

  test('术语统一：说「已抓取多次」，不说「又抓了一次」', async () => {
    const js = readPanelSourceSync();
    const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.equal(code.includes('又抓了一次'), false);
    assert.ok(code.includes('已抓取多次'));
  });

  test('导出整条链：按钮在、逐份导、一份失败不中断其余', async () => {
    const html = await readRepoFile('src/ui/panel.html');
    assert.match(html, /id="export-chain"/);
    assert.match(html, /导出这一份/, '单份那个按钮要改名，否则两个都叫「导出」分不清');

    const js = readPanelSourceSync();
    // 按当前打开的这一份取链，不是永远取最新那条
    assert.match(js, /type: 'chain', bundleId: currentBundleId/);
    // 分子目录，否则 manifest.json 互相覆盖
    assert.match(js, /subdirectorySink\(parent, bundleDirName\(id\)\)/);
    // **单份导出也要建子目录** —— 否则往同一个下载目录导几次，早先的 manifest
    // 全被覆盖，档案编号只剩在文件名里
    assert.equal(js.includes('directorySink(dir)'), false, '单份导出还在平铺');
    assert.match(js, /subdirectorySink\(dir, folder\)/);
    // 一份失败不中断其余
    // **按模块取，不按字符位置切。** 原来是从 `$('export-chain')` 第一次出现的地方
    // 切到某个函数名——那默认了「监听器写在渲染函数前面」，而面板一拆成模块，这个
    // 默认就不成立了（拼接顺序按文件名排）。判据不该绑在源码顺序上。
    const exp = await readRepoFile('src/ui/panel/export.js');
    assert.match(exp, /catch \(e\)[\s\S]{0,200}done\.push/, '失败也要记下来并继续');
  });

  test('导出结果逐份说清楚，不汇总成一句「成功」', async () => {
    const js = readPanelSourceSync();
    assert.match(js, /function renderChainExportResult/);
    // 只在校验通过时才记「已导出」——没验过就说导出了，等于给一个我们没资格给的保证
    const exp = await readRepoFile('src/ui/panel/export.js');
    assert.match(exp, /res\.problems\.length === 0/);
    // 走 `noteExported`（shared.js）——它把「记一笔」与「让界面跟上」绑在一起，
    // 所以 `markExported` 不再直接出现在导出路径里。
    assert.match(exp, /noteExported/);
    assert.doesNotMatch(
      exp, /type:\s*'markExported'/,
      '导出路径不该再直接发 markExported —— 那样就能忘记刷新，而那正是出过的问题',
    );
  });

  test('抓取中要写出正在抓的那个 URL', async () => {
    // 原来只有「档案 xxx · 当前间隔 1.0 秒」，一次抓取几个小时里几乎一动不动——
    // 看不出它是在动还是卡住了。
    const dom = await loadUi({
      which: 'panel',
      onMessage: (msg) => {
        if (msg.type === 'status') {
          return {
            ok: true,
            running: true,
            runner: {
              active: true, stopped: false, stoppedBy: null,
              bundleId: 'b', intervalMs: 1000, backoffLevel: 0,
              current: 'https://www.douban.com/people/example/statuses?p=7',
              counts: { done: 5, pending: 3 }, routes: [],
            },
          };
        }
        return IDLE(msg);
      },
    });
    try {
      const s = dom.byId.get('state').textContent;
      assert.match(s, /douban\.com\/people\/example\/statuses\?p=7/);
      assert.equal(/https:\/\//.test(s), false, '协议头是噪音，URL 本来就够长了');
    } finally {
      dom.restore();
    }
  });

  test('拿不到当前 URL 时不显示「正在抓 null」', async () => {
    const dom = await loadUi({
      which: 'panel',
      onMessage: (msg) => {
        if (msg.type === 'status') {
          return {
            ok: true,
            running: true,
            runner: {
              active: true, stopped: false, stoppedBy: null,
              bundleId: 'b', intervalMs: 1000, backoffLevel: 0, current: null,
              counts: { done: 0, pending: 3 }, routes: [],
            },
          };
        }
        return IDLE(msg);
      },
    });
    try {
      const s = dom.byId.get('state').textContent;
      assert.equal(/null|undefined|正在抓\s*$/.test(s), false);
    } finally {
      dom.restore();
    }
  });

  test('断点里的停机原因也要翻译 —— 这条以前只有 popup 测过', async () => {
    // 与上面那条不同的分支：抓取**没在跑**，原因来自持久化的 checkpoint。
    // 用户重开浏览器后看到的就是这条。
    const dom = await loadUi({
      which: 'panel',
      onMessage: (msg) => {
        if (msg.type === 'status') {
          return {
            ok: true,
            running: false,
            checkpoint: { bundle_id: 'x', pause_reason: 'host_permission_lost' },
            runner: { active: false },
          };
        }
        return IDLE(msg);
      },
    });
    try {
      const s = dom.byId.get('state').textContent;
      assert.match(s, /权限/);
      assert.equal(/host_permission_lost/.test(s), false, '界面上不许出现内部标识');
    } finally {
      dom.restore();
    }
  });

  test('删除确认框把要失去的具体东西说出来', async () => {
    // 一句「确定删除吗？」等于什么都没说。确认框必须点明哪一份、多大、导出过没有
    // ——删除不可逆且没有回收站。
    const js = readPanelSourceSync();
    const fn = js.slice(js.indexOf('async function deleteBundle'), js.indexOf('async function deleteAll'));

    assert.match(fn, /confirm\(/, '删除必须先确认');
    assert.match(fn, /u\.bundleId/, '要说是哪一份');
    assert.match(fn, /bytes\(u\.bytes\)/, '要说多大');
    assert.match(fn, /唯一的副本/, '没导出过要明确警告');
    assert.match(fn, /不可逆/, '要说清后果');
    // 代码那一侧的守卫也要在，不能只靠确认框
    assert.match(fn, /checkDeletable/);
  });

  test('清空全部会跳过正在抓的那份，并逐个删', async () => {
    const js = readPanelSourceSync();
    const fn = js.slice(js.indexOf('async function deleteAll'), js.indexOf('function setStorageResult'));

    assert.match(fn, /filter\(\(u\) => u\.deletable\)/, '正在抓的那份要保留');
    // 逐个删而不是一把梭：一份失败不该让其余的也不删
    assert.match(fn, /for \(const u of deletable\)/);
    assert.match(fn, /failed/, '要说清哪些没删成');
  });

  test('只在校验通过时才记「已导出」', async () => {
    // 没验过就说「已导出」，等于给了一个我们没资格给的保证——而那个保证会被用来
    // 决定删除确认框说得多重。
    const js = readPanelSourceSync();
    // 两条导出路径都要有这道闸。判据从「找 markExported」改成「找 noteExported」，
    // 因为记账与刷新已经合成了一个入口。
    // `await noteExported(` 才是调用点；`export async function noteExported(` 是定义，
    // 而 readPanelSource 读的是整个目录，两者都会命中。
    const spots = [...js.matchAll(/await noteExported\(/g)].map((m) => m.index);
    assert.ok(spots.length >= 2, `导出路径应当有两处（单份、整条链），实际 ${spots.length}`);
    for (const i of spots) {
      assert.match(
        js.slice(Math.max(0, i - 400), i), /problems\.length === 0/,
        '有一处没有先检查校验结果就记「已导出」',
      );
    }
  });

  test('捕获列表的措辞逻辑抽成了纯函数，并且真的被用上', async () => {
    // 那三条断言原来是对着 panel.js 做源码匹配的。逻辑抽进
    // `src/ui/capture-label.js` 之后，源码匹配失效——**但那不是退步**：现在有
    // `test/capture-label.test.js` 里 15 条真正跑逻辑的测试，覆盖旧档案、
    // 作品详情页、越界终止页、offset 游标等等。
    //
    // 这里只钉住「面板确实用的是那个模块」，别的交给行为测试。
    const js = readPanelSourceSync();
    // 路径带上层：档案页现在在 `panel/archive.js`，到 `ui/capture-label.js` 要退一级。
    // 判据问的是「有没有走那个纯函数」，不是「相对路径长什么样」。
    assert.match(js, /from '\.{1,2}\/capture-label\.js'/);
    assert.match(js, /captureTitle\(e, routeName\)/);
    assert.match(js, /captureSubtitle\(e\)/);
    // 逻辑不该又被抄回面板里
    assert.equal(js.includes('function captureSubtitle'), false);
  });

  test('判定只在不是 ok 时显示 —— 一整列「正常」是噪音', async () => {
    const js = readPanelSourceSync();
    const fn = js.slice(js.indexOf('function renderCaptureList'), js.indexOf('function captureTitle'));
    assert.match(fn, /e\.verdict === 'ok'/);
  });

  test('抓完之后不清空进度表 —— 显示上一次的结果', async () => {
    // 抓完立刻变回「还没有开始」，等于把刚跑完那一次的结果扔了，而那正是用户此刻最想
    // 看的东西。数据取自最新档案的 manifest（权威记录），不是内存里的快照。
    const js = readPanelSourceSync();
    assert.match(js, /function showLastRun/);
    assert.match(js, /crawlState/, '要读 manifest 的 crawl_state');
    assert.match(js, /low_water_time/, '「已回溯到」用最旧那一端');
  });

  test('覆盖率页有自己的加载，且先说「正在读取」', async () => {
    // 它原来只是 openBundle() 的副作用：第一次直接点进来是空白的，而空白看起来像
    // 「正在加载」——实际什么都不会发生。
    const js = readPanelSourceSync();
    assert.match(js, /if \(btn\.dataset\.tab === 'coverage'\) loadCoverage\(\)/);
    const fn = js.slice(js.indexOf('async function loadCoverage'), js.indexOf('function renderCoverage'));
    assert.match(fn, /正在读取/);
  });

  test('日志页读的是持久化的日志，不是内存数组', async () => {
    // 原来只记面板打开期间的事件、一刷新就没，而界面上却写着「仅本地保留…导出前请自行
    // 脱敏」——同时暗示了「存下来了」和「有导出」，两个都不存在。
    const js = readPanelSourceSync();
    assert.match(js, /type: 'readLog'/);
    assert.equal(js.includes('const logLines = []'), false, '内存数组不该还在');
    assert.match(js, /formatLogText/, '要有复制/导出');
  });

  test('日志页的说明与实现一致', async () => {
    const html = await readRepoFile('src/ui/panel.html');
    const hint = html.slice(html.indexOf('id="tab-log"'), html.indexOf('id="log"'));
    assert.match(hint, /IndexedDB|存在本机/, '说清存在哪');
    assert.match(hint, /脱敏/, '说清里面有 URL 与用户名');

    // **上限要与代码里的常量一致**，写死数字会跟着改一半——这条测试就是为此存在的。
    const { MAX_ENTRIES, MAX_FETCH_ENTRIES } = await import('../src/crawl/event-log.js');
    assert.ok(hint.includes(String(MAX_ENTRIES)), `说明里没提事件上限 ${MAX_ENTRIES}`);
    assert.ok(hint.includes(String(MAX_FETCH_ENTRIES)), `说明里没提抓取记录上限 ${MAX_FETCH_ENTRIES}`);
  });

  test('覆盖率只有一条渲染路径 —— 不再是档案页的副作用', async () => {
    // 两条路径就是两个真相来源：没去过档案页时覆盖率看到的可能是另一份档案；
    // 删掉档案之后选中的 id 还指着一个不存在的目录。
    const js = readPanelSourceSync();
    // 切到这个函数自己的末尾，不要切到「下一个函数的名字」——那种切法会在下一次
    // 改名或挪动顺序时静默地扩大或缩小范围。
    const open = js.slice(js.indexOf('async function openBundle'));
    const openBundleFn = open.slice(0, open.indexOf('\n}\n'));
    assert.equal(openBundleFn.includes('renderCoverage'), false, '档案页不该顺手渲染覆盖率');

    const loadCov = js.slice(js.indexOf('async function loadCoverage'), js.indexOf('function renderCoverage'));
    assert.match(loadCov, /loadBundleSummary/, '覆盖率要从共同来源读');
  });

  test('两个标签页共用同一处「在看哪份档案」', async () => {
    const js = readPanelSourceSync();
    assert.match(js, /async function loadBundleSummary/);
    assert.match(js, /summaryCache/);
  });

  test('删除档案会作废缓存并取消已失效的选中', async () => {
    // 不取消的话，下一次读取会去开一个不存在的目录然后报「读不出来」，
    // 而真实情况只是它被删了。
    const js = readPanelSourceSync();
    const inv = js.slice(js.indexOf('function invalidateBundles'), js.indexOf('async function loadBundleSummary'));
    assert.match(inv, /summaryCache = null/);
    assert.match(inv, /currentBundleId = null/);

    // 单份删除与清空全部都要调
    const del = js.slice(js.indexOf('async function deleteBundle'), js.indexOf('async function deleteAll'));
    const all = js.slice(js.indexOf('async function deleteAll'), js.indexOf('function setStorageResult'));
    assert.match(del, /invalidateBundles/);
    assert.match(all, /invalidateBundles/);
  });

  test('存储变化之后要重画当前打开的那一页', async () => {
    // 只作废缓存不重画的话，用户会盯着一份已经被删掉的档案的数字。
    const js = readPanelSourceSync();
    assert.match(js, /async function refreshOpenTab/);
    const del = js.slice(js.indexOf('async function deleteBundle'), js.indexOf('async function deleteAll'));
    assert.match(del, /refreshOpenTab/);
  });

  test('每个 $(id) 都在 HTML 里真的存在', async () => {
    // `$()` 返回 null 之后往上一步才炸，栈里看不出缺的是哪个 id。
    const js = readPanelSourceSync();
    const html = await readRepoFile('src/ui/panel.html');
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    for (const m of js.matchAll(/\$\('([^']+)'\)/g)) {
      assert.ok(ids.has(m[1]), `panel.js 用了 #${m[1]}，但 panel.html 里没有`);
    }
  });
});

describe('popup 已经拆掉了', () => {
  // 它是个多余的中间层：真正要看的东西（日志、覆盖率、档案预览、失败页面）一个都放不下，
  // 而且一失焦就关，长任务没法在里面盯。实际用法一直是「点图标、再点一下进面板」。
  //
  // 这组测试防的是「拆了一半」——那比不拆更糟：manifest 里留着 default_popup 的话，
  // `action.onClicked` **永远不会触发**，于是点图标什么都不会发生。

  test('manifest 里没有 default_popup', async () => {
    const mf = JSON.parse(await readRepoFile('manifest.json'));
    assert.equal('default_popup' in (mf.action ?? {}), false,
      '留着它的话 action.onClicked 不会触发，点图标就没反应了');
    assert.ok(mf.action?.default_icon, '图标还是要有的');
  });

  test('background 接管了图标点击', async () => {
    const js = await readRepoFile('src/background.js');
    assert.match(js, /chrome\?\.action\?\.onClicked/, '没人接图标点击 = 点了没反应');
    assert.match(js, /openPanel\(\)/);
  });

  test('源码里不再引用 popup 文件', async () => {
    for (const f of ['src/background.js', 'src/ui/panel.js', 'src/ui/notify.js']) {
      const js = await readRepoFile(f);
      assert.equal(/popup\.(html|js)/.test(js), false, `${f} 还指向已删除的 popup`);
    }
  });
});

describe('openPanel：点图标和点通知共同的落点', () => {
  test('已经开着就切过去，不再开一个', async () => {
    // 一次抓取里这个会被点很多次。每次都 tabs.create 的话，一个下午能攒出十几个
    // 同一个页面的标签页——而它们还都在轮询状态。
    const created = [];
    const activated = [];
    const focused = [];
    const chrome = {
      runtime: {
        getURL: (p) => `chrome-extension://abc/${p}`,
        getContexts: async () => [
          { contextType: 'TAB', tabId: 7, windowId: 3,
            documentUrl: 'chrome-extension://abc/src/ui/panel.html#log' },
        ],
      },
      tabs: {
        create: async (o) => created.push(o.url),
        update: async (id, o) => activated.push([id, o.active]),
      },
      windows: { update: async (id, o) => focused.push([id, o.focused]) },
    };
    const prev = globalThis.chrome;
    globalThis.chrome = chrome;
    try {
      const { openPanel } = await import('../src/ui/notify.js');
      const r = await openPanel();
      assert.equal(r.created, false);
      assert.deepEqual(created, [], '不该再开一个');
      assert.deepEqual(activated, [[7, true]]);
      assert.deepEqual(focused, [[3, true]], '标签页可能在别的窗口里');
    } finally {
      globalThis.chrome = prev;
    }
  });

  test('没开着就开一个', async () => {
    const created = [];
    const prev = globalThis.chrome;
    globalThis.chrome = {
      runtime: { getURL: (p) => `chrome-extension://abc/${p}`, getContexts: async () => [] },
      tabs: { create: async (o) => created.push(o.url) },
    };
    try {
      const { openPanel } = await import('../src/ui/notify.js');
      const r = await openPanel();
      assert.equal(r.created, true);
      assert.deepEqual(created, ['chrome-extension://abc/src/ui/panel.html']);
    } finally {
      globalThis.chrome = prev;
    }
  });

  test('getContexts 不可用时照样能开 —— 多开一个是小事，打不开是大事', async () => {
    // getContexts 要 Chrome 116+。
    const created = [];
    const prev = globalThis.chrome;
    globalThis.chrome = {
      runtime: { getURL: (p) => `chrome-extension://abc/${p}` }, // 没有 getContexts
      tabs: { create: async (o) => created.push(o.url) },
    };
    try {
      const { openPanel } = await import('../src/ui/notify.js');
      await openPanel();
      assert.equal(created.length, 1);
    } finally {
      globalThis.chrome = prev;
    }
  });
});

describe('停下来之后，顶端不能是死路', () => {
  const js = readPanelSourceSync();

  test('failures_pending 刻意不给「继续」—— 但必须给别的', () => {
    // 这个状态该做的决定是「重试」还是「就这样收尾」，而那两个按钮在失败清单里。
    // 道理是对的，可结果是：屏幕顶端只剩一个「中止这次抓取」，真正该点的东西在
    // 一百多行表格的下面。
    //
    // 用户的原话是「继续按钮没了，只剩中止」——从顶端看这就是一条死路，而一个
    // 只提供「放弃」的界面会把人推向放弃。
    assert.match(js, /\.\.\.failureActions\(r\.failures\)/, '没有把失败动作提到顶部动作行');
  });

  test('顶部与清单里指向同一个函数，不是另一套逻辑', () => {
    // 两处各写一遍的话，迟早有一处忘了改——而它们是同一个决定。
    assert.match(js, /async function retryFailures\(\)/);
    assert.match(js, /async function finishWithGaps\(leaves\)/);
    assert.equal(
      (js.match(/type: 'retryFailed'/g) ?? []).length, 1,
      '「重试」的实现出现了不止一处',
    );
    assert.equal(
      (js.match(/type: 'finishWithGaps'/g) ?? []).length, 1,
      '「就这样收尾」的实现出现了不止一处',
    );
  });

  test('有分页失败时不给「就这样收尾」', async () => {
    // 跳过分页条目等于免掉水位线赖以成立的前提，那不是用户能授权的事。
    assert.match(js, /if \(!ordered\.length\) acts\.push\(\['就这样收尾'/);
  });
});

describe('只剩 checkpoint 时也不能是死路', () => {
  const js = readPanelSourceSync();
  const bg = readFileSync(new URL('../src/background.js', import.meta.url), 'utf-8');

  test('failures_pending 在 checkpoint 分支里有出路', () => {
    // 这条分支（offscreen 被回收了，只剩 checkpoint）**根本不渲染失败清单**，
    // 而 failures_pending 又刻意不给「继续」——于是整个界面只剩一个
    // 「中止这次抓取」。用户唯一能做的事，是把一次跑了几小时、只差几个页面的
    // 抓取扔掉。
    assert.match(js, /s\.checkpoint\.pause_reason !== 'failures_pending'/);
    assert.match(js, /重试抓不下来的页面/);
  });

  test('那两个操作要能自己把抓取装回内存', () => {
    // frontier 活在内存里，offscreen 一被回收就没了。不先装回来的话，这两个
    // 按钮点下去只会拿到「没有进行中的抓取」——按钮在，但按不动。
    assert.match(bg, /async function ensureRunLoaded\(\)/);
    const retryIdx = bg.indexOf("case 'retryFailed'");
    const finishIdx = bg.indexOf("case 'finishWithGaps'");
    assert.ok(retryIdx > 0 && finishIdx > 0);
    assert.match(bg.slice(retryIdx, retryIdx + 300), /ensureRunLoaded\(\)/);
    assert.match(bg.slice(finishIdx, finishIdx + 300), /ensureRunLoaded\(\)/);
  });

  test('装回内存不等于接着抓', () => {
    // 用户点的是「处理失败」，不是「继续抓」。顺手驱动一段等于替他做了决定，
    // 而这个状态下他很可能正想收尾。
    const i = bg.indexOf('async function ensureRunLoaded()');
    const body = bg.slice(i, bg.indexOf('\n}', i));
    assert.equal(/\bdrive\(\)/.test(body), false, 'ensureRunLoaded 不该顺手驱动');
  });

  test('**收尾的确认放在函数里**，不在调用方', async () => {
    // 有两个入口会调它。确认写在调用方的话，迟早有一个入口忘了——而这是一个
    // 会写进 manifest、影响下次水位线的决定。
    const i = js.indexOf('async function finishWithGaps(leaves)');
    const body = js.slice(i, js.indexOf('\n}', i));
    assert.match(body, /confirm\(/);
  });
});

describe('出错就停在错误上，不要接着刷新掉', () => {
  const js = readPanelSourceSync();

  /** 取一个函数体（到下一个顶层 `}` 为止，够用）。 */
  const bodyOf = (name) => {
    const i = js.indexOf(`async function ${name}(`);
    assert.ok(i > 0, `找不到 ${name}`);
    return js.slice(i, js.indexOf('\n}', i));
  };

  for (const fn of ['retryFailures', 'finishWithGaps', 'resumeCrawl']) {
    test(`${fn}：错误写进 notice，不是状态卡`, () => {
      // **状态卡活不过两秒。** 它由 refresh() 画，而 refresh() 每 2 秒被轮询
      // 调用一次——写在上面的错误会被下一轮按后台状态重画掉。
      //
      // 用户看到的正是这个：点一下 → 闪出点什么 → 回到原样。而「点了没反应」
      // 与「报了错但你没看见」在屏幕上完全一样，却指向完全不同的原因——这次
      // 排查在这上面白绕了好几轮。
      const body = bodyOf(fn);
      assert.match(body, /setActionError\(/, `${fn} 还在往状态卡里写错误`);
      assert.equal(
        /setState\('err'/.test(body), false,
        `${fn} 用 setState('err') 写错误，两秒后会被轮询抹掉`,
      );
      const errIdx = body.indexOf('setActionError(');
      const after = body.slice(errIdx);
      assert.match(after, /return;/, `${fn} 写完错误没有 return`);
    });
  }

  test('提示由用户或下一次成功清掉，轮询不碰它', () => {
    // 轮询要是也清它，就等于没做——那正是原来的毛病。
    assert.match(js, /function renderNotice\(\)/);
    assert.match(js, /function clearActionError\(\)/);
    const refreshBody = js.slice(js.indexOf('async function refresh()'), js.indexOf('async function refresh()') + 2000);
    assert.equal(
      /clearActionError\(\)/.test(refreshBody), false,
      'refresh() 里清了提示，等于又回到「闪一下就没」',
    );
  });

  test('「一条都没重试」要说出来，不能与成功长得一样', () => {
    // count: 0 时原来什么都不做：按钮按下去、界面回到原样、一个请求都没发——
    // 与成功完全无法区分。
    const body = bodyOf('retryFailures');
    assert.match(body, /if \(!r\.count\)/);
    assert.match(body, /没有可重试的条目/);
  });
});

describe('操作失败的提示活得过轮询', () => {
  /**
   * 这是这次排查里最贵的一个坑。
   *
   * 状态卡由 `refresh()` 画，而 `refresh()` **每 2 秒被轮询调用一次**。写进状态卡的
   * 错误最多活两秒，然后被下一轮按后台状态重画掉。用户看到的是：
   *
   *     点一下 → 闪出点什么 → 回到原样
   *
   * 而「点了没反应」与「报了错但你没看见」在屏幕上完全一样，却指向完全不同的
   * 原因——为此白绕了好几轮。
   *
   * 所以这条测试不看源码，看**行为**：报个错，再跑一次 refresh，提示必须还在。
   */
  test('refresh 之后提示还在', async () => {
    const checkpointWithFailures = (msg) => {
      if (msg.type === 'status') {
        return {
          ok: true,
          running: false,
          checkpoint: { bundle_id: '20260802T101500Z-a1b2c3', pause_reason: 'failures_pending' },
          runner: { active: false },
        };
      }
      // 重试一律失败，这正是要显示出来的那种情况
      if (msg.type === 'retryFailed') return { ok: false, error: '没有进行中的抓取' };
      if (msg.type === 'preflight') {
        return {
          ok: true,
          permissions: { granted: true, missing: [] },
          storage: { usage: 0, quota: 100e9, available: 100e9, need: 1.2e9, enough: true },
        };
      }
      return { ok: true };
    };

    const dom = await loadUi({ which: 'panel', onMessage: checkpointWithFailures });
    try {
      // 这个状态下必须有出路，而不是只剩「中止」
      const buttons = [...dom.byId.get('actions').children].map((b) => b.textContent);
      assert.ok(
        buttons.some((x) => x.includes('重试')),
        `只剩这些按钮：${JSON.stringify(buttons)}`,
      );

      // 点它 —— 后台会拒绝
      const retry = [...dom.byId.get('actions').children].find((b) => b.textContent.includes('重试'));
      await retry.onclick();
      await new Promise((r) => setTimeout(r, 5));
      assert.match(dom.byId.get('notice').textContent, /重试失败/, '错误根本没显示出来');

      // **轮询再来一轮。** 原来的实现在这里把错误抹掉了。
      // 用 `dom.tick()`——它跑的是界面真正注册的那个 2 秒回调。
      // （第一版写成了 `dom.rerunRefresh?.()`，那个方法根本不存在，于是可选链
      //  把整句变成空操作，断言必然通过。又一次差点写出无效的测试。）
      await dom.tick();
      assert.match(
        dom.byId.get('notice').textContent, /重试失败/,
        '刷新一次之后提示没了 —— 用户看到的就是「闪一下又回到原样」',
      );
    } finally {
      dom.restore();
    }
  });
});

describe('别把不相干的问题挂在这次操作头上', () => {
  /**
   * 用户点「重试抓不下来的页面」，屏幕上出现：
   *
   *     重试失败
   *     当前未登录豆瓣。请先登录再开始——……
   *
   * 看起来像重试功能坏了。实际发生的是**会话过期**——而界面里本来就有一块专门
   * 处理它的（「登录状态已失效 / 我登录好了，继续」），只是走不到。
   *
   * 成因：错误码在 offscreen → background → 面板这一路上被拍扁成了一句话，
   * 上层无从分辨「这次操作失败了」与「整场都得停」。
   */
  test('会话过期报的是「登录状态已失效」，不是「重试失败」', async () => {
    const dom = await loadUi({
      which: 'panel',
      onMessage: (msg) => {
        if (msg.type === 'status') {
          return {
            ok: true,
            running: false,
            checkpoint: { bundle_id: '20260802T101500Z-a1b2c3', pause_reason: 'failures_pending' },
            runner: { active: false },
          };
        }
        if (msg.type === 'retryFailed') {
          return {
            ok: false,
            error: '当前未登录豆瓣。请先登录再开始——未登录不仅看不到私密条目……',
            reason: 'session_expired',
          };
        }
        if (msg.type === 'preflight') {
          return {
            ok: true,
            permissions: { granted: true, missing: [] },
            storage: { usage: 0, quota: 100e9, available: 100e9, need: 1.2e9, enough: true },
          };
        }
        return { ok: true };
      },
    });
    try {
      const retry = [...dom.byId.get('actions').children].find((b) => b.textContent.includes('重试'));
      assert.ok(retry, '这个状态下应当有重试按钮');
      await retry.onclick();
      await new Promise((r) => setTimeout(r, 10));

      const notice = dom.byId.get('notice').textContent;
      assert.match(notice, /登录状态已失效/, `报错标题不对：${notice}`);
      assert.equal(/重试失败/.test(notice), false, '把会话过期说成了重试功能坏了');
    } finally {
      dom.restore();
    }
  });
});

describe('暂停状态下也要能重试', () => {
  /**
   * 「继续」看起来什么都能解决，实际上它**不会重试失败条目**——重试刻意只能由人
   * 触发（见 `Frontier.retryFailed` 与 `CrawlRunner.resume` 里的说明：恢复时把
   * 失败洗成新的，等于每次崩溃都偷偷给一次新的重试预算，而如果那面墙是风控，
   * 代价是账号）。
   *
   * 于是暂停状态下如果只给「继续」，用户会一路点下去，而那几十个页面永远留在
   * 原地——**而且不会有任何地方提醒他**。
   */
  test('暂停 + 有失败 → 顶端同时有「继续」和「重试」', async () => {
    const dom = await loadUi({
      which: 'panel',
      onMessage: (msg) => {
        if (msg.type === 'status') {
          return {
            ok: true,
            running: false,
            checkpoint: null,
            runner: {
              active: true,
              stopped: true,
              stoppedBy: 'user_paused',
              bundleId: '20260802T101500Z-a1b2c3',
              routes: [],
              failures: [
                { url: 'https://img1.doubanio.com/a.jpg', routeKey: 'asset.subject_cover', attempts: 1, ordered: false, lastError: 'unclassified' },
                { url: 'https://img1.doubanio.com/b.jpg', routeKey: 'asset.subject_cover', attempts: 1, ordered: false, lastError: 'unclassified' },
              ],
            },
          };
        }
        if (msg.type === 'preflight') {
          return {
            ok: true,
            permissions: { granted: true, missing: [] },
            storage: { usage: 0, quota: 100e9, available: 100e9, need: 1.2e9, enough: true },
          };
        }
        return { ok: true };
      },
    });
    try {
      const labels = [...dom.byId.get('actions').children].map((b) => b.textContent);
      assert.ok(labels.some((x) => x.includes('继续')), `缺「继续」：${JSON.stringify(labels)}`);
      assert.ok(labels.some((x) => x.includes('重试这 2 个')), `缺「重试」：${JSON.stringify(labels)}`);
      // **标签必须说出它会继续。** retryFailed 翻完状态就调 drive()——它不只重试
      // 这几个，而是把整场抓取推下去。不写出来的话，重载扩展之后用户会以为还得
      // 先找一个「继续」按钮；而在暂停状态下「继续」与「重试」并排摆着，更看不出
      // 后者也会继续。
      assert.ok(labels.some((x) => x.startsWith('继续，并重试')), `重试按钮没说它会继续：${JSON.stringify(labels)}`);
      assert.ok(labels.some((x) => x.includes('就这样收尾')), `缺「收尾」：${JSON.stringify(labels)}`);
    } finally {
      dom.restore();
    }
  });

  test('没有失败时不摆多余的按钮', async () => {
    const dom = await loadUi({
      which: 'panel',
      onMessage: (msg) => {
        if (msg.type === 'status') {
          return {
            ok: true,
            running: false,
            checkpoint: null,
            runner: {
              active: true, stopped: true, stoppedBy: 'user_paused',
              bundleId: '20260802T101500Z-a1b2c3', routes: [], failures: [],
            },
          };
        }
        if (msg.type === 'preflight') {
          return {
            ok: true,
            permissions: { granted: true, missing: [] },
            storage: { usage: 0, quota: 100e9, available: 100e9, need: 1.2e9, enough: true },
          };
        }
        return { ok: true };
      },
    });
    try {
      const labels = [...dom.byId.get('actions').children].map((b) => b.textContent);
      assert.equal(labels.some((x) => x.includes('重试')), false, `没有失败却给了重试：${JSON.stringify(labels)}`);
    } finally {
      dom.restore();
    }
  });
});

describe('「判不出来」不该显示成「被限制」', () => {
  /**
   * 规范的 verdict 是封闭词表，没有「判不出来」这个取值。抓取时判不出来的响应必须
   * 留证、又绝不能标成 ok，于是写入时用了 `cls.verdict ?? 'blocked'`——真相退到了
   * note 里。保守方向是对的，但界面照抄 verdict 就把两件很不一样的事说成了同一件：
   *
   *   被限制    豆瓣主动拒绝了 → 该等一等，再抓可能撞限流
   *   判不出来  页面拿到了，只是我们不认识 → 该校准选择器，重抓没用
   *
   * 实测撞到过：一篇 /topic/ 日记因为没有对应的框架标志判不出来，界面上写着「被限制」，
   * 而用户按提示去重试——重试当然还是一样的结果。
   */
  test('note 说了判不出来，就显示判不出来', async () => {
    const js = readPanelSourceSync();
    assert.match(js, /function verdictName\(e\)/);
    assert.match(js, /e\?\.note\?\.startsWith\('判不出来'\)/);
  });

  test('**三处显示判定的地方都要走它**', async () => {
    // 漏掉任何一处，同一条捕获在档案页与详情页会显示成两种不同的东西。
    const js = readPanelSourceSync();
    const direct = [...js.matchAll(/VERDICT_NAMES\[(?:e|entry)\.verdict\]/g)];
    assert.equal(direct.length, 0, `还有 ${direct.length} 处直接查表，没走 verdictName`);
    assert.ok((js.match(/verdictName\(/g) ?? []).length >= 4, '至少三处显示 + 一处定义');
  });
});

describe('判不出来时要说清该怎么办', () => {
  test('原因文案说的是「该怎么办」，不是「哪里不对」', async () => {
    // 用户看到判定之后要做决定，而决定只有三种：等一等重抓、改抽取器、先看一眼。
    const js = readPanelSourceSync();
    assert.match(js, /frame_anchors_missing: '页面结构变了，重抓没用'/);
    assert.match(js, /empty_body: '空响应，可以重抓'/);
  });

  test('**旧档案也要认** —— 它们只有 note，没有 verdict_reason', async () => {
    // bundle/1.2 之前判不出来的响应写成 blocked，真相在 note 里。档案是冻结的，
    // 改词表救不回它们，所以两条路都要走。
    const js = readPanelSourceSync();
    assert.match(js, /e\?\.verdict === 'unknown' \|\| e\?\.note\?\.startsWith\('判不出来'\)/);
  });
});

describe('导出之后该做什么 —— 面板要说得出来', () => {
  const html = readFileSync(new URL('../src/ui/panel.html', import.meta.url), 'utf-8');

  test('帮助页有这一节，且带 id（导出结果那句话要跳过来）', () => {
    assert.match(html, /<h2 id="downstream">导出之后/);
  });

  test('**命令旁边必须给出「说了算的地方」**', () => {
    // 命令会过期，而这个页面不会跟着更新。真正的出路是把权威指向 README，
    // 而不是指望这里的命令一直对——所以两条命令各自都要有一个 README 链接。
    const sec = html.slice(html.indexOf('id="downstream"'), html.indexOf('每个标签页是干什么的'));
    for (const repo of ['doubak-data-parser', 'doubak-site-generator']) {
      assert.match(sec, new RegExp(`https://github\\.com/Doubak/${repo}#readme`), `${repo} 的 README 没链上`);
    }
    assert.match(sec, /以各自仓库的 README 为准|以 README 为准/, '要写明谁说了算');
  });

  test('**说清这两步同样不联网**', () => {
    // 「装个东西、跑个命令」在一个以「数据不出设备」为卖点的工具里会引起合理的
    // 怀疑。不说的话，最谨慎的那批用户会停在这里。
    const sec = html.slice(html.indexOf('id="downstream"'), html.indexOf('每个标签页是干什么的'));
    assert.match(sec, /不联网/);
  });

  test('导出成功之后指一下路，但不在档案页铺开步骤', () => {
    const exp = readFileSync(new URL('../src/ui/panel/export.js', import.meta.url), 'utf-8');
    assert.match(exp, /data-tab="help"/, '要能跳到帮助页');
    assert.match(exp, /downstream/, '要滚到那一节');
    // 档案页已经很满（导入/导出/校验/删除/用量/捕获检查器…），步骤属于帮助页。
    assert.doesNotMatch(exp, /node bin\/parse\.js/, '命令不该在档案页出现第二份');
  });

  test('**整个帮助页不许用口语**（docs/ui.md 8.5）', () => {
    // 这是一个关于「档案能不能被信任」的工具，口语化的措辞会削弱它本来要传达的
    // 确定性。帮助页是用户读得最久的一页，所以整页都按这条来。
    //
    // 名单只收**改写时真的出现过**的那些，不做泛化的措辞审查：一份凭想象列出来的
    // 禁用词表会挡住合法的写法，然后被人加白名单绕过去，最后谁也不看它。
    const help = html.slice(html.indexOf('id="tab-help"'), html.indexOf('</section>', html.indexOf('id="tab-help"')));
    const COLLOQUIAL = [
      '然后呢', '搞定', '咋', '啥',
      '就行', '就是了', '不用管', '干什么的', '说了算的地方',
      '几分钟就完', '都行', '一遍就是',
    ];
    const hit = COLLOQUIAL.filter((w) => help.includes(w));
    assert.deepEqual(hit, [], `帮助页里出现了口语词：${hit.join(' ')}`);
  });

  test('书面化不许把信息改没了', () => {
    // docs/ui.md 8.5：「书面化改的是语气，不是内容。」这些是改写时最容易被顺手
    // 删掉的「为什么」——每一条都是用户做决定时真正需要的那句。
    const help = html.slice(html.indexOf('id="tab-help"'), html.indexOf('</section>', html.indexOf('id="tab-help"')));
    const MUST_KEEP = [
      ['不设任何后端服务器', '没有服务器这件事要说出来'],
      ['卸载扩展或清除站点数据', '不导出的代价'],
      ['占档案九成体积', '为什么详情页要跳过'],
      ['发布后不可编辑', '为什么广播只抓新的'],
      ['图片地址即内容地址', '为什么图片永远跳过'],
      ['不会带来任何新数据', '为什么图片那一档没有「重抓」选项'],
      ['无法判定哪一份正确', '为什么编号撞了不覆盖'],
      ['合并之后无法再分离', '为什么别的账号默认不导'],
      ['可能导致账号被限制', '为什么被限制之后不重试'],
      ['缺口位于列表中段', '为什么不能看数量差'],
      ['未抓取到即为永久丢失', '为什么广播优先'],
    ];
    const lost = MUST_KEEP.filter(([t]) => !help.includes(t)).map(([t, why]) => `${t}（${why}）`);
    assert.deepEqual(lost, [], `书面化时丢了这些理由：\n${lost.join('\n')}`);
  });
});

describe('抓取停下来不是「失败」—— 面板必须在删除之前说出来', () => {
  /**
   * ## 为什么这几条要被守着
   *
   * 「没收尾的档案照样能解析、导出之后照样能导回来」这两件事**代码里本来就是对的**，
   * 而且措辞也早就写好了——`pipeline/opfs-bundle-source.js` 的 `status` 注释里一句，
   * `bundle/importer.js` 的 `no_manifest` 告警里一句。问题是那两句都出现在用户
   * **已经决定之后**才会看到的地方：前者根本不上屏，后者要等他开始导入才弹。
   *
   * 而真正做决定的两个对话框，一个只印「未收尾」三个字（周围全是量词，于是它读起来
   * 像个缺陷标签），另一个末行直接写着「中止后，该档案即可删除」。
   *
   * 这类回退是**静默**的：删掉一句话不会让任何东西变红，页面照常打开。所以这里
   * 反着钉——钉那句不该再出现的话。
   */

  test('中止确认框不再以「即可删除」收尾', () => {
    const js = readPanelSourceSync();
    assert.equal(
      js.includes('中止后，该档案即可删除。'), false,
      '这句话出现在确认框最末一行，读起来是建议而不是事实，且与三行之上的「将全部保留」自相矛盾',
    );
    // 能力照说，但不能是最后一句。
    assert.match(js, /中止后该档案将解除占用/);
    assert.match(js, /半途中止的档案照样能解析、能导出，导出之后也能再导入回来/);
  });

  test('删除确认框在档案没收尾时，说得出它还能做什么', () => {
    const js = readPanelSourceSync();
    // 判据是 hasManifest，不是别的：这一句只对没收尾的那些成立。
    assert.match(js, /if \(!u\.hasManifest\) \{[\s\S]{0,400}未收尾」不等于「没用」/);
    assert.match(js, /解析器照常读得出来，导出之后也可以再导入回来/);
    // 「清空全部」是同一个判断，而且那条路上的人更可能是觉得前几次白抓了。
    assert.match(js, /const unfinalized = deletable\.filter\(\(u\) => !u\.hasManifest\)/);
  });

  test('帮助页那张表有总纲，也有「没抓完」这两种收场', async () => {
    const html = await readRepoFile('src/ui/panel.html');
    assert.match(html, /抓取不会「失败」，只会停下来/, '五行全是「继续」的表需要一句总纲');
    // 总纲必须同时给出那条例外，否则它就是一句撑不住的话。
    assert.match(html, /未曾抓取/, '真正会永久丢失的只有这一种，不说就是过度承诺');
    for (const row of ['你中止了这次抓取', '这份档案还没收尾']) {
      assert.ok(html.includes(`<b>${row}</b>`), `表里少了「${row}」这一行`);
    }
  });

  test('档案页那张「还没收尾」的卡片，不止说「不是坏的」', () => {
    const js = readPanelSourceSync();
    assert.match(js, /这并不表示档案损坏/);
    // 只否定一件事，看到一屏空字段的人接着要问的仍然没人答。
    assert.match(js, /即便这次抓取就此中止，这一份也不会作废/);
  });

  test('这几句都进得了面板 —— 界面文字不是 Markdown', () => {
    const js = readPanelSourceSync();
    for (const s of ['未收尾」不等于「没用」', '半途中止的档案照样能解析']) {
      const i = js.indexOf(s);
      assert.notEqual(i, -1, `找不到「${s}」`);
      assert.equal(js.slice(i - 60, i + 120).includes('**'), false, '界面文字里不许有 Markdown 星号');
    }
  });
});

describe('一次只能选一个文件夹 —— 这话要在点开对话框之前说', () => {
  /**
   * 用户问的是「导入档案的对话框能不能多选文件夹」。答案是不能：
   * `showDirectoryPicker()` 没有多选，`<input webkitdirectory>` 也一样，
   * 这是浏览器那一侧的事，不是我们挑的。
   *
   * 但要做的事本来就做得到——`scanForBundles` 往下找三层，选中共同的上一级
   * 就是一次导入好几份。问题只在于这句话原来**只在扫不到档案之后**才出现，
   * 也就是决定已经做完之后才到。判据不是「这句话对不对」。
   */
  test('按钮旁边就得说清楚，而不是等扫空了才说', async () => {
    // **先把 HTML 注释剥掉。** 这一段的注释里就写着「共同的上一级」（在讲这句话
    // 为什么必须提前说），带着注释去搜，删掉屏幕上那一行判据照样是绿的——变异测试
    // 当场抓到了这一点。注释不是界面。
    const html = (await readRepoFile('src/ui/panel.html')).replace(/<!--[\s\S]*?-->/g, '');
    const bar = html.indexOf('id="library-bar"');
    const list = html.indexOf('id="import-result"');
    assert.ok(bar > 0 && list > bar, '找不到导入那一行，这条判据已经失去意义');
    const between = html.slice(bar, list);
    assert.ok(between.length > 40, '剥完注释就没剩什么了，这条判据已经失去意义');
    assert.match(between, /一次只能选一个文件夹/, '没有在按钮旁边说「一次只能选一个」');
    assert.match(between, /共同的上一级/, '没说该怎么办 —— 只说限制等于没说');
  });

  test('文案里那个「三层」必须就是扫描器真的走的层数', async () => {
    // 一个写死在句子里的数字，改了代码不会有任何东西提醒你。而它错了的后果是
    // 用户照着做、然后得到一句「这里没有档案」。
    const { scanForBundles } = await import('../src/bundle/importer.js');
    const depth = /maxDepth = (\d+)/.exec(
      await readRepoFile('src/bundle/importer.js'),
    );
    assert.ok(scanForBundles && depth, '找不到 maxDepth 的默认值');
    const 汉字 = ['零', '一', '两', '三', '四', '五', '六'][Number(depth[1])];
    for (const f of ['src/ui/panel.html', 'README.md']) {
      const t = await readRepoFile(f);
      assert.match(t, new RegExp(`往下找${汉字}层`), `${f} 里那个层数和 maxDepth 对不上`);
    }
  });
});
