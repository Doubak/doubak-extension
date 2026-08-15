#!/usr/bin/env node
/**
 * 把 doubak-data-parser 的抽取器同步进 src/vendor/parser/。
 *
 *   node tools/sync-extractors.mjs           # 同步
 *   node tools/sync-extractors.mjs --check   # 只比对，不写（测试调用）
 *
 * ## 为什么是「抄一份 + 查新鲜度」，不是重写一份
 *
 * 面板要把档案里的内容显示出来（「这真的是我的东西吗」），而把 HTML 变成条目这件事
 * **解析器已经做过一遍了**，而且是对着真实字节一处处量出来的。在扩展里另写一份浅
 * 一点的，结果是**能力更弱、而且会漂**——两份实现对同一段 HTML 得出不同结论，只是
 * 早晚的事。
 *
 * 这不是假想。`&#34;` 曾经明晃晃地印在 sample.doubak.com 上：当时有**四份**各自演化
 * 的 HTML 实体解码表，其中一份干脆没有。合并成一份之后，未解码的实体从 196 个降到
 * 1 个，而那 1 个是对的。
 *
 * ## 为什么不 import 过去
 *
 * 八个仓库各自独立，扩展打包时只带 `tools/package.mjs` 白名单里的文件；跨仓库的
 * `import` 在装好的扩展里根本不存在。而这个项目又**刻意没有构建步骤**，所以也不能
 * 靠打包器把它们拉进来。
 *
 * 于是走既定的那条路——与 `generate-spec-constants.mjs` 一模一样：**产物提交进仓库**
 * （跑扩展、跑测试都不需要解析器在场，零构建步骤的前提不变），`--check` 由测试调用，
 * 漂了就红，而不是悄悄分叉。
 *
 * ## 只搬纯函数
 *
 * 名单里每个文件都只 import `./html-entities.js`，一个 node 内建都不碰——这是它们能
 * 跑在浏览器里的前提，也由 `test/no-node-builtins.test.js` 兜着。解析器里碰 `node:fs`
 * 的那些（`bundle-source.js`）**不搬**：扩展读的是 OPFS，那一层本来就该各写各的。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'src', 'vendor', 'parser');

/**
 * 要搬哪些。**加一个之前先确认它不碰 node 内建**——否则扩展装上就报错，
 * 而报错的地方离这儿很远。
 */
export const FILES = [
  'html-entities.js',
  'extract.js',
  'extract-broadcast.js',
  'extract-longform.js',
  'extract-doulist.js',
];

/** 解析器仓库在哪。与规范仓库同一套找法。 */
export function findParserDir() {
  const candidates = [
    process.env.DOUBAK_PARSER_DIR,
    join(ROOT, '..', 'doubak-data-parser'),
  ].filter(Boolean);
  return candidates.find((d) => existsSync(join(d, 'src', 'extract.js'))) ?? null;
}

/**
 * 加一行醒目的抬头。**不改任何一行代码**——改了就不再是「同一份」，
 * 而这个脚本的全部意义就是让它们是同一份。
 *
 * @param {string} src @param {string} name
 */
export function stamp(src, name) {
  return `/* 【自动同步，请勿手改】来自 doubak-data-parser 的 src/${name}\n`
    + ` * 改动请在解析器仓库里做，然后运行 node tools/sync-extractors.mjs。\n`
    + ` * 理由见 tools/sync-extractors.mjs：两份实现对同一段 HTML 得出不同结论，只是早晚的事。\n`
    + ` */\n${src}`;
}

/** @param {string} parserDir */
export function renderAll(parserDir) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const name of FILES) {
    out.set(name, stamp(readFileSync(join(parserDir, 'src', name), 'utf-8'), name));
  }
  return out;
}

function main() {
  const parserDir = findParserDir();
  if (!parserDir) {
    console.error('找不到 doubak-data-parser（试过 DOUBAK_PARSER_DIR 与 ../doubak-data-parser）');
    process.exit(2);
  }
  const want = renderAll(parserDir);
  const check = process.argv.includes('--check');

  const stale = [];
  for (const [name, text] of want) {
    const p = join(DEST, name);
    if (!existsSync(p) || readFileSync(p, 'utf-8') !== text) stale.push(name);
  }
  // 多出来的也算漂移：解析器那边删掉一个文件，这边不能还留着。
  const extra = existsSync(DEST)
    ? readdirSync(DEST).filter((f) => f.endsWith('.js') && !want.has(f))
    : [];

  if (check) {
    if (stale.length || extra.length) {
      console.error('vendor 的抽取器过期了：');
      for (const n of stale) console.error(`  与解析器不一致：${n}`);
      for (const n of extra) console.error(`  解析器那边已经没有了：${n}`);
      console.error('请运行 node tools/sync-extractors.mjs');
      process.exit(1);
    }
    console.log(`vendor 的抽取器与解析器一致（${want.size} 个文件）`);
    return;
  }

  mkdirSync(DEST, { recursive: true });
  for (const [name, text] of want) writeFileSync(join(DEST, name), text);
  console.log(`同步了 ${want.size} 个文件 → src/vendor/parser/`);
  if (extra.length) console.log(`  注意：${extra.join('、')} 在解析器那边已经没有了，请手动删除`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
