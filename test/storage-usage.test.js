/**
 * 存储用量与「能不能删」的判断。
 *
 * 删档案不可逆，而且没有回收站——OPFS 里那份可能是用户唯一的副本。所以这套判断
 * 全部做成纯函数放在 Node 里测，不混在只能靠肉眼看的界面代码里。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeBundles, checkDeletable, totalBytes, hasUnexported, exportedKey, EXPORTED_KEY_PREFIX,
} from '../src/storage/storage-usage.js';

const A = '20260730T010000Z-aaaaaa';
const B = '20260730T020000Z-bbbbbb';

/** @param {string} id @param {Array<[string, number]>} files */
function dir(id, files) {
  return {
    bundleId: id,
    dir: `doubak-bundle-${id}`,
    files: files.map(([name, bytes]) => ({ name, bytes })),
  };
}

describe('汇总', () => {
  test('体积是目录里所有文件之和', () => {
    const [u] = summarizeBundles({
      dirs: [dir(A, [['data-000001.warc.gz', 1000], ['index.ndjson', 24], ['manifest.json', 500]])],
    });
    assert.equal(u.bytes, 1524);
    assert.equal(u.files, 3);
    assert.equal(u.hasManifest, true);
  });

  test('没有 manifest = 还没收尾', () => {
    const [u] = summarizeBundles({ dirs: [dir(A, [['index.ndjson', 24]])] });
    assert.equal(u.hasManifest, false);
  });

  test('新的排在前面', () => {
    // bundle_id 以时间戳打头，所以倒序即最新在前。
    const us = summarizeBundles({ dirs: [dir(A, []), dir(B, [])] });
    assert.deepEqual(us.map((u) => u.bundleId), [B, A]);
  });
});

describe('正在抓的那份绝不许删', () => {
  test('active 的不可删，并说出原因', () => {
    // 删了它，写入器下一次落盘就会往一个不存在的目录里写——而抓取正跑在几小时的
    // 中途。
    const us = summarizeBundles({
      dirs: [dir(A, [['index.ndjson', 1]]), dir(B, [['index.ndjson', 1]])],
      activeBundleId: A,
    });
    const a = us.find((u) => u.bundleId === A);
    const b = us.find((u) => u.bundleId === B);

    assert.equal(a.active, true);
    assert.equal(a.deletable, false);
    // 灰掉的按钮看起来像 bug，所以原因必须能显示出来
    assert.match(a.blockedReason, /正在抓/);

    assert.equal(b.deletable, true);
    assert.equal(b.blockedReason, null);
  });

  test('checkDeletable 是代码那一侧的守卫，与确认框相互独立', () => {
    // 用户可能点得很快，而消息也可能是从别处发来的。
    const us = summarizeBundles({ dirs: [dir(A, [])], activeBundleId: A });
    const r = checkDeletable(us, A);
    assert.equal(r.ok, false);
    assert.match(r.error, /正在抓/);
  });

  test('不存在的档案也被拒绝', () => {
    const us = summarizeBundles({ dirs: [dir(A, [])] });
    const r = checkDeletable(us, '20260101T000000Z-zzzzzz');
    assert.equal(r.ok, false);
    assert.match(r.error, /没有这份档案/);
  });

  test('可删时把目标带出来，省得调用方再找一遍', () => {
    const us = summarizeBundles({ dirs: [dir(A, [['index.ndjson', 7]])] });
    const r = checkDeletable(us, A);
    assert.equal(r.ok, true);
    assert.equal(r.target.bytes, 7);
  });
});

describe('导出状态：不知道就说不知道', () => {
  test('有记录 → exported', () => {
    const [u] = summarizeBundles({
      dirs: [dir(A, [])],
      exportedAt: { [A]: '2026-07-30T12:00:00.000Z' },
    });
    assert.equal(u.exportState, 'exported');
    assert.equal(u.exportedAt, '2026-07-30T12:00:00.000Z');
  });

  test('没记录且记录机制可信 → not_exported（这是唯一的副本）', () => {
    const [u] = summarizeBundles({ dirs: [dir(A, [])], exportRecordsUsable: true });
    assert.equal(u.exportState, 'not_exported');
  });

  test('记录机制不可信 → unknown，**不许**显示成未导出', () => {
    // 导出记录只在这台浏览器里。换过机器、清过数据、或者用别的方式导出过，我们都
    // 看不见。这种情况显示「未导出」是在替用户下一个我们没资格下的判断。
    const [u] = summarizeBundles({ dirs: [dir(A, [])], exportRecordsUsable: false });
    assert.equal(u.exportState, 'unknown');
    assert.notEqual(u.exportState, 'not_exported');
  });

  test('unknown 也算「可能是唯一副本」—— 按最坏情况警告', () => {
    // 不确定的时候要按最坏情况警告，而不是按最好情况放行。
    const unknown = summarizeBundles({ dirs: [dir(A, [])], exportRecordsUsable: false });
    assert.equal(hasUnexported(unknown), true);

    const exported = summarizeBundles({
      dirs: [dir(A, [])],
      exportedAt: { [A]: '2026-07-30T12:00:00.000Z' },
    });
    assert.equal(hasUnexported(exported), false);

    const mixed = summarizeBundles({
      dirs: [dir(A, []), dir(B, [])],
      exportedAt: { [A]: '2026-07-30T12:00:00.000Z' },
    });
    assert.equal(hasUnexported(mixed), true, '只要有一份没导出就要警告');
  });
});

describe('总量与键名', () => {
  test('totalBytes 把所有档案加起来', () => {
    const us = summarizeBundles({
      dirs: [dir(A, [['a', 100]]), dir(B, [['b', 250]])],
    });
    assert.equal(totalBytes(us), 350);
  });

  test('导出记录的键带前缀，且能按 bundleId 区分', () => {
    assert.equal(exportedKey(A), `${EXPORTED_KEY_PREFIX}${A}`);
    assert.notEqual(exportedKey(A), exportedKey(B));
    // 与抓取指针的键不冲突——那是抓取状态，这是界面派生状态
    assert.equal(exportedKey(A).startsWith('doubak.currentRun'), false);
  });

  test('空存储不报错', () => {
    const us = summarizeBundles({ dirs: [] });
    assert.deepEqual(us, []);
    assert.equal(totalBytes(us), 0);
    assert.equal(hasUnexported(us), false);
  });
});
