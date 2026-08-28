#!/usr/bin/env node
/**
 * 把另外三个仓库里的**纯函数**同步进 `src/vendor/`。
 *
 *   node tools/sync-vendor.mjs           # 同步
 *   node tools/sync-vendor.mjs --check   # 只比对，不写（测试调用）
 *
 * ## 为什么是「抄一份 + 查新鲜度」，不是重写一份
 *
 * 面板要把档案解析成 canonical、再导出成 NeoDB 的归档格式。这两件事**另外两个
 * 仓库已经做过了**，而且是对着真实字节一处处量出来的。在扩展里另写一份浅一点的，
 * 结果是能力更弱、而且会漂——两份实现对同一段 HTML 得出不同结论，只是早晚的事。
 *
 * 这不是假想。`&#34;` 曾经明晃晃地印在 sample.doubak.com 上：当时有**四份**各自
 * 演化的 HTML 实体解码表，其中一份干脆没有。合并成一份之后，未解码的实体从 196
 * 个降到 1 个，而那 1 个是对的。
 *
 * ## 为什么不 import 过去，也不用 submodule
 *
 * 八个仓库各自独立，扩展打包时只带 `tools/package.mjs` 白名单里的文件；跨仓库的
 * `import` 在装好的扩展里根本不存在。而这个项目又**刻意没有构建步骤**，也就不能
 * 靠打包器把它们拉进来。
 *
 * submodule 更糟，而且有个具体的理由：`git clone` 不加 `--recursive` 会留下一个
 * **存在但是空的**目录。`package.mjs` 的 `collect()` 只在路径不存在时才抛，空目录
 * 它照收不误——于是打包成功，装出来的扩展里没有解析器。白名单当初就是为了避开
 * 这种「静静少了东西」的失败，不能从后门把它放回来。
 *
 * 所以走既定的那条路——与 `generate-spec-constants.mjs` 一模一样：**产物提交进
 * 仓库**（跑扩展、跑测试都不需要那三个仓库在场，零构建步骤的前提不变），
 * `--check` 由测试与 CI 调用，漂了就红，而不是悄悄分叉。
 *
 * ## 只搬纯函数
 *
 * 名单里每个文件都不碰任何 node 内建——这是它们能跑在浏览器里的前提，也由
 * `test/no-node-builtins.test.js` 兜着。上游那三个仓库各自也有一条
 * `portable.test.js` 守着同一条线，所以「加了个 import 忘了通知扩展」在那边就会红。
 *
 * 碰 `node:fs` 的那些**不搬**：`bundle-source.js`（解析器）、`canonical.js`
 * （导出适配器）、`generate.js`（站点生成器）读的都是文件系统，而扩展读的是
 * OPFS。**「字节从哪儿来」本来就该各写各的，「字节怎么解释」只能有一份。**
 *
 * ## 目录结构照抄，不拉平
 *
 * `targets/neodb-ndjson.js` 里写的是 `import { csv } from '../csv.js'`。拉平到
 * 一个目录就得改那行 import，而**改了就不再是同一份**，逐字节比对也就失去意义。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 三个上游，各自搬哪些文件。
 *
 * **加一个之前先确认它不碰 node 内建**——否则扩展装上就报错，而报错的地方离这儿
 * 很远（如果是在 Worker 里，`ErrorEvent` 上什么信息都没有）。
 */
export const SOURCES = [
  {
    repo: 'doubak-data-parser',
    env: 'DOUBAK_PARSER_DIR',
    probe: 'src/extract.js',
    dest: 'parser',
    /** HTML → 记录，以及 bundle → canonical 的全部逻辑。少的只有「怎么读字节」。 */
    files: [
      'html-entities.js',
      'extract.js',
      'extract-broadcast.js',
      'extract-longform.js',
      'extract-doulist.js',
      'extract-subject.js',
      'sha256.js',
      'digest.js',
      'topology.js',
      'authority.js',
      'parse.js',
    ],
  },
  {
    repo: 'doubak-export-adapters',
    env: 'DOUBAK_ADAPTERS_DIR',
    probe: 'src/targets/neodb-ndjson.js',
    dest: 'export-adapters',
    /** canonical → NeoDB 的 NDJSON 归档。zip 的格式在这儿，压缩由宿主给。 */
    files: [
      'record.js',
      'classify.js',
      'csv.js',
      'instructions.js',
      'zip.js',
      'targets/neodb-ndjson.js',
    ],
  },
  {
    repo: 'doubak-site-generator',
    env: 'DOUBAK_SITEGEN_DIR',
    probe: 'src/markdown.js',
    dest: 'site-generator',
    /** canonical → 投影 → Markdown。图片路径是传进来的，所以这几个是纯的。 */
    files: [
      'yaml.js',
      'projection.js',
      'markdown.js',
      'search.js',
      'pages.js',
      'image-index.js',
    ],
  },
];

/** @param {typeof SOURCES[number]} source */
export function findDir(source) {
  const candidates = [process.env[source.env], join(ROOT, '..', source.repo)].filter(Boolean);
  return candidates.find((d) => existsSync(join(d, source.probe))) ?? null;
}

/**
 * 加一行醒目的抬头。**不改任何一行代码**——改了就不再是「同一份」，
 * 而这个脚本的全部意义就是让它们是同一份。
 *
 * @param {string} src @param {string} name @param {string} repo
 */
export function stamp(src, name, repo) {
  return `/* 【自动同步，请勿手改】来自 ${repo} 的 src/${name}\n`
    + ` * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。\n`
    + ` * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。\n`
    + ` */\n${src}`;
}

/**
 * 一个上游要写出的全部文件。
 * @param {typeof SOURCES[number]} source @param {string} dir
 * @returns {Map<string, string>} 相对 `src/vendor/<dest>/` 的路径 → 内容
 */
export function renderOne(source, dir) {
  const out = new Map();
  for (const name of source.files) {
    out.set(name, stamp(readFileSync(join(dir, 'src', name), 'utf-8'), name, source.repo));
  }
  return out;
}

/** 递归列出一个目录下的 .js（相对路径），不存在就是空。 */
function listJs(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listJs(join(dir, e.name), rel));
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

function main() {
  const check = process.argv.includes('--check');
  const missing = [];
  const plans = [];

  for (const source of SOURCES) {
    const dir = findDir(source);
    if (!dir) { missing.push(source); continue; }
    plans.push({ source, want: renderOne(source, dir) });
  }

  if (missing.length) {
    const names = missing.map((m) => `${m.repo}（试过 ${m.env} 与 ../${m.repo}）`);
    // **本地缺仓库时是「带原因跳过」，CI 里必须是失败。** 跳过在 CI 里等于没测，
    // 而这个检查的全部价值就在于它真的跑过。
    console.error(`找不到：${names.join('；')}`);
    if (process.env.CI) { console.error('CI 里这算失败：跳过等于没测'); process.exit(2); }
    if (check) { console.error('本地缺仓库，跳过这几项检查'); }
    if (!plans.length) process.exit(check ? 0 : 2);
  }

  const stale = [];
  const extra = [];
  for (const { source, want } of plans) {
    const dest = join(ROOT, 'src', 'vendor', source.dest);
    for (const [name, text] of want) {
      const p = join(dest, name);
      if (!existsSync(p) || readFileSync(p, 'utf-8') !== text) stale.push(`${source.dest}/${name}`);
    }
    // 多出来的也算漂移：上游删掉一个文件，这边不能还留着。
    for (const name of listJs(dest)) {
      if (!want.has(name)) extra.push(`${source.dest}/${name}`);
    }
  }

  const total = plans.reduce((n, p) => n + p.want.size, 0);

  if (check) {
    if (stale.length || extra.length) {
      console.error('vendor 过期了：');
      for (const n of stale) console.error(`  与上游不一致：${n}`);
      for (const n of extra) console.error(`  上游那边已经没有了：${n}`);
      console.error('请运行 node tools/sync-vendor.mjs');
      process.exit(1);
    }
    console.log(`vendor 与上游一致（${total} 个文件，${plans.length} 个仓库）`);
    return;
  }

  for (const { source, want } of plans) {
    const dest = join(ROOT, 'src', 'vendor', source.dest);
    for (const [name, text] of want) {
      const p = join(dest, name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
  }
  console.log(`同步了 ${total} 个文件 → src/vendor/（${plans.map((p) => p.source.dest).join('、')}）`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
