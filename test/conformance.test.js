/**
 * 跨仓库一致性：用**规范仓库的参考校验器**校验 BundleWriter 的真实产出。
 *
 * 这是写入器的最终验收标准：
 *
 *   > 用写入器产出一个 bundle，用 doubak-data-specs 的 validate.py 校验，
 *   > 必须通过。
 *
 * 它比任何单元测试都更有说服力：单元测试只能证明代码符合我们自己的理解，
 * 校验器代表的是规范的理解——独立编写、另一种语言、另一个仓库。
 *
 * 规范仓库的定位顺序：
 *   1. 环境变量 DOUBAK_SPECS_DIR
 *   2. 同级目录 ../doubak-data-specs
 * 找不到就显示原因并跳过，不静默变绿。
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MemoryFileStore } from '../src/storage/file-store.js';
import { BundleWriter } from '../src/bundle/bundle-writer.js';
import { coverageEntry, crawlStateEntry } from '../src/bundle/manifest-builder.js';
import { EMPTY_SHA256 } from '../src/core/digest.js';
import { parseDoubanTimestamp } from '../src/core/time.js';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const enc = new TextEncoder();

/** @type {string | null} */
let specsDir = null;
/** @type {string | false} */
let skipReason = false;

before(async () => {
  const candidates = [
    process.env.DOUBAK_SPECS_DIR,
    path.resolve(HERE, '../../doubak-data-specs'),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'bundle/v1/validate.py'))) {
      specsDir = dir;
      break;
    }
  }
  if (!specsDir) {
    skipReason =
      `找不到 doubak-data-specs（试过：${candidates.join('、')}）——` +
      `跳过跨仓库一致性检查。设 DOUBAK_SPECS_DIR 指向规范仓库即可启用`;
    return;
  }
  try {
    await execFileAsync('python3', ['--version']);
  } catch {
    skipReason = '未找到 python3——参考校验器跑不起来，跳过跨仓库一致性检查';
  }
});

/**
 * 用真正的 BundleWriter 产出一个 bundle。
 *
 * 这里刻意走完整流程：广播列表（html 面）、接口响应（api 面）、图片
 * （assets 段）、作品详情页（catalog 段），外加 coverage 与 crawl_state。
 */
async function writeRealBundle() {
  const store = new MemoryFileStore();
  const writer = new BundleWriter({
    store,
    account: {
      user_id: '82160871',
      username: 'mewcatcher',
      profile_url: 'https://www.douban.com/people/82160871/',
    },
    producer: {
      name: 'doubak-extension',
      version: '0.0.1',
      user_agent: 'Mozilla/5.0 (X11; Linux x86_64) doubak-test',
      platform: 'node-test',
    },
  });

  const page = await writer.writeCapture({
    url: 'https://www.douban.com/people/82160871/statuses?p=1&_spm_id=ODIx&_dtcc=1',
    intent: 'broadcast.timeline',
    routeKey: 'broadcast.timeline',
    surface: 'html',
    verdict: 'ok',
    captureFidelity: 'decoded_body+observed_headers',
    httpStatus: 200,
    headers: [['Content-Type', 'text/html; charset=utf-8']],
    contentType: 'text/html; charset=utf-8',
    body: enc.encode(
      '<html><div class="status-item" data-sid="9351468114" data-uid="82160871">' +
        '<span class="created_at" title="2026-07-26 12:34:00">7月26日</span></div></html>',
    ),
    cursor: { kind: 'page', value: 1 },
  });

  const api = await writer.writeCapture({
    url: 'https://m.douban.com/rexxar/api/v2/user/82160871/interests?ck=AAAA&count=1&for_mobile=1',
    intent: 'profile.category_entry.movie',
    routeKey: 'interest.movie.collect',
    surface: 'api',
    verdict: 'ok',
    captureFidelity: 'decoded_body+observed_headers',
    httpStatus: 200,
    headers: [['Content-Type', 'application/json']],
    contentType: 'application/json',
    body: enc.encode(JSON.stringify({ total: 1234, count: 1, interests: [] })),
    parentCaptureId: page.captureId,
    cursor: { kind: 'start', value: 0 },
  });

  // 图片进 assets 段（用户上传的内容，神圣）
  await writer.writeCapture({
    url: 'https://img9.doubanio.com/view/status/small/public/0MRkQs.jpg',
    intent: 'asset.image.user_upload',
    routeKey: 'broadcast.timeline',
    surface: 'html',
    verdict: 'ok',
    captureFidelity: 'decoded_body+observed_headers',
    httpStatus: 200,
    headers: [['Content-Type', 'image/jpeg']],
    contentType: 'image/jpeg',
    kind: 'assets',
    body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
    parentCaptureId: page.captureId,
  });

  // 作品详情页进 catalog 段（目录数据，可整批丢弃）
  await writer.writeCapture({
    url: 'https://movie.douban.com/subject/36221195/',
    intent: 'interest.item',
    routeKey: 'interest.movie.collect',
    surface: 'html',
    verdict: 'ok',
    captureFidelity: 'decoded_body+observed_headers',
    httpStatus: 200,
    headers: [['Content-Type', 'text/html; charset=utf-8']],
    contentType: 'text/html; charset=utf-8',
    kind: 'catalog',
    body: enc.encode('<html><h1>银翼杀手 2049</h1></html>'),
  });

  // 一条被封锁的响应也要入档，且如实标注
  await writer.writeCapture({
    url: 'https://www.douban.com/people/82160871/statuses?p=2',
    intent: 'broadcast.timeline',
    routeKey: 'broadcast.timeline',
    surface: 'html',
    verdict: 'blocked',
    captureFidelity: 'decoded_body+observed_headers',
    httpStatus: 200,
    headers: [['Content-Type', 'text/html; charset=utf-8']],
    contentType: 'text/html; charset=utf-8',
    body: enc.encode('<html>有异常请求</html>'),
    parentCaptureId: page.captureId,
  });

  const hw = parseDoubanTimestamp('2026-07-26 12:34:00');
  writer.addCoverage(
    coverageEntry({
      routeKey: 'interest.movie.collect',
      intent: 'interest.list.movie.collect',
      claimedCount: 1234,
      claimedRaw: '{"total": 1234}',
      claimedSource: api.captureId,
      claimedObservedAt: hw.iso,
      capturedCount: 0,
    }),
  );
  writer.addCoverage(
    coverageEntry({
      routeKey: 'broadcast.timeline',
      intent: 'broadcast.timeline',
      claimedCount: null, // 广播没有可信的声明数量。null ≠ 0
      capturedCount: 2,
    }),
  );
  writer.addCrawlState(
    crawlStateEntry({
      routeKey: 'broadcast.timeline',
      intent: 'broadcast.timeline',
      highWaterTime: hw.iso,
      highWaterRaw: hw.raw,
      highWaterIds: ['9351468114'],
      floorTime: null,
      enumeration: 'bounded',
      contiguous: true,
      advanced: true,
      bundleId: writer.bundleId,
    }),
  );

  const manifest = await writer.finalize();
  return { store, writer, manifest };
}

/** 把内存里的 bundle 倒到真实目录上，供校验器读取。 */
async function dumpTo(store, dir) {
  for (const [name, bytes] of Object.entries(store.snapshot())) {
    await writeFile(path.join(dir, name), bytes);
  }
}

async function runValidator(bundleDir) {
  const script = path.join(specsDir, 'bundle/v1/validate.py');
  try {
    const { stdout } = await execFileAsync('python3', [script, bundleDir]);
    return { ok: true, output: stdout };
  } catch (err) {
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** @param {(dir: string, ctx: {store: MemoryFileStore, manifest: object}) => Promise<void>} fn */
async function withRealBundle(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'doubak-conformance-'));
  try {
    const { store, manifest } = await writeRealBundle();
    await dumpTo(store, root);
    await fn(root, { store, manifest });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('跨仓库一致性（doubak-data-specs 的参考校验器）', () => {
  test('BundleWriter 的产出通过规范校验器', async (t) => {
    if (skipReason) return t.skip(skipReason);

    await withRealBundle(async (dir, { manifest }) => {
      const res = await runValidator(dir);
      assert.ok(res.ok, `校验器应当通过，实际输出：\n${res.output}`);
      assert.match(res.output, /通过/);

      // 顺带确认这个 bundle 确实覆盖了三种留存等级
      const kinds = new Set(manifest.segments.map((s) => s.filename.split('-')[0]));
      assert.deepEqual([...kinds].sort(), ['assets', 'catalog', 'data']);
    });
  });

  test('负面对照：段被改动而摘要没变 —— 校验器必须报错', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // 没有这个对照，上一个测试可能只是「校验器根本没跑起来」而假绿。
    await withRealBundle(async (dir, { manifest }) => {
      const seg = manifest.segments[0].filename;
      const bytes = await readFile(path.join(dir, seg));
      await writeFile(path.join(dir, seg), Buffer.concat([bytes, Buffer.from([0])]));

      const res = await runValidator(dir);
      assert.equal(res.ok, false, '被改动的段必须被发现');
      assert.match(res.output, /sha256 不符|大小不符/);
    });
  });

  test('负面对照：index 被截断 —— 校验器必须报错', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // 导出中断的典型形态。
    await withRealBundle(async (dir, { manifest }) => {
      const file = path.join(dir, manifest.index.filename);
      const lines = (await readFile(file, 'utf-8')).trimEnd().split('\n');
      await writeFile(file, lines.slice(0, -1).join('\n') + '\n');

      const res = await runValidator(dir);
      assert.equal(res.ok, false);
      assert.match(res.output, /行数不符|sha256 不符|record_count/);
    });
  });
});

describe('写入器根本不产出违规的 bundle', () => {
  // 上面那组测的是「产出之后被破坏能否发现」。这一组测的是更强的性质：
  // 有些违规状态，写入器压根就拒绝构造——问题在更早的地方就被挡住了。

  test('水位线不变量：连续性不成立就不许推进', async () => {
    assert.throws(
      () =>
        crawlStateEntry({
          routeKey: 'broadcast.timeline',
          intent: 'broadcast.timeline',
          highWaterTime: '2026-07-26T12:34:00+08:00',
          floorTime: null,
          enumeration: 'bounded',
          contiguous: false,
          advanced: true,
          bundleId: '20260729T101500Z-a3f9c1',
        }),
      /contiguous=false/,
    );
  });

  test('零长度载荷不得记为 ok', async () => {
    const store = new MemoryFileStore();
    const writer = new BundleWriter({ store, account: { user_id: '1' } });
    await assert.rejects(
      () =>
        writer.writeCapture({
          url: 'https://www.douban.com/x',
          intent: 'broadcast.timeline',
          routeKey: 'broadcast.timeline',
          surface: 'html',
          verdict: 'ok',
          captureFidelity: 'decoded_body+observed_headers',
          httpStatus: 200,
          body: new Uint8Array(0),
        }),
      /零长度/,
    );
  });

  test('空响应如实标注就允许 —— 空的封锁页本来就该存下来', async () => {
    const store = new MemoryFileStore();
    const writer = new BundleWriter({ store, account: { user_id: '1' } });
    const loc = await writer.writeCapture({
      url: 'https://www.douban.com/x',
      intent: 'broadcast.timeline',
      routeKey: 'broadcast.timeline',
      surface: 'html',
      verdict: 'blocked',
      captureFidelity: 'decoded_body+observed_headers',
      httpStatus: 200,
      body: new Uint8Array(0),
    });
    assert.ok(loc.captureId);
  });

  test('claimed_count 没有出处就不许记', async () => {
    assert.throws(
      () => coverageEntry({ routeKey: 'x', intent: 'x', claimedCount: 100, capturedCount: 100 }),
      /claimed_source/,
    );
  });

  test('EMPTY_SHA256 与规范里的常量一致', () => {
    assert.equal(EMPTY_SHA256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('抓取循环产出的 bundle 也要通过规范校验器', () => {
  // 上面那组验的是手工组装的 bundle。这一组验的是**抓取循环真跑一遍**
  // 产出的东西——包括它自己攒出来的 coverage 与 crawl_state。

  test('循环跑完 → 完整 bundle → 通过校验器', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const { CrawlLoop } = await import('../src/crawl/loop.js');
    const { Frontier } = await import('../src/crawl/frontier.js');
    const { Transport } = await import('../src/crawl/transport.js');
    const { Pacer, RequestGate } = await import('../src/crawl/pacing.js');
    const { SessionGuard } = await import('../src/crawl/session.js');
    const { buildRoutes } = await import('../src/crawl/routes.js');

    // 数字 uid 取自 `_GLOBAL_NAV.USER_ID`，不是广播条目的 `data-uid`——后者在作品
// 详情页上是评论者的 ID。见 src/crawl/session.js 里 UID_PATTERNS 的说明。
const NAV = `<li class="nav-user-account"><a href="/accounts/logout">退出</a>
      <span>示例的账号</span></li><a href="https://www.douban.com/people/example/">主页</a>
<script>;window._GLOBAL_NAV = { USER_ID: "10001" };</script>`;
    const bcPage = (n, from) => {
      let items = '';
      for (let i = 0; i < n; i++) {
        items += `<div class="status-item" data-sid="${from + i}" data-uid="10001">
          <span class="created_at" title="2026-07-2${i % 9} 1${i % 9}:00:00">x</span></div>`;
      }
      return `<html><head><title>\n示例的广播\n</title></head><body>${NAV}${items}</body></html>`;
    };

    const script = [bcPage(20, 0), bcPage(20, 20), bcPage(0, 0), bcPage(0, 0), bcPage(0, 0)];
    let i = 0;
    let now = 0;

    const store = new MemoryFileStore();
    const pacer = new Pacer({ intervalMs: 1, jitterRatio: 0 });
    const gate = new RequestGate({ pacer, now: () => now, sleep: async (ms) => { now += ms; } });
    const transport = new Transport({
      gate,
      now: () => now,
      fetchImpl: async (url) => {
        const body = enc.encode(script[Math.min(i++, script.length - 1)]);
        return {
          status: 200, url,
          headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
          arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        };
      },
    });

    const writer = new BundleWriter({
      store,
      account: { user_id: '10001', username: 'example' },
      now: () => new Date(1750000000000 + now),
    });
    const session = new SessionGuard();
    session.preflight(bcPage(1, 0));

    const frontier = new Frontier();
    const routes = new Map(buildRoutes({ username: 'example', includeCatalog: false }).map((r) => [r.key, r]));
    const bc = routes.get('broadcast.timeline');
    frontier.enqueue({
      url: bc.entryUrl({ offset: 1 }), urlKey: bc.entryUrl({ offset: 1 }),
      routeKey: 'broadcast.timeline', intent: 'broadcast.timeline',
      cursor: { kind: 'page', value: 1 },
    });

    const loop = new CrawlLoop({ frontier, transport, writer, session, pacer, routes });
    await loop.run({ maxItems: 8 });
    loop.flushRouteEvidence();
    const manifest = await writer.finalize();

    // 先确认它真的产出了完整性证据——空的 crawl_state 也能通过校验器，
    // 但那等于没有任何完整性依据。
    assert.ok(manifest.crawl_state.length > 0, '必须产出 crawl_state');
    assert.equal(manifest.crawl_state[0].advanced, true, '干净跑完应当推进水位线');
    assert.ok(manifest.coverage.length > 0, '必须产出 coverage');

    const root = await mkdtemp(path.join(tmpdir(), 'doubak-loop-'));
    try {
      await dumpTo(store, root);
      const res = await runValidator(root);
      assert.ok(res.ok, `校验器应当通过，实际输出：\n${res.output}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
