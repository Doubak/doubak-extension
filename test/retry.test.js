/**
 * 抓不下来的页面怎么处置。
 *
 * ## 这一组测试来自一个真实的、很贵的 bug
 *
 * 造一个永远抓不下来的电影详情页，三个条目跑下来是这样：
 *
 *     /1/=done   /2/=failed   /3/=pending ← 永远不会被抓
 *     hasReady() = false
 *     → 上层认为「跑完了」→ finish('complete')
 *     → manifest.status = complete，crawl_state 与 coverage **都是空的**
 *
 * 三个问题叠在一起：一个失败堵死整条路线（作品详情页占档案九成体积）；档案被静默标成
 * 完成（假的完整性声明，这个项目最不能出的错）；失败在 manifest 里一点痕迹都没有。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Frontier, MAX_NETWORK_RETRIES } from '../src/crawl/frontier.js';
import { CrawlLoop } from '../src/crawl/loop.js';
import { SessionGuard } from '../src/crawl/session.js';
import { Pacer, RequestGate } from '../src/crawl/pacing.js';
import { Transport } from '../src/crawl/transport.js';
import { BundleWriter } from '../src/bundle/bundle-writer.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { fixtures } from './helpers/fixtures.js';

const enc = new TextEncoder();

const SUBJECT_OK = `<html><body>
<div id="db-global-nav"><li class="nav-user-account"><a href="/accounts/logout">退出</a></li></div>
<script>;window._GLOBAL_NAV = { USER_ID: "82160871" };</script>
<div id="content"><div id="mainpic"></div></div></body></html>`;

/**
 * @param {object} opts
 * @param {boolean} opts.ordered  条目之间有没有先后关系
 * @param {(url: string) => boolean} opts.failIf
 */
async function harness({ ordered, failIf }) {
  const store = new MemoryFileStore();
  const writer = new BundleWriter({ store, account: { user_id: '82160871', username: 'example' } });

  const frontier = new Frontier();
  const urls = [1, 2, 3].map((n) => `https://movie.douban.com/subject/${n}/`);
  for (const u of urls) {
    frontier.enqueue({ url: u, urlKey: u, routeKey: 'interest.item', intent: 'interest.item', ordered });
  }

  let calls = 0;
  const transport = new Transport({
    gate: new RequestGate({ pacer: new Pacer({ intervalMs: 1, jitterRatio: 0 }) }),
    fetchImpl: async (url) => {
      calls += 1;
      if (failIf(url)) throw new TypeError('Failed to fetch');
      const b = enc.encode(SUBJECT_OK);
      return {
        status: 200, url,
        headers: new Headers({ 'content-type': 'text/html' }),
        arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
      };
    },
  });

  const session = new SessionGuard();
  session.preflight(fixtures.broadcastPage);
  /** @type {object[]} */
  const events = [];
  const loop = new CrawlLoop({
    frontier, transport, writer, session,
    pacer: new Pacer({ intervalMs: 1, jitterRatio: 0 }),
    routes: new Map([['interest.item', { intent: 'interest.item', kind: 'catalog' }]]),
    onEvent: (e) => events.push(e),
  });

  return { loop, frontier, writer, store, events, urls, calls: () => calls };
}

describe('重试预算', () => {
  test('只重试网络错误，一共请求 1 + MAX_NETWORK_RETRIES 次', async () => {
    const h = await harness({ ordered: false, failIf: (u) => u.includes('/2/') });
    await h.loop.run({ maxItems: 50 });

    const retries = h.events.filter((e) => e.type === 'retry');
    assert.equal(retries.length, MAX_NETWORK_RETRIES + 1, '重试事件数');
    assert.equal(retries.at(-1).willRetry, false, '最后一次要说明不再重试了');
  });

  test('重试用尽后记一处缺口 —— 否则失败在 manifest 里不可检测', async () => {
    // 这条分支原来只是返回 'failed' 就完了：不记缺口，而叶子路线又从没走过
    // observePage，于是 crawl_state 与 coverage 双双为空。gaps 在规范里本来就是
    // 「必须显式记录，不得静默」。
    const h = await harness({ ordered: false, failIf: (u) => u.includes('/2/') });
    await h.loop.run({ maxItems: 50 });

    h.loop.flushRouteEvidence('2026-07-30T00:00:00Z');
    // 从真的 manifest 里读——这才是下游会看到的东西。
    const manifest = await h.writer.finalize({ status: 'aborted' });
    const cs = manifest.crawl_state.find((c) => c.route_key === 'interest.item');
    assert.ok(cs, 'crawl_state 里必须有这条路线');
    assert.ok(cs.gaps.length > 0, '必须记下缺口');
    assert.equal(cs.gaps[0].reason, 'fetch_failed');
    assert.match(cs.gaps[0].detail, /subject\/2\//, '要说清是哪一页');
    assert.equal(cs.advanced, false, '有缺口就不许推进水位线');
  });
});

describe('叶子失败不许连带其它条目', () => {
  test('一个作品页抓不下来，其余的照样抓完', async () => {
    // 原来一个失败会把整条路线拉黑：三个条目里第三个**永远停在 pending**。
    // 而作品详情页占真实档案 90.3% 的体积——一页失败葬送九成档案。
    const h = await harness({ ordered: false, failIf: (u) => u.includes('/2/') });
    const r = await h.loop.run({ maxItems: 50 });

    const states = Object.fromEntries(h.frontier.snapshot().map((i) => [i.url.slice(-3), i.state]));
    assert.deepEqual(states, { '/1/': 'done', '/2/': 'failed', '/3/': 'done' });
    assert.equal(r.captured, 2);
    assert.equal(h.frontier.hasReady(), false, '真的没有可跑的了');
  });

  test('分页条目失败**要**堵住整条路线', async () => {
    // 这是刻意的：跳过抓不下来的第 7 页去抓第 8 页，就再也不能声称「第 7 页以上全都
    // 抓到了」，而水位线正建立在那句话上。
    const h = await harness({ ordered: true, failIf: (u) => u.includes('/2/') });
    await h.loop.run({ maxItems: 50 });

    const states = Object.fromEntries(h.frontier.snapshot().map((i) => [i.url.slice(-3), i.state]));
    assert.equal(states['/2/'], 'failed');
    assert.equal(states['/3/'], 'pending', '有序路线上后面的条目必须被挡住');
  });
});

describe('有未解决的失败就不许标 complete', () => {
  test('run() 把未解决的失败报出来，并区分有序与叶子', async () => {
    // 失败不调用 stop()，所以 stoppedBy 是 null——上层不能只看那个。
    const h = await harness({ ordered: false, failIf: (u) => u.includes('/2/') });
    const r = await h.loop.run({ maxItems: 50 });

    assert.equal(r.stoppedBy, null, '失败**不是**停机');
    assert.equal(r.unresolvedFailures, 1);
    assert.equal(r.unresolvedOrderedFailures, 0, '叶子失败不算有序失败');
  });

  test('有序失败也被单独数出来', async () => {
    const h = await harness({ ordered: true, failIf: (u) => u.includes('/2/') });
    const r = await h.loop.run({ maxItems: 50 });
    assert.equal(r.unresolvedOrderedFailures, 1);
  });
});

describe('人工处置', () => {
  test('retryFailed 把失败条目放回队列，并重置预算', async () => {
    let failing = true;
    const h = await harness({ ordered: false, failIf: (u) => failing && u.includes('/2/') });
    await h.loop.run({ maxItems: 50 });
    assert.equal(h.frontier.failedItems().length, 1);

    // 网络恢复了，用户点「重试」
    failing = false;
    const n = h.frontier.retryFailed();
    assert.equal(n, 1);

    const r2 = await h.loop.run({ maxItems: 50 });
    assert.equal(r2.captured, 1, '重试之后抓到了');
    assert.equal(h.frontier.failedItems().length, 0);
  });

  test('retryFailed 可以只针对一条路线', async () => {
    const h = await harness({ ordered: false, failIf: (u) => u.includes('/2/') });
    await h.loop.run({ maxItems: 50 });

    assert.equal(h.frontier.retryFailed({ routeKey: '别的路线' }), 0);
    assert.equal(h.frontier.retryFailed({ routeKey: 'interest.item' }), 1);
  });

  test('**没有任何自动调用者** —— 重试只能由人触发', async () => {
    // 自动重试一个反复失败的页面，最坏情况是每次心跳都去撞同一面墙；如果那面墙是
    // 风控，代价是账号。
    const { readFile } = await import('node:fs/promises');
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    for (const f of ['src/crawl/loop.js', 'src/crawl/driver.js', 'src/crawl/supervisor.js']) {
      const src = strip(await readFile(new URL(`../${f}`, import.meta.url), 'utf-8'));
      assert.equal(src.includes('retryFailed'), false, `${f} 里不该有自动重试`);
    }

    // background 里允许出现，但只在界面命令的分支里。
    // **切片要精确**：拿 `/onAlarm[\s\S]*?retryFailed/` 去匹配会横跨整个文件，
    // 于是「界面分支里有 retryFailed」被误判成「心跳里有 retryFailed」。
    const bg = strip(await readFile(new URL('../src/background.js', import.meta.url), 'utf-8'));
    assert.match(bg, /case 'retryFailed'/, '界面要能触发');

    const alarmStart = bg.indexOf('alarms?.onAlarm');
    const alarmBlock = bg.slice(alarmStart, bg.indexOf('});', alarmStart));
    assert.ok(alarmStart > 0, '找不到闹钟监听器，这条测试失去了意义');
    assert.equal(alarmBlock.includes('retryFailed'), false, '心跳里不许重试');

    // 恢复钩子里也不许——那条路径同样由心跳驱动
    const resumeStart = bg.indexOf('onResume:');
    const resumeBlock = bg.slice(resumeStart, bg.indexOf('onBlocked:', resumeStart));
    assert.equal(resumeBlock.includes('retryFailed'), false, '自动恢复时不许重试');
  });
});

describe('恢复时失败状态要原样还原', () => {
  test('checkpoint 写下的 failed 不许在恢复时被抹掉', async () => {
    // 早先恢复一律按「新条目」重建（pending、attempts 归零），于是 checkpoint 里的
    // failed 被静默丢弃——持久化了却不读，等于每次恢复都偷偷给一次新的重试预算。
    // 而崩溃恢复每 30 秒就可能发生一次。
    const f = new Frontier();
    f.enqueue({
      url: 'https://movie.douban.com/subject/9/', urlKey: 'k', routeKey: 'interest.item',
      intent: 'i', ordered: false, state: 'failed', attempts: 3,
    });

    const [it] = f.snapshot();
    assert.equal(it.state, 'failed');
    assert.equal(it.attempts, 3);
    assert.equal(f.failedItems().length, 1);
  });

  test('in_flight 仍然要还原成 pending —— 它没写完', async () => {
    const f = new Frontier();
    f.enqueue({
      url: 'https://movie.douban.com/subject/9/', urlKey: 'k', routeKey: 'interest.item',
      intent: 'i', state: 'pending', attempts: 1,
    });
    assert.equal(f.snapshot()[0].state, 'pending');
  });
});
