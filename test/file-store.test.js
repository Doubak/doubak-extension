import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryFileStore } from '../src/storage/file-store.js';
import { fileStoreContract } from './helpers/file-store-contract.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// 契约测试：同一组断言也会在浏览器里跑在 OpfsFileStore 上（见 selftest/）。
// 两个实现必须行为一致，否则 Node 里的测试是在为一件不会真实发生的事背书。
describe('FileStore 契约（MemoryFileStore）', () => {
  for (const c of fileStoreContract()) {
    test(c.name, async () => {
      await c.fn(new MemoryFileStore());
    });
  }
});

/** @type {MemoryFileStore} */
let store;
beforeEach(() => {
  store = new MemoryFileStore();
});

describe('追加', () => {
  test('文件不存在时创建', async () => {
    await store.append('a.warc.gz', enc.encode('第一段'));
    assert.equal(dec.decode(await store.read('a.warc.gz')), '第一段');
  });

  test('多次追加首尾相接', async () => {
    await store.append('a', enc.encode('一'));
    await store.append('a', enc.encode('二'));
    await store.append('a', enc.encode('三'));
    assert.equal(dec.decode(await store.read('a')), '一二三');
  });

  test('size 就是下一条记录的偏移量', async () => {
    // 段写入器完全依赖这一点：写之前先问 size，那就是这条记录的 offset。
    assert.equal(await store.size('a'), 0);

    const first = enc.encode('第一条记录');
    await store.append('a', first);
    assert.equal(await store.size('a'), first.length);

    const second = enc.encode('第二条');
    const offsetOfSecond = await store.size('a');
    await store.append('a', second);

    assert.deepEqual(await store.read('a', offsetOfSecond, second.length), second);
  });

  test('追加后不共享底层缓冲 —— 调用方改自己的数组不该影响已写内容', async () => {
    const buf = enc.encode('原始');
    await store.append('a', buf);
    buf[0] = 0x41;
    assert.equal(dec.decode(await store.read('a')), '原始');
  });

  test('拒绝非 Uint8Array', async () => {
    await assert.rejects(() => store.append('a', /** @type {any} */ ('字符串')), /Uint8Array/);
  });
});

describe('替换', () => {
  test('整体覆盖，用于 manifest 与 checkpoint', async () => {
    await store.append('manifest.json', enc.encode('{"v":1}'));
    await store.replace('manifest.json', enc.encode('{"v":2}'));
    assert.equal(dec.decode(await store.read('manifest.json')), '{"v":2}');
  });

  test('文件不存在时也能替换', async () => {
    await store.replace('new.json', enc.encode('x'));
    assert.equal(await store.size('new.json'), 1);
  });
});

describe('读取', () => {
  beforeEach(async () => {
    await store.append('a', enc.encode('0123456789'));
  });

  test('不给范围则读全文', async () => {
    assert.equal(dec.decode(await store.read('a')), '0123456789');
  });

  test('按 offset/length 读 —— index.ndjson 记的就是这两个数', async () => {
    assert.equal(dec.decode(await store.read('a', 3, 4)), '3456');
    assert.equal(dec.decode(await store.read('a', 0, 1)), '0');
    assert.equal(dec.decode(await store.read('a', 9, 1)), '9');
  });

  test('只给 offset 则读到末尾', async () => {
    assert.equal(dec.decode(await store.read('a', 7)), '789');
  });

  test('越界读取要抛，不能悄悄返回短数据', async () => {
    // 悄悄截短会让崩溃恢复读到一段「看起来完整」的字节。
    await assert.rejects(() => store.read('a', 5, 10), /越界/);
    await assert.rejects(() => store.read('a', 11, 1), /越界/);
    await assert.rejects(() => store.read('a', -1, 2), /越界/);
  });

  test('文件不存在要抛', async () => {
    await assert.rejects(() => store.read('nope'), /文件不存在/);
  });

  test('读出来的是副本，改它不影响存储', async () => {
    const got = await store.read('a');
    got[0] = 0x5a;
    assert.equal(dec.decode(await store.read('a')), '0123456789');
  });
});

describe('截断 —— 崩溃恢复的核心操作', () => {
  beforeEach(async () => {
    await store.append('seg', enc.encode('0123456789'));
  });

  test('切到指定长度', async () => {
    await store.truncate('seg', 4);
    assert.equal(dec.decode(await store.read('seg')), '0123');
    assert.equal(await store.size('seg'), 4);
  });

  test('可以截到 0', async () => {
    await store.truncate('seg', 0);
    assert.equal(await store.size('seg'), 0);
    assert.equal(await store.exists('seg'), true, '截到 0 不等于删除');
  });

  test('拒绝「截断」到比现有更长 —— 那是补零扩展，不是截断', async () => {
    // 允许的话会在段文件里悄悄插入合法的零字节，而崩溃恢复恰恰依赖
    // 「尾部要么是完整的 gzip member，要么解压失败」这个性质。
    await assert.rejects(() => store.truncate('seg', 20), /大于文件长度/);
  });

  test('拒绝非法长度', async () => {
    await assert.rejects(() => store.truncate('seg', -1), />=0/);
    await assert.rejects(() => store.truncate('seg', 1.5), />=0/);
  });

  test('文件不存在要抛', async () => {
    await assert.rejects(() => store.truncate('nope', 0), /文件不存在/);
  });

  test('截断后继续追加，偏移量从新长度接上', async () => {
    // 崩溃恢复之后就是这个流程：切掉撕裂的尾巴，然后接着写。
    await store.truncate('seg', 4);
    const resumeOffset = await store.size('seg');
    await store.append('seg', enc.encode('ABC'));

    assert.equal(resumeOffset, 4);
    assert.equal(dec.decode(await store.read('seg')), '0123ABC');
    assert.equal(dec.decode(await store.read('seg', resumeOffset, 3)), 'ABC');
  });
});

describe('存在性与枚举', () => {
  test('exists', async () => {
    assert.equal(await store.exists('a'), false);
    await store.append('a', enc.encode('x'));
    assert.equal(await store.exists('a'), true);
  });

  test('list 按字典序 —— 段文件名带零填充序号，因此即时间序', async () => {
    await store.append('data-B-00002.warc.gz', enc.encode('x'));
    await store.append('data-B-00001.warc.gz', enc.encode('x'));
    await store.append('data-A-00010.warc.gz', enc.encode('x'));
    assert.deepEqual(await store.list(), [
      'data-A-00010.warc.gz',
      'data-B-00001.warc.gz',
      'data-B-00002.warc.gz',
    ]);
  });

  test('remove 对不存在的文件静默通过', async () => {
    await store.remove('nope');
    await store.append('a', enc.encode('x'));
    await store.remove('a');
    assert.equal(await store.exists('a'), false);
  });
});

describe('文件名校验', () => {
  test('拒绝路径分隔符 —— 挡住拼接错误导致的路径穿越', async () => {
    for (const bad of ['a/b', 'a\\b', '../x', '.', '..']) {
      await assert.rejects(
        () => store.append(bad, enc.encode('x')),
        /路径分隔符|不能为空/,
        `不该接受 ${JSON.stringify(bad)}`,
      );
    }
  });

  test('拒绝空名', async () => {
    await assert.rejects(() => store.append('', enc.encode('x')), /不能为空/);
    await assert.rejects(() => store.size(/** @type {any} */ (null)), /不能为空/);
  });
});

describe('辅助方法', () => {
  test('snapshot 返回全部文件的副本', async () => {
    await store.append('a', enc.encode('一'));
    await store.append('b', enc.encode('二'));

    const snap = store.snapshot();
    assert.deepEqual(Object.keys(snap).sort(), ['a', 'b']);

    snap.a[0] = 0x41;
    assert.equal(dec.decode(await store.read('a')), '一', 'snapshot 应当是副本');
  });

  test('totalBytes 汇总所有文件', async () => {
    await store.append('a', new Uint8Array(100));
    await store.append('b', new Uint8Array(50));
    assert.equal(store.totalBytes(), 150);
  });
});
