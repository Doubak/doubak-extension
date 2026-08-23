/**
 * tools/coveralls.mjs 的测试。
 *
 * 这个脚本存在的唯一理由是**把重复的 SF 段合起来**，所以那一条是这里的主线：
 * Node 内置的 lcov reporter 每个工作进程各写一份，互不合并（实测扩展仓库
 * 133 条 SF 记录、77 个文件，panel.js 出现 43 次）。合并错了不会报错，只会
 * 上报一个错的百分比，而百分比是没人会去核对的东西。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { parseLcov, coverageArray, buildPayload } from '../tools/coveralls.mjs';

/** 造一段 lcov。 */
function lcov(name, das, brdas = []) {
  return [
    `SF:${name}`,
    ...brdas.map((b) => `BRDA:${b}`),
    ...das.map(([ln, hits]) => `DA:${ln},${hits}`),
    'end_of_record',
    '',
  ].join('\n');
}

describe('parseLcov', () => {
  test('读出行命中数', () => {
    const files = parseLcov(lcov('src/a.js', [[1, 3], [2, 0]]));
    assert.deepEqual([...files.get('src/a.js').lines], [[1, 3], [2, 0]]);
  });

  test('**同名文件的多段要合并，命中数相加** —— 这是整个脚本的存在理由', () => {
    // 一个工作进程跑到 1 号行 3 次，另一个跑到 2 次，真实命中就是 5 次。
    const text = lcov('src/a.js', [[1, 3], [2, 0]]) + lcov('src/a.js', [[1, 2], [2, 1]]);
    const files = parseLcov(text);
    assert.equal(files.size, 1, '合并后应当只剩一个文件');
    assert.deepEqual([...files.get('src/a.js').lines], [[1, 5], [2, 1]]);
  });

  test('合并后「有人覆盖过」不会被后一段抹掉', () => {
    // 取最后一份的话，第 1 行会变成 0——本来是覆盖过的。
    const text = lcov('src/a.js', [[1, 7]]) + lcov('src/a.js', [[1, 0]]);
    assert.equal(parseLcov(text).get('src/a.js').lines.get(1), 7);
  });

  test('分支命中数也相加，`-` 当 0', () => {
    const text = lcov('src/a.js', [[1, 1]], ['1,0,0,2', '1,0,1,-'])
      + lcov('src/a.js', [[1, 1]], ['1,0,0,3', '1,0,1,-']);
    const b = parseLcov(text).get('src/a.js').branches;
    assert.equal(b.get('1,0,0'), 5);
    assert.equal(b.get('1,0,1'), 0);
  });

  test('不同文件互不影响', () => {
    const files = parseLcov(lcov('src/a.js', [[1, 1]]) + lcov('src/b.js', [[1, 9]]));
    assert.equal(files.get('src/a.js').lines.get(1), 1);
    assert.equal(files.get('src/b.js').lines.get(1), 9);
  });

  test('end_of_record 之后的孤儿 DA 不会落到上一个文件上', () => {
    const files = parseLcov('SF:src/a.js\nDA:1,1\nend_of_record\nDA:99,5\n');
    assert.equal(files.get('src/a.js').lines.has(99), false);
  });
});

describe('coverageArray', () => {
  test('长度等于行数，没提到的行是 null', () => {
    const src = 'a\nb\nc\n';
    assert.deepEqual(coverageArray(src, new Map([[1, 4], [3, 0]])), [4, null, 0]);
  });

  test('**null 与 0 是两件事**', () => {
    // 0 = 这行是代码但没跑到；null = 这行压根不算代码。
    // 把 null 写成 0，覆盖率会被稀释成假的低值。
    const cov = coverageArray('a\nb\n', new Map([[2, 0]]));
    assert.equal(cov[0], null);
    assert.equal(cov[1], 0);
    assert.notEqual(cov[0], cov[1]);
  });

  test('结尾换行不算多出来的一行', () => {
    assert.equal(coverageArray('a\nb\n', new Map()).length, 2);
    assert.equal(coverageArray('a\nb', new Map()).length, 2);
  });

  test('超出文件行数的行号被忽略而不是撑长数组', () => {
    // 行号越界说明 lcov 与磁盘上的文件对不上，撑长数组只会把错误藏进 payload。
    assert.equal(coverageArray('a\n', new Map([[1, 1], [50, 1]])).length, 1);
  });
});

describe('buildPayload', () => {
  let dir;
  const setup = (files) => {
    dir = mkdtempSync(join(tmpdir(), 'coveralls-'));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  };
  const cleanup = () => dir && rmSync(dir, { recursive: true, force: true });

  test('source_digest 是源文件的 md5', (t) => {
    t.after(cleanup);
    const body = 'const a = 1;\n';
    const root = setup({ 'a.js': body });
    const p = buildPayload([lcov('a.js', [[1, 1]])], { root, token: 'T' });
    assert.equal(p.source_files[0].source_digest, createHash('md5').update(body).digest('hex'));
  });

  test('**跨多个 lcov 文件也合并** —— 分片跑测试时就是这个形状', (t) => {
    t.after(cleanup);
    const root = setup({ 'a.js': 'x\ny\n' });
    const p = buildPayload([lcov('a.js', [[1, 2]]), lcov('a.js', [[1, 3], [2, 1]])], { root, token: 'T' });
    assert.equal(p.source_files.length, 1);
    assert.deepEqual(p.source_files[0].coverage, [5, 1]);
  });

  test('branches 摊平成四元组', (t) => {
    t.after(cleanup);
    const root = setup({ 'a.js': 'x\n' });
    const p = buildPayload([lcov('a.js', [[1, 1]], ['1,0,0,2'])], { root, token: 'T' });
    assert.deepEqual(p.source_files[0].branches, [1, 0, 0, 2]);
  });

  test('没有分支就不写 branches 字段', (t) => {
    t.after(cleanup);
    const root = setup({ 'a.js': 'x\n' });
    const p = buildPayload([lcov('a.js', [[1, 1]])], { root, token: 'T' });
    assert.equal('branches' in p.source_files[0], false);
  });

  test('**lcov 指到磁盘上没有的文件要报错，不能静默丢掉**', (t) => {
    t.after(cleanup);
    const root = setup({ 'a.js': 'x\n' });
    // 丢掉的话，覆盖率会凭空变好看——分母少了没覆盖的那些文件。
    assert.throws(
      () => buildPayload([lcov('a.js', [[1, 1]]) + lcov('gone.js', [[1, 0]])], { root, token: 'T' }),
      /找不到/,
    );
  });

  test('空 lcov 要报错而不是上报一个空 payload', () => {
    assert.throws(() => buildPayload([''], { root: process.cwd(), token: 'T' }), /一个文件都没解析出来/);
  });

  test('带上 repo_token 与 service_name', (t) => {
    t.after(cleanup);
    const root = setup({ 'a.js': 'x\n' });
    const p = buildPayload([lcov('a.js', [[1, 1]])], { root, token: 'SECRET' });
    assert.equal(p.repo_token, 'SECRET');
    assert.equal(p.service_name, 'github');
    assert.ok(p.git.head.id, 'git.head.id 不能是空的');
  });

  test('payload 能被 JSON 序列化 —— 上传前它要变成一个文件', (t) => {
    t.after(cleanup);
    const root = setup({ 'a.js': 'x\ny\n' });
    const p = buildPayload([lcov('a.js', [[1, 1]])], { root, token: 'T' });
    const round = JSON.parse(JSON.stringify(p));
    assert.deepEqual(round.source_files[0].coverage, [1, null]);
  });
});
