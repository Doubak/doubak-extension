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

/** 每次都要新的模块实例——界面脚本有模块级状态（preflightShown、routeRows）。 */
let cacheBust = 0;

/**
 * 装好假 DOM，加载界面脚本，等它跑完第一轮。
 *
 * @param {object} opts
 * @param {'panel' | 'popup'} opts.which
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
              routes: [{ routeKey: 'broadcast.timeline', captured, highWater: '2026-07-01T00:00:00Z', contiguous: false }],
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

describe('popup 脚本', () => {
  test('加载并跑完第一次 refresh，不抛任何异常', async () => {
    const errors = [];
    const onRejection = (e) => errors.push(e);
    process.on('unhandledRejection', onRejection);

    const dom = await loadUi({ which: 'popup', onMessage: IDLE });
    try {
      assert.deepEqual(errors.map(String), []);
      assert.match(dom.byId.get('state').textContent, /没有进行中的抓取/);
      assert.match(dom.byId.get('primary').textContent, /开始抓取/);
    } finally {
      process.off('unhandledRejection', onRejection);
      dom.restore();
    }
  });

  test('停机时给出可执行的下一步，不给错误码', async () => {
    const dom = await loadUi({
      which: 'popup',
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
      const t = dom.byId.get('state').textContent;
      assert.match(t, /权限/);
      assert.equal(/host_permission_lost/.test(t), false, '界面上不许出现内部标识');
    } finally {
      dom.restore();
    }
  });

  test('每个 $(id) 都在 HTML 里真的存在', async () => {
    const js = await readRepoFile('src/ui/popup.js');
    const html = await readRepoFile('src/ui/popup.html');
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    for (const m of js.matchAll(/\$\('([^']+)'\)/g)) {
      assert.ok(ids.has(m[1]), `popup.js 用了 #${m[1]}，但 popup.html 里没有`);
    }
  });
});
