/**
 * 发布这条路上的检查：**两个商店的包都得真的被打出来。**
 *
 * ## 为什么这值得一组静态检查
 *
 * 这个工作流平时没人看——它的产物是给别人下载的，我们自己装扩展走的是本地
 * `node tools/package.mjs`。所以它坏掉的样子是：**发版当天才发现**，而那正是最不该
 * 出问题的一天。2026-09-09 加 Firefox 支持时，两个包的代码、manifest、测试都做完了，
 * 而 CI 仍然只打 Chrome 那一个——是仓库主人问「CI 更新了吗」才发现的。
 *
 * 这里查的是 YAML 文本，不是跑一遍工作流。判据因此要挑**改坏了一定会变**的那几个
 * 字符串（调了哪个命令、release 挂了哪几个文件），而不是「文件里出现过 firefox」。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const yml = () => readFile(new URL('../.github/workflows/package.yml', import.meta.url), 'utf8');

const doc = (f) => readFile(new URL(`../${f}`, import.meta.url), 'utf8');

describe('打包这件事的文档，跟着目标表走', () => {
  /**
   * 判据从 `TARGETS` 来，**不是抄一张目标清单**。
   *
   * 抄一张的话，加第三个目标（Safari？）时它照样全绿，而症状是「文档里没有这个包」
   * ——那正是 2026-09-09 已经发生过一次的事：代码、manifest、测试都做完了，
   * CI 和文档还只知道一个包，是仓库主人问了才发现的。
   */
  const targets = async () => {
    const src = await doc('tools/package.mjs');
    const table = src.slice(src.indexOf('const TARGETS = {'), src.indexOf('const targetName'));
    return [...table.matchAll(/^ {2}(\w+): ?\{?/gm)].map((m) => m[1]);
  };

  test('目标表能读出来，而且不止一个 —— 读不出来的话下面几条全是空转', async () => {
    const t = await targets();
    assert.ok(t.length >= 2, `只读出 ${t.length} 个目标：${t}`);
    assert.deepEqual(t.sort(), ['chrome', 'firefox']);
  });

  for (const f of ['README.md', 'docs/release.md']) {
    test(`${f} 里每个目标都有它自己的打包命令`, async () => {
      const text = await doc(f);
      for (const t of await targets()) {
        const cmd = t === 'chrome'
          ? /node tools\/package\.mjs(?![\s\S]{0,3}--firefox)/
          : new RegExp(`node tools/package\\.mjs --${t}`);
        assert.match(text, cmd, `${f} 里没写 ${t} 那个包怎么打`);
      }
    });
  }

  test('两个商店在 README 与 release.md 里各有交代', async () => {
    // 「上架了没有」是读者会立刻问的第一件事，而它两边不一样。
    for (const f of ['README.md', 'docs/release.md']) {
      const text = await doc(f);
      assert.match(text, /chromewebstore\.google\.com/, `${f} 没提 Chrome 应用商店`);
      assert.match(text, /AMO/, `${f} 没提 AMO`);
    }
  });

  test('AMO 那几样只写在一处，别的地方指过去', async () => {
    // 扩展 id 出现在两处就会分叉，而分叉的方向是「其中一处还写着旧的 id」——
    // 那个字符串是 AMO 眼里「这是同一个扩展」的全部依据，改掉不会报错。
    const home = await doc('docs/firefox.md');
    assert.match(home, /doubak@doubak\.com/, 'firefox.md 里没有那个 id');
    for (const f of ['README.md', 'docs/release.md', 'docs/store-listing.md']) {
      const text = await doc(f);
      assert.ok(!text.includes('doubak@doubak.com'), `${f} 里又抄了一份扩展 id`);
      assert.match(text, /firefox\.md/, `${f} 没指向那一处`);
    }
  });
});

describe('打包工作流', () => {
  test('两个目标都打 zip', async () => {
    const s = await yml();
    assert.match(s, /^\s*run: node tools\/package\.mjs$/m, 'Chrome 那个包没打');
    assert.match(s, /^\s*run: node tools\/package\.mjs --firefox$/m, 'AMO 那个包没打');
  });

  test('两个目标都摊成可直接加载的目录，而且**各上传各的**', async () => {
    // 一个目录传两次、或者两个目标摊到同一个目录，症状是「下下来的是另一个浏览器
    // 的包」——装上去会直接加载失败，而失败信息不会提到是拿错了包。
    const s = await yml();
    const stages = [...s.matchAll(/--stage (\S+)/g)].map((m) => m[1]);
    assert.equal(stages.length, 2, `摊了 ${stages.length} 个目录，应当是 2 个`);
    assert.equal(new Set(stages).size, 2, `两个目标摊到了同一个目录：${stages}`);

    const paths = [...s.matchAll(/^\s+path: (dist\/\S+)$/gm)].map((m) => m[1].replace(/\/$/, ''));
    assert.deepEqual(paths.sort(), stages.sort(), '上传的目录与摊出来的对不上');

    const names = [...s.matchAll(/^\s+name: (doubak-\S+)$/gm)].map((m) => m[1]);
    assert.equal(new Set(names).size, names.length, `两个产物重名了：${names}`);
  });

  test('**release 上两个包都挂**', async () => {
    // 只挂一个的话，另一半用户在 release 页上什么都找不到，而 release 正是我们给
    // 出去的那个入口。
    const s = await yml();
    const created = s.slice(s.indexOf('gh release create'));
    assert.match(created, /doubak-\$\{\{ steps\.v\.outputs\.version \}\}\.zip/, 'Chrome 那个没挂');
    assert.match(created, /doubak-\$\{\{ steps\.v\.outputs\.version \}\}-firefox\.zip/, 'Firefox 那个没挂');
  });

  test('release 说明把两种装法分开写，并且先说「别装错」', async () => {
    // 两个包放在一起，第一个要回答的问题是「我该下哪个」。装错的症状是直接加载
    // 失败，而失败信息里不会提到是拿错了包。
    const s = await yml();
    const notes = s.slice(s.indexOf('release-notes.md'), s.indexOf('gh release create'));
    assert.match(notes, /两个包/);
    assert.match(notes, /chrome:\/\/extensions/);
    assert.match(notes, /about:debugging/, 'Firefox 那半边没写怎么装');
    assert.match(notes, /关掉浏览器就没了/, '「临时载入」是临时的，不说就是过度承诺');
  });

  test('`manifest.firefox.json` 在打包之前先核对过是算出来的那一份', async () => {
    // 手改过的那份能装、能跑，只是与 Chrome 那份悄悄分了家——而分家的方向是
    // 「Firefox 那份少了一个新权限」，症状是装得上、某个功能不工作。
    //
    // `npm test` 里有同一条，但那是**另一个工作流**：这一份是发出去的东西，
    // 它的检查得跟着它自己走。
    const s = await yml();
    const check = s.indexOf('make-manifest.mjs --check');
    const pack = s.indexOf('node tools/package.mjs --firefox');
    assert.ok(check > 0, '没核对生成出来的 manifest');
    assert.ok(check < pack, '核对排在打包后面 —— 那时包已经打好了');
  });

  test('web-ext lint 验的是**打好的那个包**，而且版本钉死', async () => {
    // 仓库根上放的是 Chrome 那份 manifest，而发出去的不是它 —— 对着仓库 lint
    // 等于验了一个不会被上传的东西（实测：对仓库根 lint 是 2 errors，对包是 0）。
    const s = await yml();
    const m = /npx --yes (web-ext@[\d.]+) lint --source-dir (\S+)/.exec(s);
    assert.ok(m, '没跑 web-ext lint —— AMO 会拿它卡上架');
    assert.match(m[1], /@\d/, `web-ext 没钉版本：${m[1]}`);
    assert.match(m[2], /unpacked-firefox/, `lint 的不是 Firefox 那个包：${m[2]}`);
  });
});
