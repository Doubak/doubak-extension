/**
 * lcov → Coveralls 的 JSON，然后 POST 上去。零依赖。
 *
 * ## 为什么不用 coverallsapp/github-action
 *
 * 那个 action 只认 `github-token`——它拿这个 token 去 Coveralls 那边「确认是哪个
 * 仓库」，并且要把 @coveralls 这个用户以 `Role: Write` 请进仓库来发 PR 状态。
 * 我们不要那份权限。Coveralls 的 `/jobs` 端点本来就支持用 **repo token** 认证，
 * 不需要任何 GitHub App，于是这里直接 POST，CI 里一个第三方 action 都不引入。
 *
 *     POST https://coveralls.io/api/v1/jobs
 *     multipart/form-data，字段名 json_file
 *
 * ## 必须合并重复的 SF 段
 *
 * **Node 内置的 lcov reporter 每个工作进程各输出一份，互不合并。** 实测扩展那个
 * 仓库：133 条 SF 记录，去重后只有 77 个文件，`src/ui/panel.js` 出现 43 次。
 * 直接上传的话，覆盖率取决于 Coveralls 自己怎么处理重复段——按最后一份算，还是
 * 累加。那是个我们不该去赌的实现细节，所以在这里就把命中数加起来。
 *
 * 小仓库看不出来（解析器 11/11、站点生成器 8/8，一条重复都没有），所以这个坑会在
 * 三个仓库里表现得完全正常，只在最大的那个仓库里出错——正是最不容易发现的形状。
 *
 * ## coverage 数组的语义
 *
 * 长度必须等于文件的行数，逐行对应：
 *   正整数 = 命中次数、0 = 没被执行、**null = 这一行不算代码**（空行、注释）。
 * 0 和 null 是两件事：把不算代码的行写成 0，覆盖率会被稀释成假的低值。
 *
 * 用法：node tools/coveralls.mjs <lcov 文件> [更多 lcov 文件…]
 *   环境变量 COVERALLS_REPO_TOKEN 必须存在；没有就直接退出并报错，
 *   **不静默跳过**——静默跳过的上传等于永远没人知道它坏了。
 *   带 --dry-run 时只写出 JSON 不上传。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';

const ENDPOINT = 'https://coveralls.io/api/v1/jobs';

/** 解析 lcov。同名文件的多段会合并：命中数相加，分支命中数相加。 */
export function parseLcov(text) {
  const files = new Map();
  let cur = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      const name = line.slice(3);
      if (!files.has(name)) files.set(name, { lines: new Map(), branches: new Map() });
      cur = files.get(name);
    } else if (!cur) {
      continue;
    } else if (line.startsWith('DA:')) {
      // DA:<行号>,<命中数>
      const [n, hits] = line.slice(3).split(',');
      const ln = Number(n);
      cur.lines.set(ln, (cur.lines.get(ln) || 0) + Number(hits));
    } else if (line.startsWith('BRDA:')) {
      // BRDA:<行号>,<块>,<分支>,<命中数或 ->
      const [n, block, branch, taken] = line.slice(5).split(',');
      const key = `${n},${block},${branch}`;
      const hits = taken === '-' ? 0 : Number(taken);
      cur.branches.set(key, (cur.branches.get(key) || 0) + hits);
    } else if (line === 'end_of_record') {
      cur = null;
    }
  }
  return files;
}

/** 一个文件的 coverage 数组：长度等于行数，没出现在 DA 里的行是 null。 */
export function coverageArray(source, lines) {
  // 末尾换行会切出一个空串，那不是一行。
  const n = source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
  const out = new Array(n).fill(null);
  for (const [ln, hits] of lines) {
    if (ln >= 1 && ln <= n) out[ln - 1] = hits;
  }
  return out;
}

function git(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function gitInfo() {
  // CI 上用 GitHub 给的 SHA：checkout 可能是 detached/merge commit，
  // 这时 `git rev-parse HEAD` 指的不是被测的那个提交。
  const id = process.env.GITHUB_SHA || git('rev-parse', 'HEAD');
  const branch =
    process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || git('rev-parse', '--abbrev-ref', 'HEAD');
  return {
    head: {
      id,
      author_name: git('log', '-1', '--pretty=%an', id) || 'unknown',
      author_email: git('log', '-1', '--pretty=%ae', id) || '',
      committer_name: git('log', '-1', '--pretty=%cn', id) || 'unknown',
      committer_email: git('log', '-1', '--pretty=%ce', id) || '',
      message: git('log', '-1', '--pretty=%s', id) || '',
    },
    branch,
    remotes: [],
  };
}

export function buildPayload(lcovTexts, { root = process.cwd(), token, service } = {}) {
  const merged = new Map();
  for (const text of lcovTexts) {
    for (const [name, data] of parseLcov(text)) {
      if (!merged.has(name)) merged.set(name, { lines: new Map(), branches: new Map() });
      const dst = merged.get(name);
      for (const [ln, h] of data.lines) dst.lines.set(ln, (dst.lines.get(ln) || 0) + h);
      for (const [k, h] of data.branches) dst.branches.set(k, (dst.branches.get(k) || 0) + h);
    }
  }

  const source_files = [];
  const missing = [];
  for (const [name, data] of merged) {
    const abs = resolve(root, name);
    if (!existsSync(abs)) {
      missing.push(name);
      continue;
    }
    const source = readFileSync(abs, 'utf-8');
    const branches = [];
    for (const [key, hits] of data.branches) {
      const [ln, block, branch] = key.split(',').map(Number);
      branches.push(ln, block, branch, hits);
    }
    source_files.push({
      name: relative(root, abs).split('\\').join('/'),
      source_digest: createHash('md5').update(source).digest('hex'),
      coverage: coverageArray(source, data.lines),
      ...(branches.length ? { branches } : {}),
    });
  }

  // lcov 指到的文件不在磁盘上，说明路径基准不对——静默丢掉会让覆盖率凭空变好看。
  if (missing.length) {
    throw new Error(`lcov 里这些文件找不到（路径基准不对？）：\n  ${missing.join('\n  ')}`);
  }
  if (!source_files.length) throw new Error('一个文件都没解析出来，lcov 大概是空的');

  return {
    repo_token: token,
    service_name: service?.name || 'github',
    ...(service?.number ? { service_number: service.number } : {}),
    ...(service?.jobId ? { service_job_id: service.jobId } : {}),
    ...(service?.pr ? { service_pull_request: service.pr } : {}),
    git: gitInfo(),
    run_at: new Date().toISOString(),
    source_files,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const paths = args.filter((a) => !a.startsWith('--'));
  if (!paths.length) {
    console.error('用法: node tools/coveralls.mjs <lcov 文件…> [--dry-run]');
    return 2;
  }

  const token = process.env.COVERALLS_REPO_TOKEN;
  if (!token && !dryRun) {
    console.error('::error::没有 COVERALLS_REPO_TOKEN —— 上传不会静默跳过');
    return 1;
  }

  const payload = buildPayload(
    paths.map((p) => readFileSync(p, 'utf-8')),
    {
      token: token || 'DRY-RUN',
      service: {
        name: 'github',
        number: process.env.GITHUB_RUN_NUMBER,
        jobId: process.env.GITHUB_RUN_ID,
        pr: process.env.GITHUB_EVENT_NAME === 'pull_request' ? process.env.GITHUB_REF_NAME?.split('/')[0] : '',
      },
    },
  );

  const covered = payload.source_files.reduce(
    (n, f) => n + f.coverage.filter((c) => c !== null && c > 0).length, 0);
  const relevant = payload.source_files.reduce(
    (n, f) => n + f.coverage.filter((c) => c !== null).length, 0);
  console.log(
    `${payload.source_files.length} 个文件 · ${covered}/${relevant} 行 ` +
    `(${((covered / relevant) * 100).toFixed(2)}%)`,
  );

  const json = JSON.stringify(payload);
  if (dryRun) {
    writeFileSync('coveralls.json', json);
    console.log('--dry-run：写了 coveralls.json，没上传');
    return 0;
  }

  // 用 curl 而不是 fetch：multipart 的边界拼接手写容易出错，而 curl 在
  // 所有 runner 上都在。--fail-with-body 让 4xx/5xx 变成非零退出且能看见响应体。
  writeFileSync('coveralls.json', json);
  try {
    const out = execFileSync(
      'curl',
      ['--silent', '--show-error', '--fail-with-body', '-F', 'json_file=@coveralls.json', ENDPOINT],
      { encoding: 'utf-8' },
    );
    console.log(out);
  } catch (e) {
    console.error(`::error::上传失败：${e.stdout || ''}${e.stderr || ''}`);
    return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
