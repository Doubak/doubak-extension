import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionDetector, SESSION_TTL_MS } from '../src/crawl/session-detector.js';

test('多个面板与重复轮询共享单次会话探测，TTL 内不请求网络', async () => {
  let calls = 0, now = 1000;
  const detector = new SessionDetector({ probe: async () => { calls++; return { state: 'logged_in', account: { userId: '111' } }; }, now: () => now });
  const results = await Promise.all(Array.from({ length: 20 }, () => detector.detect()));
  assert.equal(calls, 1);
  assert.ok(results.every((r) => r.account.userId === '111'));
  now += SESSION_TTL_MS - 1;
  await detector.detect();
  assert.equal(calls, 1);
  now += 2;
  await detector.detect();
  assert.equal(calls, 2);
});

test('新后台实例复用浏览器会话缓存，显式探测与 Cookie 失效重新请求', async () => {
  let cached = null, calls = 0;
  const options = { read: async () => cached, write: async (value) => { cached = value; },
    now: () => 1000, probe: async () => { calls++; return { state: 'logged_out' }; } };
  await new SessionDetector(options).detect();
  const detector = new SessionDetector(options);
  await detector.detect();
  assert.equal(calls, 1);
  await detector.detect({ force: true });
  assert.equal(calls, 2);
  detector.invalidate();
  await detector.detect();
  assert.equal(calls, 3);
});

test('探测期间身份失效，不把迟到结果写回缓存；失败可重试', async () => {
  let resolve, saved = null, calls = 0;
  const detector = new SessionDetector({ write: async (value) => { saved = value; }, probe: async () => {
    calls++;
    if (calls === 1) return new Promise((r) => { resolve = r; });
    if (calls === 2) throw new Error('网络断开');
    return { state: 'logged_out' };
  } });
  const pending = detector.detect();
  await new Promise((r) => setImmediate(r));
  detector.invalidate();
  resolve({ state: 'logged_in', account: { userId: '111' } });
  await pending;
  assert.equal(saved, null);
  await assert.rejects(() => detector.detect(), /网络断开/);
  assert.equal((await detector.detect()).state, 'logged_out');
});
