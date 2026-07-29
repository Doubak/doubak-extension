#!/usr/bin/env node
/**
 * 从 doubak-data-specs 的 JSON Schema 生成 src/core/spec-constants.js。
 *
 *     node tools/generate-spec-constants.mjs            # 写入
 *     node tools/generate-spec-constants.mjs --check    # 只比对，不写
 *
 * ## 为什么要有这个东西
 *
 * 规范的封闭词表（verdict / surface / capture_fidelity）与 index 的必填
 * 字段，原本在扩展里是**手抄**的。手抄意味着规范加了一个 verdict 取值之后，
 * 扩展会继续把它当非法值拒掉，而且没有任何东西会提醒你。
 *
 * 项目的既定原则是「从 schema 生成代码，绝不反过来」。这个脚本把原则落实：
 * schema 是唯一权威，本文件的产物是它的投影。
 *
 * 生成的文件【提交进仓库】，所以运行扩展和跑测试都不需要规范仓库在场——
 * 零构建步骤的前提不变。`--check` 模式则由测试调用，确保提交的产物没有
 * 过期。忘记重新生成会让测试失败，而不是悄悄漂移。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../src/core/spec-constants.js');

/** 与一致性测试用同一套定位规则。 */
export function findSpecsDir() {
  const candidates = [
    process.env.DOUBAK_SPECS_DIR,
    path.resolve(HERE, '../../doubak-data-specs'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'bundle/v1/common.schema.json'))) return dir;
  }
  return null;
}

/** 生成时读取的 schema 文件。摘要只覆盖这几个文件，见下。 */
const SOURCE_FILES = [
  'common.schema.json',
  'index-entry.schema.json',
  'crawl-state-entry.schema.json',
];

/**
 * 来源摘要：把读取到的 schema 文件按序拼起来算 SHA-256。
 *
 * 为什么不用规范仓库的 git commit：那样规范仓库任何一次提交（改文档、加
 * 测试用例）都会让本文件「过期」，freshness 测试变成噪音，很快就没人当回事。
 * 只对**实际读取的字节**取摘要，则只有真正影响生成结果的改动才会触发重新
 * 生成——信号才有意义。
 *
 * @param {string} v1Dir
 */
async function sourceDigest(v1Dir) {
  const parts = [];
  for (const name of SOURCE_FILES) {
    parts.push(`--- ${name} ---\n`, await readFile(path.join(v1Dir, name), 'utf-8'));
  }
  const bytes = new TextEncoder().encode(parts.join(''));
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** @param {string} specsDir */
export async function renderConstants(specsDir) {
  const v1 = path.join(specsDir, 'bundle/v1');
  const read = async (name) => JSON.parse(await readFile(path.join(v1, name), 'utf-8'));

  const common = await read('common.schema.json');
  const indexEntry = await read('index-entry.schema.json');
  const crawlState = await read('crawl-state-entry.schema.json');
  const digest = await sourceDigest(v1);

  const defs = common.$defs;

  const specVersion = defs.spec_version.const;
  const verdicts = defs.verdict.enum;
  const surfaces = defs.surface.enum;
  const fidelities = defs.capture_fidelity.enum;
  const enumerations = crawlState.properties.enumeration.enum;

  // 段前缀藏在文件名的正则里，从中抽出来
  const kindMatch = /\^\(([a-z|]+)\)-/.exec(defs.segment_filename.pattern);
  if (!kindMatch) throw new Error('无法从 segment_filename 的 pattern 中解析段前缀');
  const kinds = kindMatch[1].split('|');

  const requiredIndexFields = indexEntry.required;

  const arr = (xs) => xs.map((x) => `  ${JSON.stringify(x)},`).join('\n');

  return `// 本文件由 tools/generate-spec-constants.mjs 自动生成，请勿手改。
// 来源：doubak-data-specs/bundle/v1/*.schema.json
// 重新生成：node tools/generate-spec-constants.mjs
//
// 规范是唯一权威，本文件是它的投影。手抄这些取值意味着规范新增一个
// verdict 之后，扩展会继续把它当非法值拒掉，且没有任何东西会提醒你。

/** 本扩展按哪一版规范写入。 */
export const SPEC_VERSION = ${JSON.stringify(specVersion)};

/**
 * 生成来源的摘要：${SOURCE_FILES.join('、')} 的内容哈希。
 *
 * 这是溯源信息——回答「这份常量是照着哪一版 schema 生成的」。只覆盖实际
 * 读取的文件，所以规范仓库改文档或加测试用例不会让它变，只有真正影响生成
 * 结果的改动才会。
 */
export const SPEC_SOURCE_DIGEST = ${JSON.stringify(digest)};

/**
 * 响应可信度判定。封闭词表——安全相关字段，拼错必须失败。
 * 读者遇到未知取值必须当作不可信，不得当作 ok。
 */
export const VERDICTS = Object.freeze([
${arr(verdicts)}
]);

/** 抓取面。同一条内容可能在两面各存一份，不标注会被误认为两次修订。 */
export const SURFACES = Object.freeze([
${arr(surfaces)}
]);

/** 保真度。浏览器拿不到完全未经处理的原始字节，此字段如实记录实际成色。 */
export const CAPTURE_FIDELITIES = Object.freeze([
${arr(fidelities)}
]);

/** 枚举方式。决定下游有没有资格推断删除。 */
export const ENUMERATIONS = Object.freeze([
${arr(enumerations)}
]);

/** 段前缀，表示留存等级而非媒体类型。 */
export const SEGMENT_KINDS = Object.freeze([
${arr(kinds)}
]);

/** index.ndjson 每行的必填字段，都属于事后不可恢复的那一类。 */
export const REQUIRED_INDEX_FIELDS = Object.freeze([
${arr(requiredIndexFields)}
]);
`;
}

async function main() {
  const specsDir = findSpecsDir();
  if (!specsDir) {
    console.error(
      '找不到 doubak-data-specs。设 DOUBAK_SPECS_DIR，或把两个仓库并排检出。',
    );
    process.exit(2);
  }

  const rendered = await renderConstants(specsDir);
  const check = process.argv.includes('--check');

  if (check) {
    const current = existsSync(OUT) ? await readFile(OUT, 'utf-8') : '';
    if (current !== rendered) {
      console.error('spec-constants.js 已过期，请运行 node tools/generate-spec-constants.mjs');
      process.exit(1);
    }
    console.log('spec-constants.js 与规范一致');
    return;
  }

  await writeFile(OUT, rendered, 'utf-8');
  console.log(`已生成 ${path.relative(process.cwd(), OUT)}（来源 ${specsDir}）`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
