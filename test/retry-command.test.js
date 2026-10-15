import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRetryCommand } from '../src/crawl/retry-command.js';

test('会话确认期间重复重试共享结果，只排队并推进一次，且恢复调度心跳', async () => {
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const calls = [];
  const request = createRetryCommand({
    load: async () => { calls.push('load'); await ready; return true; },
    retry: async () => { calls.push('retry'); return calls.filter(c => c === 'retry').length === 1 ? 1 : 0; },
    resumeSchedule: async () => calls.push('resume'),
    clearAttention: async () => calls.push('clear'),
    drive: async () => calls.push('drive'),
  });
  const a = request(), b = request();
  assert.equal(a, b);
  await assert.rejects(request('another.route'), { reason: 'busy' });
  release();
  assert.deepEqual(await a, { ok: true, count: 1, loaded: true });
  assert.deepEqual(await b, await a);
  assert.deepEqual(calls, ['load', 'retry', 'resume', 'clear', 'drive']);
  assert.equal((await request()).count, 0, '已经完成的请求不能无限复用成功答复');
  assert.equal(calls.filter(c => c === 'drive').length, 1);
});

test('恢复身份验证失败时不重排、不恢复调度、不推进，用户之后仍能再试', async () => {
  let fail = true;
  const calls = [];
  const request = createRetryCommand({
    load: async () => { if (fail) throw new Error('operator_switched'); return true; },
    retry: async () => { calls.push('retry'); return 1; },
    resumeSchedule: async () => calls.push('resume'),
    clearAttention: async () => calls.push('clear'),
    drive: async () => calls.push('drive'),
  });
  await assert.rejects(request(), /operator_switched/);
  assert.deepEqual(calls, []);
  fail = false;
  assert.equal((await request()).count, 1);
  assert.deepEqual(calls, ['retry', 'resume', 'clear', 'drive']);
});

test('没有断点时不执行重试和推进', async () => {
  const unexpected = () => assert.fail('不应执行');
  const request = createRetryCommand({ load: async () => false, retry: unexpected,
    resumeSchedule: unexpected, clearAttention: unexpected, drive: unexpected });
  assert.deepEqual(await request(), { ok: true, count: 0, loaded: false });
});
