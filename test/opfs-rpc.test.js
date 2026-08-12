/**
 * OPFS 的三个入口各自能做什么。
 *
 * ## 为什么这份要单独存在
 *
 * 「写 OPFS 只该有一条路径」原来是靠**只有两个 worker 入口文件**来保证的——
 * 想破坏它得先新建一个文件，那足够显眼。导入把第三个入口摆上了台面，于是这条
 * 规矩第一次需要被真的检查：导入模式到底能不能碰到已有的档案。
 *
 * 这里验的正是那一句：**导入只能新建文件，碰不到任何已经在那儿的字节。**
 * 它必须在 worker 一侧成立——客户端那层只是约定，改一行就没了。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { handleOpfsRpc } from '../src/storage/opfs-rpc.js';
import { MemoryFileStore } from '../src/storage/file-store.js';

/** 一套跑在内存上的 RPC 环境，与生产共用同一个 `handleOpfsRpc`。 */
function env({ allowWrites = false, importOnly = false, dirs = new Map() } = {}) {
  const claimed = new Set();
  const owned = new Set();
  const storeFor = async (dir) => {
    if (!dirs.has(dir)) dirs.set(dir, new MemoryFileStore());
    return dirs.get(dir);
  };
  const call = (msg) => handleOpfsRpc(msg, {
    allowWrites,
    importOnly,
    storeFor,
    claimed,
    owned,
    listDirs: async () => [...dirs.keys()],
    destroyDir: async (d) => { dirs.delete(d); },
  });
  return { call, dirs, claimed, owned };
}

const bytes = new Uint8Array([1, 2, 3]);

describe('只读入口（面板看档案、导出）', () => {
  test('读得了', async () => {
    const dirs = new Map([['a', new MemoryFileStore()]]);
    await dirs.get('a').replace('x', bytes);
    const { call } = env({ dirs });
    assert.deepEqual((await call({ op: 'read', dir: 'a', name: 'x' })).result, bytes);
  });

  test('一切写操作都拒', async () => {
    const { call } = env();
    for (const op of ['append', 'replace', 'truncate', 'remove', 'destroy']) {
      await assert.rejects(() => call({ op, dir: 'a', name: 'x', bytes, length: 0 }), /只读/,
        `${op} 没被拒 —— 面板不该有写 OPFS 的能力`);
    }
  });
});

describe('导入入口', () => {
  test('**新建文件可以**', async () => {
    const { call, dirs } = env({ allowWrites: true, importOnly: true });
    await call({ op: 'append', dir: 'doubak-bundle-x', name: 'seg', bytes });
    assert.deepEqual(await dirs.get('doubak-bundle-x').read('seg'), bytes);
  });

  test('同一份文件的后续分块照写 —— 导入是按块流式复制的', async () => {
    const { call, dirs } = env({ allowWrites: true, importOnly: true });
    await call({ op: 'append', dir: 'a', name: 'seg', bytes });
    await call({ op: 'append', dir: 'a', name: 'seg', bytes });
    assert.equal(await dirs.get('a').size('seg'), 6);
  });

  test('**已经存在的文件碰不到** —— 这是「绝不覆盖已有档案」的实际执行处', async () => {
    const dirs = new Map([['doubak-bundle-x', new MemoryFileStore()]]);
    await dirs.get('doubak-bundle-x').replace('manifest.json', bytes);
    const { call } = env({ allowWrites: true, importOnly: true, dirs });

    for (const op of ['append', 'replace', 'remove']) {
      await assert.rejects(
        () => call({ op, dir: 'doubak-bundle-x', name: 'manifest.json', bytes }),
        /不覆盖已经存在的/,
        `${op} 没被拒 —— 它能改掉一份已有档案里的字节`,
      );
    }
    assert.deepEqual(await dirs.get('doubak-bundle-x').read('manifest.json'), bytes,
      '已有档案的内容被动过了');
  });

  test('**往已有档案里补缺的文件可以** —— 那正是续传，而它不碰任何已有字节', async () => {
    // 「只能往空目录里写」那条规矩会把这种情况一起挡掉，逼用户先删掉半份档案 ——
    // 而那恰恰是最不该让用户去做的操作。
    const dirs = new Map([['doubak-bundle-x', new MemoryFileStore()]]);
    await dirs.get('doubak-bundle-x').replace('index-x.ndjson', bytes);
    const { call } = env({ allowWrites: true, importOnly: true, dirs });

    await call({ op: 'append', dir: 'doubak-bundle-x', name: 'pages-x-00001.warc.gz', bytes });
    assert.deepEqual(await dirs.get('doubak-bundle-x').read('pages-x-00001.warc.gz'), bytes);
    assert.deepEqual(await dirs.get('doubak-bundle-x').read('index-x.ndjson'), bytes,
      '补文件的时候把原来那个也动了');
  });

  test('**truncate 永远拒**，哪怕是自己刚建的文件', async () => {
    // 它是唯一能改变已写入字节位置的操作，而索引里每一条都记着 offset+length。
    // 导入自己也不需要它 —— 它只新建文件。
    const { call } = env({ allowWrites: true, importOnly: true });
    await call({ op: 'append', dir: 'a', name: 'seg', bytes });
    await assert.rejects(() => call({ op: 'truncate', dir: 'a', name: 'seg', length: 0 }),
      /不接受 truncate/);
  });

  test('半路失败要能回滚，所以**从零建起来的**目录允许 destroy', async () => {
    const { call, dirs } = env({ allowWrites: true, importOnly: true });
    const claim = await call({ op: 'claimForImport', dir: 'a' });
    assert.deepEqual(claim.result, { fresh: true, files: 0 });
    await call({ op: 'append', dir: 'a', name: 'x', bytes });
    await call({ op: 'destroy', dir: 'a' });
    assert.equal(dirs.has('a'), false);
  });

  test('**本来就有东西的目录 destroy 不了** —— 那会变成一条删档案的旁路', async () => {
    const dirs = new Map([['doubak-bundle-x', new MemoryFileStore()]]);
    await dirs.get('doubak-bundle-x').replace('manifest.json', bytes);
    const { call } = env({ allowWrites: true, importOnly: true, dirs });

    const claim = await call({ op: 'claimForImport', dir: 'doubak-bundle-x' });
    assert.equal(claim.result.fresh, false, '非空目录不该被认成「我从零建的」');
    await assert.rejects(() => call({ op: 'destroy', dir: 'doubak-bundle-x' }), /不是这次导入/);
    assert.equal(dirs.has('doubak-bundle-x'), true);
  });
});

describe('抓取入口', () => {
  test('该能写的都能写，而且不需要认领', async () => {
    const { call, dirs } = env({ allowWrites: true });
    await call({ op: 'append', dir: 'a', name: 'seg', bytes });
    await call({ op: 'truncate', dir: 'a', name: 'seg', length: 1 });
    assert.equal(await dirs.get('a').size('seg'), 1);
  });

  test('claimForImport 只属于导入模式', async () => {
    const { call } = env({ allowWrites: true });
    await assert.rejects(() => call({ op: 'claimForImport', dir: 'a' }), /只用于导入模式/);
  });
});
