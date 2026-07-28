/**
 * 跨仓库一致性：用**规范仓库的参考校验器**校验我们产出的 bundle。
 *
 * 这是写入器的最终验收标准：
 *
 *   > 用写入器产出一个 bundle，用 doubak-data-specs 的 validate.py 校验，
 *   > 必须通过。
 *
 * 它比任何单元测试都更能说明「我们真的写对了格式」——单元测试只能证明
 * 代码符合我们自己的理解，校验器代表的是规范的理解。
 *
 * 规范仓库的定位顺序：
 *   1. 环境变量 DOUBAK_SPECS_DIR
 *   2. 同级目录 ../doubak-data-specs（两仓库并排检出是默认开发布局）
 * 找不到就显示原因并跳过，不静默变绿。
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  newBundleId,
  captureId,
  segmentFilename,
  indexFilename,
  bundleDirName,
  newWarcRecordId,
  SequenceAllocator,
} from '../src/core/ids.js';
import {
  buildWarcRecord,
  buildHttpResponseBlock,
  buildWarcinfoRecord,
  gzipMember,
} from '../src/core/warc.js';
import { sha256Hex, sha1Base32 } from '../src/core/digest.js';
import { toRfc3339, parseDoubanTimestamp } from '../src/core/time.js';
import { urlKey, URL_KEY_RULES_VERSION } from '../src/core/urlkey.js';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const enc = new TextEncoder();

/** @type {string | null} */
let specsDir = null;
/** @type {string | false} */
let skipReason = false;

before(async () => {
  const candidates = [
    process.env.DOUBAK_SPECS_DIR,
    path.resolve(HERE, '../../doubak-data-specs'),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'bundle/v1/validate.py'))) {
      specsDir = dir;
      break;
    }
  }

  if (!specsDir) {
    skipReason =
      `找不到 doubak-data-specs（试过：${candidates.join('、')}）——` +
      `跳过跨仓库一致性检查。设 DOUBAK_SPECS_DIR 指向规范仓库即可启用`;
    return;
  }

  try {
    await execFileAsync('python3', ['--version']);
  } catch {
    skipReason = '未找到 python3——参考校验器跑不起来，跳过跨仓库一致性检查';
  }
});

/**
 * 组装一个最小但完整的 bundle。
 *
 * TODO(临时): 这段组装逻辑是 bundle 写入器的雏形。等 src/bundle/writer.js
 * 落地后，本测试应改为直接调用写入器——那时这个测试才真正验的是写入器，
 * 而不是测试里另写一遍的组装逻辑。
 *
 * @param {string} dir 目标目录
 * @param {{ corrupt?: 'segment' | 'watermark' | 'empty-ok' }} [opts]
 */
async function buildMinimalBundle(dir, opts = {}) {
  const bundleId = newBundleId();
  const seq = new SequenceAllocator();
  const now = new Date();
  const observedAt = toRfc3339(now, 480);
  const segName = segmentFilename('data', bundleId, 1);

  /** @type {Uint8Array[]} */
  const members = [];
  /** @type {object[]} */
  const indexLines = [];
  let offset = 0;

  // 段以 warcinfo 开头（WARC 惯例）。它不是一次「捕获」，所以不进 index。
  const info = await gzipMember(
    buildWarcinfoRecord({
      recordId: newWarcRecordId(),
      date: now,
      filename: segName,
      bundleId,
      software: 'doubak-extension/0.0.1',
    }),
  );
  members.push(info);
  offset += info.length;

  const captures = [
    {
      url: 'https://www.douban.com/people/82160871/statuses?p=1?_spm_id=ODIx',
      intent: 'broadcast.timeline',
      route: 'broadcast.timeline',
      surface: 'html',
      contentType: 'text/html; charset=utf-8',
      body: enc.encode(
        '<html><div class="status-item" data-sid="9351468114">' +
          '<span class="created_at" title="2026-07-26 12:34:00">7月26日</span>' +
          '</div></html>',
      ),
    },
    {
      url: 'https://m.douban.com/rexxar/api/v2/user/82160871/interests?ck=AAAA&count=1&for_mobile=1',
      intent: 'profile.category_entry.movie',
      route: 'interest.movie.collect',
      surface: 'api',
      contentType: 'application/json',
      body: enc.encode(JSON.stringify({ total: 1234, count: 1, interests: [] })),
    },
  ];

  for (const [i, cap] of captures.entries()) {
    const cid = captureId(bundleId, seq.next());
    const recordId = newWarcRecordId();
    const block = buildHttpResponseBlock({
      statusLine: 'HTTP/1.1 200 OK',
      headers: [['Content-Type', cap.contentType]],
      body: cap.body,
    });
    const rec = buildWarcRecord({
      type: 'response',
      recordId,
      date: now,
      targetUri: cap.url,
      contentType: 'application/http;msgtype=response',
      headers: [
        ['WARC-Block-Digest', await sha1Base32(block)],
        ['WARC-Payload-Digest', await sha1Base32(cap.body)],
      ],
      block,
    });
    const member = await gzipMember(rec);

    indexLines.push({
      capture_id: cid,
      warc_record_id: recordId,
      segment: segName,
      offset,
      length: member.length,
      url: cap.url,
      url_key: urlKey(cap.url),
      url_key_rules: URL_KEY_RULES_VERSION,
      intent: cap.intent,
      route_key: cap.route,
      surface: cap.surface,
      verdict: 'ok',
      capture_fidelity: 'decoded_body+observed_headers',
      observed_at: observedAt,
      http_status: 200,
      content_type: cap.contentType,
      content_sha256:
        opts.corrupt === 'empty-ok'
          ? 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
          : await sha256Hex(cap.body),
      parent_capture_id: i === 0 ? null : indexLines[0].capture_id,
      cursor: i === 0 ? { kind: 'page', value: 1 } : { kind: 'start', value: 0 },
    });

    members.push(member);
    offset += member.length;
  }

  let segmentBytes = new Uint8Array(offset);
  let at = 0;
  for (const m of members) {
    segmentBytes.set(m, at);
    at += m.length;
  }
  // 负面对照：段被改动而 manifest 里的 sha256 不变，校验器必须发现
  if (opts.corrupt === 'segment') {
    segmentBytes = new Uint8Array([...segmentBytes, 0x00]);
  }

  const indexText = indexLines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  const hw = parseDoubanTimestamp('2026-07-26 12:34:00');

  const manifest = {
    spec_version: 'bundle/1.0',
    bundle_id: bundleId,
    previous_bundle_id: null,
    status: 'complete',
    created_at: observedAt,
    completed_at: observedAt,
    producer: {
      name: 'doubak-extension',
      version: '0.0.1',
      user_agent: 'Mozilla/5.0 (X11; Linux x86_64) doubak-test',
      platform: 'node-test',
    },
    account: {
      user_id: '82160871',
      username: 'mewcatcher',
      profile_url: 'https://www.douban.com/people/82160871/',
    },
    timezone_assumption: 'Asia/Shanghai',
    segments: [
      {
        filename: segName,
        bytes: opts.corrupt === 'segment' ? segmentBytes.length - 1 : segmentBytes.length,
        sha256: await sha256Hex(
          opts.corrupt === 'segment' ? segmentBytes.slice(0, -1) : segmentBytes,
        ),
        record_count: captures.length,
        first_capture_id: indexLines[0].capture_id,
        last_capture_id: indexLines.at(-1).capture_id,
      },
    ],
    index: {
      filename: indexFilename(bundleId),
      sha256: await sha256Hex(enc.encode(indexText)),
      line_count: indexLines.length,
    },
    coverage: [
      {
        route_key: 'interest.movie.collect',
        intent: 'interest.list.movie.collect',
        claimed_count: 1234,
        claimed_raw: '{"total": 1234}',
        claimed_source: indexLines[1].capture_id,
        claimed_observed_at: observedAt,
        captured_count: 0,
        delta: -1234,
      },
      {
        // 广播没有可信的声明数量。null ≠ 0。
        route_key: 'broadcast.timeline',
        intent: 'broadcast.timeline',
        claimed_count: null,
        claimed_raw: null,
        claimed_source: null,
        claimed_observed_at: null,
        captured_count: 1,
        delta: null,
      },
    ],
    crawl_state: [
      {
        route_key: 'broadcast.timeline',
        intent: 'broadcast.timeline',
        high_water_time: hw.iso,
        high_water_raw: hw.raw,
        high_water_ids: ['9351468114'],
        floor_time: null,
        enumeration: 'bounded',
        contiguous: opts.corrupt === 'watermark' ? false : true,
        gaps: [],
        advanced: true, // corrupt='watermark' 时与 contiguous=false 冲突
        completed_at: observedAt,
        bundle_id: bundleId,
      },
    ],
    counts: {
      by_verdict: { ok: captures.length },
      by_surface: { html: 1, api: 1 },
    },
  };

  const readme = [
    'doubak 备份档案 / doubak backup bundle',
    '',
    '规范版本 / Spec version: bundle/1.0',
    `档案编号 / Bundle ID:    ${bundleId}`,
    '',
    '这是从豆瓣抓取的个人数据存档。data-*.warc.gz 是标准 WARC 格式，',
    '可用 ReplayWeb.page 或 pywb 打开。index-*.ndjson 每行一条抓取记录。',
    '',
    'This archive uses the standard WARC format; open the data-*.warc.gz',
    'files with ReplayWeb.page or pywb. Full specification:',
    'https://spec.doubak.com/bundle/v1/',
    '',
  ].join('\n');

  await writeFile(path.join(dir, segName), segmentBytes);
  await writeFile(path.join(dir, indexFilename(bundleId)), indexText, 'utf-8');
  await writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8',
  );
  await writeFile(path.join(dir, 'README.txt'), readme, 'utf-8');

  return { bundleId, dir };
}

/** 跑规范仓库的参考校验器。 */
async function runValidator(bundleDir) {
  const script = path.join(specsDir, 'bundle/v1/validate.py');
  try {
    const { stdout } = await execFileAsync('python3', [script, bundleDir]);
    return { ok: true, output: stdout };
  } catch (err) {
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** @param {(dir: string) => Promise<void>} fn */
async function withTempBundle(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'doubak-conformance-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('跨仓库一致性（doubak-data-specs 的参考校验器）', () => {
  test('我们的基础类型组装出的 bundle 能通过规范校验器', async (t) => {
    if (skipReason) return t.skip(skipReason);

    await withTempBundle(async (root) => {
      const { bundleId } = await buildMinimalBundle(root);
      const dir = path.join(root, bundleDirName(bundleId));
      // 校验器接受任意目录名，这里只是顺带确认命名函数可用
      assert.match(bundleDirName(bundleId), /^doubak-bundle-/);

      const res = await runValidator(root);
      assert.ok(res.ok, `校验器应当通过，实际输出：\n${res.output}`);
      assert.match(res.output, /通过/);
      void dir;
    });
  });

  test('负面对照：段被改动而摘要没变 —— 校验器必须报错', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // 没有这个对照，上一个测试可能只是「校验器根本没跑起来」而假绿。
    await withTempBundle(async (root) => {
      await buildMinimalBundle(root, { corrupt: 'segment' });
      const res = await runValidator(root);
      assert.equal(res.ok, false, '被改动的段必须被发现');
      assert.match(res.output, /sha256 不符|大小不符/);
    });
  });

  test('负面对照：advanced=true 但 contiguous=false —— 校验器必须报错', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // 水位线不变量：没连续走完就不许推进水位线，否则会留下永久且不可
    // 检测的空洞。这条规则由规范强制，不能只靠写入器自觉。
    await withTempBundle(async (root) => {
      await buildMinimalBundle(root, { corrupt: 'watermark' });
      const res = await runValidator(root);
      assert.equal(res.ok, false);
      assert.match(res.output, /contiguous/);
    });
  });

  test('负面对照：零长度载荷标成 ok —— 校验器必须报错', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // 真实旧档案里出现过 7 个零字节文件，磁盘上没有任何失败痕迹。
    await withTempBundle(async (root) => {
      await buildMinimalBundle(root, { corrupt: 'empty-ok' });
      const res = await runValidator(root);
      assert.equal(res.ok, false);
      assert.match(res.output, /零长度/);
    });
  });

  test('index.ndjson 每行都是合法 JSON 且字段齐全', async (t) => {
    if (skipReason) return t.skip(skipReason);

    await withTempBundle(async (root) => {
      const { bundleId } = await buildMinimalBundle(root);
      const text = await readFile(path.join(root, indexFilename(bundleId)), 'utf-8');
      const lines = text.trimEnd().split('\n');
      assert.equal(lines.length, 2);

      for (const line of lines) {
        const e = JSON.parse(line);
        for (const field of [
          'capture_id', 'warc_record_id', 'segment', 'offset', 'length',
          'url', 'intent', 'route_key', 'surface', 'verdict',
          'capture_fidelity', 'observed_at',
        ]) {
          assert.ok(field in e, `缺少必填字段 ${field}`);
        }
        // url 保留跟踪参数（事实），url_key 剥掉（索引）
        assert.notEqual(e.url, undefined);
      }

      const [first, second] = lines.map((l) => JSON.parse(l));
      assert.equal(first.parent_capture_id, null, '第一条是根节点');
      assert.equal(second.parent_capture_id, first.capture_id, '第二条应指回第一条');
      assert.doesNotMatch(second.url_key, /ck=/, 'url_key 应剥掉会话令牌');
      assert.match(second.url, /ck=AAAA/, 'url 应保留原样');
    });
  });
});
