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
import { execFileSync } from 'node:child_process';

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

  test('**src/ 的代码里不许出现任何形如 x.y.z 的版本字面量**', () => {
    // 上面那条只挡得住「写死了当前版本」。而真正发生过的是**写死了一个过期版本**：
    // manifest 涨到 0.9.0 之后，`'0.0.1'` 那三份副本与它不再相等——按上面那条判据
    // 反而全都合规。所以这里不比对具体数值，只问「代码里还有没有版本字面量」。
    //
    // 注释不算：讲清那次 bug 的来龙去脉恰恰需要把 '0.0.1' 写出来。
    const offenders = [];
    for (const f of sources()) {
      const text = readFileSync(f, 'utf8');
      text.split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/^\s*\*/.test(line) || /^\s*\/\//.test(line)) return; // 整行注释
        if (/['"`]\d+\.\d+\.\d+[a-z0-9.-]*['"`]/.test(code)) offenders.push(`${f}:${i + 1}`);
      });
    }
    assert.deepEqual(
      offenders, [],
      '代码里出现了版本字面量。它迟早会与 manifest 对不上，而它会被写进不可逆的档案',
    );
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

  /**
   * 把 `fetch` 换成一个只认扩展根下资源的假货，跑一段，然后还回去。
   *
   * @param {(url: string) => Response | Promise<Response>} impl
   * @param {() => Promise<void>} body
   */
  async function withFetch(impl, body) {
    const prevFetch = globalThis.fetch;
    const prevChrome = globalThis.chrome;
    try {
      globalThis.fetch = /** @type {any} */ ((u) => impl(String(u)));
      globalThis.chrome = /** @type {any} */ ({
        // **只给 getURL。** offscreen document 里就只有这些——见下面那条契约测试。
        runtime: { getURL: (p) => `chrome-extension://fake/${p}` },
      });
      await body();
    } finally {
      globalThis.fetch = prevFetch;
      if (prevChrome === undefined) delete globalThis.chrome;
      else globalThis.chrome = prevChrome;
    }
  }

  test('读不到 manifest.json 时抛错，而不是编一个', async () => {
    await withFetch(() => new Response('', { status: 404 }), async () => {
      await assert.rejects(() => extensionVersion(), /manifest\.json/);
    });
  });

  test('manifest.json 里没有 version 时也抛 —— 空字符串不算', async () => {
    await withFetch(() => Response.json({ name: '豆备' }), async () => {
      await assert.rejects(() => extensionVersion(), /版本号/);
    });
    await withFetch(() => Response.json({ version: '' }), async () => {
      await assert.rejects(() => extensionVersion(), /版本号/);
    });
  });

  test('读到的就是 manifest.json 里那个', async () => {
    let asked = null;
    await withFetch((u) => { asked = u; return Response.json(manifest); }, async () => {
      assert.equal(await extensionVersion(), manifest.version);
    });
    assert.equal(asked, 'chrome-extension://fake/manifest.json', '要读的就是那一个文件');
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

describe('打包', () => {
  /**
   * 打包脚本的文件清单。`--list` 不写盘，所以测试里跑它是安全的。
   *
   * **在测试里跑，不在模块顶层跑。** 顶层跑的话，脚本一旦非零退出，
   * `execFileSync` 会在加载阶段抛出，整个 describe 连同它的断言一起消失——
   * 于是「测试变少了」而不是「测试红了」，而前者看起来像一切正常。
   * 实测过：把 test/ 加进白名单，用例数从 1418 掉到 1414，没有一条红。
   */
  const listFiles = () => {
    let out;
    try {
      out = execFileSync('node', ['tools/package.mjs', '--list'], { encoding: 'utf8' });
    } catch (e) {
      assert.fail(`打包脚本自己就没通过：\n${e.stderr || e.message}`);
    }
    return out.split('\n').filter((l) => l && !l.includes('个文件'));
  };

  test('**测试与开发用的东西不许进包**', () => {
    // test/ 里有真实账号的用户名与数字 uid（刻意保留的，见 CLAUDE.md），
    // 没必要连同扩展分发给每一个装它的人；而审核那边每多一个文件就多一分被问。
    const leaked = listFiles().filter((f) => /^(test|tools|docs|node_modules|\.git|dist)\//.test(f));
    assert.deepEqual(leaked, [], `这些不该出现在包里：\n${leaked.join('\n')}`);
  });

  test('**manifest 引用到的文件必须都在包里**', () => {
    // 少一个的话，扩展装上才发现——而那时已经过了一轮审核。
    const refs = [
      manifest.background?.service_worker,
      ...Object.values(manifest.icons ?? {}),
      ...Object.values(manifest.action?.default_icon ?? {}),
    ].filter(Boolean);
    const listed = listFiles();
    for (const r of refs) assert.ok(listed.includes(r), `manifest 引用了 ${r}，但它不在包里`);
  });

  test('**自检页要带上** —— 调试页那个按钮真的会打开它', () => {
    // 不带上，那个按钮就是个死链。这一条是差点漏掉的：selftest 没有被
    // manifest 引用，只被 panel.js 用 getURL 打开。
    assert.ok(listFiles().includes('selftest/index.html'));
  });

  test('包里的入口就在根部，没有顶层目录', () => {
    // Chrome 要求 manifest.json 在压缩包根部。
    const listed = listFiles();
    assert.ok(listed.includes('manifest.json'));
    assert.ok(!listed.some((f) => f.startsWith('doubak')), '不该有一层同名目录');
  });
});
