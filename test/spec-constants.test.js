/**
 * spec-constants.js 是从规范的 JSON Schema 生成的。这组测试保证它没有过期。
 *
 * ## 这解决的是什么问题
 *
 * 扩展在【写入时】校验，用的是手写的 JS 判断，不是 JSON Schema——浏览器
 * 里没有 schema 校验器，也不该为此引入一个。于是同一套规则就有了两处编码：
 * 规范仓库的 schema，和扩展里的判断。
 *
 * 两处编码必然漂移。最可能的形态是：规范新增一个 verdict 取值，而扩展继续
 * 把它当非法值拒掉，且没有任何东西提醒你——抓取会在遇到该取值时当场失败，
 * 排查起来却要绕一大圈。
 *
 * 所以把词表从 schema 生成、提交进仓库，再用这个测试盯着它别过期。
 * 忘记重新生成会让测试失败，而不是悄悄漂移。
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findSpecsDir, renderConstants } from '../tools/generate-spec-constants.mjs';
import * as constants from '../src/core/spec-constants.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GENERATED = path.resolve(HERE, '../src/core/spec-constants.js');

/** @type {string | null} */
let specsDir = null;
/** @type {string | false} */
let skipReason = false;

before(() => {
  specsDir = findSpecsDir();
  if (!specsDir) {
    skipReason =
      '找不到 doubak-data-specs——跳过词表新鲜度检查。' +
      '设 DOUBAK_SPECS_DIR 指向规范仓库即可启用';
  }
});

describe('从规范生成的词表', () => {
  test('提交的产物与规范一致（过期就失败）', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const expected = await renderConstants(specsDir);
    const actual = await readFile(GENERATED, 'utf-8');

    assert.equal(
      actual,
      expected,
      'spec-constants.js 已过期。规范改了却没重新生成，' +
        '会导致扩展按旧规则校验。请运行：node tools/generate-spec-constants.mjs',
    );
  });

  test('生成器能从 schema 里解析出所有词表', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const text = await renderConstants(specsDir);
    for (const name of [
      'SPEC_VERSION',
      'VERDICTS',
      'SURFACES',
      'CAPTURE_FIDELITIES',
      'ENUMERATIONS',
      'SEGMENT_KINDS',
      'REQUIRED_INDEX_FIELDS',
    ]) {
      assert.match(text, new RegExp(`export const ${name}\\b`), `应当生成 ${name}`);
    }
  });

  test('生成的文件确实存在于仓库里 —— 不需要规范仓库也能跑扩展', () => {
    // 零构建步骤的前提：产物提交进仓库，运行时不依赖规范仓库在场。
    assert.ok(existsSync(GENERATED));
  });
});

describe('词表内容', () => {
  test('六个 verdict 取值', () => {
    assert.deepEqual(
      [...constants.VERDICTS].sort(),
      ['blocked', 'challenge', 'gone', 'login', 'ok', 'soft404'],
    );
  });

  test('三个抓取面 —— asset 是 bundle/1.1 加的', () => {
    assert.deepEqual([...constants.SURFACES].sort(), ['api', 'asset', 'html']);
  });

  test('三种留存等级', () => {
    assert.deepEqual([...constants.SEGMENT_KINDS], ['data', 'assets', 'catalog']);
  });

  test('枚举方式只有 full 与 bounded —— 它决定下游能否推断删除', () => {
    assert.deepEqual([...constants.ENUMERATIONS].sort(), ['bounded', 'full']);
  });

  test('写入的是大版本 1 线上的某一个小版本', () => {
    // **不钉死具体的小版本号。** 钉死的话，规范每加一个可选字段都要来改这里，
    // 而这条测试真正该守的是别的东西：版本号不能是 undefined（生成器读错字段
    // 就会这样，见 tools/generate-spec-constants.mjs），也不能跳到大版本 2
    // ——那意味着旧读者会误读，不是改个常量能了事的。
    assert.match(constants.SPEC_VERSION, /^bundle\/1\.\d+$/);
  });

  test('12 个必填的 index 字段', () => {
    assert.equal(constants.REQUIRED_INDEX_FIELDS.length, 12);
    for (const f of ['intent', 'surface', 'verdict', 'capture_fidelity', 'observed_at']) {
      assert.ok(constants.REQUIRED_INDEX_FIELDS.includes(f), `${f} 必须是必填`);
    }
  });

  test('词表是冻结的，运行时改不了', () => {
    assert.throws(() => constants.VERDICTS.push('whatever'));
    assert.ok(Object.isFrozen(constants.VERDICTS));
  });
});

describe('溯源', () => {
  test('记录了生成来源的摘要', () => {
    // 回答「这份常量是照着哪一版 schema 生成的」，无需 submodule 也能溯源。
    assert.match(constants.SPEC_SOURCE_DIGEST, /^[0-9a-f]{64}$/);
  });

  test('摘要只覆盖实际读取的 schema —— 规范仓库改文档不该让它变', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // 用 git commit 当溯源标记的话，规范仓库任何一次提交都会让本文件「过期」，
    // freshness 测试沦为噪音，很快就没人当回事。所以只对读到的字节取摘要。
    const before = await renderConstants(specsDir);

    const readme = path.join(specsDir, 'bundle/README.md');
    const original = await readFile(readme, 'utf-8');
    await writeFile(readme, original + '\n<!-- 临时改动 -->\n', 'utf-8');
    try {
      const after = await renderConstants(specsDir);
      assert.equal(after, before, '改规范的文档不该影响生成结果');
    } finally {
      await writeFile(readme, original, 'utf-8');
    }
  });
});
