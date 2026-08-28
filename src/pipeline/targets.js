/**
 * canonical → 三种可以交出去的东西。
 *
 * 每一种都是**一个目录里的一堆文件**（`{name, bytes|text}`），怎么写盘由调用方管。
 * 这样这一层不需要知道 File System Access API，测试也不用假装有一个文件系统。
 *
 * ## 三种产出的关系
 *
 *     canonical   —— 上游的那份结构化数据，五个 ndjson。喂给命令行的下游工具。
 *     neodb       —— canonical → NeoDB 的 NDJSON 归档 zip，直接上传。
 *     markdown    —— canonical → 投影 → 一棵 Markdown 树 + 图片，交给任何 SSG。
 *
 * 后两种都从第一种来，所以**一次解析可以出三份**——而这也正是不落中间产物的底气：
 * 重算一次的代价就是解析那一遍，而那一遍本来就要跑。
 */

import { zip } from '../vendor/export-adapters/zip.js';
import { buildNeodbNdjson } from '../vendor/export-adapters/targets/neodb-ndjson.js';
import { instructions } from '../vendor/export-adapters/instructions.js';
import { project } from '../vendor/site-generator/projection.js';
import { buildPages } from '../vendor/site-generator/pages.js';
import { canonicalFiles } from './run.js';
import { indexImages, exportImages, reallyMissing } from './images.js';

const enc = new TextEncoder();

/**
 * 浏览器这边的 raw deflate。
 *
 * `zip.js` 只管格式，压缩是传进来的——Node 那边给 `deflateRawSync`，这边给
 * `CompressionStream`。两边各写一个 zip 写出器是不行的：那样「NeoDB 收不收得下」
 * 就要验两遍，而其中一遍多半没人验。
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function deflateRaw(bytes) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  // 写入侧的 promise 必须显式吞掉：流出错时 `write()` 与 `close()` 都会 reject，
  // 放任不管就是一个 unhandled rejection。真正的错误由读取侧报出来。
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});

  const chunks = [];
  let total = 0;
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/**
 * canonical 五件套，外加一份说明。
 *
 * @param {object} data
 * @returns {Promise<{files: {name: string, bytes: Uint8Array}[], report: object}>}
 */
export async function buildCanonical(data) {
  const files = canonicalFiles(data).map((f) => ({ name: f.name, bytes: enc.encode(f.text) }));
  files.push({ name: 'README.txt', bytes: enc.encode(canonicalReadme(data)) });
  return {
    files,
    report: {
      marks: data.marks.length,
      subjects: data.subjects.length,
      broadcasts: data.broadcasts.length,
      longform: data.longform.length,
      doulists: data.doulists.length,
      revisions: data.marks.reduce((n, m) => n + (m.revisions?.length ?? 0), 0),
    },
  };
}

/**
 * NeoDB 的 NDJSON 归档：一个 zip，加上几份**不进 zip** 的旁注。
 *
 * 旁注留在 zip 外面是刻意的：进了 zip 就会被当成要导入的东西，而它们是给人看的。
 * 更要紧的是那条规矩——**一个永远有内容的失败清单，就是一个没人看的失败清单**，
 * 所以「注定导不进去」的行不能混在包里凑数。
 *
 * @param {object} data
 * @param {{shelfHistory?: boolean, visibility?: number}} [options]
 */
export async function buildNeodb(data, options = {}) {
  const built = buildNeodbNdjson(data, { ...options, generator: 'doubak-extension' });
  const bytes = await zip(built.files, { deflateRaw });

  const files = [{ name: 'neodb-ndjson-import.zip', bytes }];
  for (const s of built.sidecars) files.push({ name: s.name, bytes: enc.encode(s.text) });
  files.push({ name: '怎么导入.md', bytes: enc.encode(instructions(built.report)) });

  return { files, report: built.report };
}

/**
 * 一棵 Markdown 树，外加图片。
 *
 * **图片是这一路最不可替代的部分。** 不导出的话页面上留的是 doubanio 的地址——
 * 那一张图从此需要豆瓣还活着才看得见，而这个项目存在的全部理由就是不再需要那个
 * 前提。所以 `remote`（最后仍然指向豆瓣的那些）要报出来，不能只报「缺了几张」。
 *
 * @param {object} data
 * @param {object} opts
 * @param {Array<object>} opts.sources 打开着的 OpfsBundleSource
 * @param {(rel: string, bytes: Uint8Array) => Promise<void>} opts.write
 *   图片直接流出去，不在内存里攒——一份真实档案有 3000 多张
 * @param {(p: {done: number, total: number}) => void} [opts.onImageProgress]
 */
export async function buildMarkdown(data, { sources, write, onImageProgress }) {
  const p = project(data);

  // 想要哪些图：封面、正文内嵌的、广播附图。**广播附图是用户自己上传的**，
  // 比封面更不可替代——封面豆瓣还有一份，这些没有第二处。
  const wanted = new Set();
  for (const m of p.marks) if (m.coverUrl) wanted.add(m.coverUrl);
  for (const r of p.longform) {
    for (const m of (r.body ?? '').matchAll(/https:\/\/[a-z0-9.]*doubanio\.com\/[^\s"'<>)）]+/g)) {
      wanted.add(m[0]);
    }
  }
  for (const b of p.broadcasts) for (const u of b.images) wanted.add(u);

  const img = await exportImages({
    index: indexImages(sources),
    wanted,
    // **按作品 id 再找一遍封面**：列表页缩略图与详情页封面是同一张图的两个尺寸，
    // 只按 URL 找会漏掉一批明明就在档案里的。
    wantedBySubject: new Set(p.marks.map((m) => m.subjectId)),
    write,
    onProgress: (done, total) => onImageProgress?.({ done, total }),
  });

  const built = buildPages(p, { images: img.paths, coverBySubject: img.bySubject });

  // 按作品 id 找到的不算缺，占位图也不算缺。判定在 image-index.js 里，与站点
  // 生成器同一份——一条永远存在的假告警会让真的那条也被忽略。
  const covered = new Set(
    p.marks.filter((m) => img.bySubject[m.subjectId] && m.coverUrl).map((m) => m.coverUrl),
  );

  return {
    files: built.files.map(([name, text]) => ({ name, bytes: enc.encode(text) })),
    report: {
      ...built.stats,
      images: img.written,
      missing: img.missing.filter((u) => reallyMissing(u, covered)),
      remote: built.remote,
    },
  };
}

/** canonical 目录里那份说明。写给几年后打开这个文件夹的人。 */
function canonicalReadme(data) {
  const n = (a) => String(a.length);
  return [
    '豆备（Doubak）canonical 数据',
    '',
    '这是从 WARC 档案解析出来的结构化数据，每行一条 JSON（NDJSON）。',
    '它是**派生数据**：删掉也没关系，拿档案重新解析一遍就有。真正不可替代的是',
    '那些 WARC 档案本身。',
    '',
    `  marks.ndjson       ${n(data.marks)} 条标记（看过/在看/想看，含评分、短评、标签）`,
    `  subjects.ndjson    ${n(data.subjects)} 个作品`,
    `  broadcasts.ndjson  ${n(data.broadcasts)} 条广播`,
    `  longform.ndjson    ${n(data.longform)} 篇日记与评论`,
    `  doulists.ndjson    ${n(data.doulists)} 份豆列`,
    '',
    '每条记录带着 revisions —— 同一件事被观测到几次就有几条，各自带摘要与',
    '指回 WARC 的 capture_ids。**只比较同一个 parser_version 的修订**，',
    '否则修好一个抽取 bug 会让所有记录同时看起来被编辑过。',
    '',
    '格式说明：https://github.com/Doubak/doubak-data-specs',
    '下游工具：https://github.com/Doubak/doubak-export-adapters（导到 NeoDB 等）',
    '          https://github.com/Doubak/doubak-site-generator（生成静态站点）',
    '',
  ].join('\n');
}
