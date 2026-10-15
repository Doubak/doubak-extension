import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureHost } from '../src/runtime/host-offscreen.js';

test('已存在的离屏文档尚未注册监听器时，只用 ping 等待', async t => {
  const original = globalThis.chrome; t.after(() => { globalThis.chrome = original; });
  const calls = [];
  globalThis.chrome = { runtime: { getURL: p => p, getContexts: async () => [{}], sendMessage: async msg => {
    calls.push(msg); if (calls.length === 1) throw new Error('Receiving end does not exist.');
    return calls.length < 3 ? undefined : { ok: true };
  } } };
  await ensureHost();
  assert.deepEqual(calls, Array(3).fill({ target: 'offscreen', op: 'ping' }));
});

test('并发 ensure 共用创建及就绪握手，不把文档存在当作监听器就绪', async t => {
  const original = globalThis.chrome; t.after(() => { globalThis.chrome = original; });
  let created = 0, pinged = 0, release;
  globalThis.chrome = { offscreen: { createDocument: async () => { created++; } }, runtime: {
    getURL: p => p, getContexts: async () => [],
    sendMessage: () => { pinged++; return new Promise(resolve => { release = resolve; }); },
  } };
  let finished = false;
  const a = ensureHost().then(() => { finished = true; });
  const b = ensureHost();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(created, 1); assert.equal(pinged, 1); assert.equal(finished, false);
  release({ ok: true }); await Promise.all([a, b]); assert.equal(finished, true);
});

test('模块一直无法就绪时有界失败，不发送开始命令或删除档案', async t => {
  const original = globalThis.chrome; t.after(() => { globalThis.chrome = original; });
  const ops = [];
  globalThis.chrome = { runtime: { getURL: p => p, getContexts: async () => [{}], sendMessage: async msg => { ops.push(msg.op); } } };
  await assert.rejects(() => ensureHost(), /未能就绪.*已有档案会保留/);
  assert.deepEqual(ops, Array(40).fill('ping'));
});
