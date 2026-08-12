/**
 * 把档案从 OPFS 导出到用户自己选的目录。
 *
 * 设计：DESIGN.md F-08、docs/ui.md §6
 *
 * ## 为什么这一步不能马虎
 *
 * OPFS 里的东西**不属于用户**：它挂在扩展的来源下，卸载扩展、清站点数据、
 * 某些「清理浏览器」操作都能把它一次性抹掉，而用户完全不会被问一句。导出是
 * 档案从「浏览器里的一份缓存」变成「用户手上的文件」的那一刻——在那之前，
 * 这个项目关于长期保存的全部承诺都还没兑现。
 *
 * 更要紧的是**导出之后用户会删掉 OPFS 那一份**。所以一次悄悄截断的导出不是
 * 「少了几个字节」，而是唯一的副本没了。这就是下面要花一整趟回读去校验的
 * 理由。
 *
 * ## 三条约束
 *
 * **① 流式复制，绝不在内存里拼一个大 Blob。** 真实档案 782 MB，段文件上限
 * 256 MiB。整份读进内存在低配机器上直接崩，而崩的时间点是用户刚点完「导出」
 * 满怀期待的时候。
 *
 * **② 校验必须回读目的地，不能只信源头。** 源头对不对根本不是问题所在——
 * 问题是字节有没有真的落到用户的盘上。配额耗尽、U 盘拔了、写入被中断，这些
 * 全都只在目的地那一侧看得见。
 *
 * **③ 校验结果只说自己真验过的那部分。** 字节数一致和摘要一致是两件事，
 * 界面上分开说。把前者叫成「已校验」是这个项目一直在躲的那种假安心。
 *
 * ## 为什么不打包成一个 zip
 *
 * 档案就该是一个**目录里的普通文件**。zip 多一层格式、多一次全量读写，还让
 * 「2040 年的陌生人拿 jq 就能看」这件事多一道手续。规范里的 bundle 本来就是
 * 目录形态，导出保持原样是最省事也最耐久的选择。
 */

import { sha256Hex } from '../core/digest.js';

/** 每次搬多少。够大以摊薄单次写入开销，又远小于段文件上限。 */
export const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * 导出的目的地。
 *
 * 只有两个操作，刻意做得比 FileStore 还窄：导出是**只写不改**的——它往一个
 * 空目录里放文件，没有任何理由去追加、截断或修改已有内容。
 *
 * @typedef {object} ExportSink
 * @property {(name: string) => Promise<ExportSinkFile>} open  建文件，返回可流式写入的句柄
 * @property {(name: string) => Promise<Uint8Array>} [read]
 *   回读用。**没有它就没法校验**——那种情况下如实报告「未校验」，不许含糊过去。
 * @property {() => Promise<string[]>} [list]
 */

/**
 * @typedef {object} ExportSinkFile
 * @property {(bytes: Uint8Array) => Promise<void>} write
 * @property {() => Promise<void>} close
 */

/**
 * 不该跟着档案走的文件。
 *
 * `checkpoint.json` 是**抓取过程的内部状态**，不是档案的一部分：它记的是
 * frontier 游标与暂停原因，只对 OPFS 里那份正在跑的抓取有意义。带出去既不
 * 符合规范里 bundle 的文件清单，也会让人误以为导出的这份能拿去接着抓。
 */
export const NOT_PART_OF_BUNDLE = new Set(['checkpoint.json']);

/**
 * 看看目的地已经有什么，哪些是完好的。
 *
 * ## 为什么续导不需要一个「进度文件」
 *
 * **目的地目录本身就是进度。** 每个文件要么完整、要么不在——把已完整的挑出来
 * 跳过，剩下的照抄，就是续导的全部。
 *
 * 记一个 `export-progress.json` 反而更糟：它会与真实情况不同步（用户手动删了
 * 一个文件、盘满了写了一半），而**崩溃恰恰是最没机会写下状态的时刻**——
 * 而崩溃正是续导要解决的场景。
 *
 * ## 中断留下的是「没有这个文件」，不是「半个文件」
 *
 * `createWritable()` 写的是临时文件，只在 `close()` 那一刻整体换上去。所以
 * 抓取被打断时，目的地要么是上一次的完整内容，要么这个文件根本不存在——
 * 不会留下一个截断的半成品。这让「完整就跳过」这条判据站得住。
 *
 * 但仍然**要验，不能只看在不在**：盘满、U 盘拔掉、上一次导的是别的档案，
 * 这些都会留下一个大小或摘要对不上的同名文件。
 *
 * @param {object} opts
 * @param {import('../storage/file-store.js').FileStore} opts.store
 * @param {ExportSink} opts.sink
 * @param {string[]} opts.files  这份档案该有的文件
 * @param {Map<string, string>} opts.expected  manifest 声明的 sha256
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<Map<string, {ok: boolean, bytes: number, digestOk: boolean|null, reason?: string}>>}
 */
export async function inspectDestination({ store, sink, files, expected, signal }) {
  /** @type {Map<string, {ok: boolean, bytes: number, digestOk: boolean|null, reason?: string}>} */
  const out = new Map();
  if (!sink.list || !sink.read) return out;

  const there = new Set(await sink.list());
  for (const name of files) {
    throwIfAborted(signal);
    if (!there.has(name)) continue;

    const want = await store.size(name);
    let actual;
    try {
      actual = await sink.read(name);
    } catch (e) {
      out.set(name, { ok: false, bytes: 0, digestOk: null, reason: `读不回来：${e.message}` });
      continue;
    }
    if (actual.length !== want) {
      out.set(name, {
        ok: false, bytes: actual.length, digestOk: null,
        reason: `字节数对不上：源 ${want}，目的地 ${actual.length}`,
      });
      continue;
    }

    const wantDigest = expected.get(name);
    if (!wantDigest) {
      // manifest 没声明它的摘要（manifest.json 自己、README.txt，或抓取没收尾）。
      // 字节数一致就认——**并且如实记下摘要没验过**，别让它冒充「验过了」。
      out.set(name, { ok: true, bytes: actual.length, digestOk: null });
      continue;
    }
    const got = await sha256Hex(actual);
    out.set(name, {
      ok: got === wantDigest,
      bytes: actual.length,
      digestOk: got === wantDigest,
      reason: got === wantDigest ? undefined : `摘要对不上`,
    });
  }
  return out;
}

/**
 * 把一个档案目录整份复制出去。
 *
 * @param {object} opts
 * @param {import('../storage/file-store.js').FileStore} opts.store  源（OPFS）
 * @param {ExportSink} opts.sink  目的地（用户选的目录）
 * @param {number} [opts.chunkBytes]
 * @param {boolean} [opts.verify]  默认 true。关掉它的唯一正当理由是用户明确
 *   接受「没验过」——而不是为了快一点。
 * @param {boolean} [opts.overwrite]  目的地非空时是否照写。默认 false。
 * @param {boolean} [opts.resume]  续导：目的地已有且校验通过的文件跳过不抄。
 *   隐含 overwrite（校验不通过的照样重写），所以它是一个**明确的选择**，
 *   不会自动发生。
 * @param {(p: {phase: 'copy' | 'verify', file: string, done: number, total: number, files: number, fileIndex: number}) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 */
export async function exportBundle(opts) {
  return copyBundle({ ...opts, verb: '导出' });
}

/**
 * 搬一份档案，从一个 `FileStore` 到一个 `ExportSink`。
 *
 * ## 为什么导入也走这里
 *
 * 导入就是**把两端调个个儿**：源变成用户磁盘上的目录，目的地变成 OPFS。要做的事
 * 一模一样——按块流式复制、回读校验、跳过已经完整的、核对 manifest 声明了却不在的
 * 文件。写第二份实现，它们迟早会分叉，而分叉的方向是**导入那份少一项检查**：
 * 那些检查每一条都是曾经出过事才加上的。
 *
 * 只有措辞不同，所以只把动词参数化。
 *
 * @param {object} opts
 * @param {string} [opts.verb]  界面上叫它「导出」还是「导入」
 */
export async function copyBundle({
  store, sink, chunkBytes = DEFAULT_CHUNK_BYTES, verify = true, overwrite = false,
  resume = false, onProgress = () => {}, signal, verb = '导出',
}) {
  const all = await store.list();
  const files = all.filter((f) => !NOT_PART_OF_BUNDLE.has(f)).sort();
  if (files.length === 0) throw new Error(`这个档案目录是空的，没有东西可${verb}`);

  // 目的地是**用户在文件选择器里随手点的**一个目录，完全可能是文档目录、
  // 甚至是上一次导出的档案。同名即覆盖，而覆盖掉的东西没有回收站。
  // 所以默认拒绝往非空目录里写，让调用方去问用户。
  if (!overwrite && !resume && sink.list) {
    const existing = await sink.list();
    if (existing.length > 0) {
      const err = new Error(
        `目标文件夹里已经有 ${existing.length} 个文件（${existing.slice(0, 3).join('、')}` +
          `${existing.length > 3 ? ' 等' : ''}）。请另选一个空文件夹，或确认覆盖。`,
      );
      err.code = 'destination_not_empty';
      err.existing = existing;
      throw err;
    }
  }

  // manifest 里带着每个段文件的 sha256，是校验的**唯一权威来源**。
  // 没有它（抓取还没收尾）就只能验字节数，而那时必须如实这么说。
  const expected = await readExpectedDigests(store, files);

  // 续导：先看目的地已经有什么。校验通过的不再抄一遍——**那正是续导的全部**，
  // 不需要任何额外的进度状态。
  const already = resume
    ? await inspectDestination({ store, sink, files, expected, signal })
    : new Map();

  /** @type {Array<{name: string, bytes: number}>} */
  const copied = [];
  /** 跳过的（已经在目的地且验过）。它们仍然要出现在最终结果里。 */
  const skipped = [];
  let index = 0;

  for (const name of files) {
    throwIfAborted(signal);
    const pre = already.get(name);
    if (pre?.ok) {
      skipped.push({ name, bytes: pre.bytes, digestOk: pre.digestOk });
      index += 1;
      continue;
    }
    const total = await store.size(name);
    const out = await sink.open(name);
    let done = 0;

    try {
      // 空文件也要建出来。少一个文件和少一段内容一样是残缺，而空段文件在
      // 崩溃恢复之后是可能出现的。
      onProgress({ phase: 'copy', file: name, done: 0, total, files: files.length, fileIndex: index });
      while (done < total) {
        throwIfAborted(signal);
        const n = Math.min(chunkBytes, total - done);
        await out.write(await store.read(name, done, n));
        done += n;
        onProgress({ phase: 'copy', file: name, done, total, files: files.length, fileIndex: index });
      }
    } finally {
      // 出错也要关。半开的句柄在 File System Access 那一侧会把文件留在
      // 未落盘状态，比一个明确写坏了的文件更难查。
      await out.close();
    }

    copied.push({ name, bytes: total });
    index += 1;
  }

  const results = verify
    ? await verifyCopied({ sink, copied, expected, onProgress, signal })
    : copied.map((c) => ({ ...c, sizeOk: null, digestOk: null, reason: '按要求跳过了校验' }));

  // 跳过的那些**刚刚才验过**（就在 inspectDestination 里），不必再读一遍——
  // 对 782 MB 的档案来说那是白白多花一趟。但它们必须出现在结果里，
  // 否则「manifest 声明了却没导出」那条检查会把它们全报成缺失。
  for (const sk of skipped) {
    results.push({
      name: sk.name, bytes: sk.bytes, sizeOk: true, digestOk: sk.digestOk,
      reason: sk.digestOk === null
        ? `上次已${verb}（字节数一致，manifest 里没有摘要）`
        : `上次已${verb}，校验通过`,
      skipped: true,
    });
  }

  const problems = results.filter((r) => r.sizeOk === false || r.digestOk === false);

  // manifest 声明了却没被导出的文件，是最该抓的一种残缺——它在结果列表里
  // 根本不出现，因此不会被上面任何一条检查逮到。
  for (const name of expected.keys()) {
    if (!copied.some((c) => c.name === name) && !skipped.some((c) => c.name === name)) {
      problems.push({
        name, bytes: 0, sizeOk: false, digestOk: false,
        reason: 'manifest 声明了这个文件，但源目录里没有',
      });
    }
  }

  // 「验过了」「只验了字节数」「没验」是三件事，别折成一个布尔。
  //
  // `manifest.json` 装不下自己的摘要，`README.txt` 是生成的说明文字——
  // 这两个没有摘要可对是**常态**，不该把整次导出拖成「未校验」。真正的
  // 分界线是：manifest 到底存不存在。
  const allDeclaredOk =
    expected.size > 0 && results.every((r) => r.digestOk === true || !expected.has(r.name));

  return {
    files: results,
    // 这次真的搬了多少字节。**跳过的不算**——报进去会让「续导省了多少」
    // 这件事看不出来，而那正是用户想知道的。
    bytes: copied.reduce((a, c) => a + c.bytes, 0),
    skipped: skipped.length,
    skippedBytes: skipped.reduce((a, c) => a + c.bytes, 0),
    problems,
    verified: verify && problems.length === 0 && allDeclaredOk,
    verifiedSizeOnly: verify && problems.length === 0 && !allDeclaredOk,
  };
}

/**
 * 回读目的地并逐个核对。
 *
 * 顺序是先字节数、后摘要：字节数不对的时候摘要必然也不对，先报前者能给出
 * 有用得多的信息（差了多少、差在哪个文件）。
 */
async function verifyCopied({ sink, copied, expected, onProgress, signal }) {
  /** @type {Array<object>} */
  const out = [];
  let index = 0;

  for (const { name, bytes } of copied) {
    throwIfAborted(signal);
    onProgress({
      phase: 'verify', file: name, done: 0, total: bytes, files: copied.length, fileIndex: index,
    });
    index += 1;

    if (!sink.read) {
      out.push({ name, bytes, sizeOk: null, digestOk: null, reason: '目的地读不回来，无法校验' });
      continue;
    }

    let actual;
    try {
      actual = await sink.read(name);
    } catch (e) {
      out.push({ name, bytes, sizeOk: false, digestOk: false, reason: `读不回来：${e.message}` });
      continue;
    }

    const sizeOk = actual.length === bytes;
    if (!sizeOk) {
      out.push({
        name, bytes, sizeOk: false, digestOk: false,
        reason: `字节数对不上：写出 ${bytes}，读回 ${actual.length}`,
      });
      continue;
    }

    const want = expected.get(name);
    if (!want) {
      // manifest 没声明这个文件的摘要（比如 manifest.json 自己、README.txt，
      // 或者抓取还没收尾）。字节数验过了，摘要没有——就这么说。
      out.push({ name, bytes, sizeOk: true, digestOk: null, reason: 'manifest 里没有这个文件的摘要' });
      continue;
    }

    const got = await sha256Hex(actual);
    out.push({
      name, bytes, sizeOk: true, digestOk: got === want,
      reason: got === want ? undefined : `摘要对不上：期望 ${want}，实得 ${got}`,
    });
  }

  return out;
}

/**
 * 从 manifest 里取各段声明的 sha256。
 *
 * 拿不到就返回空表——这不是错误：抓取还没收尾时本来就没有 manifest，而那时
 * 用户照样有权把手上的东西导出去。能验多少验多少，验不了的如实说。
 *
 * @returns {Promise<Map<string, string>>}
 */
async function readExpectedDigests(store, files) {
  /** @type {Map<string, string>} */
  const m = new Map();
  if (!files.includes('manifest.json')) return m;

  try {
    const manifest = JSON.parse(new TextDecoder().decode(await store.read('manifest.json')));
    for (const seg of manifest.segments ?? []) {
      if (seg.filename && seg.sha256) m.set(seg.filename, seg.sha256);
    }
    if (manifest.index?.filename && manifest.index?.sha256) {
      m.set(manifest.index.filename, manifest.index.sha256);
    }
  } catch {
    // manifest 坏了本身是个问题，但不该让导出失败——用户手上这份再残破，
    // 也比留在随时可能被清掉的 OPFS 里强。
  }
  return m;
}

/** @param {AbortSignal} [signal] */
function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error('已取消');
}

/**
 * 用 FileStore 当目的地。测试用，也是「导出到另一个 OPFS 目录」的实现。
 *
 * @param {import('../storage/file-store.js').FileStore} store
 * @returns {ExportSink}
 */
export function fileStoreSink(store) {
  return {
    async open(name) {
      await store.replace(name, new Uint8Array(0));
      return {
        write: (bytes) => store.append(name, bytes),
        close: async () => {},
      };
    },
    read: (name) => store.read(name),
    list: () => store.list(),
  };
}

/**
 * 用 File System Access 的目录句柄当目的地。**只能在窗口里用**——service
 * worker 里没有 `showDirectoryPicker`，也不该有：选目录是个需要用户手势的
 * 动作，而 worker 随时会被杀。
 *
 * @param {FileSystemDirectoryHandle} dir
 * @returns {ExportSink}
 */
/**
 * 往**子目录**里导。
 *
 * 导出整条链时必须这样：每份档案都有 `manifest.json` 与 `README.txt`，平铺到同一个
 * 目录里后一份会覆盖前一份——那不是理论问题，用户的下载目录里就只剩了最后一次导出
 * 的 manifest，早先几份的全没了。
 *
 * 目录名用 `doubak-bundle-<id>`，与 OPFS 里的一致：搬回来的时候不用改名。
 *
 * @param {FileSystemDirectoryHandle} parent
 * @param {string} name
 */
export async function subdirectorySink(parent, name) {
  const sub = await parent.getDirectoryHandle(name, { create: true });
  return directorySink(sub);
}

export function directorySink(dir) {
  return {
    async open(name) {
      const fh = await dir.getFileHandle(name, { create: true });
      // createWritable 走的是浏览器的流式写入，不经过 JS 堆——这正是能搬
      // 800 MB 而不炸内存的原因。
      const w = await fh.createWritable();
      return {
        write: (bytes) => w.write(bytes),
        close: () => w.close(),
      };
    },
    async read(name) {
      const fh = await dir.getFileHandle(name);
      const file = await fh.getFile();
      return new Uint8Array(await file.arrayBuffer());
    },
    async list() {
      const names = [];
      for await (const n of dir.keys()) names.push(n);
      return names.sort();
    },
  };
}
