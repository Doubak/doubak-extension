#!/usr/bin/env node
/**
 * 打一个可以上传到 Chrome 应用商店的 zip。
 *
 *   node tools/package.mjs            # 产出 dist/doubak-<版本>.zip
 *   node tools/package.mjs --list     # 只列要打进去的文件，不写盘
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
  readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync, existsSync,
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
  'icons',
  'src',
  'selftest',
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

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf-8'));
const files = INCLUDE.flatMap(collect).sort();

// ── 几条上传前必须成立的
const problems = [];

// **不许把测试与开发用的东西打进去。**
for (const f of files) {
  if (/^(test|tools|docs|node_modules|\.git)\//.test(f)) problems.push(`不该打包：${f}`);
}

// manifest 引用到的文件必须都在包里。少一个的话，扩展装上才发现——而那时
// 已经过了一轮审核。
const manifestRefs = [
  manifest.background?.service_worker,
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

const bytes = files.reduce((n, f) => n + statSync(join(ROOT, f)).size, 0);

if (process.argv.includes('--list')) {
  for (const f of files) console.log(f);
  console.log(`\n${files.length} 个文件 · ${(bytes / 1024 / 1024).toFixed(2)} MB（未压缩）`);
  process.exit(0);
}

const out = join(ROOT, 'dist');
mkdirSync(out, { recursive: true });
const zip = join(out, `doubak-${manifest.version}.zip`);
rmSync(zip, { force: true });

writeFileSync(zip, makeZip(files));

const zipped = statSync(zip).size;
console.log(`${zip}`);
console.log(`  ${files.length} 个文件 · ${(bytes / 1024 / 1024).toFixed(2)} MB → ${(zipped / 1024 / 1024).toFixed(2)} MB`);
console.log('  上传前请自己再确认一遍：解开它，manifest.json 应当就在根部。');

// 顺手把清单写出来，便于与上一版比对「这次多了/少了什么」。
writeFileSync(join(out, `doubak-${manifest.version}.files.txt`), `${files.join('\n')}\n`);


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
    const raw = readFileSync(join(ROOT, name));
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
