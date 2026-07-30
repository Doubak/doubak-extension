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
import { kvStoreContract } from '../test/helpers/kv-store-contract.js';
import { IdbKvStore } from '../src/storage/idb-kv-store.js';
import { WorkerFileStore } from '../src/storage/worker-file-store.js';
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

/**
 * 抓取状态的持久化（IndexedDB）。
 *
 * **这是 IdbKvStore 唯一的真实覆盖。** Node 里没有 IndexedDB，所以那边只能测参数
 * 校验，测不到事务语义——而事务语义恰恰是这里最要紧的一点：等的必须是
 * `transaction.oncomplete` 而不是 `request.onsuccess`，因为后者早于真正提交。
 * 写完就以为落盘了、然后进程被杀，那一次写可能根本没提交，而 checkpoint 的全部
 * 意义就是「被杀之后还在」。
 */
async function runIdbKv() {
  const dbName = `doubak-selftest-${Date.now()}`;
  const kv = new IdbKvStore({ dbName });

  await check('抓取状态（IndexedDB）', 'KvStore 契约', () => kvStoreContract(() => kv));

  await check('抓取状态（IndexedDB）', '写完之后换一个实例也读得到', async () => {
    // 这一条才是 checkpoint 真正依赖的性质：写它的上下文（offscreen）和读它的
    // 上下文（service worker）不是同一个，中间还可能隔着一次进程被杀。
    await kv.set('doubak.selftest', { bundleId: 'x', dir: 'y', n: 1 });
    const other = new IdbKvStore({ dbName });
    const got = await other.get('doubak.selftest');
    if (got?.bundleId !== 'x' || got?.n !== 1) {
      throw new Error(`换实例读不到同一份数据：${JSON.stringify(got)}`);
    }
  });

  await check('抓取状态（IndexedDB）', '删掉不存在的键不抛', () => kv.remove('从来没写过'));

  await check('抓取状态（IndexedDB）', '空键被拒绝', async () => {
    let threw = false;
    try {
      await kv.get('');
    } catch {
      threw = true;
    }
    if (!threw) throw new Error('空键该被拒绝');
  });

  // 收拾现场：自检不该留下一个库
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(dbName);
    req.onsuccess = req.onerror = req.onblocked = () => resolve(undefined);
  });
}

/**
 * `WorkerFileStore` ↔ `serveOpfsRpc` 那条 RPC 路径。
 *
 * **这条路径以前一次都没被端到端跑过。** Node 测试用 `MemoryFileStore`，
 * 之前的自检直接用 `OpfsFileStore`——而抓取真正走的是 RPC。中间那一层（结构化
 * 克隆、buffer 转移、句柄串行化）因此完全没有覆盖。
 *
 * 代价已经付过了：写入路径上转移了 buffer 所有权，把调用方还要用的数据 detach
 * 掉，表现是「写入档案时出错」然后整场停机。跑一遍契约就能抓到。
 *
 * 这里用**真的** Worker，不是替身——要测的正是那条边界。
 */
async function runRpcContract() {
  const worker = new Worker(new URL('../src/storage/opfs-rw-worker.js', import.meta.url), {
    type: 'module',
  });
  const dir = `doubak-bundle-rpc-${Date.now()}`;
  const store = new WorkerFileStore({ worker, dir, readOnly: false });

  const cases = fileStoreContract();
  let passed = 0;
  for (const c of cases) {
    try {
      await c.fn(store);
      passed += 1;
      post({ type: 'case', group: 'FileStore 契约（经由 RPC）', name: c.name, ok: true });
    } catch (e) {
      post({ type: 'case', group: 'FileStore 契约（经由 RPC）', name: c.name, ok: false, error: e.message });
    }
  }

  await check('RPC 路径', '写入之后调用方的 bytes 还能用', async () => {
    // 转移过 buffer 所有权，然后撤了。`postMessage` 转移的是**整个 ArrayBuffer**，
    // 而传进来的 Uint8Array 完全可能只是某个更大 buffer 上的视图——转移它等于把
    // 调用方还要用的数据一起 detach 掉。detach 之后 length 变成 0，**没有异常**，
    // 数据悄悄空了。
    const buf = new Uint8Array(64);
    for (let i = 0; i < buf.length; i++) buf[i] = i;
    const view = buf.subarray(8, 24);

    await store.append('detach-test', view);
    if (view.length !== 16) throw new Error(`调用方的视图被 detach 了：length=${view.length}`);
    if (buf[8] !== 8) throw new Error('调用方的底层 buffer 被动过了');

    // 同一份字节再写一次也必须成立
    await store.append('detach-test', view);
    if (await store.size('detach-test') !== 32) throw new Error('第二次写没成');
  });

  await check('RPC 路径', '同一文件上的并发写不会撞句柄', async () => {
    // OPFS 的同步访问句柄是独占的。RPC 消息并发到达，两条针对同一文件的操作会
    // 重叠——不串行化的话必然一方抛 NoModificationAllowedError。
    const chunk = new Uint8Array([1, 2, 3, 4]);
    await Promise.all(Array.from({ length: 20 }, () => store.append('concurrent', chunk)));
    const size = await store.size('concurrent');
    if (size !== 80) throw new Error(`并发写丢了数据：期望 80 字节，实得 ${size}`);
  });

  await check('RPC 路径', '只读 Worker 拒绝写', async () => {
    const ro = new Worker(new URL('../src/storage/opfs-worker.js', import.meta.url), { type: 'module' });
    // 客户端标成可写，让请求真的发出去——要验的是 **Worker 一侧**的拒绝。
    const sneaky = new WorkerFileStore({ worker: ro, dir, readOnly: false });
    let threw = false;
    try {
      await sneaky.append('should-not-exist', new Uint8Array([1]));
    } catch (e) {
      threw = /只读/.test(e.message);
    }
    ro.terminate();
    if (!threw) throw new Error('只读 Worker 居然接受了写操作');
  });

  worker.terminate();
  await OpfsFileStore.destroy(dir);
  return { passed, total: cases.length };
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

    await runIdbKv();

    const rpc = await runRpcContract();
    post({ type: 'note', text: `FileStore 契约（经由 RPC）：${rpc.passed}/${rpc.total} 通过` });

    const ctx = await runWriter();
    await runRecovery(ctx);
    await OpfsFileStore.destroy(ctx.dir);

    await runThroughput();

    post({ type: 'done' });
  } catch (err) {
    post({ type: 'fatal', error: `${err?.message}\n${err?.stack ?? ''}` });
  }
};
