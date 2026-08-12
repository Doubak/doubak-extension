/**
 * 导入：能不能认出一份档案，以及**什么情况下坚决不导**。
 *
 * 这份测试的重心全在拒绝那一侧。理由是代价不对称：
 *
 * | 判错的方向 | 代价 |
 * |---|---|
 * | 该导的没导 | 零 —— 源文件还在用户盘上，看懂提示再导一次 |
 * | 不该导的导了 | 一份**看起来正常**的坏档案：能选中、能导出、能被解析器读，只是索引里有偏移量指向不存在的字节 |
 *
 * 所以每一条判据都往「宁可不导」的方向倒，而测试要盯住的是它有没有真的倒过去。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  readBundleMeta, planImport, compareContents, importBundle, ACTIONS,
} from '../src/bundle/importer.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { sha256Hex } from '../src/core/digest.js';

const ID = '20260801T005010Z-3eef52';
const OTHER = '20260804T084014Z-627045';
const enc = new TextEncoder();

/**
 * 造一份能通过全部检查的档案。
 *
 * 段文件内容随便，但**字节数必须与 manifest 声明的一致**——那正是被检查的东西，
 * 所以这里由一处算出来，测试改不动它而不自知。
 */
async function makeBundle({
  id = ID, userId = '1000001', username = 'mewx', previous = null,
  segBytes = 64, withManifest = true, extra = {},
} = {}) {
  const store = new MemoryFileStore();
  const seg = `pages-${id}-00001.warc.gz`;
  const segBody = new Uint8Array(segBytes).fill(7);
  await store.replace(seg, segBody);
  await store.replace(`index-${id}.ndjson`, enc.encode('{"capture_id":"x"}\n'));
  if (withManifest) {
    await store.replace('manifest.json', enc.encode(JSON.stringify({
      bundle_id: id,
      status: 'complete',
      completed_at: '2026-08-01T02:00:00Z',
      previous_bundle_id: previous,
      account: { user_id: userId, username },
      // **真摘要，不是占位。** 写死一个假的话，回读校验那一趟每次都失败，
      // 于是「校验通过」这个断言就永远验不到 —— 而那正是导入最要紧的一步。
      segments: [{ filename: seg, bytes: segBytes, sha256: await sha256Hex(segBody) }],
      index: { filename: `index-${id}.ndjson` },
      crawl_state: [],
    })));
  }
  for (const [name, body] of Object.entries(extra)) {
    await store.replace(name, typeof body === 'string' ? enc.encode(body) : body);
  }
  return store;
}

/** `MemoryFileStore` → `planImport` 要的那个形状。 */
async function asExisting(store, bundleId, account = {}) {
  const files = [];
  for (const name of await store.list()) files.push({ name, bytes: await store.size(name) });
  return {
    bundleId,
    files,
    accountUserId: account.userId ?? '1000001',
    accountUsername: account.username ?? 'mewx',
  };
}

describe('认出一份档案', () => {
  test('好的那种：编号、账号、上游全读出来', async () => {
    const meta = await readBundleMeta(await makeBundle({ previous: OTHER }), `doubak-bundle-${ID}`);
    assert.deepEqual(meta.fatal, []);
    assert.equal(meta.bundleId, ID);
    assert.equal(meta.idFrom, 'manifest');
    assert.equal(meta.accountUserId, '1000001');
    assert.equal(meta.previousBundleId, OTHER);
  });

  test('**文件夹改过名照样认得出** —— 身份在 manifest 里，不在目录名上', async () => {
    // 用户会改名、会放进「备份/2026-08/」、解压两遍会得到「… (1)」。
    // 拿目录名当身份的话，这些全都变成「认不出的东西」。
    const meta = await readBundleMeta(await makeBundle(), '我的豆瓣备份 (1)');
    assert.deepEqual(meta.fatal, []);
    assert.equal(meta.bundleId, ID);
  });

  test('**三处编号对不上就不导** —— 那是两份档案的文件混进了一个目录', async () => {
    const store = await makeBundle({ id: ID });
    // 另一份档案的 index 混了进来
    await store.replace(`index-${OTHER}.ndjson`, enc.encode('{}\n'));
    const meta = await readBundleMeta(store, `doubak-bundle-${ID}`);
    // 这条第一次写出来时是**红的**，而且红得很有意思：实现只取了第一个 index 文件，
    // 而排序后先出现的恰好与 manifest 对得上 —— 于是「三处必须一致」全票通过，
    // 另一份档案的段文件跟着一起导了进来。所以实现改成收全部 index 文件再比。
    assert.equal(meta.fatal.some((f) => f.code === 'id_mismatch'), true,
      '同一目录里两个档案编号，却没被判成冲突');
    assert.equal(meta.bundleId, null, '判成冲突之后不该再挑一个编号出来用');
  });

  test('**manifest 声明的段文件不在就不导**，并且说出缺的是哪一个', async () => {
    const store = await makeBundle();
    await store.remove(`pages-${ID}-00001.warc.gz`);
    const meta = await readBundleMeta(store, `doubak-bundle-${ID}`);
    const bad = meta.fatal.find((f) => f.code === 'missing_file');
    assert.ok(bad, '少一个段文件却照导 —— 那会得到一份索引指向不存在字节的档案');
    assert.match(bad.detail, /pages-.*00001\.warc\.gz/, '没说出缺的是哪一个文件');
  });

  test('**字节数与 manifest 声明的对不上就不导**（复制断了、盘满过）', async () => {
    const store = await makeBundle({ segBytes: 64 });
    await store.replace(`pages-${ID}-00001.warc.gz`, new Uint8Array(31));
    const meta = await readBundleMeta(store, `doubak-bundle-${ID}`);
    assert.equal(meta.fatal.some((f) => f.code === 'size_mismatch'), true);
  });

  test('manifest 坏了就不导 —— 没有它，没东西能证明其余文件属于同一份', async () => {
    const store = await makeBundle();
    await store.replace('manifest.json', enc.encode('{ 这不是 JSON'));
    const meta = await readBundleMeta(store, `doubak-bundle-${ID}`);
    assert.equal(meta.fatal.some((f) => f.code === 'manifest_unreadable'), true);
  });

  test('不是档案目录就直说，别猜', async () => {
    const store = new MemoryFileStore();
    await store.replace('照片.jpg', new Uint8Array(3));
    const meta = await readBundleMeta(store, '下载');
    assert.equal(meta.fatal[0].code, 'not_a_bundle');
  });

  test('**没收尾的档案能导**，但要说清校验不了摘要', async () => {
    // 抓到一半导出的档案没有 manifest。拒绝它等于因为它残缺而惩罚它，
    // 而残缺恰恰是它最需要被搬回来的理由。
    const meta = await readBundleMeta(
      await makeBundle({ withManifest: false }), `doubak-bundle-${ID}`,
    );
    assert.deepEqual(meta.fatal, []);
    assert.equal(meta.bundleId, ID, '编号该从 index 文件名认出来');
    assert.equal(meta.idFrom, 'index');
    assert.equal(meta.warnings.some((w) => w.code === 'no_manifest'), true);
  });

  test('checkpoint.json 会被点名，因为它不跟着档案走', async () => {
    const meta = await readBundleMeta(
      await makeBundle({ extra: { 'checkpoint.json': '{}' } }), `doubak-bundle-${ID}`,
    );
    assert.deepEqual(meta.fatal, []);
    assert.equal(meta.warnings.some((w) => w.code === 'checkpoint_present'), true);
  });

  test('manifest 没声明的文件要提一句 —— 可能是别人的段文件混了进来', async () => {
    const meta = await readBundleMeta(
      await makeBundle({ extra: { [`pages-${OTHER}-00001.warc.gz`]: 'x' } }),
      `doubak-bundle-${ID}`,
    );
    assert.equal(meta.warnings.some((w) => w.code === 'undeclared_file'), true);
  });
});

describe('排一份「将要发生什么」的清单', () => {
  test('干净的一份就是导', async () => {
    const meta = await readBundleMeta(await makeBundle(), 'x');
    const plan = planImport({ candidates: [meta], existing: [] });
    assert.equal(plan.items[0].action, ACTIONS.IMPORT);
    assert.equal(plan.count, 1);
    assert.equal(plan.bytes, meta.bytes);
  });

  test('**同一份档案在选区里出现两次** —— 导一次，另一次说清是同一份', async () => {
    const a = await readBundleMeta(await makeBundle(), '备份/doubak-bundle-x');
    const b = await readBundleMeta(await makeBundle(), '备份 (1)/doubak-bundle-x');
    const plan = planImport({ candidates: [a, b], existing: [] });
    assert.deepEqual(plan.items.map((i) => i.action), [ACTIONS.IMPORT, ACTIONS.DUPLICATE]);
    assert.match(plan.items[1].detail, /同一份档案/);
    assert.equal(plan.count, 1, '重复的那份不该也算进要搬的字节里');
  });

  test('编号相同但内容不同时，说的是「只导先找到的」而不是「同一份」', async () => {
    const a = await readBundleMeta(await makeBundle({ segBytes: 64 }), '甲');
    const b = await readBundleMeta(await makeBundle({ segBytes: 128 }), '乙');
    const plan = planImport({ candidates: [a, b], existing: [] });
    assert.equal(plan.items[1].action, ACTIONS.DUPLICATE);
    assert.match(plan.items[1].detail, /内容不同/);
  });

  test('**已经有了就跳过** —— 认的是编号，不是文件夹名', async () => {
    const store = await makeBundle();
    const meta = await readBundleMeta(store, '随便什么名字');
    const plan = planImport({
      candidates: [meta], existing: [await asExisting(store, ID)],
    });
    assert.equal(plan.items[0].action, ACTIONS.PRESENT);
    assert.equal(plan.count, 0);
  });

  test('**上次导到一半 → 续传**，不是冲突', async () => {
    const src = await makeBundle();
    const half = new MemoryFileStore();
    await half.replace(`index-${ID}.ndjson`, await src.read(`index-${ID}.ndjson`));
    const plan = planImport({
      candidates: [await readBundleMeta(src, 'x')],
      existing: [await asExisting(half, ID)],
    });
    assert.equal(plan.items[0].action, ACTIONS.RESUME);
    assert.match(plan.items[0].detail, /还差 /);
  });

  test('**同编号但内容对不上：拒绝，不覆盖**', async () => {
    const src = await makeBundle({ segBytes: 64 });
    const mine = await makeBundle({ segBytes: 999 });
    const plan = planImport({
      candidates: [await readBundleMeta(src, 'x')],
      existing: [await asExisting(mine, ID)],
    });
    assert.equal(plan.items[0].action, ACTIONS.CONFLICT);
    assert.match(plan.items[0].detail, /不覆盖/);
  });

  test('**正在抓的那一份不能被导上去**', async () => {
    const meta = await readBundleMeta(await makeBundle(), 'x');
    const plan = planImport({ candidates: [meta], existing: [], activeBundleId: ID });
    assert.equal(plan.items[0].action, ACTIONS.ACTIVE);
  });

  test('**另一个账号的档案默认不导** —— 解析器会拒绝混了两个账号的目录', async () => {
    const mine = await makeBundle({ id: OTHER, userId: '1000001' });
    const theirs = await readBundleMeta(await makeBundle({ userId: '2000002', username: '别人' }), 'x');
    const plan = planImport({
      candidates: [theirs],
      existing: [await asExisting(mine, OTHER, { userId: '1000001' })],
    });
    assert.equal(plan.items[0].action, ACTIONS.OTHER_ACCOUNT);
    assert.equal(plan.homeAccount.userId, '1000001');

    // 但用户明确说要的时候得让他导 —— 那是他自己的两个豆瓣号。
    const forced = planImport({
      candidates: [theirs],
      existing: [await asExisting(mine, OTHER, { userId: '1000001' })],
      allowOtherAccounts: true,
    });
    assert.equal(forced.items[0].action, ACTIONS.IMPORT);
  });

  test('**改过名不算别人** —— 那只会让下次抓取退回全量，不是拒绝导入的理由', async () => {
    const mine = await makeBundle({ id: OTHER, userId: '1000001', username: '新名字' });
    const old = await readBundleMeta(await makeBundle({ userId: '1000001', username: '旧名字' }), 'x');
    const plan = planImport({
      candidates: [old],
      existing: [await asExisting(mine, OTHER, { userId: '1000001', username: '新名字' })],
    });
    assert.equal(plan.items[0].action, ACTIONS.IMPORT);
  });

  test('OPFS 空着时，主账号从候选里推 —— 少数派那些才是「别人」', async () => {
    const a = await readBundleMeta(await makeBundle({ id: ID, userId: '1000001' }), 'a');
    const b = await readBundleMeta(await makeBundle({ id: OTHER, userId: '1000001' }), 'b');
    const c = await readBundleMeta(
      await makeBundle({ id: '20260806T083926Z-f72157', userId: '9999999' }), 'c',
    );
    const plan = planImport({ candidates: [a, b, c], existing: [] });
    assert.deepEqual(
      plan.items.map((i) => i.action),
      [ACTIONS.IMPORT, ACTIONS.IMPORT, ACTIONS.OTHER_ACCOUNT],
    );
  });

  test('**认不出账号的（没有 manifest）一律放行**', async () => {
    const mine = await makeBundle({ id: OTHER, userId: '1000001' });
    const orphan = await readBundleMeta(await makeBundle({ withManifest: false }), 'x');
    const plan = planImport({
      candidates: [orphan], existing: [await asExisting(mine, OTHER)],
    });
    assert.equal(plan.items[0].action, ACTIONS.IMPORT);
  });

  test('**链断了要说出缺的是哪一份**，但不拦着导', async () => {
    const meta = await readBundleMeta(await makeBundle({ previous: OTHER }), 'x');
    const plan = planImport({ candidates: [meta], existing: [] });
    assert.equal(plan.items[0].action, ACTIONS.IMPORT, '链断不是拒绝导入的理由');
    assert.deepEqual(plan.holes, [{ bundleId: ID, missing: OTHER }]);
  });

  test('上游也在这一批里，就不算断', async () => {
    const head = await readBundleMeta(await makeBundle({ previous: OTHER }), 'a');
    const base = await readBundleMeta(await makeBundle({ id: OTHER }), 'b');
    const plan = planImport({ candidates: [head, base], existing: [] });
    assert.deepEqual(plan.holes, []);
  });

  test('上游已经在扩展里，也不算断', async () => {
    const head = await readBundleMeta(await makeBundle({ previous: OTHER }), 'a');
    const plan = planImport({
      candidates: [head],
      existing: [await asExisting(await makeBundle({ id: OTHER }), OTHER)],
    });
    assert.deepEqual(plan.holes, []);
  });

  test('坏的那份被拒，同一批里好的那份照导', async () => {
    const broken = await makeBundle({ id: OTHER });
    await broken.remove(`pages-${OTHER}-00001.warc.gz`);
    const plan = planImport({
      candidates: [
        await readBundleMeta(broken, 'a'),
        await readBundleMeta(await makeBundle(), 'b'),
      ],
      existing: [],
    });
    assert.deepEqual(plan.items.map((i) => i.action), [ACTIONS.REFUSE, ACTIONS.IMPORT]);
  });
});

describe('比内容', () => {
  test('checkpoint.json 不参与比较 —— 它不属于档案', () => {
    const a = [{ name: 'manifest.json', bytes: 10 }, { name: 'checkpoint.json', bytes: 5 }];
    const b = [{ name: 'manifest.json', bytes: 10 }];
    assert.equal(compareContents(a, b), 'same');
  });

  test('目的地多出来的文件算 different，不算 same', () => {
    const a = [{ name: 'manifest.json', bytes: 10 }];
    const b = [{ name: 'manifest.json', bytes: 10 }, { name: '别的.warc.gz', bytes: 1 }];
    assert.equal(compareContents(a, b), 'different');
  });
});

describe('真的搬一次', () => {
  test('字节一致，并且回读校验过', async () => {
    const src = await makeBundle();
    const dest = new MemoryFileStore();
    const r = await importBundle({ source: src, dest });

    assert.deepEqual(r.problems, []);
    for (const name of await src.list()) {
      assert.deepEqual(await dest.read(name), await src.read(name), `${name} 字节对不上`);
    }
  });

  test('**checkpoint.json 不跟着导进来** —— 它会让人以为能接着抓那次没跑完的', async () => {
    const src = await makeBundle({ extra: { 'checkpoint.json': '{"bundle_id":"x"}' } });
    const dest = new MemoryFileStore();
    await importBundle({ source: src, dest });
    assert.equal(await dest.exists('checkpoint.json'), false);
  });

  test('续传只补缺的那些，已经完整的不重抄', async () => {
    const src = await makeBundle();
    const dest = new MemoryFileStore();
    const idx = `index-${ID}.ndjson`;
    await dest.replace(idx, await src.read(idx));

    const r = await importBundle({ source: src, dest, resume: true });
    assert.equal(r.skipped, 1, '已经完整的那个文件该被跳过');
    assert.equal(r.files.length, (await src.list()).length);
    for (const name of await src.list()) {
      assert.deepEqual(await dest.read(name), await src.read(name));
    }
  });

  test('续传时**字节数对不上的照样重写** —— 不能只看文件在不在', async () => {
    const src = await makeBundle();
    const dest = new MemoryFileStore();
    const seg = `pages-${ID}-00001.warc.gz`;
    await dest.replace(seg, new Uint8Array(3)); // 上次写了一半，或者是别的档案留下的

    await importBundle({ source: src, dest, resume: true });
    assert.deepEqual(await dest.read(seg), await src.read(seg));
  });
});
