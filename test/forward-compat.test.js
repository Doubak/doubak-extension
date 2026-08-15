/**
 * 读得动**将来**的档案吗（扩展这一侧）。
 *
 * ## 要守的是哪一半
 *
 * `bundle/1.0` 从未公开发布过，所以对它不兼容是可以接受的（档案主人的决定）。
 * 必须守住的是反过来那一半：**今天写好的读取端，将来遇到更新的档案不能崩、也不能
 * 静默丢东西。** 这一条今天就能验，不必等到真有 `bundle/1.3`。
 *
 * 规范 §10 给读者立了两条义务：容忍未知字段（重写时不得丢弃），以及原样保留开放
 * 词表（`intent`、`route_key`）里的未知取值。在此之前**没有任何东西验证过它们**：
 * `conformance.test.js` 验的是「写入器产出的东西合不合规范」，那是生产者方向。
 *
 * ## 为什么两个仓库各写一份
 *
 * 读取端有两个独立实现——扩展这边（`BundleReader` / `importer`，跑在浏览器里、
 * 用 OPFS 与 `DecompressionStream`）和解析器那边（跑在 Node 上、用 `fs` 与 `zlib`）。
 * 用例是共享的（在规范仓库里），但**每个实现都要自己证明**：这正是「规范由多个
 * 实现共同定义」的意思。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { BundleReader } from '../src/bundle/bundle-reader.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { readBundleMeta } from '../src/bundle/importer.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FUTURE = [
  process.env.DOUBAK_SPECS_DIR && path.join(process.env.DOUBAK_SPECS_DIR, 'bundle/v1/tests/valid/from-the-future'),
  path.resolve(HERE, '../../doubak-data-specs/bundle/v1/tests/valid/from-the-future'),
].filter(Boolean).find((d) => existsSync(d));

/** 把用例目录整份灌进内存存储——扩展读的是存储，不是磁盘。 */
async function loadIntoStore() {
  const store = new MemoryFileStore();
  for (const name of readdirSync(FUTURE)) {
    await store.append(name, new Uint8Array(readFileSync(path.join(FUTURE, name))));
  }
  return store;
}

describe('来自未来的档案：扩展这一侧也读得动', () => {
  const skip = FUTURE ? false : '找不到 doubak-data-specs —— 单独 clone 这一个仓库时这是正常的';

  test('**声明的是没见过的小版本，照样打得开**', { skip }, async () => {
    // 它写着 `bundle/1.9`。读取端**根本不看 spec_version**——按字段读，不按版本
    // 分支。这不是疏忽，正是它能读将来那些档案的原因。
    const store = await loadIntoStore();
    const idxName = readdirSync(FUTURE).find((f) => f.startsWith('index-'));
    const bundleId = idxName.slice('index-'.length, -'.ndjson'.length);

    const r = new BundleReader({ store, bundleId });
    const m = await r.manifest();
    assert.equal(m.spec_version, 'bundle/1.9');

    const idx = await r.index();
    assert.ok(idx.length > 0, 'index 一行都没读出来');
  });

  test('**未知字段读出来还在**（规范 §10）', { skip }, async () => {
    // 「只增不改」全靠读者不丢未知字段。丢了的话，把档案重写一遍，新版本加的东西
    // 就永久没了——而档案是不可重抓的。
    const store = await loadIntoStore();
    const idxName = readdirSync(FUTURE).find((f) => f.startsWith('index-'));
    const bundleId = idxName.slice('index-'.length, -'.ndjson'.length);
    const r = new BundleReader({ store, bundleId });

    const m = await r.manifest();
    assert.ok(m.future_top_level_field, 'manifest 上的未知字段被吃掉了');

    const idx = await r.index();
    const row = idx.find((x) => x.future_line_field !== undefined);
    assert.ok(row, 'index 行上的未知字段被吃掉了');
    assert.equal(row.future_line_field, 42);
  });

  test('**开放词表里的未知取值原样保留，不许猜**', { skip }, async () => {
    const store = await loadIntoStore();
    const idxName = readdirSync(FUTURE).find((f) => f.startsWith('index-'));
    const bundleId = idxName.slice('index-'.length, -'.ndjson'.length);
    const idx = await new BundleReader({ store, bundleId }).index();

    const row = idx.find((x) => String(x.intent ?? '').startsWith('future.'));
    assert.ok(row, '用例本身该带一个未知 intent');
    assert.equal(row.intent, 'future.route.that.does.not.exist.yet');
    // 猜一个是不可逆的，留着是可查的。与 `medium`、`category` 是同一条规矩。
  });

  test('**「验一验」照样能逐条取出来解压**', { skip }, async () => {
    // 这是读取端最实的一条路径：不依赖任何声明，按 index 的 offset/length 把每条
    // 记录从段文件里真取出来。它跑得通，就说明未来的档案不只是「解析得动」，
    // 而是**真的能重放**。
    const store = await loadIntoStore();
    const idxName = readdirSync(FUTURE).find((f) => f.startsWith('index-'));
    const bundleId = idxName.slice('index-'.length, -'.ndjson'.length);

    const v = await new BundleReader({ store, bundleId }).verify();
    assert.equal(v.checked > 0, true, '一条都没验到 —— 这条断言就白写了');
    assert.equal(v.problems.length, 0, `逐条取出时出了问题：${JSON.stringify(v.problems)}`);
  });

  test('**导入路径认得它，不会当成坏档案拒掉**', { skip }, async () => {
    // 导入前会先扫一遍目录并判断「这是什么」。未来的档案必须被判成一份**正常**的
    // 档案——判成残缺的话，用户换机器之后就恢复不回来了，而那正是导入存在的理由。
    const files = {};
    for (const name of readdirSync(FUTURE)) {
      files[name] = new Uint8Array(readFileSync(path.join(FUTURE, name)));
    }
    const source = {
      name: 'from-the-future',
      async list() { return Object.keys(files); },
      async read(n) { return files[n]; },
    };
    const meta = await readBundleMeta(source, 'from-the-future');
    assert.ok(meta, '导入扫描没认出这是一份档案');

    // **判据必须是真的会变的东西。** 第一版写的是 `meta.problem ?? null === null`
    // ——而 `readBundleMeta` 压根不设 `problem` 字段：把段文件整个删掉，它照样返回
    // null。那条断言恒真，白绿着。凡是断言「某个字段没有值」，都要先确认那个字段
    // **在坏情况下真的会有值**。
    assert.equal(meta.bundleId, '20260728T101500Z-a3f9c1', '没从 manifest 认出编号');
    assert.equal(meta.idFrom, 'manifest', '编号该来自 manifest，不是目录名');
    assert.equal(meta.accountUserId, '82160871', '账号归属该读得出来');
    assert.equal(meta.hasManifest, true);
    // 段文件、index、manifest 三样都要被认出来——少一样就意味着导入会判它残缺。
    const names = meta.files.map((f) => f.name);
    assert.ok(names.some((n) => n.startsWith('data-') && n.endsWith('.warc.gz')), `没认出段文件：${names}`);
    assert.ok(names.some((n) => n.startsWith('index-')), `没认出 index：${names}`);
    assert.ok(names.includes('manifest.json'), `没认出 manifest：${names}`);
  });
});
