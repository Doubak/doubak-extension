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
  appendEvent, readLog, clearLog, shouldLog, isFetchEvent, formatEntry, formatLogText,
  LOG_KEY, FETCH_LOG_KEY, MAX_ENTRIES, MAX_FETCH_ENTRIES,
} from '../src/crawl/event-log.js';
import { MemoryKvStore } from '../src/storage/kv-store.js';

describe('只记 index.ndjson 里没有的事件', () => {
  test('page 不进日志 —— 它跟 capture 一一对应，记两遍没意义', () => {
    assert.equal(shouldLog({ type: 'page', routeKey: 'r' }), false);
  });

  test('batch 不进日志 —— 它是内部记账，没有一个字是人能据此行动的', () => {
    // 踩出来的：一次驱动层空转让它以每秒几十次刷屏，导出的日志是整整 500 行
    // `batch`，唯一有用的那一行是最后的 `paused`。
    assert.equal(shouldLog({ type: 'batch', captured: 3, failed: 0, done: false }), false);
  });

  test('一场空转塞不满日志 —— 真正要紧的那几条还在', async () => {
    const kv = new MemoryKvStore();
    await appendEvent(kv, { type: 'stopped', reason: 'driver_stalled' }, { at: '2026-07-31T00:00:00Z' });
    for (let i = 0; i < 2000; i++) {
      await appendEvent(kv, { type: 'batch', captured: 0, failed: 0 }, { at: '2026-07-31T00:00:01Z' });
    }
    const rows = await readLog(kv);
    assert.deepEqual(rows.map((r) => r.type), ['stopped']);
  });

  test('capture 要记，但进的是**另一个**环', () => {
    // 一次全量抓取有几千页。混在一个 500 条的环里，翻页记录会把真正要紧的信号
    // （为什么停的、哪一页反复失败）全挤出去——而那几条正是事后唯一能查的东西。
    assert.equal(shouldLog({ type: 'capture', verdict: 'ok' }), true);
    assert.equal(isFetchEvent({ type: 'capture', verdict: 'ok' }), true);
    assert.equal(isFetchEvent({ type: 'retry' }), false);
  });

  test('判定不是 ok 的捕获走稀疏环 —— 否则会被翻页记录挤掉', () => {
    // 真实数据：一次 3347 条捕获的抓取里有 8 条 `gone`，而抓取环只有 200 条，
    // 于是日志里**只剩最后那一条**——另外 7 条查不到了。
    // 而 `gone` 正是「豆瓣把这个条目删了」，是这个项目存在的理由本身。
    assert.equal(isFetchEvent({ type: 'capture', verdict: 'ok' }), true);
    assert.equal(isFetchEvent({ type: 'capture', verdict: 'gone' }), false);
    assert.equal(isFetchEvent({ type: 'capture', verdict: 'blocked' }), false);
    assert.equal(isFetchEvent({ type: 'capture', verdict: null }), false, '判不出来的更要留着');
  });

  test('几千条正常捕获也挤不掉那几条 gone', async () => {
    const kv = new MemoryKvStore();
    const at = (i) => `2026-07-31T00:00:${String(i % 60).padStart(2, '0')}Z`;
    for (let i = 0; i < 3000; i++) {
      await appendEvent(kv, { type: 'capture', verdict: 'ok', url: `https://x/${i}` }, { at: at(i) });
      if (i % 400 === 0) {
        await appendEvent(kv, { type: 'capture', verdict: 'gone', url: `https://gone/${i}` }, { at: at(i) });
      }
    }
    const rows = await readLog(kv);
    const gone = rows.filter((r) => r.verdict === 'gone');
    assert.equal(gone.length, 8, `8 条 gone 只剩 ${gone.length} 条`);
  });

  test('抓取环装满了也不动稀疏事件那一环', async () => {
    // 这是分成两个环的**全部理由**，所以直接测它。
    const kv = new MemoryKvStore();
    await appendEvent(kv, { type: 'stopped', reason: 'user_paused' }, { at: '2026-07-30T00:00:00Z' });
    for (let i = 0; i < MAX_FETCH_ENTRIES + 50; i++) {
      await appendEvent(kv, { type: 'capture', verdict: 'ok', url: `https://x/${i}` }, { at: '2026-07-30T00:01:00Z' });
    }
    const rows = await readLog(kv);
    assert.ok(rows.some((r) => r.type === 'stopped'), '停机原因被翻页记录挤掉了');
    assert.equal(rows.filter((r) => r.type === 'capture').length, MAX_FETCH_ENTRIES);
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
    await appendEvent(kv, { type: 'page', routeKey: 'r' });
    assert.equal(await kv.get(LOG_KEY), undefined, '一条都不该写');
    assert.equal(await kv.get(FETCH_LOG_KEY), undefined);
  });

  test('没有 verdict 的 capture 按「判不出来」处理，进稀疏环', async () => {
    // 判不出来是最该被看见的一种结果，不能因为字段缺失就被当成正常页丢进抓取环。
    const kv = new MemoryKvStore();
    await appendEvent(kv, { type: 'capture', url: 'https://x/1' });
    assert.equal((await kv.get(LOG_KEY))?.length, 1);
    assert.equal(await kv.get(FETCH_LOG_KEY), undefined);
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
    // 时间戳要**能按字典序排**（真实的 RFC3339 就是这样）——readLog 现在要合并两个环，
    // 靠的就是这个。`t0…t11` 那种写法排出来是 t9 > t11。
    const at = (i) => `2026-07-30T00:00:${String(i).padStart(2, '0')}Z`;
    for (let i = 0; i < 12; i++) {
      await appendEvent(kv, { type: 'retry', count: i }, { at: at(i), max: 10 });
    }
    const rows = await readLog(kv);
    assert.equal(rows.length, 10);
    assert.equal(rows[0].at, at(11), '最新的还在');
    assert.equal(rows.at(-1).at, at(2), '最老的两条被丢了');
  });

  test('默认上限是个合理值', () => {
    assert.ok(MAX_ENTRIES >= 100 && MAX_ENTRIES <= 2000);
    assert.ok(MAX_FETCH_ENTRIES >= 50 && MAX_FETCH_ENTRIES <= MAX_ENTRIES);
  });

  test('两个环合起来是一条按时间排的时间线', async () => {
    // 分开存是为了不让翻页记录挤掉要紧的事件，但**看的时候**要的正是前后文：
    // 「停之前最后抓的是哪一页」这个问题，需要两类记录交错在一起。
    const kv = new MemoryKvStore();
    await appendEvent(kv, { type: 'capture', url: 'https://a' }, { at: '2026-07-30T00:00:01Z' });
    await appendEvent(kv, { type: 'retry', routeKey: 'r' }, { at: '2026-07-30T00:00:02Z' });
    await appendEvent(kv, { type: 'capture', url: 'https://b' }, { at: '2026-07-30T00:00:03Z' });
    const rows = await readLog(kv);
    assert.deepEqual(rows.map((r) => r.type), ['capture', 'retry', 'capture']);
    assert.equal(rows[0].url, 'https://b', '最新在前');
  });

  test('清空两个环都清 —— 漏一个的话「清空日志」是句假话', async () => {
    const kv = new MemoryKvStore();
    await appendEvent(kv, { type: 'capture', url: 'https://a' });
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
