/**
 * 每个入口跑在什么上下文里，那个上下文**没有**什么 —— 用源码钉住。
 *
 * ## 为什么要有这么一条
 *
 * `Doubak/doubak-extension#12`（2026-09-10）：1.4.0 的宿主接缝两条分支都写成动态
 * `import()`，而 **`import()` 在 ServiceWorkerGlobalScope 上是规范禁止的**
 * （w3c/ServiceWorker#1356）。桌面 Chrome / Edge 给扩展开了口子，所以本机全绿、
 * CI 全绿、真浏览器里跑得好好的；**安卓 Edge 照规范办事**，一按开始就抛那句话。
 *
 * 一般化的那句：**一个上下文放行了规范禁止的东西，不等于那条路是通的。**
 * 判据要按规范写，而不是按手边那个浏览器的宽容度写——而「手边那个浏览器」正是
 * 我们唯一跑得起来的那个，所以这类事只能静态查。
 *
 * 这是同一族的第三条。前两条各自只管一件事：
 *
 * | | 管什么 | 从哪个入口走 |
 * |---|---|---|
 * | `offscreen-contract.test.js` | offscreen 里的 `chrome.*` 白名单 | offscreen |
 * | `execution-context.test.js` | OpfsFileStore / WorkerFileStore 摆在哪一侧 | 按目录 |
 * | **这一条** | **Web 平台那一侧：这个上下文里根本不存在的东西** | 四个入口各走一遍 |
 *
 * ## 为什么是黑名单，而这一次黑名单是够的
 *
 * 这个仓库的习惯是白名单（`offscreen-contract.test.js` 就是），理由是「没想到的
 * 那一个」总会漏。这里反过来，因为**要挡的集合是闭的、而且是规范定的**：service
 * worker 与专用 Worker 里没有的，就是 `window` / `document` 那一整套，外加规范点名
 * 禁止的 `import()`。它不会以「又冒出一个新 DOM API」的方式增长。
 *
 * 代价照说：**黑名单挡不住没列进来的东西**。所以还有第二道——每个入口的模块数有
 * 下界，而新模块自动被扫；漏的只可能是「老模块里新用了一个没列的 API」。
 *
 * ## 每条判据自己也要被验一遍
 *
 * 「一个不可能失败的检查证明不了什么」在这个仓库记过四次。正则写错的症状是
 * **永远绿**，所以每条规则都带一段 `sample`（必须命中）和一段 `near`（必须不命中，
 * 挡的是 `documentation` 这种误伤），下面第一条测试逐条跑它们。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { FIREFOX_MANIFEST } from '../tools/make-manifest.mjs';

const norm = (f) => relative(process.cwd(), resolve(f)).replace(/\\/g, '/');

/** 去掉注释再查：注释里**正需要**写「service worker 里没有 document」。 */
const strip = (t) => t
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 再去掉字符串字面量：`chrome.runtime.getURL('…/opfs-worker.js')` 里的路径不是调用点。 */
const code = (t) => strip(t)
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

/**
 * 一条判据看到的是哪一份文本。
 *
 * 绝大多数看 `code()`（注释和字符串都去掉）——`chrome.runtime.getURL('…/opfs-worker.js')`
 * 里的路径不是调用点，界面文案里出现「window」两个字也不是。
 *
 * **但有一条的信号本身就在字符串里**：`addEventListener('fetch', …)`。它只能看
 * `strip()`（只去注释）。这一格是写这条测试时被自己的样例逼出来的——原来那条规则
 * 跑在 `code()` 上，而 `code()` 会把 `'fetch'` 抹成 `''`，于是它**永远不可能命中**。
 * 「一个不可能失败的检查证明不了什么」，这次是当场抓到的。
 *
 * @param {{on?: 'code'|'text'}} rule
 */
const textFor = (rule, src) => (rule.on === 'text' ? strip(src) : code(src));

/**
 * 顺着**静态** import 走。
 *
 * 只跟 `from`，不跟 `import()`：动态 import 的那一头是**另一个上下文**
 * （`host-page.js` 里的整条抓取链跑在事件页里，不在 service worker 里），
 * 跟进去会把另一个上下文的规矩套到这一个头上。
 */
function graphOf(entry) {
  const seen = new Set();
  const queue = [norm(entry)];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f) || !existsSync(f)) continue;
    seen.add(f);
    for (const m of strip(readFileSync(f, 'utf8')).matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
      if (m[1].startsWith('.')) queue.push(norm(join(dirname(f), m[1])));
    }
  }
  return [...seen];
}

/** `window` / `document` 那一套 —— service worker 与专用 Worker 里都没有。 */
const NO_DOM = [
  { id: 'document', re: /\bdocument\s*[.[]/, sample: 'const el = document.querySelector("x");', near: 'documentation.md 里写着' },
  { id: 'window', re: /\bwindow\s*[.[]/, sample: 'window.addEventListener("x", f);', near: 'const windowSize = 3;' },
  { id: 'localStorage', re: /\blocalStorage\b/, sample: 'localStorage.setItem("a", "b");' },
  { id: 'sessionStorage', re: /\bsessionStorage\b/, sample: 'sessionStorage.clear();' },
  { id: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/, sample: 'const x = new XMLHttpRequest();' },
  { id: 'DOMParser', re: /\bnew\s+DOMParser\s*\(/, sample: 'const p = new DOMParser();' },
  { id: 'alert/confirm/prompt', re: /(?:^|[^.\w])(?:alert|confirm|prompt)\s*\(/m, sample: 'alert("hi");', near: 'const ok = await this.confirmDialog(x);' },
];

/** service worker 里没有的，但**页面和专用 Worker 都有**，所以单列。 */
const NO_WORKER_SPAWN = [
  { id: 'new Worker', re: /\bnew\s+Worker\s*\(/, sample: 'const w = new Worker(u);' },
  { id: 'new SharedWorker', re: /\bnew\s+SharedWorker\s*\(/, sample: 'const w = new SharedWorker(u);' },
];

/** 规范明文禁止的（不是「没有这个 API」，是「有，但这个作用域里不许用」）。 */
const NO_DYNAMIC_IMPORT = [
  // `near` 那一段是 JSDoc 里的类型标注 —— 它命不中，**靠的是 `code()` 先去掉了注释**，
  // 而不是靠正则本身。写在这儿是因为这条依赖不写下来就看不见：哪天有人把去注释
  // 那一步挪走，全仓库每一处 `@param {import('…')}` 都会被判成违规。
  // `on: 'text'`（去注释、**留字符串**）：例外要按「引哪个目标」点名，而目标名就是
  // 那个字符串——`code()` 会把它抹成 `''`，例外就只能放行整个文件了。
  { id: "dynamic import()", on: 'text', re: /\bimport\s*\(\s*['"`]/, sample: "const m = await import('./x.js');", near: '/** @param {import("./x.js").T} a */' },
];

/** 反方向：**只有** service worker 有，事件页没有。后台入口两边都要跑得起来。 */
const NO_SW_ONLY = [
  { id: 'clients', re: /\bclients\s*\./, sample: 'await clients.matchAll();' },
  { id: 'skipWaiting', re: /\bskipWaiting\s*\(/, sample: 'self.skipWaiting();' },
  // `on: 'text'`：这条的信号在字符串里，去掉字符串就什么都不剩了。
  { id: 'install/activate/fetch 事件', on: 'text', re: /addEventListener\s*\(\s*['"](?:install|activate|fetch)['"]/, sample: "self.addEventListener('fetch', f);" },
  { id: 'importScripts', re: /\bimportScripts\s*\(/, sample: "importScripts('a.js');" },
];

/**
 * 四个入口，各自的上下文。
 *
 * `allow` 里的每一条都是一次**有理由的例外**，按「哪个文件、哪条规则」点名——
 * 整个文件放行等于把这条规则在那儿关掉。下面还有一条测试盯着它：
 * **例外不许多余**，用不上了就得删（一个没人需要的例外就是一个洞）。
 */
/**
 * 后台入口从**两份 manifest 里读**，不在这儿抄一遍。
 *
 * 抄一份的话，改了 manifest 而这条测试还在扫老文件——它照样绿，而扫的是一个
 * 已经没人加载的入口。这个仓库为「同一份名单写两遍」付过好几次学费。
 */
function backgroundEntry() {
  const chromeMf = JSON.parse(readFileSync('manifest.json', 'utf8'));
  const geckoMf = JSON.parse(readFileSync(FIREFOX_MANIFEST, 'utf8'));
  const sw = chromeMf.background?.service_worker;
  const scripts = geckoMf.background?.scripts ?? [];

  // **不在这儿 assert。** 这个函数在模块加载时就跑（下面那张表要用它），而在那儿
  // 抛异常会把整个文件带走、只留一段堆栈——报出来的不是「两份 manifest 分家了」，
  // 而是「这个测试文件加载失败」。所以问题攒起来，交给一条有名字的测试去说。
  const problems = [];
  if (!sw) problems.push('manifest.json 里没有 background.service_worker');
  if (scripts.length !== 1) problems.push(`Firefox 那份的 background.scripts 有 ${scripts.length} 个文件，不是一个`);
  // 同一个文件跑在两种上下文里 —— 这正是这条契约要取「交集」的原因。
  // 哪天它们分家了，这条契约的前提就没了，得有人重新想一遍。
  else if (scripts[0] !== sw) problems.push(`两份 manifest 的后台入口分家了：${sw} vs ${scripts[0]}`);

  return { entry: sw ?? 'src/background.js', problems };
}

const BACKGROUND = backgroundEntry();

/**
 * 专用 Worker 的入口从**调用点里读**：`new Worker(chrome.runtime.getURL('…'))`。
 *
 * 好处是加第四个 Worker 时这条契约自己会发现（下面「入口都覆盖到了」那条测试
 * 会红），而不是等它在某个浏览器上炸。
 */
function workerEntries() {
  const out = new Set();
  for (const f of allSourceFiles()) {
    const c = strip(readFileSync(f, 'utf8'));
    for (const m of c.matchAll(/new\s+Worker\s*\(\s*chrome\.runtime\.getURL\(\s*['"]([^'"]+)['"]/g)) {
      out.add(norm(m[1]));
    }
  }
  return [...out].sort();
}

/** `src/` 下所有 .js。 */
function allSourceFiles() {
  /** @param {string} dir */
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? walk(join(dir, e.name)) : (e.name.endsWith('.js') ? [norm(join(dir, e.name))] : [])
  ));
  return walk('src');
}

const CONTEXTS = [
  {
    name: '后台入口：Chrome/Edge 是 service worker，Firefox 是事件页',
    entry: BACKGROUND.entry,
    // 同一个文件跑在两种上下文里，所以要的是**交集**：任一边没有的都不许用。
    rules: [...NO_DOM, ...NO_WORKER_SPAWN, ...NO_DYNAMIC_IMPORT, ...NO_SW_ONLY],
    minModules: 10,
    allow: [{
      file: 'src/runtime/host.js',
      rule: 'dynamic import()',
      // **例外按「引哪个目标」点名，不是「这个文件随便引」。** 差别就是 1.4.0 那个
      // bug：它在同一个文件里对 `host-offscreen.js` 也用了 `import()`，而那一条
      // 是 Chrome 那条路唯一要走的路。放行整个文件的话，回归会被自己的例外放过去。
      only: /\bimport\s*\(\s*'\.\/host-page\.js'\s*\)/g,
      // 这一条是 #12 的落点，所以理由写全：它只在**没有** offscreen 时才求值，
      // 而那时后台是事件页，禁令管不着。Chrome 那条分支是静态引的。
      why: 'Firefox 那条分支：只在没有 offscreen 时才求值，那时后台是事件页，'
        + '而 `host-page.js` 会把整条抓取链拉进当前上下文，静态引会让 service worker '
        + '连 offscreen.js 一起拖进来。Chrome 那条分支是静态 import。',
    }],
  },
  ...workerEntries().map((entry) => ({
    name: `专用 Worker：${entry}`,
    entry,
    rules: [...NO_DOM],
    minModules: 3,
    allow: [],
  })),
];

describe('上下文能力契约', () => {
  test('每条判据都真的认得出它要挡的东西', () => {
    const all = [...NO_DOM, ...NO_WORKER_SPAWN, ...NO_DYNAMIC_IMPORT, ...NO_SW_ONLY];
    assert.ok(all.length >= 12, `只有 ${all.length} 条判据，表多半被砍了`);
    for (const r of all) {
      // **跑的是真检查那条管道**（`textFor`），不是裸正则。原来只测裸正则，
      // 于是那条 `addEventListener('fetch')` 的判据自测通过、真跑时永远不命中。
      assert.ok(
        r.re.test(textFor(r, r.sample)),
        `判据 ${r.id} 认不出自己的样例 —— 它会永远绿`,
      );
      if (r.near) {
        assert.equal(
          r.re.test(textFor(r, r.near)),
          false,
          `判据 ${r.id} 误伤了 ${JSON.stringify(r.near)}`,
        );
      }
    }
  });

  for (const ctx of CONTEXTS) {
    test(`${ctx.name}`, () => {
      const graph = graphOf(ctx.entry);
      assert.ok(
        graph.length >= ctx.minModules,
        `从 ${ctx.entry} 只走到 ${graph.length} 个模块（至少该有 ${ctx.minModules}）—— 走图的正则多半坏了`,
      );

      const excused = new Map(ctx.allow.map((a) => [`${norm(a.file)}::${a.rule}`, a]));
      for (const f of graph) {
        const src = readFileSync(f, 'utf8');
        for (const r of ctx.rules) {
          const text = textFor(r, src);
          const hits = [...text.matchAll(new RegExp(r.re.source, `${r.re.flags.replace('g', '')}g`))];
          if (!hits.length) continue;

          const a = excused.get(`${f}::${r.id}`);
          assert.ok(
            a,
            `${f} 用了 \`${r.id}\`，而它跑在「${ctx.name}」里 —— 那儿没有这个东西。\n`
            + '这不是「本机能跑就行」：#12 就是桌面浏览器放行了规范禁止的东西，'
            + '而另一个浏览器照规范办事。',
          );

          // 例外点了名的话，**这个文件里的每一处**都得落在那个名下。放行整个文件
          // 等于把这条规则在那儿关掉，而 1.4.0 的回归正是同一个文件里的第二处。
          if (a.only) {
            const ok = [...text.matchAll(a.only)];
            assert.equal(
              hits.length, ok.length,
              `${f} 里有 ${hits.length} 处 \`${r.id}\`，而例外只认得 ${ok.length} 处。`
              + `例外放的是 ${a.only}，多出来的那几处得自己说清楚为什么。`,
            );
          }
        }
      }
    });
  }

  test('后台那一个入口，两份 manifest 说的是同一个文件', () => {
    // 这条契约取的是 service worker 与事件页的**交集**，而那个「交集」只有在
    // 两边真的是同一个文件时才有意义。分家了就得有人重新想一遍，而不是让这张
    // 表继续按老前提往下查。
    assert.deepEqual(BACKGROUND.problems, []);
    assert.ok(existsSync(BACKGROUND.entry), `后台入口 ${BACKGROUND.entry} 不存在`);
  });

  test('每个真的会被加载的入口都在表里', () => {
    // 这条挡的是「加了个新入口，没人想起来它跑在哪个上下文里」。后台那个从
    // manifest 读、Worker 那些从 `new Worker(...)` 的调用点读，所以新增一个
    // 会自动进表——这条测试确认的是**它们真的被读出来了**，而不是正则坏了、
    // 表变空、然后所有检查一起变成空循环。
    const workers = workerEntries();
    assert.ok(workers.length >= 3, `只找到 ${workers.length} 个 Worker 入口，正则多半坏了`);
    for (const w of workers) assert.ok(existsSync(w), `${w} 不存在 —— 调用点指着一个没有的文件`);
    assert.equal(CONTEXTS.length, workers.length + 1, '入口数与上下文数对不上');
  });

  test('例外不许多余 —— 用不上了就得删', () => {
    // 一个没人需要的例外就是一个洞：它看起来像有人想过，实际上把那条规则
    // 在那个文件里永久关掉了。这个仓库为「一个永远不会触发的守卫」付过学费。
    let checked = 0;
    for (const ctx of CONTEXTS) {
      for (const a of ctx.allow) {
        const rule = ctx.rules.find((r) => r.id === a.rule);
        assert.ok(rule, `${ctx.entry} 的例外写着一条不存在的判据：${a.rule}`);
        assert.ok(existsSync(a.file), `例外指着一个不存在的文件：${a.file}`);
        assert.ok(
          rule.re.test(textFor(rule, readFileSync(a.file, 'utf8'))),
          `${a.file} 已经不用 \`${a.rule}\` 了 —— 这条例外该删掉，留着就是个洞`,
        );
        assert.ok(a.why && a.why.length > 20, `${a.file} 的例外没写理由`);
        checked += 1;
      }
    }
    assert.equal(checked, 1, `例外总数变成了 ${checked} —— 每加一条都该有人看见`);
  });
});
