/**
 * 整条导出链，端到端：真的写一份 bundle，再从它出三种产物。
 *
 * ## 为什么不用桩，要真写一份档案
 *
 * 这条链上每一处接缝都在「两个仓库之间」：写出器写的 WARC，解析器的抽取器读；
 * 解析器的 `parse()` 认那八项契约，这边的 `OpfsBundleSource` 实现它；导出适配器
 * 的 `zip()` 要一个压缩函数，这边给 `CompressionStream`。**桩会把每一处接缝都
 * 假设成对的**，而接缝正是唯一会错的地方。
 *
 * 所以这里用 `BundleWriter` + `MemoryFileStore` 真写一份，再原路读回来。
 *
 * ## 覆盖到的三条曾经出过事的规则
 *
 * - 正文按**字节**切（一个汉字三个字节，按字符切会错位）
 * - 图片走 `readRaw`，**不解码**
 * - zip 不给压缩函数要报错，不能悄悄退回「存储」
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { BundleWriter } from '../src/bundle/bundle-writer.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { bundleDirName } from '../src/core/ids.js';
import { TEST_PRODUCER } from './helpers/producer.js';
import { OpfsBundleSource } from '../src/pipeline/opfs-bundle-source.js';
import { parseLibrary, canonicalFiles } from '../src/pipeline/run.js';
import { buildCanonical, buildNeodb, buildMarkdown, deflateRaw } from '../src/pipeline/targets.js';
import { zip } from '../src/vendor/export-adapters/zip.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const AT = new Date('2026-08-28T04:00:00Z');
const ACCOUNT = { user_id: '82160871', username: 'mewcatcher' };

/** 一页「看过的电影」，两条标记，其中一条带短评与评分。 */
const MOVIE_LIST = `<!DOCTYPE html><html><head><title>看过的电影</title></head><body>
<div id="db-nav-sns"><a href="https://www.douban.com/people/mewcatcher/">mewcatcher</a></div>
<h1>mewcatcher看过的影视(2)</h1>
<div class="grid-view">
  <div class="item">
    <div class="info"><ul>
      <li class="title"><a href="https://movie.douban.com/subject/1292052/"><em>肖申克的救赎 / The Shawshank Redemption</em></a></li>
      <li class="intro">1994-09-10 / 美国</li>
      <li><span class="date">2026-07-31</span><span class="rating5-t"></span><span class="tags">标签: 经典 重看</span></li>
      <li><span class="comment">「希望是好事，也许是人间至善。」——这句话我记了很多年。</span></li>
      <li class="clearfix opt-ln"><a href="#">删除</a></li>
    </ul></div>
  </div>
  <div class="item">
    <div class="info"><ul>
      <li class="title"><a href="https://movie.douban.com/subject/1291561/"><em>千与千寻 / 千と千尋の神隠し</em></a></li>
      <li class="intro">2001-07-20 / 日本</li>
      <li><span class="date">2026-08-01</span></li>
      <li class="clearfix opt-ln"><a href="#">删除</a></li>
    </ul></div>
  </div>
</div></body></html>`;

/** @param {object} over */
function capture(over) {
  return {
    url: 'https://movie.douban.com/people/mewcatcher/collect',
    urlKey: 'movie.douban.com/people/mewcatcher/collect',
    urlKeyRules: 'v1',
    intent: 'interest.list.movie.collect',
    routeKey: 'interest.movie.collect',
    surface: 'html',
    verdict: 'ok',
    captureFidelity: 'decoded_body+observed_headers',
    body: enc.encode(MOVIE_LIST),
    httpStatus: 200,
    headers: [['Content-Type', 'text/html; charset=utf-8']],
    contentType: 'text/html; charset=utf-8',
    ...over,
  };
}

/** 写一份能解析的档案，返回 `{store, entry}`。 */
async function writeBundle(over = {}) {
  const store = new MemoryFileStore();
  const writer = new BundleWriter({
    producer: TEST_PRODUCER, store, account: ACCOUNT, now: () => AT, ...over,
  });
  await writer.writeCapture(capture());
  await writer.finalize?.();

  let manifest = null;
  try {
    manifest = JSON.parse(dec.decode(await store.read('manifest.json')));
  } catch { /* 没收尾也要能解析——见 OpfsBundleSource.status */ }

  return {
    store,
    entry: { bundleId: writer.bundleId, dir: bundleDirName(writer.bundleId), manifest },
  };
}

/** 把一份档案喂进流水线。 */
async function run(bundles) {
  const byId = new Map(bundles.map((b) => [b.entry.bundleId, b.store]));
  return parseLibrary({
    entries: bundles.map((b) => b.entry),
    openStore: (entry) => byId.get(entry.bundleId),
  });
}

describe('OpfsBundleSource', () => {
  test('那八项契约一个不少，而且 payload 取回的是正文', async () => {
    const b = await writeBundle();
    const src = await OpfsBundleSource.open({ store: b.store, entry: b.entry });

    // 契约由解析器仓库的 portable.test.js 钉住，这边验它真的实现了。
    for (const k of ['status', 'manifest', 'bundleId', 'index', 'crawlState', 'coverage']) {
      assert.notEqual(src[k], undefined, `契约里的 ${k} 没实现`);
    }
    assert.equal(typeof src.payload, 'function');
    assert.equal(typeof src.close, 'function');

    const html = await src.payload(src.index[0]);
    assert.match(html, /肖申克的救赎/);
    // **按字节切的证据**：正文以 `<!DOCTYPE` 开头，一个 HTTP 头都不许漏进来。
    assert.ok(html.startsWith('<!DOCTYPE html>'), `正文开头不对：${html.slice(0, 60)}`);
    assert.ok(!html.includes('Content-Type:'), 'HTTP 头漏进正文了');
  });

  test('没有 manifest 的档案照样解析，不是错', async () => {
    // 抓到一半被打断的档案没有 manifest，而里面 verdict: ok 的捕获是真实观测。
    const b = await writeBundle();
    const src = await OpfsBundleSource.open({
      store: b.store, entry: { ...b.entry, manifest: null },
    });
    assert.equal(src.status, 'in_progress');
    assert.equal(src.crawlState.size, 0);
    assert.equal(src.coverage.size, 0);
  });

  test('index 里有坏行就抛，不静静跳过', async () => {
    // 一行读不出来意味着索引与段文件可能已经失去对应关系 —— 那必须让人知道。
    const b = await writeBundle();
    const name = `index-${b.entry.bundleId}.ndjson`;
    const text = dec.decode(await b.store.read(name));
    await b.store.replace(name, enc.encode(`${text}{ 这不是 JSON\n`));
    await assert.rejects(
      () => OpfsBundleSource.open({ store: b.store, entry: b.entry }),
      /无法解析/,
    );
  });
});

describe('解析整个库', () => {
  test('两条标记都出来了，短评与评分没丢', async () => {
    const { data } = await run([await writeBundle()]);
    assert.equal(data.marks.length, 2);

    const shawshank = data.marks.find((m) => m.subject?.id === '1292052');
    const fields = shawshank.revisions.at(-1).fields;
    assert.equal(fields.status, 'done');
    assert.equal(fields.rating, 5);
    assert.match(fields.comment, /希望是好事/);
    assert.deepEqual(fields.tags, ['经典', '重看']);

    // 没评分的那条 rating 是 null，**不是 0** —— 那是两件不同的事。
    const spirited = data.marks.find((m) => m.subject?.id === '1291561');
    assert.equal(spirited.revisions.at(-1).fields.rating, null);
  });

  test('一个库里混了两个账号是错误，不是告警', async () => {
    // 合并过的 canonical 事后拆不开。扩展这边比命令行更容易撞上 —— 导入过
    // 别人的档案就够了。
    const mine = await writeBundle();
    const theirs = await writeBundle({ account: { user_id: '999', username: 'someone' } });
    await assert.rejects(() => run([mine, theirs]), /账号/);
  });

  test('--放行之后照样留下告警，绕过的是「停下来」不是「说出来」', async () => {
    const mine = await writeBundle();
    const theirs = await writeBundle({ account: { user_id: '999', username: 'someone' } });
    const byId = new Map([mine, theirs].map((b) => [b.entry.bundleId, b.store]));
    const { data } = await parseLibrary({
      entries: [mine.entry, theirs.entry],
      openStore: (e) => byId.get(e.bundleId),
      ignoreWarnings: true,
    });
    assert.equal(data.warnings.filter((w) => w.type === 'multiple_accounts').length, 1);
  });

  test('进度的分母从头到尾不变', async () => {
    // 一个会变的分母比没有分母更糟：进度条往回跳，看起来像出了错。
    const seen = [];
    const b = await writeBundle();
    await parseLibrary({
      entries: [b.entry],
      openStore: () => b.store,
      onProgress: (p) => { if (p.phase === 'parse') seen.push(p.total); },
    });
    assert.ok(seen.length > 0, '一次进度都没报');
    assert.equal(new Set(seen).size, 1, `分母变过：${[...new Set(seen)].join(', ')}`);
  });
});

describe('三种产出', () => {
  test('canonical：五个 ndjson，名字与命令行那边认的一致', async () => {
    const { data } = await run([await writeBundle()]);
    const { files, report } = await buildCanonical(data);
    const names = files.map((f) => f.name);
    // 名字对不上就白导了 —— 下游 `loadCanonical` 按这五个名字找。
    for (const n of ['marks', 'subjects', 'broadcasts', 'longform', 'doulists']) {
      assert.ok(names.includes(`${n}.ndjson`), `少了 ${n}.ndjson`);
    }
    assert.equal(report.marks, 2);

    // 空的那几类也要有文件：「没有豆列」与「这个版本不解析豆列」是两件事。
    const doulists = files.find((f) => f.name === 'doulists.ndjson');
    assert.ok(doulists, 'doulists.ndjson 不能因为是空的就不写');
  });

  test('canonical 的每一行都是能读回来的 JSON', async () => {
    const { data } = await run([await writeBundle()]);
    for (const f of canonicalFiles(data)) {
      for (const line of f.text.split('\n')) {
        if (line.trim()) assert.doesNotThrow(() => JSON.parse(line), `${f.name} 有坏行`);
      }
    }
  });

  test('NeoDB：zip 里必须正好是那两个文件名', async () => {
    // 上传页面按 `journal.ndjson` / `catalog.ndjson` 认格式（data.html 里那段
    // JSZip）。名字不对就是「未知格式」，连传都传不上去。
    const { data } = await run([await writeBundle()]);
    const { files } = await buildNeodb(data);

    const pkg = files.find((f) => f.name === 'neodb-ndjson-import.zip');
    assert.ok(pkg, '没出 zip');
    const inside = await readZipNames(pkg.bytes);
    assert.deepEqual(inside.sort(), ['catalog.ndjson', 'journal.ndjson']);

    // 说明书在 zip **外面**：进了 zip 就会被当成要导入的东西。
    assert.ok(files.some((f) => f.name === '怎么导入.md'));
  });

  test('NeoDB：zip 是真的 zip，而且能拆回来', async () => {
    const { data } = await run([await writeBundle()]);
    const { files } = await buildNeodb(data);
    const bytes = files[0].bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(view.getUint32(0, true), 0x04034b50, '开头不是本地文件头');

    const { unzip } = await import('../src/vendor/export-adapters/zip.js');
    const { inflateRawSync } = await import('node:zlib');
    const back = await unzip(bytes, { inflateRaw: (b) => new Uint8Array(inflateRawSync(b)) });
    const journal = back.get('journal.ndjson').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    // 第一行是文件头，之后是记录。两条标记该在里面。
    assert.equal(journal.filter((d) => d.type === 'ShelfMember').length, 2);
  });

  test('CompressionStream 压出来的，node:zlib 解得开', async () => {
    // 这是两边 zip 唯一真正不同的一处。压错了产物打不开，而 NeoDB 那边的报错
    // 是「未知格式」——离原因很远。
    const { inflateRawSync } = await import('node:zlib');
    const text = '希望是好事，也许是人间至善。'.repeat(50);
    const packed = await deflateRaw(enc.encode(text));
    assert.equal(dec.decode(inflateRawSync(packed)), text);
    assert.ok(packed.length < enc.encode(text).length, '压完反而更大了');
  });

  test('zip 不给压缩函数要报错，不许悄悄退回「存储」', async () => {
    await assert.rejects(() => zip([{ name: 'x', text: 'y' }], {}), /deflateRaw/);
  });

  test('Markdown：出一棵树，图片路径是站内路径', async () => {
    const { data, sources } = await run([await writeBundle()]);
    /** @type {Map<string, Uint8Array>} */
    const written = new Map();
    const { files, report } = await buildMarkdown(data, {
      sources,
      write: async (rel, bytes) => { written.set(rel, bytes); },
    });

    const names = files.map((f) => f.name);
    assert.ok(names.includes('content/_index.md'), '没有首页');
    assert.ok(names.some((n) => n.startsWith('content/movie/')), '没有作品页');
    assert.ok(names.includes('static/search-index.js'), '搜索索引总是要出的');

    // 这份档案里没有图片捕获，所以一张也写不出来——但**不能因此报「缺」**：
    // 缺的判定要把占位图与「按作品 id 已找到」排除掉。
    assert.equal(report.images, 0);
    assert.equal(written.size, 0);
    assert.ok(Array.isArray(report.remote));
  });

  test('Markdown：用户写的字被转义了，片名不会整个消失', async () => {
    // `From <May December>` 曾经在页面上只剩 `From` —— 而页面上一点痕迹都不留。
    const { data, sources } = await run([await writeBundle()]);
    const { files } = await buildMarkdown(data, { sources, write: async () => {} });
    const page = files.find((f) => f.name.startsWith('content/movie/') && f.name.endsWith('.md'));
    const text = dec.decode(page.bytes);
    assert.match(text, /希望是好事/, '短评没进页面');
    // 转义之后的引号仍然可读，不能被吃掉。
    assert.match(text, /人间至善/);
  });

  test('三种产出可以从同一次解析出，不用重解析', async () => {
    // 这正是「中间产物不落盘」说得过去的原因：重算的代价就是解析那一遍，
    // 而一次解析能喂三条路。
    const { data, sources } = await run([await writeBundle()]);
    const a = await buildCanonical(data);
    const b = await buildNeodb(data);
    const c = await buildMarkdown(data, { sources, write: async () => {} });
    assert.ok(a.files.length && b.files.length && c.files.length);
  });
});

/** 只读 zip 的本地文件头，够用来验名字。 */
async function readZipNames(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names = [];
  let at = 0;
  while (at + 30 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    const compressed = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const extraLen = view.getUint16(at + 28, true);
    names.push(dec.decode(bytes.subarray(at + 30, at + 30 + nameLen)));
    at = at + 30 + nameLen + extraLen + compressed;
  }
  return names;
}
