#!/usr/bin/env node
/**
 * 打一个可以上传到 Chrome 应用商店的 zip。
 *
 *   node tools/package.mjs            # 产出 dist/doubak-<版本>.zip
 *   node tools/package.mjs --list     # 只列要打进去的文件，不写盘
 *   node tools/package.mjs --stage D  # 把同一份名单摊到目录 D（给「加载已解压的扩展程序」用）
 *
 * ## 为什么需要一个脚本
 *
 * 这个项目**刻意没有构建步骤**（`docs/toolchain.md`），源码直接就是运行的代码。
 * 好处是没有构建产物要信任；代价是**打包全靠手工挑文件**，而手工挑的东西迟早会
 * 漏一个或多带一个。
 *
 * 多带的代价不只是体积：`test/` 里有真实账号的用户名与数字 uid（那是刻意保留的，
 * 见 CLAUDE.md），没必要连同扩展一起分发给每一个装它的人。而审核那边每多一个
 * 文件就多一分被问的可能。
 *
 * ## 名单是「带什么」，不是「不带什么」
 *
 * 白名单。黑名单漏一条的后果是**多打进去一个不该有的东西且没人发现**；白名单
 * 漏一条的后果是扩展装上就报错——后者一眼就能看见。
 */

import {
  readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync,
} from 'node:fs';
import { deflateRawSync, crc32 } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 要打进 zip 的东西。**改这里之前先想清楚扩展运行时到底要不要它。**
 *
 * `selftest/` 在这张单子上，因为调试页有个「打开自检页」的按钮真的会打开它
 * （`panel.js` 里的 `chrome.runtime.getURL('selftest/index.html')`）——
 * 不带上，那个按钮就是个死链。
 */
const INCLUDE = [
  'manifest.json',
  'LICENSE',
  // manifest 里 `default_locale` 指着它。漏掉的后果不是「名字变回英文」——
  // Chrome 会**整个拒绝加载**这个扩展，而 collect() 只在名单里的路径不存在时才抛，
  // 所以本地一切正常，问题要到上传审核时才出现，那时名字已经改了。
  '_locales',
  'icons',
  'src',
  'selftest',
  // **`selftest/worker.js` 会 import 这两个契约文件。** 它们躺在 `test/` 下，而
  // `test/` 整个不进包（里面有真实账号的用户名与 uid，那正是这张白名单存在的理由）
  // ——于是发出去的包里，自检页的 Worker **在加载时就死了**，按钮点开是一片空白。
  // 本地一切正常，因为开发时载入的是仓库根目录，`test/` 就在旁边。
  //
  // 它们不是夹带测试：两个文件都零 import、不含任何账号信息，而且开头就写着
  // 「刻意不依赖 node:test 或任何断言库：浏览器里也要能跑」——**它们是共享契约，
  // 只是碰巧住在 test/ 底下**。所以逐个列出来，而不是把 `test/` 整个放进来。
  'test/helpers/file-store-contract.js',
  'test/helpers/kv-store-contract.js',
];

/** 就算落在上面那些目录里也不要的。 */
const EXCLUDE_RE = /(^|\/)(\.DS_Store|Thumbs\.db|.*\.map)$/;

/** @returns {string[]} 相对 ROOT 的文件路径 */
function collect(rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) throw new Error(`名单里有 ${rel}，但它不存在`);
  if (!statSync(abs).isDirectory()) return EXCLUDE_RE.test(rel) ? [] : [rel];
  const out = [];
  for (const name of readdirSync(abs)) out.push(...collect(join(rel, name)));
  return out;
}

/**
 * 打给哪个浏览器。**同一份文件名单，两处差异，逐条写明理由。**
 *
 * 为什么不是两份名单：漂移的方向是固定的——Chrome 那份加了个新文件，Firefox 那份
 * 忘了跟，而症状是装得上、某个功能悄悄不工作。所以名单只有一份，两个包的差别只有
 * 「用哪个 manifest」与「去掉哪几个用不上的文件」。
 */
const TARGETS = {
  chrome: { manifest: 'manifest.json', suffix: '', drop: [] },
  firefox: {
    manifest: 'manifest.firefox.json',
    suffix: '-firefox',
    // **这两个在 Firefox 上永远走不到，带着只会让 web-ext lint 报 UNSUPPORTED_API。**
    // host-offscreen.js 只由 `runtime/host.js` 在 `offscreen.createDocument` 存在时
    // 动态 import，而 Firefox 上它不存在；offscreen.html 是那个文档本身。
    // 注意 `src/offscreen/offscreen.js` **要留着**——Firefox 那条路正是靠它的
    // `handleOp`，两个宿主共用同一份 switch。
    drop: ['src/runtime/host-offscreen.js', 'src/offscreen/offscreen.html'],
  },
};

const targetName = process.argv.includes('--firefox') ? 'firefox' : 'chrome';
const target = TARGETS[targetName];

const manifest = JSON.parse(readFileSync(join(ROOT, target.manifest), 'utf-8'));
const files = INCLUDE.flatMap(collect).sort().filter((f) => !target.drop.includes(f));

// ── 几条上传前必须成立的
const problems = [];

/**
 * `test/` 底下**唯一**允许进包的几个文件。
 *
 * 逐个列出，不是放开 `test/` 这个前缀——放开前缀的话，下一个进 `test/helpers/` 的
 * 文件会自动搭上顺风车，而这张守卫存在的理由是 `test/` 里有真实账号的用户名与 uid。
 * 名单短、要手动加，正是它的价值所在。
 *
 * 为什么这几个非进不可，见 INCLUDE 里的说明。
 */
const TEST_FILES_ALLOWED = new Set([
  'test/helpers/file-store-contract.js',
  'test/helpers/kv-store-contract.js',
]);

// **不许把测试与开发用的东西打进去。**
for (const f of files) {
  if (TEST_FILES_ALLOWED.has(f)) continue;
  if (/^(test|tools|docs|node_modules|\.git)\//.test(f)) problems.push(`不该打包：${f}`);
}

// manifest 引用到的文件必须都在包里。少一个的话，扩展装上才发现——而那时
// 已经过了一轮审核。
const manifestRefs = [
  manifest.background?.service_worker,
  // Firefox 那份是事件页：入口在 `background.scripts` 里。两边都查，否则换个目标
  // 就等于把这条检查关掉了——而它防的正是「装上才发现少了个文件」。
  ...(manifest.background?.scripts ?? []),
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
].filter(Boolean);
for (const r of manifestRefs) {
  if (!files.includes(r)) problems.push(`manifest 引用了 ${r}，但它不在包里`);
}

// 应用商店只收 x.y.z。
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) problems.push(`版本号不合格式：${manifest.version}`);

if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

/**
 * 包里叫 `manifest.json` 的那一条，内容从哪儿读。
 *
 * **包里的名字必须是 `manifest.json`**（浏览器只认这个），而 Firefox 那份在仓库里
 * 叫 `manifest.firefox.json`。这一层映射只在这一个地方，别处一律按包里的名字说话。
 *
 * @param {string} name 包里的路径
 */
function sourceOf(name) {
  return name === 'manifest.json' ? target.manifest : name;
}

const bytes = files.reduce((n, f) => n + statSync(join(ROOT, sourceOf(f))).size, 0);

if (process.argv.includes('--list')) {
  for (const f of files) console.log(f);
  console.log(`\n${files.length} 个文件 · ${(bytes / 1024 / 1024).toFixed(2)} MB（未压缩）`);
  process.exit(0);
}

/**
 * `--stage <目录>`：把**同一份名单**原样摊到一个目录里。
 *
 * 为什么要有这个：应用商店收的是 zip，而「加载已解压的扩展程序」要的是一个**目录**。
 * CI 里把这个目录当构建产物传上去，GitHub 会自己再压一层——下载解压出来就是可以直接
 * 加载的那个目录，中间不用手工挑文件。
 *
 * 关键是名单只有一份。要是 CI 里另写一段 `cp -r`，它迟早与 `INCLUDE` 漂移，
 * 而漂移的方向多半是「多带了 test/」——那里面有真实账号的用户名与 uid。
 */
const stageAt = process.argv.indexOf('--stage');
if (stageAt !== -1) {
  const dest = process.argv[stageAt + 1];
  if (!dest) {
    console.error('  ✗ --stage 后面要跟一个目录');
    process.exit(1);
  }
  rmSync(dest, { recursive: true, force: true });
  for (const f of files) {
    mkdirSync(join(dest, dirname(f)), { recursive: true });
    copyFileSync(join(ROOT, sourceOf(f)), join(dest, f));
  }
  console.log(`${dest}`);
  console.log(`  ${files.length} 个文件 · ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log('  这个目录可以直接用 chrome://extensions 的「加载已解压的扩展程序」打开。');
  process.exit(0);
}

/**
 * **带着开发用 id 不许出 Firefox 的包**（除非明说 `--dev`）。
 *
 * 上传一个 id 不对的包，AMO 不会报错——它会把它当成一个**新的扩展**建一条上架
 * 记录，于是现有的评价与用户都不在这一份上，已经装了的人也收不到更新。那是那种
 * 「看起来成功了」的失败，而且发生在最不可逆的一步上。
 *
 * `--list` 不受影响：测试要用它，而列文件名不会把任何东西发出去。
 */
if (targetName === 'firefox') {
  const id = manifest.browser_specific_settings?.gecko?.id;
  if (id === 'doubak-dev@localhost' && !process.argv.includes('--dev')) {
    console.error(`  ✗ 这一份的 gecko.id 还是开发用的 ${id}。`);
    console.error('    上传 AMO 前必须给真的：DOUBAK_GECKO_ID=… node tools/make-manifest.mjs');
    console.error('    只是本地装来试的话，加 --dev。');
    process.exit(1);
  }
}

const out = join(ROOT, 'dist');
mkdirSync(out, { recursive: true });
const zip = join(out, `doubak-${manifest.version}${target.suffix}.zip`);
rmSync(zip, { force: true });

writeFileSync(zip, makeZip(files));

const zipped = statSync(zip).size;
console.log(`${zip}`);
console.log(`  ${files.length} 个文件 · ${(bytes / 1024 / 1024).toFixed(2)} MB → ${(zipped / 1024 / 1024).toFixed(2)} MB`);
console.log('  上传前请自己再确认一遍：解开它，manifest.json 应当就在根部。');

// 顺手把清单写出来，便于与上一版比对「这次多了/少了什么」。
writeFileSync(join(out, `doubak-${manifest.version}${target.suffix}.files.txt`), `${files.join('\n')}\n`);


/**
 * 自己写 zip，不调系统的 `zip`。
 *
 * 一来这个项目的工具链原则就是不依赖外部程序（`docs/toolchain.md`），二来
 * 实测这台开发机上压根没有 `zip` —— 一个「在我机器上能跑」的发布脚本等于没有。
 * Node 自带 `deflateRawSync` 与 `crc32`，剩下的只是几个定长头。
 *
 * **包里不能有顶层目录**：Chrome 要求 `manifest.json` 就在压缩包根部。
 * 这里按相对 ROOT 的路径写条目，正好是这个形状。
 *
 * @param {string[]} names 相对 ROOT 的路径
 */
function makeZip(names) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const name of names) {
    const raw = readFileSync(join(ROOT, sourceOf(name)));
    const deflated = deflateRawSync(raw, { level: 9 });
    // 压不小的就原样存。zip 允许逐条选方法，而对已经压过的 png 来说
    // deflate 往往反而更大。
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const sum = crc32(raw);
    const nameBuf = Buffer.from(name, 'utf-8');

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // 需要的版本
    lh.writeUInt16LE(0x0800, 6);      // 文件名是 UTF-8
    lh.writeUInt16LE(method, 8);
    // 时间戳一律写 0（1980-01-01）。**要的是可复现**：同样的源码打出逐字节
    // 相同的包，才能核对「上传的到底是不是我构建的那个」。
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(sum, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(sum, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, eocd]);
}
