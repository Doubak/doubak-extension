/**
 * 自检 Worker：在真实浏览器里验证 OPFS 与整条 bundle 写入链路。
 *
 * 为什么必须是 Worker：OPFS 的原地读写 `createSyncAccessHandle()` 只能在
 * Worker 里用（见 src/storage/opfs-store.js 的说明）。这也正是生产环境的
 * 形态，所以这里测的就是真实路径。
 *
 * TODO(开发期): 整个 selftest/ 目录是开发工具，正式发布前从打包产物里排除。
 */

import { OpfsFileStore } from '../src/storage/opfs-store.js';
import { fileStoreContract } from '../test/helpers/file-store-contract.js';
import { BundleWriter } from '../src/bundle/bundle-writer.js';
import { coverageEntry, crawlStateEntry } from '../src/bundle/manifest-builder.js';
import { recoverBundle } from '../src/bundle/recovery.js';
import { gunzip } from '../src/core/warc.js';
import { parseDoubanTimestamp } from '../src/core/time.js';
import { indexFilename } from '../src/core/ids.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** @param {object} msg */
function post(msg) {
  self.postMessage(msg);
}

/** @param {string} dirName */
async function freshStore(dirName) {
  await OpfsFileStore.destroy(dirName);
  return OpfsFileStore.open(dirName);
}

/** 逐条跑 FileStore 契约。 */
async function runContract() {
  const cases = fileStoreContract();
  let passed = 0;
  for (const [i, c] of cases.entries()) {
    const dir = `doubak-selftest-contract-${i}`;
    try {
      const store = await freshStore(dir);
      await c.fn(store);
      passed += 1;
      post({ type: 'case', group: 'FileStore 契约（OPFS）', name: c.name, ok: true });
    } catch (e) {
      post({ type: 'case', group: 'FileStore 契约（OPFS）', name: c.name, ok: false, error: e.message });
    } finally {
      await OpfsFileStore.destroy(dir);
    }
  }
  return { total: cases.length, passed };
}

/** @param {object} [over] */
function capture(over = {}) {
  return {
    url: 'https://www.douban.com/people/82160871/statuses?p=1&_spm_id=ODIx',
    intent: 'broadcast.timeline',
    routeKey: 'broadcast.timeline',
    surface: 'html',
    verdict: 'ok',
    captureFidelity: 'decoded_body+observed_headers',
    body: enc.encode('<html><div class="status-item">看过《银翼杀手》</div></html>'),
    httpStatus: 200,
    headers: [['Content-Type', 'text/html; charset=utf-8']],
    contentType: 'text/html; charset=utf-8',
    ...over,
  };
}

/** @param {string} group @param {string} name @param {() => Promise<void>} fn */
async function check(group, name, fn) {
  try {
    await fn();
    post({ type: 'case', group, name, ok: true });
    return true;
  } catch (e) {
    post({ type: 'case', group, name, ok: false, error: e.message });
    return false;
  }
}

/** 在 OPFS 上真正跑一遍 bundle 写入器。 */
async function runWriter() {
  const G = 'bundle 写入器（跑在 OPFS 上）';
  const dir = 'doubak-selftest-writer';
  const store = await freshStore(dir);
  const writer = new BundleWriter({ store, account: { user_id: '82160871', username: 'selftest' } });
  /** @type {any[]} */
  const locs = [];

  await check(G, '写入 20 条捕获（含三种留存等级）', async () => {
    for (let i = 0; i < 18; i++) locs.push(await writer.writeCapture(capture()));
    locs.push(await writer.writeCapture(capture({ kind: 'assets', intent: 'asset.image.user_upload' })));
    locs.push(await writer.writeCapture(capture({ kind: 'catalog', intent: 'interest.item' })));
    if (locs.length !== 20) throw new Error(`只写了 ${locs.length} 条`);
  });

  await check(G, '按 offset/length 能取回并解压每一条记录', async () => {
    for (const loc of locs) {
      const member = await store.read(loc.segment, loc.offset, loc.length);
      const record = dec.decode(await gunzip(member));
      if (!record.includes('WARC-Type: response')) throw new Error(`${loc.captureId} 解出来不是 response 记录`);
    }
  });

  await check(G, 'finalize 产出 manifest 与 README', async () => {
    const hw = parseDoubanTimestamp('2026-07-26 12:34:00');
    writer.addCoverage(
      coverageEntry({
        routeKey: 'broadcast.timeline',
        intent: 'broadcast.timeline',
        claimedCount: null,
        capturedCount: 18,
      }),
    );
    writer.addCrawlState(
      crawlStateEntry({
        routeKey: 'broadcast.timeline',
        intent: 'broadcast.timeline',
        highWaterTime: hw.iso,
        highWaterRaw: hw.raw,
        floorTime: null,
        enumeration: 'bounded',
        contiguous: true,
        advanced: true,
        bundleId: writer.bundleId,
      }),
    );
    const manifest = await writer.finalize();
    if (manifest.index.line_count !== 20) throw new Error('index 行数不对');
    if (!(await store.exists('README.txt'))) throw new Error('缺 README.txt');
  });

  await check(G, '段文件真的落在 OPFS 上且体积非零', async () => {
    const files = await store.list();
    const segs = files.filter((f) => f.endsWith('.warc.gz'));
    if (segs.length < 3) throw new Error(`段文件只有 ${segs.length} 个，应当三种等级各一`);
    for (const s of segs) {
      if ((await store.size(s)) === 0) throw new Error(`${s} 是空的`);
    }
  });

  return { store, writer, dir };
}

/** 在 OPFS 上验证崩溃恢复。 */
async function runRecovery(ctx) {
  const G = '崩溃恢复（跑在 OPFS 上）';
  const { store, writer } = ctx;
  const bundleId = writer.bundleId;

  await check(G, '自洽的 bundle 恢复是空操作', async () => {
    const res = await recoverBundle({ store, bundleId });
    if (res.repairs.length !== 0) throw new Error(`不该有修复，实际 ${JSON.stringify(res.repairs)}`);
    if (res.lastSeq !== 20) throw new Error(`lastSeq 应为 20，实际 ${res.lastSeq}`);
  });

  await check(G, '段尾撕裂 + index 半行 能被修好', async () => {
    const segs = (await store.list()).filter((f) => f.startsWith('data-'));
    await store.append(segs.at(-1), new Uint8Array(137).fill(0xab));
    await store.append(indexFilename(bundleId), enc.encode('{"capture_id":"半'));

    const res = await recoverBundle({ store, bundleId });
    const kinds = res.repairs.map((r) => r.kind).sort().join(',');
    if (kinds !== 'index_partial_line,segment_tail') {
      throw new Error(`修复种类不对：${kinds}`);
    }
    if ((await recoverBundle({ store, bundleId })).repairs.length !== 0) {
      throw new Error('恢复不是幂等的');
    }
  });

  await check(G, '恢复后可续写且序号不重复', async () => {
    const res = await recoverBundle({ store, bundleId });
    const w2 = new BundleWriter({
      store,
      account: { user_id: '82160871' },
      bundleId,
      startSeq: res.lastSeq,
      resume: res.resume,
    });
    await w2.writeCapture(capture());

    const text = dec.decode(await store.read(indexFilename(bundleId)));
    const ids = text.trimEnd().split('\n').map((l) => JSON.parse(l).capture_id);
    if (new Set(ids).size !== ids.length) throw new Error('出现了重复的 capture_id');
  });
}

/** 体量与吞吐的粗略实测：写 64 MB，看耗时。 */
async function runThroughput() {
  const G = '吞吐（真实档案是几百 MB 级）';
  const dir = 'doubak-selftest-throughput';
  const store = await freshStore(dir);

  await check(G, '连续写入 64 MB', async () => {
    const chunk = new Uint8Array(256 * 1024).fill(0x5a);
    const t0 = performance.now();
    for (let i = 0; i < 256; i++) await store.append('big.bin', chunk);
    const ms = performance.now() - t0;
    const size = await store.size('big.bin');
    if (size !== 64 * 1024 * 1024) throw new Error(`大小不对：${size}`);
    post({
      type: 'note',
      text: `写入 64 MB 用时 ${ms.toFixed(0)} ms（约 ${(64 / (ms / 1000)).toFixed(1)} MB/s）。` +
        `每次 append 都开关一次 sync access handle，这是已知的可优化点。`,
    });
  });

  await OpfsFileStore.destroy(dir);
}

self.onmessage = async (e) => {
  if (e.data !== 'run') return;
  try {
    post({ type: 'note', text: `Worker 启动，OPFS ${navigator.storage?.getDirectory ? '可用' : '不可用'}` });

    const contract = await runContract();
    post({ type: 'note', text: `FileStore 契约：${contract.passed}/${contract.total} 通过` });

    const ctx = await runWriter();
    await runRecovery(ctx);
    await OpfsFileStore.destroy(ctx.dir);

    await runThroughput();

    post({ type: 'done' });
  } catch (err) {
    post({ type: 'fatal', error: `${err?.message}\n${err?.stack ?? ''}` });
  }
};
