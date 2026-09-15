/**
 * 把面板渲染成一张 PNG —— **一台不需要装扩展就能看见界面的量具。**
 *
 * ## 为什么需要它
 *
 * 这个面板的界面几乎全是 JS 画的：状态卡、进度表、档案清单、导出结果，静态读
 * `panel.html` 一行都看不到。于是「改完长什么样」此前只有两条路：装进浏览器手动点，
 * 或者靠读代码想象。第二条是这个仓库明确栽过的——CLAUDE.md 里那两个 bug
 * （动作词里多出来的空格、书名号里凭空多的两格）都写着「**是看生成出来的站点看出来的**，
 * 测试全绿的时候它们都在」。界面这一侧一直没有对应的量具。
 *
 * 2026-09-15 那次 UI 改动是拿它量的：七个标签页的真实高度（帮助 4584px，是第二长
 * 那页的 4.6 倍）、导出页改小标签前后的 1080 → 780px、以及铺 14 份真档案之后的档案页
 * ——**结论因此改了一个**：本来打算给档案清单加滚动，看过之后没改（那条路早就被
 * 试过又撤回，理由写在 panel.css 里）。
 *
 * ## 三个坎，每个都会让截图看起来正常而其实是错的
 *
 * **① `file://` 下 ES 模块加载不了。** Firefox 按不透明来源处理，模块图整个不执行，
 * 而页面照样渲染出静态骨架——截出来是一张「界面没坏但什么都没填」的图，看不出
 * 是脚本压根没跑。所以走一个本地 HTTP 服务。
 *
 * **② `--screenshot` 在 `load` 那一刻截图，而界面是异步画出来的。** 截到的是
 * 「正在读取状态…」。解法是挂一张**慢慢才回**的图（`/slow`）：`load` 要等图片，
 * 于是异步渲染有时间跑完。没有这一条，这台量具量什么都是空的。
 *
 * **③ 面板一起来就开 OPFS worker 去读档案目录，而 worker 拿着 sync access handle
 * 的时候写同一个文件会抛 `NoModificationAllowedError`。** 所以顺序是**先铺数据，
 * 再动态 import panel.js**，不能让 `<script type="module">` 自己先跑。
 *
 * ## 假答复是量具的一部分，而它骗过我两次
 *
 * 写这台量具时，假后台答错了两处，两次都在屏幕上显示成「像是产品的 bug」：
 *
 * - 路线 key 编了 `interest.movie.done`，而真实状态词是 `collect / do / wish`
 *   ——于是截图里混着中文名和内部标识，看起来像 `route-names.js` 漏了几条
 *   （那件事真发生过，见它的文件头），实际是假数据编错了；
 * - 存储那一栏传了 `quota / usage`，而界面读的是 `available / need`，于是显示
 *   「可用 NaN GB」。
 *
 * 两次都是**量具错了，被当成被量的东西错了**。所以 `test/panel-shot.test.js` 钉住
 * 一条：面板发得出的每一种消息，这里都要么有答复、要么明写在「故意不答」名单里。
 *
 * ## 用法
 *
 *     node tools/panel-shot.mjs <标签页> [选项]
 *
 *     node tools/panel-shot.mjs formats --out=/tmp/导出页.png
 *     node tools/panel-shot.mjs overview --state=crawling
 *     node tools/panel-shot.mjs archive --bundles=14 --theme=light
 *     node tools/panel-shot.mjs help --height=5200
 *     node tools/panel-shot.mjs overview --measure        # 只报各页高度，不截图
 *
 * 要 Firefox（`FIREFOX=/path/to/firefox` 可指定）。没有就明说，不装、不猜。
 * **产出只落在 `--out` 指的地方**，临时目录用完就删（`--keep` 留着排查）。
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 慢慢才回的那张 1×1 PNG，用来把 `load` 按住。见文件头第②条。 */
const SLOW_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

/** @param {string[]} argv */
function parseArgs(argv) {
  const o = {
    tab: 'overview', state: 'first-run', bundles: 0,
    width: 1280, height: 1000, theme: 'dark', wait: 4000,
    out: null, keep: false, measure: false,
  };
  for (const a of argv) {
    if (!a.startsWith('--')) { o.tab = a; continue; }
    const [k, v = 'true'] = a.slice(2).split('=');
    if (!(k in o)) throw new Error(`不认识的选项：--${k}`);
    o[k] = typeof o[k] === 'number' ? Number(v) : typeof o[k] === 'boolean' ? v !== 'false' : v;
  }
  o.out ??= join(tmpdir(), `doubak-panel-${o.tab}.png`);
  return o;
}

/** Firefox 在哪。**找不到就说清楚**，别让它以一个 0 字节的 png 收场。 */
function findFirefox() {
  const cands = [process.env.FIREFOX, '/usr/bin/firefox', '/snap/bin/firefox',
    '/Applications/Firefox.app/Contents/MacOS/firefox'].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
  const which = spawnSync('which', ['firefox'], { encoding: 'utf-8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return null;
}

/**
 * 把 `src/` 抄进临时目录，并把量具塞进 `panel.html`。
 *
 * **不在仓库里改文件。** 这台量具跑完之后 `git status` 必须是干净的——一个会弄脏
 * 工作区的量具，用一次就会有人把它的产物提交进去。
 */
function stage(opts) {
  const dir = mkdtempSync(join(tmpdir(), 'doubak-shot-'));
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'manifest.json'), join(dir, 'manifest.json'));
  cpSync(join(ROOT, 'tools', 'panel-shot-harness.js'), join(dir, 'src', 'ui', '_harness.js'));

  const page = join(dir, 'src', 'ui', 'panel.html');
  let html = readFileSync(page, 'utf-8');
  const tag = '<script type="module" src="./panel.js"></script>';
  if (!html.includes(tag)) throw new Error('panel.html 里找不到 panel.js 的 script 标签');
  // 量具**取代** panel.js 的标签：它要先铺好数据再 `import('./panel.js')`。见第③条。
  html = html.replace(tag, '<script type="module" src="./_harness.js"></script>');
  html = html.replace('</body>', `  <img src="/slow?ms=${opts.wait}" alt="" width="1" height="1">\n</body>`);
  writeFileSync(page, html);
  return dir;
}

/** @param {string} dir @returns {Promise<{port: number, close: () => void}>} */
function serve(dir) {
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/slow') {
      // 见文件头第②条：`load` 要等这张图，异步渲染才来得及跑完。
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': SLOW_PNG.length });
        res.end(SLOW_PNG);
      }, Number(u.searchParams.get('ms') ?? 3000));
      return;
    }
    const p = join(dir, decodeURIComponent(u.pathname));
    if (!p.startsWith(dir) || !existsSync(p) || statSync(p).isDirectory()) {
      res.writeHead(404); res.end('no'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] ?? 'application/octet-stream' });
    res.end(readFileSync(p));
  });
  return new Promise((ok) => {
    srv.listen(0, '127.0.0.1', () => ok({ port: srv.address().port, close: () => srv.close() }));
  });
}

const opts = parseArgs(process.argv.slice(2));
const firefox = findFirefox();
if (!firefox) {
  console.error('找不到 Firefox。装一个，或者 FIREFOX=/path/to/firefox 指给它。');
  console.error('（这台量具只用来看界面，不是测试的一部分——没有它 `npm test` 照常全绿。）');
  process.exit(2);
}

const dir = stage(opts);
const { port, close } = await serve(dir);
const profile = mkdtempSync(join(tmpdir(), 'doubak-prof-'));
// 主题跟着系统走（panel.css 用的是 prefers-color-scheme），所以在配置里定。
// 每次都用**新配置**：OPFS 是按来源存的，留着上一次的档案会让这次的 --bundles 说不准。
writeFileSync(join(profile, 'user.js'),
  `user_pref("ui.systemUsesDarkTheme", ${opts.theme === 'light' ? 0 : 1});\n`);

const q = new URLSearchParams({
  tab: opts.tab, state: opts.state,
  bundles: String(opts.bundles), measure: String(opts.measure),
});
const url = `http://127.0.0.1:${port}/src/ui/panel.html?${q}`;
// **必须是异步的 spawn。** 服务器跑在这同一个进程里，而 `spawnSync` 会把事件循环
// 整个堵死——于是 Firefox 请求页面，这边永远答不上，双方一起等到超时。
// （第一版就是这么写的，症状是「跑 120 秒，一张图都没有」。）
const r = await new Promise((done) => {
  const ff = spawn(firefox, [
    '--headless', '--profile', profile,
    '--window-size', `${opts.width},${opts.height}`,
    '--screenshot', opts.out, url,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  ff.stdout.on('data', (d) => { stdout += d; });
  ff.stderr.on('data', (d) => { stderr += d; });
  const kill = setTimeout(() => ff.kill('SIGKILL'), 120_000);
  ff.on('close', () => { clearTimeout(kill); done({ stdout, stderr }); });
});

close();
if (!opts.keep) { rmSync(dir, { recursive: true, force: true }); rmSync(profile, { recursive: true, force: true }); }

if (!existsSync(opts.out)) {
  console.error('没截出图来。Firefox 说：');
  console.error((r.stderr || r.stdout || '（什么都没说）').split('\n').slice(-12).join('\n'));
  process.exit(1);
}
console.log(`${opts.out}  ${(statSync(opts.out).size / 1024).toFixed(0)} KB  `
  + `[${opts.tab} · ${opts.state} · ${opts.bundles} 份档案 · ${opts.theme} · ${opts.width}×${opts.height}]`);
if (opts.keep) console.log(`临时目录留着了：${dir}`);
