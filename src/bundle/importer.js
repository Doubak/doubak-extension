/**
 * 导入：把用户磁盘上的档案搬回 OPFS。导出的反向。
 *
 * 规范：doubak-data-specs/bundle/v1/SPEC.md
 *
 * ## 为什么需要它
 *
 * 导出把档案变成用户手上的文件之后，**扩展就再也不认识它了**。而增量抓取要靠
 * 已有档案挑下界（`crawl/chain.js`），作品详情页去重要靠「这个账号名下的全部档案」。
 * 所以一旦用户把 OPFS 清干净——而我们一直在劝他这么做（「导出之后可以安全删除」）
 * ——下一次抓取就退回全量：几小时，而且把几千个详情页重抓一遍。
 *
 * 换机器、重装浏览器、扩展被清过站点数据，都是同一件事。导入是**让档案回得来**，
 * 否则「你的档案属于你」这句话只成立一半：拿得走，但拿不回来。
 *
 * ## 三条判断，全部朝着「宁可不导，不可覆盖」
 *
 * **① 身份是 `bundle_id`，不是目录名。** 用户会把导出的文件夹改名、放进
 * `备份/2026-08/` 里、解压两遍得到 `xxx (1)`。目录名一律只当线索，真相在
 * `manifest.json` 与 index 文件名里——而这三处**必须互相对得上**，对不上就是有人
 * 把两份档案的文件混进了一个目录，那时任何一种猜法都可能写出一份自相矛盾的档案。
 *
 * **② 已经在的绝不覆盖。** 这一条不靠界面上的确认框，而是**结构上做不到**：
 * 导入用的 Worker 写之前必须先认领目录，而认领只在目录不存在或为空时成立
 * （见 storage/opfs-rpc.js）。所以「导入把我抓了三小时的档案盖掉了」这件事
 * 没有代码路径能走到。
 *
 * **③ 残缺的档案不导。** 段文件少一个、字节数与 manifest 声明的对不上——这种
 * 目录导进来会变成一份**看起来正常**的档案：能选中、能导出、能被解析器读，
 * 只是索引里有些偏移量指向不存在的字节。而源文件还在用户盘上，拒绝导入
 * 什么都没损失；导进来则会让一份坏档案获得与好档案同等的外观。
 *
 * ## 复制本身走导出那套
 *
 * `copyBundle()`（exporter.js）两端一换就是导入。不另写一份，是因为两份实现
 * 迟早分叉，而分叉的方向是**导入这份少一项检查**——那些检查每一条都是出过事
 * 才加上的（回读校验、manifest 声明了却不在的文件、续传时逐个核对而不是只看
 * 文件在不在）。
 */

import { copyBundle, NOT_PART_OF_BUNDLE } from './exporter.js';
import { bundleIdFromDirName, isBundleId } from '../core/ids.js';

/** index 文件名的形状：`index-<bundle_id>.ndjson`。 */
const INDEX_RE = /^index-(\d{8}T\d{6}Z-[0-9a-f]{6})\.ndjson$/;

/**
 * 一个待导入的候选目录读起来是什么样。与 `FileStore` 的只读部分同形，
 * 所以 `MemoryFileStore` 直接可以当它用（测试里就是这么做的）。
 *
 * @typedef {object} ImportSource
 * @property {() => Promise<string[]>} list
 * @property {(name: string) => Promise<number>} size
 * @property {(name: string, offset?: number, length?: number) => Promise<Uint8Array>} read
 */

/**
 * @typedef {object} BundleMeta
 * @property {string} label              用户看得懂的位置（目录名/路径）
 * @property {string | null} bundleId
 * @property {'manifest'|'index'|'dirname'|null} idFrom  编号是从哪儿认出来的
 * @property {Array<{name: string, bytes: number}>} files
 * @property {number} bytes
 * @property {boolean} hasManifest
 * @property {string | null} accountUserId
 * @property {string | null} accountUsername
 * @property {string | null} previousBundleId
 * @property {string | null} completedAt
 * @property {Array<Record<string, any>>} crawlState
 * @property {Array<{code: string, detail: string}>} fatal     有一条就不导
 * @property {Array<{code: string, detail: string}>} warnings  照导，但要说出来
 */

/**
 * 读一个候选目录，判断它是不是一份能导的档案。
 *
 * **不读段文件的内容**，只看文件名与字节数。真正逐条解压核对是 `copyBundle` 的
 * 回读校验在做的事，而那要等用户确认之后——预检必须快，用户面对的是一次
 * 「选了个文件夹，告诉我里面有什么」。
 *
 * @param {ImportSource} source
 * @param {string} label
 * @returns {Promise<BundleMeta>}
 */
export async function readBundleMeta(source, label) {
  /** @type {BundleMeta} */
  const meta = {
    label,
    bundleId: null,
    idFrom: null,
    files: [],
    bytes: 0,
    hasManifest: false,
    accountUserId: null,
    accountUsername: null,
    previousBundleId: null,
    completedAt: null,
    crawlState: [],
    fatal: [],
    warnings: [],
  };

  let names;
  try {
    names = await source.list();
  } catch (e) {
    meta.fatal.push({ code: 'unreadable', detail: `这个文件夹读不了：${e.message}` });
    return meta;
  }

  for (const name of names) {
    let bytes = 0;
    try {
      bytes = await source.size(name);
    } catch (e) {
      meta.fatal.push({ code: 'unreadable', detail: `${name} 读不了：${e.message}` });
    }
    meta.files.push({ name, bytes });
  }
  meta.bytes = meta.files.reduce((n, f) => n + f.bytes, 0);

  /**
   * **所有** index 文件，不是第一个。
   *
   * 挑第一个会把这份检查最该抓的那种目录放过去：两份档案的文件混在一起时，两个
   * index 都在，而排序后**恰好先出现的那个常常与 manifest 对得上**——于是
   * 「三处必须一致」全票通过，另一份档案的段文件就跟着导了进来。
   */
  const indexNames = names.filter((n) => INDEX_RE.test(n));
  meta.hasManifest = names.includes('manifest.json');

  if (!meta.hasManifest && indexNames.length === 0) {
    meta.fatal.push({
      code: 'not_a_bundle',
      detail: '里面既没有 manifest.json，也没有 index-….ndjson —— 这不是一份档案目录。',
    });
    return meta;
  }

  /** 三处线索。**都要读出来再比**，不能读到一个就收工——对不上本身才是要抓的东西。 */
  const idsFromIndex = indexNames.map((n) => INDEX_RE.exec(n)[1]);
  const idFromDir = bundleIdFromDirName(label.split('/').pop() ?? label);
  let idFromManifest = null;
  /** @type {Record<string, any> | null} */
  let manifest = null;

  if (meta.hasManifest) {
    try {
      manifest = JSON.parse(new TextDecoder().decode(await source.read('manifest.json')));
    } catch (e) {
      meta.fatal.push({
        code: 'manifest_unreadable',
        detail: `manifest.json 解析不了：${e.message}。`
          + '它是这份档案的自述，坏了就没有任何东西能证明其余文件属于同一份档案。',
      });
    }
    if (manifest) {
      idFromManifest = typeof manifest.bundle_id === 'string' ? manifest.bundle_id : null;
      if (!idFromManifest) {
        meta.fatal.push({ code: 'manifest_unreadable', detail: 'manifest.json 里没有 bundle_id。' });
      }
    }
  } else {
    // 抓到一半就导出的档案没有 manifest（它只在收尾时写一次）。能导，但校验只能
    // 验字节数，而且它不带覆盖率证据、也进不了链——都要说清楚。
    meta.warnings.push({
      code: 'no_manifest',
      detail: '这一份没有 manifest.json —— 抓取还没收尾就导出的。可以导入，'
        + '但没有摘要可核对，也没有覆盖率证据，增量抓取用不了它当基准。',
    });
  }

  // **三处必须一致。** 不一致意味着有人把两份档案的文件放进了同一个目录，
  // 而那时任何一种猜法都可能写出一份自相矛盾的档案：index 说自己属于 A，
  // 段文件名里写着 B。
  const seen = [
    ['manifest.json 里', idFromManifest],
    ...idsFromIndex.map((v) => ['index 文件名里', v]),
    ['文件夹名里', idFromDir],
  ].filter(([, v]) => v);
  const distinct = [...new Set(seen.map(([, v]) => v))];

  if (distinct.length > 1) {
    meta.fatal.push({
      code: 'id_mismatch',
      detail: `同一个文件夹里出现了 ${distinct.length} 个不同的档案编号（`
        + seen.map(([where, v]) => `${where} ${v}`).join('，')
        + '）。多半是两份档案的文件被放进了一个目录 —— 请把它们分开再导。',
    });
    return meta;
  }
  if (distinct.length === 0) {
    meta.fatal.push({
      code: 'id_unknown',
      detail: '认不出这是哪一份档案：manifest、index 文件名、文件夹名都没给出合法的档案编号。',
    });
    return meta;
  }

  meta.bundleId = distinct[0];
  meta.idFrom = idFromManifest ? 'manifest' : (idsFromIndex.length ? 'index' : 'dirname');
  if (!isBundleId(meta.bundleId)) {
    meta.fatal.push({ code: 'id_unknown', detail: `档案编号不合法：${meta.bundleId}` });
    return meta;
  }

  if (manifest) {
    meta.accountUserId = manifest.account?.user_id ?? null;
    meta.accountUsername = manifest.account?.username ?? null;
    meta.previousBundleId = manifest.previous_bundle_id ?? null;
    meta.completedAt = manifest.completed_at ?? null;
    meta.crawlState = manifest.crawl_state ?? [];
    checkDeclaredFiles(meta, manifest);
  }

  if (names.includes('checkpoint.json')) {
    // 不跟着档案走（NOT_PART_OF_BUNDLE）。说一句，免得用户以为导进来就能接着抓
    // 那次没跑完的抓取。
    meta.warnings.push({
      code: 'checkpoint_present',
      detail: 'checkpoint.json 是抓取过程的内部状态，不属于档案，不会导入。',
    });
  }

  return meta;
}

/**
 * manifest 声明的文件，一个都不能少，字节数也要对得上。
 *
 * ## 为什么这两条是「不导」而不是「导了再说」
 *
 * 少一个段文件的档案导进来之后**看起来是正常的**：能选中、能导出、能被解析器读，
 * 只是索引里有一批偏移量指向不存在的字节。而这个项目最不能出的错，就是让一份
 * 坏档案获得与好档案同等的外观。
 *
 * 拒绝的代价是零：源文件还在用户盘上，什么都没丢。用户去把缺的那个文件找回来，
 * 再导一次就行——所以报错里要**写出缺的是哪一个**。
 */
function checkDeclaredFiles(meta, manifest) {
  const have = new Map(meta.files.map((f) => [f.name, f.bytes]));
  /** @type {Set<string>} */
  const declared = new Set();

  for (const seg of manifest.segments ?? []) {
    if (!seg?.filename) continue;
    declared.add(seg.filename);
    if (!have.has(seg.filename)) {
      meta.fatal.push({
        code: 'missing_file',
        detail: `manifest 声明了段文件 ${seg.filename}，但它不在这个文件夹里。`
          + '把它找回来再导 —— 少一个段文件，索引里就有一批偏移量指向不存在的字节。',
      });
      continue;
    }
    if (typeof seg.bytes === 'number' && have.get(seg.filename) !== seg.bytes) {
      meta.fatal.push({
        code: 'size_mismatch',
        detail: `${seg.filename} 的字节数与 manifest 声明的对不上`
          + `（声明 ${seg.bytes}，实际 ${have.get(seg.filename)}）。`
          + '多半是复制中途断了，或者盘满过。',
      });
    }
  }

  if (manifest.index?.filename) {
    declared.add(manifest.index.filename);
    if (!have.has(manifest.index.filename)) {
      meta.fatal.push({
        code: 'missing_file',
        detail: `manifest 声明了索引 ${manifest.index.filename}，但它不在这个文件夹里。`,
      });
    }
  }

  // 声明之外的文件。README.txt 与 manifest.json 本来就没有摘要，是常态；
  // 别的东西出现在这里值得说一句——最可能的是**另一份档案的段文件混了进来**，
  // 而那种目录导进来会得到一份带着别人字节的档案。
  const expectedExtras = new Set(['manifest.json', 'README.txt', 'checkpoint.json']);
  const stray = meta.files
    .map((f) => f.name)
    .filter((n) => !declared.has(n) && !expectedExtras.has(n));
  if (stray.length) {
    meta.warnings.push({
      code: 'undeclared_file',
      detail: `有 ${stray.length} 个文件 manifest 没有声明（${stray.slice(0, 3).join('、')}`
        + `${stray.length > 3 ? ' 等' : ''}）。它们会一起导入，但不在校验范围内。`
        + '如果里面有段文件，请确认没有把另一份档案的文件混进来。',
    });
  }
}

/**
 * 两份同编号的档案，内容是什么关系。
 *
 * 只比文件名与字节数，不比摘要：三种结论的后果分别是「跳过」「续传」「拒绝」，
 * 全都在安全的一侧，而比摘要要把几百 MB 读两遍。真正的逐字节核对在
 * `copyBundle` 的回读校验里，那是用户确认要导之后的事。
 *
 * @param {Array<{name: string, bytes: number}>} src
 * @param {Array<{name: string, bytes: number}>} dst
 * @returns {'same' | 'partial' | 'different'}
 */
export function compareContents(src, dst) {
  const keep = (fs) => fs.filter((f) => !NOT_PART_OF_BUNDLE.has(f.name));
  const s = new Map(keep(src).map((f) => [f.name, f.bytes]));
  const d = new Map(keep(dst).map((f) => [f.name, f.bytes]));

  // 目的地有而源里没有、或者字节数不一样 —— 说不清是谁对，不碰。
  for (const [name, bytes] of d) {
    if (!s.has(name) || s.get(name) !== bytes) return 'different';
  }
  // 目的地是源的子集：**上一次导到一半**（或者 OPFS 里那份是没收尾的抓取，
  // 而手上这份是它收尾后的导出）。续传能把它补齐。
  return d.size === s.size ? 'same' : 'partial';
}

/**
 * @typedef {object} ExistingBundle
 * @property {string} bundleId
 * @property {Array<{name: string, bytes: number}>} files
 * @property {string | null} [accountUserId]
 * @property {string | null} [accountUsername]
 */

/** 一个候选最终会怎么处置。 */
export const ACTIONS = /** @type {const} */ ({
  IMPORT: 'import',
  RESUME: 'resume',
  PRESENT: 'present',
  DUPLICATE: 'duplicate',
  CONFLICT: 'conflict',
  OTHER_ACCOUNT: 'other_account',
  ACTIVE: 'active',
  REFUSE: 'refuse',
});

/**
 * 把一批候选排成一份「将要发生什么」的清单。
 *
 * **纯函数，不碰任何存储。** 用户看到的那份预览就是它的返回值——先看清楚再写，
 * 而不是边写边报告。这与导出那边「目的地非空时先去数一数已经导好了几个，再把
 * 将要发生什么原原本本说出来」是同一条规矩。
 *
 * @param {object} opts
 * @param {BundleMeta[]} opts.candidates      扫出来的，顺序即用户目录里的顺序
 * @param {ExistingBundle[]} opts.existing    OPFS 里已经有的
 * @param {string | null} [opts.activeBundleId]  正在抓的那一份
 * @param {boolean} [opts.allowOtherAccounts]
 * @returns {{items: Array<{meta: BundleMeta, action: string, detail: string}>,
 *   homeAccount: {userId: string|null, username: string|null} | null,
 *   holes: Array<{bundleId: string, missing: string}>,
 *   bytes: number, count: number}}
 */
export function planImport({
  candidates, existing, activeBundleId = null, allowOtherAccounts = false,
}) {
  const byId = new Map(existing.map((e) => [e.bundleId, e]));
  const homeAccount = pickHomeAccount(existing, candidates);

  /** @type {Array<{meta: BundleMeta, action: string, detail: string}>} */
  const items = [];
  /** 这一批里已经决定要导的编号，用来认出选区内部的重复。 */
  const claimedInBatch = new Map();

  for (const meta of candidates) {
    const say = (action, detail) => items.push({ meta, action, detail });

    if (meta.fatal.length) {
      say(ACTIONS.REFUSE, meta.fatal.map((f) => f.detail).join(' '));
      continue;
    }

    if (meta.bundleId === activeBundleId) {
      say(ACTIONS.ACTIVE,
        '正在抓的就是这一份，不能往它上面导。等抓完，或者在概览页中止这次抓取。');
      continue;
    }

    // ── 选区内部的重复：同一份档案在用户选的目录树里出现了不止一次。
    // 解压两遍、`备份` 与 `备份 (1)` 并存，都会造成这个。
    const twin = claimedInBatch.get(meta.bundleId);
    if (twin) {
      const rel = compareContents(twin.files, meta.files);
      say(ACTIONS.DUPLICATE, rel === 'same'
        ? `与 ${twin.label} 是同一份档案（编号一样、文件也一样），导一次就够。`
        : `与 ${twin.label} 编号相同但内容不同 —— 只导先找到的那一份。`
          + '如果拿不准哪份是对的，请分开放到两个文件夹里分别确认。');
      continue;
    }

    // ── 账号。数字 ID 不同就是**别人的档案**。
    if (!allowOtherAccounts && isOtherAccount(meta, homeAccount)) {
      say(ACTIONS.OTHER_ACCOUNT,
        `这一份是账号 ${meta.accountUsername ?? meta.accountUserId} 的，`
        + `而这里已有的档案属于 ${homeAccount.username ?? homeAccount.userId}。`
        + '两个账号的档案混在一起，解析器会拒绝整个目录（合过之后拆不开）。');
      continue;
    }

    const here = byId.get(meta.bundleId);
    if (here) {
      const rel = compareContents(meta.files, here.files);
      if (rel === 'same') {
        say(ACTIONS.PRESENT, '这一份已经在扩展里了，文件与字节数完全一致，跳过。');
        continue;
      }
      if (rel === 'partial') {
        say(ACTIONS.RESUME,
          `扩展里已经有这一份的 ${here.files.length} 个文件，还差 `
          + `${meta.files.length - here.files.length} 个 —— 只补缺的那些。`);
        claimedInBatch.set(meta.bundleId, meta);
        continue;
      }
      say(ACTIONS.CONFLICT,
        '扩展里已经有同编号的一份，但内容对不上（文件不同或字节数不同）。'
        + '不覆盖 —— 同一个编号下有两种内容，说不清哪一份是对的。'
        + '要换成手上这一份的话，先在这一页删掉旧的那份。');
      continue;
    }

    claimedInBatch.set(meta.bundleId, meta);
    say(ACTIONS.IMPORT, meta.hasManifest ? '导入并逐个核对摘要。' : '导入（没有摘要，只核对字节数）。');
  }

  const going = items.filter((i) => i.action === ACTIONS.IMPORT || i.action === ACTIONS.RESUME);
  return {
    items,
    homeAccount,
    holes: findHoles(items, existing),
    bytes: going.reduce((n, i) => n + i.meta.bytes, 0),
    count: going.length,
  };
}

/**
 * 「这里的档案属于谁」。
 *
 * OPFS 里已经有档案时以它们为准——那是这台浏览器的主人。一份都没有时（刚装、
 * 刚清空）才从候选里推，取占多数的那个账号。
 *
 * **拿不准就返回 null**，那时不拦任何东西：宁可让用户自己看着办，也不要拿一个
 * 猜出来的「主账号」去拒绝他真正想导的档案。
 */
function pickHomeAccount(existing, candidates) {
  const count = (rows) => {
    /** @type {Map<string, {userId: string, username: string|null, n: number}>} */
    const m = new Map();
    for (const r of rows) {
      const id = r.accountUserId;
      if (!id) continue;
      const cur = m.get(id) ?? { userId: id, username: r.accountUsername ?? null, n: 0 };
      cur.n += 1;
      m.set(id, cur);
    }
    return [...m.values()].sort((a, b) => b.n - a.n);
  };

  const fromExisting = count(existing);
  if (fromExisting.length) return fromExisting[0];
  const fromCandidates = count(candidates.filter((c) => !c.fatal.length));
  return fromCandidates.length ? fromCandidates[0] : null;
}

/**
 * 是不是别人的档案。
 *
 * **只有数字 ID 不同才算。** 改过名（ID 相同、用户名不同）不算别人——`chain.js`
 * 已经会因为改名退回全量抓取，那是正确处理，不是拒绝导入的理由；把改名当成
 * 「别人」会让用户导不进自己的旧档案。
 *
 * 没有 manifest 的那些认不出账号，一律放行：拒绝一份认不出账号的档案，
 * 等于因为它残缺而惩罚它，而残缺恰恰是它最需要被搬回来的理由。
 */
function isOtherAccount(meta, homeAccount) {
  if (!homeAccount?.userId || !meta.accountUserId) return false;
  return meta.accountUserId !== homeAccount.userId;
}

/**
 * 导完之后，哪些「接在谁后面」还是指向一份不在场的档案。
 *
 * **不是拒绝的理由**：链断了不代表在场的这几份无效，它们各自抓到的东西照样有效，
 * 只是「从今天连续回溯到 X」这句话证明不了。但必须说出来，而且要说出**缺的是哪一份**
 * ——用户多半还留着它，只是没选进来。
 */
function findHoles(items, existing) {
  const after = new Set(existing.map((e) => e.bundleId));
  for (const i of items) {
    if (i.action === ACTIONS.IMPORT || i.action === ACTIONS.RESUME) after.add(i.meta.bundleId);
  }
  /** @type {Array<{bundleId: string, missing: string}>} */
  const holes = [];
  for (const i of items) {
    const prev = i.meta.previousBundleId;
    if (!prev) continue;
    if (i.action !== ACTIONS.IMPORT && i.action !== ACTIONS.RESUME) continue;
    if (!after.has(prev)) holes.push({ bundleId: i.meta.bundleId, missing: prev });
  }
  return holes;
}

/**
 * 真的搬一份进来。
 *
 * `dest` 必须是**已经认领过**的目录（`WorkerFileStore.claimForImport()`）——那是
 * 「绝不覆盖已有档案」这条的实际执行处，而它在 Worker 一侧，不靠这里自觉。
 *
 * @param {object} opts
 * @param {ImportSource} opts.source
 * @param {import('../storage/file-store.js').FileStore} opts.dest
 * @param {boolean} [opts.resume]
 * @param {number} [opts.chunkBytes]
 * @param {(p: object) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 */
export function importBundle({ source, dest, resume = false, chunkBytes, onProgress, signal }) {
  return copyBundle({
    store: source,
    sink: fileStoreSink(dest),
    // 认领过的目录一定是空的，所以首次导入不会撞上「目的地非空」；续传时是
    // 明确的选择，与导出那边同一套语义。
    overwrite: true,
    resume,
    chunkBytes,
    onProgress,
    signal,
    verb: '导入',
  });
}

/**
 * 把一个 `FileStore` 当作复制的目的地。
 *
 * 与 exporter.js 里那个同名函数是同一件事，但**不复用它**：那边接的是导出，
 * 这边接的是导入，两条路径将来可能各自要加东西（比如导入侧的配额重试）。
 * 十行的重复，换掉的是一处「改导出顺手改坏导入」的可能。
 *
 * @param {import('../storage/file-store.js').FileStore} store
 */
function fileStoreSink(store) {
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

// ── 下面是 File System Access 那一侧。**只能在窗口里用。** ──────────────

/**
 * 把一个目录句柄当作导入源。
 *
 * 读取走 `File.slice()`，**不把整个文件读进内存**——真实档案里单个段文件可以到
 * 256 MiB，而用户可能一次导八份。
 *
 * @param {FileSystemDirectoryHandle} dir
 * @returns {ImportSource}
 */
export function directorySource(dir) {
  /** @param {string} name */
  const fileOf = async (name) => (await dir.getFileHandle(name)).getFile();
  return {
    async list() {
      /** @type {string[]} */
      const out = [];
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'file') out.push(name);
      }
      return out.sort();
    },
    async size(name) {
      return (await fileOf(name)).size;
    },
    async read(name, offset, length) {
      const file = await fileOf(name);
      const start = offset ?? 0;
      const end = length === undefined ? file.size : start + length;
      return new Uint8Array(await file.slice(start, end).arrayBuffer());
    },
  };
}

/** 一个目录看起来像不像档案目录。 */
function looksLikeBundle(names) {
  return names.includes('manifest.json') || names.some((n) => INDEX_RE.test(n));
}

/**
 * 在用户选的目录里找档案。
 *
 * ## 为什么要往下找，而不是只看用户选的那一层
 *
 * 「导出整条链」产出的就是**一个父目录 + 每份档案各一个子目录**，所以用户选中
 * 父目录是最自然的操作。而真实的下载目录还会再套几层：解压出来的
 * `豆备备份.zip/豆备备份/doubak-bundle-…`、按月归档的 `备份/2026-08/…`。
 * 只看一层的话，用户会得到一句「这里没有档案」，而档案就在下面一层。
 *
 * ## 为什么找到就不再往下
 *
 * 档案目录里不该有子目录。进去只会浪费时间，还可能把某个恰好同名的东西也当成
 * 候选。
 *
 * ## 为什么有上限
 *
 * 用户完全可能手滑选中整个「下载」目录，甚至用户主目录。没有上限的话界面会在
 * 那儿转上几分钟，而它什么都不会说。到了上限就**停下并说出来**——报一个不完整
 * 的结果而不声张，是这个项目最不能出的那类错。
 *
 * @param {FileSystemDirectoryHandle} root
 * @param {object} [opts]
 * @param {number} [opts.maxDepth]
 * @param {number} [opts.maxDirs]
 * @returns {Promise<{found: Array<{label: string, source: ImportSource}>, scanned: number, truncated: boolean}>}
 */
export async function scanForBundles(root, { maxDepth = 3, maxDirs = 400 } = {}) {
  /** @type {Array<{label: string, source: ImportSource}>} */
  const found = [];
  let scanned = 0;
  let truncated = false;

  /** @param {FileSystemDirectoryHandle} dir @param {string} path @param {number} depth */
  async function walk(dir, path, depth) {
    if (truncated) return;
    if (scanned >= maxDirs) { truncated = true; return; }
    scanned += 1;

    /** @type {string[]} */
    const files = [];
    /** @type {Array<[string, FileSystemDirectoryHandle]>} */
    const subs = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file') files.push(name);
      else subs.push([name, handle]);
    }

    if (looksLikeBundle(files)) {
      found.push({ label: path, source: directorySource(dir) });
      return; // 档案目录里不该有子目录，别再往下
    }
    if (depth >= maxDepth) return;
    // 排序：同一个目录树两次扫出来的顺序要一样，否则「先找到的那一份」会变。
    subs.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const [name, sub] of subs) await walk(sub, `${path}/${name}`, depth + 1);
  }

  await walk(root, root.name, 0);
  return { found, scanned, truncated };
}
