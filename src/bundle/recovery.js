/**
 * 崩溃恢复：把一份写到一半的 bundle 修回自洽状态。
 *
 * 规范：doubak-data-specs/bundle/v1/SPEC.md §8.2
 *
 * ## 落盘顺序决定了崩溃能留下哪几种残局
 *
 * 写入顺序是「分配序号 → WARC 记录 → index 行 → 状态」，所以崩溃点只有
 * 四种可能，且**每一种都可检测、可修复**：
 *
 * | 崩在哪 | 磁盘上留下什么 | 怎么修 |
 * |---|---|---|
 * | WARC 写到一半 | 段尾是一个撕裂的 gzip member | 段截断到最后一条完整记录 |
 * | WARC 写完、index 未写 | 段尾是一条孤儿记录 | 同上（index 没引用它） |
 * | index 写到一半 | index 末尾是半行 | index 截断到最后一个换行 |
 * | 两者都写完 | 自洽 | 不用修 |
 *
 * 这正是「顺序不能换」的回报。反过来（先 index 后 WARC）会留下**指向不存在
 * 记录的索引项**，那种残局没法靠截断修复——你不知道该信索引还是该信段文件。
 *
 * ## 修复的方向永远是「向后截断」
 *
 * 只丢弃尚未被索引确认的尾部，绝不尝试补写或推测。被截掉的那条捕获会在续抓
 * 时重新抓一遍——重复是免费的。
 */

import { gunzip } from '../core/warc.js';
import { parseCaptureId, indexFilename } from '../core/ids.js';

const dec = new TextDecoder();

/**
 * @typedef {object} Repair
 * @property {string} kind  'index_partial_line' | 'segment_tail' | 'segment_orphaned'
 * @property {string} file
 * @property {number} [droppedBytes]
 * @property {string} detail
 */

/**
 * @typedef {object} RecoveryResult
 * @property {number} lastSeq         已确认写入的最大序号；续抓时用它重建分配器
 * @property {string | null} lastCaptureId
 * @property {number} indexLineCount
 * @property {Repair[]} repairs       做过的修复，空数组表示本来就自洽
 */

/**
 * 把 index 文件截断到最后一个完整行。
 *
 * 写入器每行是一次 append（内容 + 换行），所以崩在写入途中会留下一个没有
 * 换行结尾的半行。半行无法解析，留着会让后续所有读取失败。
 *
 * @returns {Promise<Repair | null>}
 */
async function repairIndexTail(store, filename) {
  if (!(await store.exists(filename))) return null;

  const bytes = await store.read(filename);
  if (bytes.length === 0) return null;

  // 0x0a = '\n'
  let lastNewline = -1;
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i] === 0x0a) {
      lastNewline = i;
      break;
    }
  }

  const keep = lastNewline + 1; // 保留到最后一个换行（含）
  if (keep === bytes.length) return null; // 本来就以换行结尾

  await store.truncate(filename, keep);
  return {
    kind: 'index_partial_line',
    file: filename,
    droppedBytes: bytes.length - keep,
    detail:
      keep === 0
        ? 'index 只有半行，已清空'
        : `index 末尾有半行（崩在写入途中），已截断到最后一个完整行`,
  };
}

/**
 * 恢复一份 bundle。
 *
 * 幂等：对已经自洽的 bundle 调用它不会有任何改动。
 *
 * @param {object} opts
 * @param {import('../storage/file-store.js').FileStore} opts.store
 * @param {string} opts.bundleId
 * @returns {Promise<RecoveryResult>}
 */
export async function recoverBundle({ store, bundleId }) {
  /** @type {Repair[]} */
  const repairs = [];
  const idxName = indexFilename(bundleId);

  // ── 第 1 步：修 index 的半行
  const indexRepair = await repairIndexTail(store, idxName);
  if (indexRepair) repairs.push(indexRepair);

  // ── 第 2 步：读回 index，它是「哪些捕获算数」的唯一权威
  /** @type {Array<Record<string, any>>} */
  const entries = [];
  if (await store.exists(idxName)) {
    const text = dec.decode(await store.read(idxName));
    for (const line of text.split('\n')) {
      if (line.trim()) entries.push(JSON.parse(line));
    }
  }

  /** @type {Map<string, number>} 每段被索引确认的结束位置 */
  const segmentEnd = new Map();
  for (const e of entries) {
    const end = e.offset + e.length;
    segmentEnd.set(e.segment, Math.max(segmentEnd.get(e.segment) ?? 0, end));
  }

  // ── 第 3 步：逐段截掉未被索引确认的尾部
  for (const name of await store.list()) {
    if (!name.endsWith('.warc.gz') || !name.includes(bundleId)) continue;

    const size = await store.size(name);
    const confirmed = segmentEnd.get(name);

    if (confirmed === undefined) {
      // 段里一条被索引的捕获都没有——只可能是刚开了段写完 warcinfo 就崩了。
      // 没有任何索引引用它，删掉即可，续抓时会重新开段。
      await store.remove(name);
      repairs.push({
        kind: 'segment_orphaned',
        file: name,
        droppedBytes: size,
        detail: '段中没有任何被索引的记录（开段后立即崩溃），已删除',
      });
      continue;
    }

    if (size > confirmed) {
      // 尾部要么是撕裂的 gzip member，要么是写完 WARC 但 index 未落盘的
      // 孤儿记录。两种都只能丢——索引没确认过它。
      await store.truncate(name, confirmed);
      repairs.push({
        kind: 'segment_tail',
        file: name,
        droppedBytes: size - confirmed,
        detail:
          '段尾有未被索引确认的字节（撕裂的记录或孤儿记录），已截断。' +
          '被截掉的捕获会在续抓时重新抓一遍',
      });
    }
  }

  // ── 第 4 步：校验索引确认过的记录确实能取出来
  //
  // 走到这里如果还失败，说明不是「崩在写入途中」而是真的损坏了（磁盘错误、
  // 被别的东西改过）。这种情况必须响亮地失败，不能悄悄继续写下去。
  for (const e of entries) {
    let member;
    try {
      member = await store.read(e.segment, e.offset, e.length);
    } catch (err) {
      throw new Error(
        `索引项 ${e.capture_id} 指向段外区域（${e.segment} @${e.offset}+${e.length}）：${err.message}。` +
          `这不是崩溃残留，而是档案已损坏——请勿在此基础上继续写入。`,
      );
    }
    try {
      await gunzip(member);
    } catch (err) {
      throw new Error(
        `索引项 ${e.capture_id} 处不是合法的 gzip member：${err.message}。` +
          `这不是崩溃残留，而是档案已损坏——请勿在此基础上继续写入。`,
      );
    }
  }

  // ── 第 5 步：重建序号
  //
  // 用索引里的最大序号。此时尾部的孤儿记录已被截掉，所以复用这个序号之后的
  // 号不会与磁盘上任何东西冲突。
  let lastSeq = 0;
  let lastCaptureId = null;
  for (const e of entries) {
    const { seq } = parseCaptureId(e.capture_id);
    if (seq > lastSeq) {
      lastSeq = seq;
      lastCaptureId = e.capture_id;
    }
  }

  // ── 第 6 步：重建段状态，供续写用
  //
  // 光有序号不够。续写时如果不知道已经写到第几段，写入器会从第 1 段重新开，
  // 而那个文件已经存在——它会（正确地）拒绝覆盖，于是恢复完了却写不下去。
  const resume = rebuildSegmentState(entries);

  return {
    lastSeq, lastCaptureId, indexLineCount: entries.length, repairs, resume,
    // 每条路线已经抓到多少条目。**这是唯一权威的数字**：index 写在档案里、每页
    // 落盘，而内存里的计数随 service worker 一起清零。
    //
    // 不给它的话，界面上的「已抓」在每次崩溃恢复之后归零——而一场几小时的抓取
    // 会跨越很多次 worker 死亡，于是那个数字实际显示的是「上次恢复以来抓了多少」，
    // 用户看到的却是「一共抓了多少」。
    capturedByRoute: countByRoute(entries),
    // index 的计数器同样要交还给写入器。它们活在内存里，而 index 文件是追加写的
    // ——不交还的话收尾时段与索引对不上（见 `IndexWriter` 构造里的说明）。
    indexStats: indexStatsOf(entries),
  };
}

/**
 * 重建 index 的内存计数器。
 *
 * 这些数全都能从 index.ndjson 重算——本来就该从这里来，而不是指望内存里的累加
 * 能活过 service worker 被杀。
 *
 * @param {Array<Record<string, any>>} entries
 * @returns {import('./index-writer.js').IndexStats}
 */
function indexStatsOf(entries) {
  const counts = { by_verdict: {}, by_surface: {}, by_intent: {} };
  /** @type {Map<string, number>} */
  const perSegment = new Map();
  const bump = (bucket, key) => {
    if (typeof key === 'string') bucket[key] = (bucket[key] ?? 0) + 1;
  };
  for (const e of entries) {
    bump(counts.by_verdict, e.verdict);
    bump(counts.by_surface, e.surface);
    bump(counts.by_intent, e.intent);
    if (typeof e.segment === 'string') {
      perSegment.set(e.segment, (perSegment.get(e.segment) ?? 0) + 1);
    }
  }
  return { lineCount: entries.length, counts, perSegment };
}

/**
 * 从 index 汇总每条路线的条目数。
 *
 * 数的是**条目**不是页：用户理解的是「已抓 40 条广播」，不是「已抓 2 页」。
 *
 * `item_count` 有三种情形，对应三种算法——这跟捕获列表那边的措辞是同一套区分
 * （见 `src/ui/capture-label.js`）：
 *
 * | `item_count` | 含义 | 算几条 |
 * |---|---|---|
 * | 数字 | 这一页有这么多条目 | 就是它 |
 * | `null` | **这条路线没有条目概念**（作品详情页） | 1 —— 一次捕获就是一个条目 |
 * | 字段不存在 | 旧档案，写它的时候规范里还没这个字段 | 1，且是个**下界** |
 *
 * 最后一种会把 40 条广播数成 2 条。那是明知的低估，不是错报：这个数字只用来接上
 * 界面上的「已抓」，而低估会随着继续抓而自己收敛；反过来高估则会一直挂在那里。
 *
 * @param {Array<Record<string, any>>} entries
 * @returns {Record<string, number>}
 */
function countByRoute(entries) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const e of entries) {
    if (!e.route_key) continue;
    // 只数成功的：判定不是 ok 的那些没有内容，算进去等于虚报进度。
    if (e.verdict && e.verdict !== 'ok') continue;
    out[e.route_key] = (out[e.route_key] ?? 0) + (typeof e.item_count === 'number' ? e.item_count : 1);
  }
  return out;
}

/**
 * 从索引重建各留存等级的段状态。
 *
 * @param {Array<Record<string, any>>} entries
 * @returns {Record<string, {segmentNo: number, segments: Array<{filename: string, recordCount: number, firstCaptureId: string, lastCaptureId: string}>}>}
 */
function rebuildSegmentState(entries) {
  /** @type {Map<string, {filename: string, recordCount: number, firstCaptureId: string, lastCaptureId: string}>} */
  const perSegment = new Map();

  for (const e of entries) {
    const cur = perSegment.get(e.segment);
    if (cur) {
      cur.recordCount += 1;
      cur.lastCaptureId = e.capture_id;
    } else {
      perSegment.set(e.segment, {
        filename: e.segment,
        recordCount: 1,
        firstCaptureId: e.capture_id,
        lastCaptureId: e.capture_id,
      });
    }
  }

  /** @type {Record<string, {segmentNo: number, segments: any[]}>} */
  const byKind = {};
  for (const meta of perSegment.values()) {
    // 段文件名形如 `<kind>-<bundle_id>-<00001>.warc.gz`
    const m = /^([a-z]+)-.*-(\d{5})\.warc\.gz$/.exec(meta.filename);
    if (!m) continue;
    const [, kind, num] = m;
    byKind[kind] ??= { segmentNo: 0, segments: [] };
    byKind[kind].segments.push(meta);
    byKind[kind].segmentNo = Math.max(byKind[kind].segmentNo, Number(num));
  }
  for (const state of Object.values(byKind)) {
    state.segments.sort((a, b) => (a.filename < b.filename ? -1 : 1));
  }
  return byKind;
}
