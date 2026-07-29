import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  newBundleId,
  isBundleId,
  captureId,
  parseCaptureId,
  segmentFilename,
  indexFilename,
  bundleDirName,
  bundleIdFromDirName,
  newWarcRecordId,
  SequenceAllocator,
} from '../src/core/ids.js';

describe('bundle_id', () => {
  test('形如 20260728T101500Z-a3f9c1', () => {
    const id = newBundleId(new Date(Date.UTC(2026, 6, 28, 10, 15, 0)));
    assert.match(id, /^20260728T101500Z-[0-9a-f]{6}$/);
    assert.ok(isBundleId(id));
  });

  test('用 UTC 而非本机时区', () => {
    // 若误用本机时间，在非 UTC 机器上跑出来的 id 会与时刻对不上。
    const id = newBundleId(new Date('2026-07-28T10:15:00Z'));
    assert.ok(id.startsWith('20260728T101500Z-'));
  });

  test('按字典序排序即按时间排序', () => {
    const early = newBundleId(new Date('2026-01-01T00:00:00Z'));
    const late = newBundleId(new Date('2026-12-31T23:59:59Z'));
    assert.ok(early < late);
  });

  test('同一时刻的两次调用也不会撞', () => {
    const at = new Date('2026-07-28T10:15:00Z');
    const ids = new Set(Array.from({ length: 200 }, () => newBundleId(at)));
    assert.equal(ids.size, 200);
  });

  test('拒绝格式不对的 id', () => {
    for (const bad of ['', '20260728T101500Z', '20260728T101500Z-XYZ123', 'doubak']) {
      assert.equal(isBundleId(bad), false, `不该接受 ${JSON.stringify(bad)}`);
    }
  });
});

describe('capture_id', () => {
  const BID = '20260728T101500Z-a3f9c1';

  test('零填充到 6 位', () => {
    assert.equal(captureId(BID, 1), `${BID}#000001`);
    assert.equal(captureId(BID, 42), `${BID}#000042`);
    assert.equal(captureId(BID, 999999), `${BID}#999999`);
  });

  test('超过 6 位时自然变长，不截断', () => {
    // 序号是硬上限的话，重度用户（大量图片 + 目录页）会撞墙，
    // 而撞墙的后果是 capture_id 重复——那是规范明令禁止的。
    assert.equal(captureId(BID, 1_000_000), `${BID}#1000000`);
    assert.equal(parseCaptureId(`${BID}#1000000`).seq, 1_000_000);
  });

  test('可往返解析', () => {
    const { bundleId, seq } = parseCaptureId(captureId(BID, 12345));
    assert.equal(bundleId, BID);
    assert.equal(seq, 12345);
  });

  test('拒绝非法输入', () => {
    assert.throws(() => captureId('乱七八糟', 1), /bundle_id 非法/);
    assert.throws(() => captureId(BID, 0), /序号/);
    assert.throws(() => captureId(BID, -1), /序号/);
    assert.throws(() => captureId(BID, 1.5), /序号/);
    assert.throws(() => parseCaptureId(`${BID}#42`), /capture_id 非法/); // 位数不足
    assert.throws(() => parseCaptureId(BID), /capture_id 非法/);
  });
});

describe('文件名', () => {
  const BID = '20260728T101500Z-a3f9c1';

  test('段文件名内嵌 bundle_id —— 多次抓取混放也不会互相覆盖', () => {
    const a = segmentFilename('data', '20260728T101500Z-a3f9c1', 1);
    const b = segmentFilename('data', '20260801T090000Z-ff0011', 1);
    assert.notEqual(a, b);
    assert.equal(a, 'data-20260728T101500Z-a3f9c1-00001.warc.gz');
  });

  test('三种留存等级前缀', () => {
    assert.ok(segmentFilename('data', BID, 1).startsWith('data-'));
    assert.ok(segmentFilename('assets', BID, 1).startsWith('assets-'));
    assert.ok(segmentFilename('catalog', BID, 1).startsWith('catalog-'));
    assert.throws(() => segmentFilename(/** @type {any} */ ('other'), BID, 1), /未知的段类型/);
  });

  test('段序号零填充到 5 位', () => {
    assert.ok(segmentFilename('data', BID, 7).endsWith('-00007.warc.gz'));
    assert.ok(segmentFilename('data', BID, 12345).endsWith('-12345.warc.gz'));
  });

  test('index 与目录名', () => {
    assert.equal(indexFilename(BID), `index-${BID}.ndjson`);
    assert.equal(bundleDirName(BID), `doubak-bundle-${BID}`);
  });
});

describe('WARC-Record-ID', () => {
  test('是 urn:uuid 形式', () => {
    assert.match(
      newWarcRecordId(),
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test('不重复', () => {
    const ids = new Set(Array.from({ length: 500 }, newWarcRecordId));
    assert.equal(ids.size, 500);
  });
});

describe('序号分配器', () => {
  test('从 1 开始单调递增', () => {
    const a = new SequenceAllocator();
    assert.equal(a.next(), 1);
    assert.equal(a.next(), 2);
    assert.equal(a.next(), 3);
    assert.equal(a.last, 3);
  });

  test('可从恢复点继续', () => {
    const a = new SequenceAllocator(12043);
    assert.equal(a.next(), 12044);
  });

  test('崩溃留下的是空洞而不是重复', () => {
    // 模拟：分配 → 写入途中崩溃 → 重启后从「已用到的最大序号」继续。
    // 关键在于 5 号被跳过了（空洞，合法），而没有任何两条记录拿到同一个号。
    const before = new SequenceAllocator();
    const written = [before.next(), before.next(), before.next(), before.next()];
    const allocatedButLost = before.next(); // 5：分配了，写盘前崩了

    const after = new SequenceAllocator(before.last);
    const more = [after.next(), after.next()];

    const all = [...written, ...more];
    assert.deepEqual(all, [1, 2, 3, 4, 6, 7]);
    assert.equal(new Set(all).size, all.length, '不允许出现重复序号');
    assert.ok(!all.includes(allocatedButLost), '5 号应当成为空洞');
  });

  test('拒绝非法起点', () => {
    assert.throws(() => new SequenceAllocator(-1), /startAt/);
    assert.throws(() => new SequenceAllocator(1.5), /startAt/);
  });
});

describe('bundleIdFromDirName', () => {
  test('与 bundleDirName 互为逆运算', () => {
    const id = newBundleId(new Date('2026-07-29T10:15:00Z'));
    assert.equal(bundleIdFromDirName(bundleDirName(id)), id);
  });

  test('不是档案目录一律返回 null', () => {
    // OPFS 根下不止我们的东西，认错一个目录就会去读一份不存在的 manifest。
    for (const bad of [
      'doubak-bundle-',
      'doubak-bundle-不是合法ID',
      'doubak-bundle-2026',
      'bundle-20260729-101500',
      '',
      'tmp',
      `doubak-bundle-${newBundleId()}-extra`,
    ]) {
      assert.equal(bundleIdFromDirName(bad), null, `${JSON.stringify(bad)} 不该被认成档案目录`);
    }
  });

  test('目录名字典序 = 时间序', () => {
    // 「最新的档案排最前」直接靠字典序倒排，不另存时间。bundle_id 以时间戳
    // 打头，这个性质要是破了，档案列表的顺序会静默出错。
    const a = bundleDirName(newBundleId(new Date('2026-01-02T03:04:05Z')));
    const b = bundleDirName(newBundleId(new Date('2026-07-29T10:15:00Z')));
    assert.ok(a < b, `${a} 应当排在 ${b} 之前`);
  });
});
