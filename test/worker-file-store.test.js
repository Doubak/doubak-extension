/**
 * 窗口 ↔ Worker 的 RPC 客户端。
 *
 * 这一层没有浏览器专有 API——它只是收发 `postMessage`。所以拿一个假的
 * Worker（照着真 Worker 的事件接口）就能完整测，包括那些在真实浏览器里
 * 极难复现的错法：编号串了、Worker 挂了、两个实例抢同一条通道。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { WorkerFileStore } from '../src/storage/worker-file-store.js';
import { MemoryFileStore } from '../src/storage/file-store.js';

/**
 * 一个假的 Worker：照着真 Worker 那一侧的逻辑，把请求转给内存 store。
 *
 * @param {Record<string, MemoryFileStore>} dirs
 */
function fakeWorker(dirs, { delay = 0 } = {}) {
  /** @type {Set<Function>} */
  const onMessage = new Set();
  /** @type {Set<Function>} */
  const onError = new Set();

  return {
    seen: [],
    _onMessage: onMessage,
    addEventListener(type, fn) {
      (type === 'message' ? onMessage : onError).add(fn);
    },
    async postMessage(msg) {
      this.seen.push(msg);
      const { id, op, dir, name, offset, length } = msg;
      let reply;
      try {
        let result;
        if (op === 'listBundleDirs') result = Object.keys(dirs).sort().reverse();
        else if (op === 'list') result = await dirs[dir].list();
        else if (op === 'size') result = await dirs[dir].size(name);
        else if (op === 'exists') result = await dirs[dir].exists(name);
        else if (op === 'read') result = await dirs[dir].read(name, offset, length);
        else if (op === 'append') result = await dirs[dir].append(name, msg.bytes);
        else if (op === 'replace') result = await dirs[dir].replace(name, msg.bytes);
        else if (op === 'truncate') result = await dirs[dir].truncate(name, length);
        else if (op === 'remove') result = await dirs[dir].remove(name);
        else throw new Error(`未知操作：${op}`);
        reply = { id, ok: true, result };
      } catch (e) {
        reply = { id, ok: false, error: String(e.message) };
      }
      if (delay) await new Promise((r) => setTimeout(r, delay));
      for (const fn of onMessage) fn({ data: reply });
    },
    crash(message) {
      for (const fn of onError) fn({ message, type: 'error' });
    },
  };
}

const enc = new TextEncoder();

async function bundleDir() {
  const s = new MemoryFileStore();
  await s.replace('index.ndjson', enc.encode('{"a":1}\n'));
  await s.replace('data-000001.warc.gz', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  return s;
}

describe('WorkerFileStore', () => {
  test('读、大小、存在、列目录都转发过去', async () => {
    const worker = fakeWorker({ 'doubak-bundle-A': await bundleDir() });
    const s = new WorkerFileStore({ worker, dir: 'doubak-bundle-A' });

    assert.deepEqual(await s.list(), ['data-000001.warc.gz', 'index.ndjson']);
    assert.equal(await s.size('index.ndjson'), 8);
    assert.equal(await s.exists('index.ndjson'), true);
    assert.equal(await s.exists('没有这个'), false);
    assert.deepEqual(await s.read('data-000001.warc.gz'), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  });

  test('范围读原样传过去——导出就靠它把峰值内存钉在一块', async () => {
    const worker = fakeWorker({ 'doubak-bundle-A': await bundleDir() });
    const s = new WorkerFileStore({ worker, dir: 'doubak-bundle-A' });

    assert.deepEqual(await s.read('data-000001.warc.gz', 2, 3), new Uint8Array([3, 4, 5]));
    const req = worker.seen.at(-1);
    assert.equal(req.offset, 2);
    assert.equal(req.length, 3);
  });

  test('两个实例共用一个 Worker，答复不会串门', async () => {
    // 编号要是每个实例各数各的，两边会发出同号请求，而答复只按号找人——
    // 于是 A 拿到 B 的字节。这种错不抛异常，只会让你看到别的档案的内容。
    const a = new MemoryFileStore();
    await a.replace('f', enc.encode('AAA'));
    const b = new MemoryFileStore();
    await b.replace('f', enc.encode('BBB'));

    const worker = fakeWorker({ 'doubak-bundle-A': a, 'doubak-bundle-B': b }, { delay: 1 });
    const sa = new WorkerFileStore({ worker, dir: 'doubak-bundle-A' });
    const sb = new WorkerFileStore({ worker, dir: 'doubak-bundle-B' });

    const [ra, rb] = await Promise.all([sa.read('f'), sb.read('f')]);
    assert.equal(new TextDecoder().decode(ra), 'AAA');
    assert.equal(new TextDecoder().decode(rb), 'BBB');

    const ids = worker.seen.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, '两个实例发出了同号请求');
  });

  test('后建的实例不会把先建的处理器顶掉', async () => {
    // 用 onmessage（独占）而不是 addEventListener 的话，先建的那个 store
    // 从此永远收不到答复，界面停在「正在读取…」。
    const worker = fakeWorker({ 'doubak-bundle-A': await bundleDir() });
    const first = new WorkerFileStore({ worker, dir: 'doubak-bundle-A' });
    new WorkerFileStore({ worker, dir: 'doubak-bundle-A' });

    assert.equal(await first.size('index.ndjson'), 8);
  });

  test('Worker 侧的错误变成拒绝，带得上原因', async () => {
    const worker = fakeWorker({ 'doubak-bundle-A': await bundleDir() });
    const s = new WorkerFileStore({ worker, dir: 'doubak-bundle-A' });
    await assert.rejects(() => s.read('不存在的文件'), /文件不存在/);
  });

  test('Worker 挂掉：在飞的请求全部拒绝，不许永远悬着', async () => {
    // 不主动拒绝的话界面会永远停在「正在读取…」，比报错难查得多。
    const worker = fakeWorker({ 'doubak-bundle-A': await bundleDir() }, { delay: 50 });
    const s = new WorkerFileStore({ worker, dir: 'doubak-bundle-A' });

    const p = s.read('index.ndjson');
    worker.crash('OPFS 没了');
    await assert.rejects(() => p, /存储 Worker 出错.*OPFS 没了/);
  });

  test('默认只读：写操作一律抛，且一个消息都不发', async () => {
    // 静默的空实现会让「为什么没写进去」变成一次漫长的排查。
    // 「不发消息」也要验：发出去再被拒绝，等于把一条本可以在客户端就挡住的
    // 错误变成一次往返。
    const worker = fakeWorker({ 'doubak-bundle-A': await bundleDir() });
    const s = new WorkerFileStore({ worker, dir: 'doubak-bundle-A' });

    for (const op of ['append', 'replace', 'truncate', 'remove']) {
      assert.throws(() => s[op]('f', new Uint8Array(1)), /只读/, `${op} 该抛`);
    }
    assert.equal(worker.seen.length, 0, '写操作不该发出任何消息');
  });

  test('readOnly:false 时写操作真的转发过去', async () => {
    const dir = await bundleDir();
    const worker = fakeWorker({ 'doubak-bundle-A': dir });
    const s = new WorkerFileStore({ worker, dir: 'doubak-bundle-A', readOnly: false });

    await s.append('新文件', enc.encode('abc'));
    assert.equal(new TextDecoder().decode(await dir.read('新文件')), 'abc');
  });

  test('错误的 name 会被还原 —— 上层要靠它认出配额耗尽', async () => {
    // Error 本身跨不过 postMessage。只传 message 的话，QuotaExceededError 会
    // 退化成一个普通错误，于是「磁盘满了」被显示成「未知错误」。
    const worker = fakeWorker({});
    worker.postMessage = async function (msg) {
      this.seen.push(msg);
      for (const fn of this._onMessage) {
        fn({ data: { id: msg.id, ok: false, error: '满了', errorName: 'QuotaExceededError' } });
      }
    };
    const s = new WorkerFileStore({ worker, dir: 'd', readOnly: false });
    await assert.rejects(() => s.append('f', enc.encode('x')), (e) => {
      assert.equal(e.name, 'QuotaExceededError');
      return true;
    });
  });

  test('listBundleDirs 不需要先绑定某一份档案', async () => {
    const worker = fakeWorker({
      'doubak-bundle-A': await bundleDir(),
      'doubak-bundle-B': await bundleDir(),
    });
    assert.deepEqual(await WorkerFileStore.listBundleDirs(worker), [
      'doubak-bundle-B',
      'doubak-bundle-A',
    ]);
  });
});
