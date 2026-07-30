/**
 * 抓取事件日志。
 *
 * ## 为什么要有它
 *
 * 原来面板里那个日志是内存数组：只记面板打开期间的事件，一刷新就没了。而界面上写着
 * 「仅本地保留，不会发送到任何地方。导出前请自行脱敏」——那句话同时暗示了「存下来了」
 * 和「有导出」，**两个都不存在**。
 *
 * 而排查问题时最想要的恰好是「上次那次抓取在哪一步停下的」。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendEvent, readLog, clearLog, shouldLog, formatEntry, formatLogText, LOG_KEY, MAX_ENTRIES,
} from '../src/crawl/event-log.js';
import { MemoryKvStore } from '../src/storage/kv-store.js';

describe('只记 index.ndjson 里没有的事件', () => {
  test('capture 与 page 不进日志', () => {
    // 每一次成功的捕获已经逐条写在 index.ndjson 里了，而且更权威（带偏移量与摘要）。
    // 抄一遍只会得到两份可能不一致的记录，还把真正稀少的信号淹掉。
    assert.equal(shouldLog({ type: 'capture', verdict: 'ok' }), false);
    assert.equal(shouldLog({ type: 'page', routeKey: 'r' }), false);
  });

  test('重试、停机、错误、门控这些要记', () => {
    for (const type of ['retry', 'stopped', 'error', 'gate_opened', 'paused', 'subjects_enqueued']) {
      assert.equal(shouldLog({ type }), true, type);
    }
  });

  test('没有 type 的不记', () => {
    assert.equal(shouldLog({}), false);
    assert.equal(shouldLog(null), false);
  });

  test('append 会跳过被过滤的事件', async () => {
    const kv = new MemoryKvStore();
    await appendEvent(kv, { type: 'capture' });
    assert.equal(await kv.get(LOG_KEY), undefined, '一条都不该写');
  });
});

describe('一条日志留什么', () => {
  test('只留人看得懂的字段，不留整个事件对象', () => {
    // 事件里可能有大段 HTML 或错误栈，而日志有**条数**上限没有字节上限——
    // 一条超大记录会把有用的挤掉。
    const e = {
      type: 'error', routeKey: 'broadcast.timeline', url: 'https://x/1',
      message: 'boom', bodyText: 'x'.repeat(100_000), reasons: ['a', 'b'],
    };
    const r = formatEntry(e, '2026-07-30T00:00:00Z');
    assert.deepEqual(Object.keys(r).sort(), ['at', 'message', 'routeKey', 'type', 'url']);
    assert.equal('bodyText' in r, false);
  });

  test('错误信息要留但要截断 —— 它是排查的主要线索', () => {
    const r = formatEntry({ type: 'error', message: 'x'.repeat(2000) }, 'now');
    assert.equal(r.message.length, 500);
  });

  test('URL 也截断', () => {
    const r = formatEntry({ type: 'error', url: `https://x/${'y'.repeat(1000)}` }, 'now');
    assert.equal(r.url.length, 300);
  });
});

describe('存得住、有上限、最新在前', () => {
  test('写进去读得回来', async () => {
    const kv = new MemoryKvStore();
    await appendEvent(kv, { type: 'retry', url: 'https://x/1' }, { at: 'A' });
    await appendEvent(kv, { type: 'stopped', reason: 'blocked' }, { at: 'B' });

    const rows = await readLog(kv);
    assert.equal(rows.length, 2);
    // 最新在前：看日志的人先要看到最后发生的事
    assert.equal(rows[0].at, 'B');
    assert.equal(rows[1].at, 'A');
  });

  test('满了丢最老的 —— 日志是诊断用的，不是档案', async () => {
    // 它没有「不可再生」的性质，所以宁可丢最老的也不要无界增长。真正不可再生的
    // 都在 WARC 里。
    const kv = new MemoryKvStore();
    for (let i = 0; i < 12; i++) {
      await appendEvent(kv, { type: 'retry', count: i }, { at: `t${i}`, max: 10 });
    }
    const rows = await readLog(kv);
    assert.equal(rows.length, 10);
    assert.equal(rows[0].at, 't11', '最新的还在');
    assert.equal(rows.at(-1).at, 't2', '最老的两条被丢了');
  });

  test('默认上限是个合理值', () => {
    assert.ok(MAX_ENTRIES >= 100 && MAX_ENTRIES <= 2000);
  });

  test('清空', async () => {
    const kv = new MemoryKvStore();
    await appendEvent(kv, { type: 'retry' });
    await clearLog(kv);
    assert.deepEqual(await readLog(kv), []);
  });

  test('没写过就读，返回空数组而不是抛', async () => {
    assert.deepEqual(await readLog(new MemoryKvStore()), []);
  });
});

describe('导出文本', () => {
  test('开头就警告里面有 URL 与用户名', async () => {
    // 它是本地诊断工具，不是可以随手贴到公开地方的东西。而这个项目的用户群里，
    // 「装了一个豆瓣备份工具」本身就是不该外泄的信号。
    const text = formatLogText([{ at: 'A', type: 'retry', url: 'https://www.douban.com/people/x/' }]);
    assert.match(text, /脱敏/);
    assert.match(text, /URL 与用户名/);
  });

  test('每条一行，字段用分隔符连起来', () => {
    const text = formatLogText([{ at: 'A', type: 'stopped', reason: 'blocked', message: 'boom' }]);
    const line = text.split('\n').find((l) => l.includes('stopped'));
    assert.match(line, /blocked/);
    assert.match(line, /boom/);
  });

  test('空日志也能导出，不崩', () => {
    assert.doesNotThrow(() => formatLogText([]));
  });
});
