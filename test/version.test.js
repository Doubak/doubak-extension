/**
 * 版本号只能有一个来源。
 *
 * 这些断言存在，是因为反面已经发生过：`manifest.json` 停在 `0.0.1` 一路没动，同时
 * `crawl/runner.js` 和 `bundle/bundle-writer.js` 各自写死了一份 `'0.0.1'`——三份互相
 * 不认识的副本。等 manifest 涨到 0.9.0 的那天，已经导出的档案仍然一律自称 0.0.1，
 * 而 `producer.version` 的**唯一**用途就是回答「这份档案是哪份代码抓的」。
 *
 * 档案不可逆：写错的版本号是永久的，而且它看起来像证据。所以这里守三件事——
 * 两份元数据对得上、`src/` 里再也不出现写死的版本号、缺 producer 就抛而不是猜。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { extensionVersion } from '../src/core/version.js';
import { BundleWriter } from '../src/bundle/bundle-writer.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { TEST_PRODUCER } from './helpers/producer.js';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

/** 递归列出 src/ 下所有 .js。 */
function sources(dir = 'src') {
  /** @type {string[]} */
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

describe('版本号', () => {
  test('manifest.json 与 package.json 一致', () => {
    assert.equal(
      pkg.version,
      manifest.version,
      'package.json 与 manifest.json 的版本号必须一起改。manifest 那个是权威的（Chrome 和应用店认它）',
    );
  });

  test('版本号形如 x.y.z —— 应用店只收数字段', () => {
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  });

  test('src/ 里没有任何地方把当前版本号写死', () => {
    const offenders = sources()
      .filter((f) => f !== join('src', 'core', 'version.js'))
      .filter((f) => readFileSync(f, 'utf8').includes(`'${manifest.version}'`)
        || readFileSync(f, 'utf8').includes(`"${manifest.version}"`));
    assert.deepEqual(
      offenders, [],
      '版本号只能从 manifest 读（core/version.js）。写死的那份迟早会与真实版本对不上，'
      + '而它会被写进不可逆的档案里',
    );
  });

  test('拿不到 manifest 时抛错，而不是编一个', () => {
    const prev = globalThis.chrome;
    try {
      delete globalThis.chrome;
      assert.throws(() => extensionVersion(), /版本号/);
    } finally {
      if (prev === undefined) delete globalThis.chrome;
      else globalThis.chrome = prev;
    }
  });

  test('有 manifest 时，读到的就是 manifest 里那个', () => {
    const prev = globalThis.chrome;
    try {
      globalThis.chrome = { runtime: { getManifest: () => ({ version: manifest.version }) } };
      assert.equal(extensionVersion(), manifest.version);
    } finally {
      if (prev === undefined) delete globalThis.chrome;
      else globalThis.chrome = prev;
    }
  });

  test('BundleWriter 缺 producer 就抛 —— 不许有默认值兜底', () => {
    assert.throws(
      () => new BundleWriter({ store: new MemoryFileStore(), account: { user_id: '1' } }),
      /producer/,
      '默认值会把一个过时的版本号静默写进 WARC 的 software: 头',
    );
    // 传了就正常
    assert.ok(new BundleWriter({
      store: new MemoryFileStore(),
      account: { user_id: '1' },
      producer: TEST_PRODUCER,
    }));
  });
});
