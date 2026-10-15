import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFFSCREEN_TARGET } from '../src/offscreen/protocol.js';

test('开始抓取的目标账号对象不能被当成离屏消息地址丢弃', async (t) => {
  const original = globalThis.chrome;
  t.after(() => { globalThis.chrome = original; });
  let listener;
  globalThis.chrome = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    // 让命令在第一步返回明确的业务错误，无须依赖 Node 中没有的 IDB。
    permissions: { contains: async () => false },
  };
  await import('../src/background.js');
  for (const target of [null, { input: 'https://www.douban.com/people/154611037/', userId: '154611037', operatorUserId: '222' },
    { input: '222', userId: '222', operatorUserId: '222' }]) {
    let resolve;
    const response = new Promise(r => { resolve = r; });
    assert.equal(listener({ type: 'start', target }, {}, resolve), true, '必须保持消息通道等待答复');
    const result = await response;
    assert.equal(result.ok, false);
    assert.match(result.error, /权限/, '命令必须抵达处理器');
  }
  let answered = false;
  assert.equal(listener({ target: OFFSCREEN_TARGET, op: 'start' }, {}, () => { answered = true; }), undefined);
  assert.equal(answered, false, '后台不能抢答离屏宿主命令');
});
