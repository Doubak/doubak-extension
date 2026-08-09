/**
 * 演练夹具的验证。
 *
 * ## 为什么这个测试必须存在
 *
 * 面板上每个剧本都印着一句「预期：……」。那句话是一个**断言**，而断言不能
 * 只写在界面上——否则夹具一旦写歪，演练会安安静静地给出绿色结果，用户以为
 * 「拦截会被正确识别」已经验证过了，实际上什么都没验证。
 *
 * 一个说谎的调试工具比没有调试工具更糟。所以每个剧本在这里都真跑一遍，断言
 * 的正是界面上那句承诺。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SCENARIOS, dryRunFetch } from '../src/crawl/dry-run.js';
import { CrawlRunner } from '../src/crawl/runner.js';
import { RunStore } from '../src/crawl/run-store.js';
import { MemoryKvStore } from '../src/storage/kv-store.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { indexFilename } from '../src/core/ids.js';
import { TEST_PRODUCER_VERSION } from './helpers/producer.js';

/**
 * 按后台里 `runDryRun()` 的方式跑一个剧本。
 *
 * 这里刻意用**和生产同一条**路径：同一个 CrawlRunner、同一个分类器、同一个
 * frontier、同一个写入器。只有 fetch 与存储是替身。
 *
 * @param {string} key
 */
async function runScenario(key) {
  /** @type {Map<string, MemoryFileStore>} */
  const dirs = new Map();
  const openBundle = async (dir) => {
    if (!dirs.has(dir)) dirs.set(dir, new MemoryFileStore());
    return dirs.get(dir);
  };

  /** @type {object[]} */
  const events = [];
  /** @type {Record<string, number>} */
  const byVerdict = {};

  const runner = new CrawlRunner({ producerVersion: TEST_PRODUCER_VERSION,
    runStore: new RunStore({ kv: new MemoryKvStore(), openBundle }),
    openBundle,
    fetchImpl: dryRunFetch(key),
    pacerOptions: { intervalMs: 1, jitterRatio: 0 },
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'capture') {
        const k = e.verdict ?? 'unclassified';
        byVerdict[k] = (byVerdict[k] ?? 0) + 1;
      }
    },
  });

  await runner.start({
    username: 'dryrun',
    onlyRoutes: ['broadcast.timeline'],
    includeCatalog: false,
  });

  let captured = 0;
  let failed = 0;
  let stoppedBy = null;
  let unresolved = 0;
  let batches = 0;
  for (let i = 0; i < 40; i++) {
    const b = await runner.runBatch();
    batches += 1;
    captured += b.captured;
    failed += b.failed;
    stoppedBy = b.stoppedBy;
    // 软封锁挡住的条目同样不算跑完（状态是 awaiting_human，不是 failed）。
    unresolved = (b.unresolvedFailures ?? 0) + (b.awaitingHuman ?? 0);
    if (b.done) break;
  }

  const st = runner.status();
  const route = st.routes?.find((r) => r.routeKey === 'broadcast.timeline');
  // 「水位线能不能推进」看的是 `newestSeen`（本次最新的一条），**不是**进度。
  // 进度是 `oldestSeen`，那是给人看的。
  const advanced = route ? Boolean(route.contiguous && route.newestSeen) : null;
  const bundleId = st.bundleId;
  // 有未解决的失败、或者被软封锁挡住的条目，都不许标 complete（见 runner.finish）。
  await runner.finish(stoppedBy || unresolved ? 'aborted' : 'complete');

  // 计数器与档案是两回事。「拦截页也要进档案」这条承诺只能对着档案本身验，
  // 不能对着计数器——被停机打断的那一页根本不计入 captured。
  const dir = [...dirs.keys()][0];
  const text = new TextDecoder().decode(await dirs.get(dir).read(indexFilename(bundleId)));
  const index = text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

  return { captured, failed, stoppedBy, unresolved, byVerdict, advanced, events, batches, dirs, index };
}

describe('演练夹具', () => {
  test('每个剧本都跑得起来，且都写出了档案', async () => {
    for (const key of Object.keys(SCENARIOS)) {
      const r = await runScenario(key);
      assert.ok(r.batches > 0, `${key}：一批都没跑`);
      // 连被拦截、被判死的页面也要落盘——分类器要能在不重新抓取的前提下重训。
      // 真实旧档案里恰恰是「存了但没标注」造成了静默的数据损坏。
      assert.ok(r.index.length > 0, `${key}：什么都没写进档案`);
      for (const e of r.index) {
        assert.ok(e.verdict, `${key}：${e.url} 没有判定`);
      }
    }
  });

  test('clean：走到停滞终止，水位线推进', async () => {
    const r = await runScenario('clean');
    assert.equal(r.stoppedBy, null, '不该有停机原因——这一场是干净跑完的');
    assert.equal(r.advanced, true, '干净完成必须推进水位线');
    assert.ok(r.captured >= 4, `抓到的页数太少：${r.captured}`);
    assert.equal(r.byVerdict.ok, r.captured, '每一页都该判 ok');
  });

  test('terminator_vs_login：条目数相同，判定必须不同', async () => {
    const r = await runScenario('terminator_vs_login');
    // 这是整个分类器最要命的一条：0 条的越界终止页与 0 条的登录页，
    // 光看条目数完全一样。判错方向的代价是把「掉登录」当成「抓完了」。
    assert.ok(r.byVerdict.ok >= 3, `正常页判定不对：${JSON.stringify(r.byVerdict)}`);
    assert.equal(r.byVerdict.login, 1, '0 条的登录页必须判 login，不能跟越界页混为一谈');
    assert.equal(r.stoppedBy, 'session_expired', '掉登录是停止条件');
    assert.equal(r.advanced, false, '没走到终点就不许推进水位线');
  });

  test('blocked：判 blocked、进档案、转等待人工、不推进水位线', async () => {
    const r = await runScenario('blocked');
    assert.equal(r.byVerdict.blocked, 1, '封锁页必须被判出来');
    // 封锁是**路线级**的等待人工，不是全局停机：别的路线没被封，没理由陪葬。
    const aw = r.events.find((e) => e.type === 'awaiting_human');
    assert.equal(aw?.reason, 'blocked');
    assert.ok(aw.intervalMs > 0, '被拦之后必须降速');
    assert.equal(r.advanced, false, '被拦截打断的抓取不算完成');
    assert.ok(r.index.some((e) => e.verdict === 'blocked'), '封锁页必须留在档案里');
  });

  test('challenge：转等待人工，不自动重试', async () => {
    const r = await runScenario('challenge');
    assert.equal(r.byVerdict.challenge, 1);
    assert.equal(r.events.find((e) => e.type === 'awaiting_human')?.reason, 'challenge');
    // 「不自动重试」得看得见：那一页只许被抓一次。在软封锁上重试，正是把
    // 限流升级成封号的那条路径。
    const urls = r.index.map((e) => e.url);
    assert.equal(new Set(urls).size, urls.length, '有 URL 被重复抓取');
    assert.equal(r.advanced, false);
  });

  test('session_lost：会话失效是停止条件，已抓的照样留在档案里', async () => {
    const r = await runScenario('session_lost');
    assert.equal(r.stoppedBy, 'session_expired');
    assert.ok(r.captured >= 2, '掉登录之前抓到的必须留下');
    assert.equal(r.advanced, false, '被打断的路线下次仍从旧下界重走');
  });

  test('anon_with_data：页面有数据也必须判 login', async () => {
    const r = await runScenario('anon_with_data');
    // 最阴的一种：页面结构完整、条目是真的，只有导航栏露了馅。
    // 当成账号数据就是把公开视图（没有私密条目）冒充成完整列表。
    assert.equal(r.byVerdict.ok ?? 0, 0, '未登录的页面绝不能判 ok');
    assert.equal(r.stoppedBy, 'session_expired');
    // 停机之前那一页照样得写进档案
    assert.ok(r.index.length >= 1);
  });

  test('server_error：判不出来 → 走可重试路径 → 用尽后失败', async () => {
    const r = await runScenario('server_error');
    assert.ok(r.failed > 0 || r.stoppedBy, `5xx 不该被当成成功：${JSON.stringify(r)}`);
    assert.equal(r.byVerdict.ok ?? 0, 0);
    assert.equal(r.advanced, false);
  });

  test('unknown_page：认不出的页面判 null，不是 ok', async () => {
    const r = await runScenario('unknown_page');
    assert.equal(r.byVerdict.ok ?? 0, 0, '结构对不上就不能判 ok');
    assert.ok(
      (r.byVerdict.unclassified ?? 0) > 0,
      `应当有判不出来的页面：${JSON.stringify(r.byVerdict)}`,
    );
    // 判不出来必须记下依据，否则事后无从复盘豆瓣改了什么
    const cap = r.events.find((e) => e.type === 'capture' && e.verdict === null);
    assert.ok(cap?.reasons?.length, '判不出来时必须记录判定依据');
  });

  test('演练一个网络请求都不发', async () => {
    // 「零网络请求」是演练模式全部的意义所在——它是安全承诺，不是性能优化。
    // 所以在源码层面把它钉死：夹具里不许出现任何出网手段。一旦有人往里加了
    // 一句真 fetch，这条会红，而不是等到某天真的去撞了豆瓣的风控。
    const url = new URL('../src/crawl/dry-run.js', import.meta.url);
    const src = await (await import('node:fs/promises')).readFile(url, 'utf-8');
    for (const bad of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'import(']) {
      assert.equal(src.includes(bad), false, `演练夹具里不该出现 ${bad}`);
    }

    /** @type {string[]} */
    const seen = [];
    const f = dryRunFetch('clean', (info) => seen.push(info.url));
    const res = await f('https://www.douban.com/people/dryrun/');
    assert.deepEqual(seen, ['https://www.douban.com/people/dryrun/']);
    assert.equal(res.status, 200);
  });

  test('剧本键与标题都是唯一的', () => {
    // 面板按 key 发命令、按 title 显示。标题重了，用户就分不清点的是哪一个。
    const titles = Object.values(SCENARIOS).map((s) => s.title);
    assert.equal(new Set(titles).size, titles.length);
    for (const [key, s] of Object.entries(SCENARIOS)) {
      assert.ok(s.expect?.length > 10, `${key} 缺少「预期」说明`);
      assert.equal(typeof s.pages, 'function');
    }
  });
});
