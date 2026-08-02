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

import { installFakeDom, readRepoFile } from './helpers/fake-dom.js';
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
    const js = await readRepoFile('src/ui/panel.js');
    assert.match(js, /function renderVanished\(\)/);
    // 它由 renderCaptures 调用——两者共用同一份已加载的 index，不另开一条读取路径
    assert.match(js, /renderVanished\(\);[\s\S]{0,200}\$\('captures'\)/);
  });

  test('删档案是日常操作 —— 有自己的标签页，不藏在调试页里', async () => {
    // 调试页里全是**会改变抓取行为**的东西（演练、绕过门控、小范围试跑）。
    // 把一件日常操作摆在那儿，等于训练用户往那儿去找东西。
    const html = await readRepoFile('src/ui/panel.html');
    assert.match(html, /data-tab="storage"/, '存储该有自己的标签页');
    assert.match(html, /id="tab-storage"/);

    // 存储那一块必须在存储页里，不在调试页里
    const storageSection = html.slice(html.indexOf('id="tab-storage"'));
    assert.match(storageSection.slice(0, 900), /id="storage"/);
    const debugSection = html.slice(html.indexOf('id="tab-debug"'), html.indexOf('id="tab-storage"'));
    assert.equal(debugSection.includes('id="storage"'), false, '存储还留在调试页里');
  });

  test('档案页能删掉当前这一份 —— 那里才有上下文', async () => {
    const html = await readRepoFile('src/ui/panel.html');
    assert.match(html, /id="delete-this"/);
    // 不可逆的操作要看起来不一样
    assert.match(html, /id="delete-this"[^>]*|class="act danger"/);
    const js = await readRepoFile('src/ui/panel.js');
    assert.match(js, /\$\('delete-this'\)\.addEventListener/);
    // 结果要写在档案页自己的地方 —— 否则消息出现在用户看不见的标签页里
    assert.match(js, /deleteBundle\(currentBundleId, \{[\s\S]{0,200}report:/);
  });

  test('开抓前那一行不再说「增量还没接上」', async () => {
    const js = await readRepoFile('src/ui/panel.js');
    assert.equal(js.includes('增量还没接上'), false);
    assert.match(js, /function scopeText/);
  });

  test('覆盖率页有「合起来 / 这一份」两个视角，默认合起来', async () => {
    const js = await readRepoFile('src/ui/panel.js');
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

    const js = await readRepoFile('src/ui/panel.js');
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
    const js = await readRepoFile('src/ui/panel.js');
    assert.match(js, /let crawlMode = 'incremental'/, '默认该是增量');
    for (const mode of ['full', 'refresh-subjects']) {
      assert.ok(js.includes(`'${mode}'`), `少了「${mode}」这个选项`);
    }
    // 选了什么要真的传下去
    assert.match(js, /send\(\{ type: 'start', mode: crawlMode \}\)/);
  });

  test('中止要有额外确认，且说清不可逆的是什么', async () => {
    const js = await readRepoFile('src/ui/panel.js');
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
    const js = await readRepoFile('src/ui/panel.js');
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
    const js = await readRepoFile('src/ui/panel.js');
    const fn = js.slice(js.indexOf('async function refresh'));
    const idxBusy = fn.indexOf('const busy =');
    const idxActive = fn.indexOf("if (s.runner?.active || s.checkpoint)");
    assert.ok(idxBusy >= 0 && idxBusy < idxActive, '忙碌状态要在所有分支之前判');
  });

  test('切换档案时把上一份的结果框清干净 —— 包括 class', async () => {
    // 只清文字会留下一个**空的红框**：看起来像出了事，却什么都不说。
    const js = await readRepoFile('src/ui/panel.js');
    const fn = js.slice(js.indexOf('async function openBundle'));
    const body = fn.slice(0, fn.indexOf('const summaryEl'));
    assert.match(body, /export-result/);
    assert.match(body, /className = ''/, 'class 也要清');
  });

  test('版本历史只报个数，且个数是真的', async () => {
    const js = await readRepoFile('src/ui/panel.js');
    assert.match(js, /function renderVersions\(count\)/);
    // 早先回的是截断到 200 条的清单，界面拿它的长度当总数 → 永远写着「200 个」
    const off = await readRepoFile('src/offscreen/offscreen.js');
    assert.match(off, /versionCount: d\.versions\.length/);
    assert.equal(off.includes('versions.slice(0, 200)'), false, '别再截断然后拿长度当总数');
  });

  test('一行里的 URL 与右边的计数要分开', async () => {
    // `…/games5 个版本` —— 两段直接粘在一起。
    const html = await readRepoFile('src/ui/panel.html');
    assert.match(html, /\.cap \{[^}]*display: flex/);
    assert.match(html, /\.cap \{[^}]*gap:/);
  });

  test('**不许往兄弟节点里插** —— 没人负责清，切一次档案就多留一张', async () => {
    // 真实现象：打开一份 05:13 的全量档案，上面挂着**两张一模一样**的卡片，都写着
    // 「接在 11:21 那份后面」。一份 05:13 的档案不可能接在 11:21 后面——那两张是
    // 看别的档案时留下的，`.after()` 插进去之后没人管。
    const js = await readRepoFile('src/ui/panel.js');
    const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const bad of ['.after(', '.before(', 'insertAdjacent']) {
      assert.equal(code.includes(bad), false, `${bad} 插出来的节点没人负责清`);
    }
  });

  test('「这是一次增量抓取」有自己的容器，且切档案时会清掉', async () => {
    const html = await readRepoFile('src/ui/panel.html');
    assert.match(html, /id="archive-incremental"/);
    const js = await readRepoFile('src/ui/panel.js');
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
    const js = await readRepoFile('src/ui/panel.js');
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
    const js = await readRepoFile('src/ui/panel.js');
    const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.equal(code.includes('又抓了一次'), false);
    assert.ok(code.includes('已抓取多次'));
  });

  test('导出整条链：按钮在、逐份导、一份失败不中断其余', async () => {
    const html = await readRepoFile('src/ui/panel.html');
    assert.match(html, /id="export-chain"/);
    assert.match(html, /导出这一份/, '单份那个按钮要改名，否则两个都叫「导出」分不清');

    const js = await readRepoFile('src/ui/panel.js');
    // 按当前打开的这一份取链，不是永远取最新那条
    assert.match(js, /type: 'chain', bundleId: currentBundleId/);
    // 分子目录，否则 manifest.json 互相覆盖
    assert.match(js, /subdirectorySink\(parent, bundleDirName\(id\)\)/);
    // **单份导出也要建子目录** —— 否则往同一个下载目录导几次，早先的 manifest
    // 全被覆盖，档案编号只剩在文件名里
    assert.equal(js.includes('directorySink(dir)'), false, '单份导出还在平铺');
    assert.match(js, /subdirectorySink\(dir, folder\)/);
    // 一份失败不中断其余
    const fn = js.slice(js.indexOf("\$('export-chain')"));
    const body = fn.slice(0, fn.indexOf('renderChainExportResult(el, done)'));
    assert.match(body, /catch \(e\)[\s\S]{0,200}done\.push/, '失败也要记下来并继续');
  });

  test('导出结果逐份说清楚，不汇总成一句「成功」', async () => {
    const js = await readRepoFile('src/ui/panel.js');
    assert.match(js, /function renderChainExportResult/);
    // 只在校验通过时才记「已导出」——没验过就说导出了，等于给一个我们没资格给的保证
    const fn = js.slice(js.indexOf('export-chain'));
    const body = fn.slice(0, fn.indexOf('renderChainExportResult'));
    assert.match(body, /res\.problems\.length === 0/);
    assert.match(body, /markExported/);
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
    const js = await readRepoFile('src/ui/panel.js');
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
    const js = await readRepoFile('src/ui/panel.js');
    const fn = js.slice(js.indexOf('async function deleteAll'), js.indexOf('function setStorageResult'));

    assert.match(fn, /filter\(\(u\) => u\.deletable\)/, '正在抓的那份要保留');
    // 逐个删而不是一把梭：一份失败不该让其余的也不删
    assert.match(fn, /for \(const u of deletable\)/);
    assert.match(fn, /failed/, '要说清哪些没删成');
  });

  test('只在校验通过时才记「已导出」', async () => {
    // 没验过就说「已导出」，等于给了一个我们没资格给的保证——而那个保证会被用来
    // 决定删除确认框说得多重。
    const js = await readRepoFile('src/ui/panel.js');
    const i = js.indexOf('markExported');
    const before = js.slice(Math.max(0, i - 400), i);
    assert.match(before, /problems\.length === 0/);
  });

  test('捕获列表的措辞逻辑抽成了纯函数，并且真的被用上', async () => {
    // 那三条断言原来是对着 panel.js 做源码匹配的。逻辑抽进
    // `src/ui/capture-label.js` 之后，源码匹配失效——**但那不是退步**：现在有
    // `test/capture-label.test.js` 里 15 条真正跑逻辑的测试，覆盖旧档案、
    // 作品详情页、越界终止页、offset 游标等等。
    //
    // 这里只钉住「面板确实用的是那个模块」，别的交给行为测试。
    const js = await readRepoFile('src/ui/panel.js');
    assert.match(js, /from '\.\/capture-label\.js'/);
    assert.match(js, /captureTitle\(e, routeName\)/);
    assert.match(js, /captureSubtitle\(e\)/);
    // 逻辑不该又被抄回面板里
    assert.equal(js.includes('function captureSubtitle'), false);
  });

  test('判定只在不是 ok 时显示 —— 一整列「正常」是噪音', async () => {
    const js = await readRepoFile('src/ui/panel.js');
    const fn = js.slice(js.indexOf('function renderCaptures'), js.indexOf('function captureTitle'));
    assert.match(fn, /e\.verdict === 'ok'/);
  });

  test('抓完之后不清空进度表 —— 显示上一次的结果', async () => {
    // 抓完立刻变回「还没有开始」，等于把刚跑完那一次的结果扔了，而那正是用户此刻最想
    // 看的东西。数据取自最新档案的 manifest（权威记录），不是内存里的快照。
    const js = await readRepoFile('src/ui/panel.js');
    assert.match(js, /function showLastRun/);
    assert.match(js, /crawlState/, '要读 manifest 的 crawl_state');
    assert.match(js, /low_water_time/, '「已回溯到」用最旧那一端');
  });

  test('覆盖率页有自己的加载，且先说「正在读取」', async () => {
    // 它原来只是 openBundle() 的副作用：第一次直接点进来是空白的，而空白看起来像
    // 「正在加载」——实际什么都不会发生。
    const js = await readRepoFile('src/ui/panel.js');
    assert.match(js, /if \(btn\.dataset\.tab === 'coverage'\) loadCoverage\(\)/);
    const fn = js.slice(js.indexOf('async function loadCoverage'), js.indexOf('function renderCoverage'));
    assert.match(fn, /正在读取/);
  });

  test('日志页读的是持久化的日志，不是内存数组', async () => {
    // 原来只记面板打开期间的事件、一刷新就没，而界面上却写着「仅本地保留…导出前请自行
    // 脱敏」——同时暗示了「存下来了」和「有导出」，两个都不存在。
    const js = await readRepoFile('src/ui/panel.js');
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
    const js = await readRepoFile('src/ui/panel.js');
    const openBundleFn = js.slice(js.indexOf('async function openBundle'), js.indexOf('function renderCaptures'));
    assert.equal(openBundleFn.includes('renderCoverage'), false, '档案页不该顺手渲染覆盖率');

    const loadCov = js.slice(js.indexOf('async function loadCoverage'), js.indexOf('function renderCoverage'));
    assert.match(loadCov, /loadBundleSummary/, '覆盖率要从共同来源读');
  });

  test('两个标签页共用同一处「在看哪份档案」', async () => {
    const js = await readRepoFile('src/ui/panel.js');
    assert.match(js, /async function loadBundleSummary/);
    assert.match(js, /summaryCache/);
  });

  test('删除档案会作废缓存并取消已失效的选中', async () => {
    // 不取消的话，下一次读取会去开一个不存在的目录然后报「读不出来」，
    // 而真实情况只是它被删了。
    const js = await readRepoFile('src/ui/panel.js');
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
    const js = await readRepoFile('src/ui/panel.js');
    assert.match(js, /async function refreshOpenTab/);
    const del = js.slice(js.indexOf('async function deleteBundle'), js.indexOf('async function deleteAll'));
    assert.match(del, /refreshOpenTab/);
  });

  test('每个 $(id) 都在 HTML 里真的存在', async () => {
    // `$()` 返回 null 之后往上一步才炸，栈里看不出缺的是哪个 id。
    const js = await readRepoFile('src/ui/panel.js');
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
  const js = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf-8');

  test('failures_pending 刻意不给「继续」—— 但必须给别的', () => {
    // 这个状态该做的决定是「重试」还是「就这样收尾」，而那两个按钮在失败清单里。
    // 道理是对的，可结果是：屏幕顶端只剩一个「中止这次抓取」，真正该点的东西在
    // 一百多行表格的下面。
    //
    // 用户的原话是「继续按钮没了，只剩中止」——从顶端看这就是一条死路，而一个
    // 只提供「放弃」的界面会把人推向放弃。
    assert.match(js, /failureActions\(r\.failures\)/, '没有把失败动作提到顶部动作行');
    assert.match(js, /\.\.\.\(action \? \[\] : failureActions/, '有「继续」时不该重复给');
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

  test('有分页失败时不给「就这样收尾」', () => {
    // 跳过分页条目等于免掉水位线赖以成立的前提，那不是用户能授权的事。
    assert.match(js, /if \(!ordered\.length\) acts\.push\(\['就这样收尾'/);
  });
});

describe('只剩 checkpoint 时也不能是死路', () => {
  const js = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf-8');
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

  test('**收尾的确认放在函数里**，不在调用方', () => {
    // 有两个入口会调它。确认写在调用方的话，迟早有一个入口忘了——而这是一个
    // 会写进 manifest、影响下次水位线的决定。
    const i = js.indexOf('async function finishWithGaps(leaves)');
    const body = js.slice(i, js.indexOf('\n}', i));
    assert.match(body, /confirm\(/);
  });
});

describe('出错就停在错误上，不要接着刷新掉', () => {
  const js = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf-8');

  /** 取一个函数体（到下一个顶层 `}` 为止，够用）。 */
  const bodyOf = (name) => {
    const i = js.indexOf(`async function ${name}(`);
    assert.ok(i > 0, `找不到 ${name}`);
    return js.slice(i, js.indexOf('\n}', i));
  };

  for (const fn of ['retryFailures', 'finishWithGaps', 'resumeCrawl']) {
    test(`${fn}：写了错误就 return`, () => {
      // `refresh()` 按后台状态重画整块，跟在 setState('err', …) 后面会**当场把
      // 刚写的错误抹掉**。用户看到的是「闪了一下又回到原样」，而真正的原因刚被
      // 自己擦掉——这个毛病在「继续」上犯过一次，在「重试」上又犯了一次。
      const body = bodyOf(fn);
      const errIdx = body.indexOf("setState('err'");
      assert.ok(errIdx > 0, `${fn} 没有错误分支？`);
      const after = body.slice(errIdx, errIdx + 240);
      assert.match(after, /return;/, `${fn} 写完错误没有 return`);
      const refreshIdx = after.indexOf('refresh()');
      const returnIdx = after.indexOf('return;');
      assert.ok(
        refreshIdx === -1 || returnIdx < refreshIdx,
        `${fn} 在错误分支之后又 refresh()，错误会被抹掉`,
      );
    });
  }

  test('「一条都没重试」要说出来，不能与成功长得一样', () => {
    // count: 0 时原来什么都不做：按钮按下去、界面回到原样、一个请求都没发——
    // 与成功完全无法区分。
    const body = bodyOf('retryFailures');
    assert.match(body, /if \(!r\.count\)/);
    assert.match(body, /没有可重试的条目/);
  });
});
