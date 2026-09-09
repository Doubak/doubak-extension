/**
 * 通知：**Firefox 会把整条通知拒收，而不是忽略它不认的那两个键。**
 *
 * 实测（Firefox 155，跑的是打好的那个包）：
 *
 *     notifications.create(id, {type, iconUrl, title, message, requireInteraction, silent})
 *     → Type error for parameter options
 *       (Unexpected properties: requireInteraction, silent) for notifications.create.
 *
 * 而 `show()` 整段裹在一个「通知发不出去不算事」的 try 里——所以症状是**一条通知
 * 都发不出来，只在控制台留一行**。抓取要跑几个小时，通知是「撞上验证码了，回来
 * 点一下」唯一会主动找到用户的东西；丢掉它，人回来时看到的是一个停了很久的进度条。
 *
 * 这一条只能在这儿测：真正会失败的那个上下文（Gecko 的参数校验）本地跑不到，
 * 所以把它的行为**照抄成一个假实现**——与 `offscreen-contract.test.js` 抄 NeoDB
 * 导入器的契约是同一个做法。
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { notifyNeedsAction, clearAttention, resetNotifyProbe } from '../src/ui/notify.js';

/**
 * 一个假的通知接口。
 *
 * @param {object} opts
 * @param {boolean} opts.strict Firefox 那样：不认的键就整条拒收
 * @param {boolean} [opts.broken] 连基础形状都失败（图标路径不对、没权限……）
 */
function fakeChrome({ strict, broken = false }) {
  const created = [];
  const cleared = [];
  return {
    created,
    cleared,
    api: {
      runtime: { getURL: (p) => `moz-extension://x/${p}` },
      action: {
        setBadgeText: async () => {},
        setBadgeBackgroundColor: async () => {},
        setTitle: async () => {},
      },
      notifications: {
        clear: async (id) => { cleared.push(id); return true; },
        create: async (id, opts) => {
          if (broken) throw new Error('Could not find icon');
          if (strict) {
            const bad = Object.keys(opts).filter(
              (k) => !['type', 'iconUrl', 'title', 'message'].includes(k),
            );
            if (bad.length) {
              throw new Error(
                `Type error for parameter options (Unexpected properties: ${bad.join(', ')})`
                + ' for notifications.create.',
              );
            }
          }
          created.push({ id, opts });
          return id;
        },
      },
    },
  };
}

const kv = () => {
  const m = new Map();
  return {
    get: async (k) => m.get(k),
    set: async (k, v) => { m.set(k, v); },
    remove: async (k) => { m.delete(k); },
  };
};

describe('通知在两种浏览器上都真的发得出去', () => {
  beforeEach(() => {
    resetNotifyProbe();
    delete globalThis.chrome;
  });

  test('Chrome：收下 requireInteraction 与 silent', async () => {
    const f = fakeChrome({ strict: false });
    globalThis.chrome = f.api;
    await notifyNeedsAction('challenge', { kv: kv() });
    assert.equal(f.created.length, 1, '一条都没发出去');
    assert.equal(f.created[0].opts.requireInteraction, true,
      '验证码那种要停在那儿等人，不能自己消失');
    assert.equal(f.created[0].opts.silent, false);
  });

  test('**Firefox：退成基础形状，通知照样发得出去**', async () => {
    const f = fakeChrome({ strict: true });
    globalThis.chrome = f.api;
    await notifyNeedsAction('challenge', { kv: kv() });
    assert.equal(f.created.length, 1,
      '一条都没发出去 —— 而这正是这个文件存在的理由');
    assert.deepEqual(Object.keys(f.created[0].opts).sort(),
      ['iconUrl', 'message', 'title', 'type']);
    assert.match(f.created[0].opts.message, /./, '内容不能因为退档就空了');
  });

  test('退档只试一次，之后直接用基础形状', async () => {
    // 每条通知都先失败一次是白费，而且控制台会堆一串吓人的红字。
    const f = fakeChrome({ strict: true });
    globalThis.chrome = f.api;
    let attempts = 0;
    const create = f.api.notifications.create;
    f.api.notifications.create = (id, o) => { attempts += 1; return create(id, o); };

    await notifyNeedsAction('challenge', { kv: kv() });
    assert.equal(attempts, 2, '第一次应当是「先试全的，再退」');
    await notifyNeedsAction('session_expired', { kv: kv() });
    assert.equal(attempts, 3, '第二次还在试那个已经知道不行的形状');
    assert.equal(f.created.length, 2);
  });

  test('**只对「有几个键不认识」退档**，别的错照旧往上报', async () => {
    // 「只要报错就退一档」会让真正的故障（图标路径不对、没权限）被一次悄悄的重试
    // 盖住 —— 而重试同样会失败，于是变成「通知没了，也没人知道为什么」。
    const f = fakeChrome({ strict: false, broken: true });
    globalThis.chrome = f.api;
    let calls = 0;
    const create = f.api.notifications.create;
    f.api.notifications.create = (id, o) => { calls += 1; return create(id, o); };

    await notifyNeedsAction('challenge', { kv: kv() }); // 不许抛
    assert.equal(calls, 1, '不是「键不认识」的错，不该重试');
    assert.equal(f.created.length, 0);
  });

  test('没有 notifications 接口时不炸 —— 角标顶上', async () => {
    globalThis.chrome = { action: fakeChrome({ strict: false }).api.action, runtime: {} };
    await notifyNeedsAction('challenge', { kv: kv() });
    await clearAttention({ kv: kv() });
  });
});
