/* 【自动同步，请勿手改】来自 doubak-data-parser 的 src/parse.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/**
 * 主流程：一堆 bundle → canonical。
 *
 * ## 它是对**全集**的纯函数
 *
 * 不是「在上次结果上打补丁」。canonical/INGESTION.md §5.1 要求：对 N 份档案跑一遍，
 * 再对 N+1 份跑一遍，第二次不得丢掉第一次得到的任何东西。做成增量的话，这条性质
 * 要靠小心维护；做成纯函数则它是**免费**的。
 *
 * 增量解析可以后来再加，那是缓存优化，不是语义。
 */

import { extractMarks } from './extract.js';
import { extractBroadcasts } from './extract-broadcast.js';
import { topology, assertSingleAccount } from './topology.js';
import { extractSubjectDetail } from './extract-subject.js';
import { extractLongform } from './extract-longform.js';
import { extractDoulist, mergeDoulistPages } from './extract-doulist.js';
import { digestAll, sameRevision } from './digest.js';
import {
  absenceAuthority, isContent, hasUnknownVerdict, isRecalibratable, implausible,
} from './authority.js';

// 【改抽取逻辑就要推这个版本】否则重跑之后摘要变了，会被当成用户编辑——
// 而 canonical 只比较同一 parser_version 的修订（../INGESTION.md §4.4）。
// 0.1.0：广播正文不再包含「（全文）」这个 UI 标签，改为记 text_truncated + full_text_url。
// 0.2.0：开始解析作品详情页，作品记录多出 aliases（又名）。
// 0.3.0：详情页 #info 整块收进 info；又名改按 ` / ` 切（裸斜杠会把 `(港/台)` 切坏）。
// 0.4.0：HTML 实体收敛成一份实现（src/html-entities.js）。标记列表页原来一个实体都不解，
//        于是 `&#34;` 原样进了 canonical，被站点生成器忠实地印在页面上。
// 0.5.0：音乐与舞台剧的短评原来一条都抽不到（它们的短评裸在 <li> 里，没有
//        `<span class="comment">`）；长文正文的段落、点列表不再粘成一坨，
//        日记正文不再吞进豆瓣的频道标签与版权声明。
// 0.6.0：**打了分的广播，正文原来一律抽不到**（评分星夹在 blockquote 与 <p> 之间）。
//        实测 2200 条有正文的广播漏掉 1411 条，且漏掉的每一条都带评分。
// 0.7.0：广播多出 rating —— 发布那一刻给的星数（1447/3401 条有）。标记只留最新那个分，
//        而广播冻结，所以这是豆瓣自己都不保存的评分变化史。
// 0.8.0：广播多存一个 target_title —— 卡片上那个作品名。实测 162 条广播指向一个本地
//        没有的条目（被豆瓣删了、或豆列这类不产生标记的东西），此前页面上只剩一个动作词。
// 0.9.0：**标记的身份跨层归并**。data-cid 是 2023-12 才有的（IDENTITY.md §2.2），
//        而两层用的是两个不相交的键空间，于是一个目录里同时有那之前和之后的档案时，
//        每一条跨越那条线的标记都会一分为二。实测把前代工具 2022-12 → 2024-08 的
//        档案导进来：2526 个作品出了 4050 条标记，修订史被劈成两半。
//        这里不改任何抽取逻辑，摘要一个都没动——变的是「哪些观测算同一条记录」。
export const PARSER_VERSION = 'doubak-data-parser/0.9.0';
export const CANONICAL_VERSION = 'canonical/1.0';

/** 路线状态词 → canonical 的封闭词表。 */
const STATUS = { collect: 'done', do: 'doing', wish: 'wish' };

/**
 * bundle → canonical。
 *
 * ## 为什么是 async
 *
 * 这个函数本身不做 I/O，`sources` 是**传进来的**——但它们的 `payload(row)` 会做。
 * Node 那边（`bundle-source.js`）是同步读文件，而扩展那边读的是 OPFS，只有异步
 * 接口。全函数里唯一等它的地方就是下面那一处 `await src.payload(row)`；同步的
 * 实现照样能 await，所以 Node 这一路的行为一点没变。
 *
 * 另一条路——让扩展先把捕获全读进内存再同步解析——是不行的：一份真实档案
 * 9000 多条捕获、几百 MB 的 HTML，那等于把整个档案摊进堆里。
 *
 * @param {Array<{status: string, manifest: object|null, bundleId: string, index: object[],
 *   crawlState: Map<string, object>, coverage: Map<string, object>,
 *   payload: (row: object) => string | Promise<string>, close: () => void}>} sources
 *   契约只有这八项。`BundleSource`（Node）与 `OpfsBundleSource`（扩展）各实现一份，
 *   因为「字节从哪儿来」本来就该各写各的。
 * @param {{parserVersion?: string, timezone?: string, ignoreWarnings?: boolean,
 *   skipCaptures?: Set<string>,
 *   onProgress?: (p: {done: number, total: number, phase: string}) => void}} [opts]
 *   `ignoreWarnings` 只放行「混了多个账号」那一条，且照样把它写进 `warnings`。
 *   `skipCaptures` 是一组 capture_id，摄取时跳过——`bin/verify.js` 查出字节对不上的
 *   那几条走这里。**它是一个普通的 Set，不是一项新的宿主契约**，所以扩展那边
 *   照样能用，八项契约一个字没动。
 *   `onProgress` 给界面用：分母是本地 index 的行数，**是可信的**——那跟豆瓣的
 *   计数不是一回事（后者有时统计于审查之前、有时之后）。
 */
export async function parse(sources, opts = {}) {
  const parserVersion = opts.parserVersion ?? PARSER_VERSION;
  const tz = opts.timezone ?? 'Asia/Shanghai';
  /** 完整性检查查出问题的那几条捕获。默认空集——不查就等于全都信。 */
  const skipCaptures = opts.skipCaptures ?? new Set();

  // 先体检，再解析。**分叉不拦**——两条分支只是同一个账号的两批观测，合并起来是
  // 信息更多而不是信息打架（理由与实测见 topology.js）。真该拦的是另外两件事。
  const topo = topology(sources);
  const accountWarning = assertSingleAccount(topo, { ignoreWarnings: opts.ignoreWarnings });

  /**
   * 没有 manifest 的档案归到哪个账号名下。
   *
   * **`'unknown'` 不是一个账号 id，是「没有 id」。** 把它当成键的一部分用，等于
   * 凭空造出第二个人：退化键是 `d:<账号>:<媒介>:<作品 id>`，于是同一个作品在
   * 有 manifest 的档案里落到 `d:82160871:drama:34912679`，在没有 manifest 的档案里
   * 落到 `d:unknown:drama:34912679`——**两个不相交的键空间**，与 0.9.0 修掉的
   * `data-cid` 那个 bug 是同一个形状，只是换了个字段来劈。
   *
   * 实测：把 9 份没有 manifest 的档案并进来，2955 个作品出了 2960 条标记，
   * 5 部舞台剧一分为二（两半的 status / rating / marked_at 完全相同，只有
   * first_observed_at 不一样）。只有舞台剧中招，因为它的列表页没有 `data-cid`
   * ——带上游 id 的走 `u:` 键，与账号无关，照常合并。
   *
   * 修法是**认领，不是猜**：目录里恰好只有一个账号时，缺 manifest 的档案就归它。
   * 这与扩展「导出」页对无归属档案的处理是同一条（INGESTION.md §2.3——限制的是
   * 结论，不是数据），而且这里的前提更硬：多账号本来就是错误，走不到这一步。
   *
   * 目录里一个已知账号都没有时，大家一起用 `'unknown'`——那时它是**唯一**的
   * 键空间，不会劈开任何东西。
   */
  const soleAccount = topo.accounts.length === 1
    ? (sources.find((s) => s.manifest?.account?.user_id)?.manifest.account ?? null)
    : null;
  /**
   * 哪些档案是被认领进来的。**认领了就要说出来**，否则这是一次静默的归属判断。
   *
   * 这里**先算好，不边用边记**。第一版是在 `accountOf()` 里边调边往数组里塞，
   * 而那个告警是在工作循环之前 push 的——于是数组永远是空的，告警永远不出现。
   * 一条永远不触发的告警比没有告警更糟：它让人以为这件事有人盯着。
   */
  const adopted = soleAccount
    ? sources.filter((s) => !s.manifest?.account).map((s) => s.bundleId).sort()
    : [];
  /** @param {{manifest: object|null}} src */
  const accountOf = (src) => src.manifest?.account ?? soleAccount ?? undefined;

  /** @type {Map<string, object>} 身份键 → 记录 */
  const marks = new Map();
  /**
   * 退化键 → 这个作品的标记最终落在哪个身份键上。
   *
   * 存在的理由见 `identityOf()`：`data-cid` 是 2023-12 才出现的，一个目录里同时
   * 有那之前和之后的档案时，同一条标记的观测会分属两个键空间。这张表就是把它们
   * 认回同一条记录的那一环。
   *
   * @type {Map<string, string>}
   */
  const markKeys = new Map();
  /** @type {Map<string, object>} `${medium}:${id}` → 作品 */
  const subjects = new Map();
  /** @type {Map<string, object>} data-sid → 广播 */
  const broadcasts = new Map();
  /** @type {Map<string, object>} `${kind}:${id}` → 日记 / 评论 */
  const longform = new Map();
  /**
   * 豆列。
   *
   * **一份豆列横跨好几次捕获**（每页 25 条，实测有 4 页的），所以这里先按
   * 「哪一份档案里的哪一份豆列」把页面攒起来，等这一份档案读完再合成一条记录。
   * 边读边 upsert 是不行的：第二页到达时前一页的条目已经写进修订里了，合起来会
   * 变成「第一次观测只有 25 条，第二次观测有 50 条」——一份**凭空多出来的编辑
   * 历史**，而豆列恰恰是可编辑的，没人分得清那是真改还是分页假象。
   *
   * @type {Map<string, {src: object, id: string, pages: Map<number, object>}>}
   */
  const doulistPages = new Map();
  /**
   * `medium:id` → 从详情页补来的字段。
   *
   * **先收齐再用**，不是边读边写。解析必须与档案的处理顺序无关
   *（canonical/INGESTION.md §5.2），而详情页与列表页谁先被读到是不一定的。
   * @type {Map<string, {aliases: string[], bundleId: string, captureId: string}>}
   */
  const details = new Map();
  const warnings = [];
  // 被 --ignore-warnings 放行的那条，照样记进告警里：绕过的是「停下来」，不是「说出来」。
  if (accountWarning) warnings.push({ type: 'multiple_accounts', accounts: topo.accounts, message: accountWarning });
  const stats = {
    bundles: 0,
    pages: 0,
    observations: 0,
    skipped: {},
    /**
     * **改一行选择器就能救回来的捕获。**
     *
     * 这是 `verdict_reason`（bundle/1.2）真正兑现的地方。解析器能一次扫完所有档案，
     * 回答一个别处回答不了的问题：**欠了多少，以及要不要求人重抓。**
     *
     * `frame_anchors_missing` / `not_an_image` 这两类的页面已经原样躺在 WARC 里，
     * 改好抽取器离线重跑就行；而 `empty_body` / `server_error` 那类得真的重抓。
     * 混成一句「有 N 条失败」的话，用户只能去做代价最大的那个动作。
     *
     * 按 route_key 分组：一次改动通常只修好一条路线，分组之后「改这个能救回多少」
     * 是直接可读的。
     * @type {Record<string, number>}
     */
    recalibratable: {},
  };

  // 观测必须按时间升序处理，否则「第一次看到」和「最后一次看到」会记反。
  // 顺序无关那条说的是**结果**与输入顺序无关，不是可以随便乱序处理。
  /** @type {Array<{src: any, row: any, medium: string, status: string, auth: string}>} */
  const work = [];

  for (const src of sources) {
    stats.bundles += 1;
    const cs = src.crawlState;
    const cov = src.coverage;

    // **档案里的完整性声明说不通时要说出来。** 不报的话，一份带着假声明的档案
    // 会安静地被降级处理，而用户永远不知道自己手上那份有问题——而它是冻结的，
    // 知道了才好决定要不要重抓一遍。
    for (const [routeKey, entry] of cs) {
      if (entry.enumeration === 'full' && implausible(cov.get(routeKey))) {
        const c = cov.get(routeKey);
        warnings.push({
          type: 'implausible_full',
          bundle: src.bundleId,
          route_key: routeKey,
          claimed: c.claimed_count,
          captured: c.captured_count,
        });
      }
    }
    for (const row of src.index) {
      // **字节对不上的那几条，在这里就排除掉。**
      //
      // 排除而不是拒绝整份档案：一张图坏了不该让另外两万条观测也进不来
      // （canonical/INGESTION.md §2.3——丢弃的是凭它能下的结论，不是数据）。
      //
      // 落进 `skipped` 而不是 `warnings`，是因为它与 `verdict:login` 是同一类
      // 事情：这一条没被摄取，而这里说的是为什么。真正要人看的那句话由
      // `bin/verify.js` 自己讲，它才知道是哪一种对不上。
      if (skipCaptures.has(row.capture_id)) {
        bump(stats.skipped, 'verify:字节与索引对不上');
        continue;
      }

      const isBroadcast = row.intent === 'broadcast.timeline';
      const lfKind = row.intent === 'note.item' ? 'note' : row.intent === 'review.item' ? 'review' : null;
      const isDetail = row.intent === 'interest.item';
      const isDoulist = row.intent === 'doulist.item';
      if (!isBroadcast && !lfKind && !isDetail && !isDoulist
          && !row.intent?.startsWith('interest.list.')) continue;

      if (isDoulist) {
        // 索引页（`doulist.list.*`）不产生记录：它只说「有哪几份」，而那几份的
        // URL 已经在抓取时用过了。内容全在详情页里。
        if (hasUnknownVerdict(row)) {
          warnings.push({ type: 'unknown_verdict', verdict: row.verdict, capture: row.capture_id });
          bump(stats.skipped, `未知 verdict:${row.verdict}`); continue;
        }
        if (!isContent(row)) {
          bump(stats.skipped, `verdict:${row.verdict}`);
          if (isRecalibratable(row)) bump(stats.recalibratable, row.route_key);
          continue;
        }
        work.push({ src, row, kind: 'doulist', auth: absenceAuthority(cs.get(row.route_key), src.status, cov.get(row.route_key)) });
        continue;
      }

      if (lfKind) {
        if (hasUnknownVerdict(row)) {
          warnings.push({ type: 'unknown_verdict', verdict: row.verdict, capture: row.capture_id });
          bump(stats.skipped, `未知 verdict:${row.verdict}`); continue;
        }
        if (!isContent(row)) {
          bump(stats.skipped, `verdict:${row.verdict}`);
          if (isRecalibratable(row)) bump(stats.recalibratable, row.route_key);
          continue;
        }
        work.push({ src, row, kind: 'longform', lfKind, auth: absenceAuthority(cs.get(row.route_key), src.status, cov.get(row.route_key)) });
        continue;
      }

      if (isBroadcast) {
        if (hasUnknownVerdict(row)) {
          warnings.push({ type: 'unknown_verdict', verdict: row.verdict, capture: row.capture_id });
          bump(stats.skipped, `未知 verdict:${row.verdict}`); continue;
        }
        if (!isContent(row)) {
          bump(stats.skipped, `verdict:${row.verdict}`);
          if (isRecalibratable(row)) bump(stats.recalibratable, row.route_key);
          continue;
        }
        work.push({ src, row, kind: 'broadcast', auth: absenceAuthority(cs.get(row.route_key), src.status, cov.get(row.route_key)) });
        continue;
      }

      if (isDetail) {
        // 详情页不产生新的作品记录，只给已有的补字段——记录本身来自列表页
        // （那才是「我标记过它」的来源）。所以这里只入队，合并在下面做。
        if (hasUnknownVerdict(row) || !isContent(row)) { bump(stats.skipped, `verdict:${row.verdict}`); continue; }
        work.push({ src, row, kind: 'detail', auth: absenceAuthority(cs.get(row.route_key), src.status, cov.get(row.route_key)) });
        continue;
      }

      const [, , medium, statusWord] = row.intent.split('.');
      const status = STATUS[statusWord];
      if (!status) { bump(stats.skipped, `未知状态词:${statusWord}`); continue; }

      if (hasUnknownVerdict(row)) {
        // 封闭词表出现新取值 = 生产者知道一种我们不认识的失败方式。当作判不出来。
        warnings.push({ type: 'unknown_verdict', verdict: row.verdict, capture: row.capture_id });
        bump(stats.skipped, `未知 verdict:${row.verdict}`);
        continue;
      }
      if (!isContent(row)) {
        bump(stats.skipped, `verdict:${row.verdict}`);
        if (isRecalibratable(row)) bump(stats.recalibratable, row.route_key);
        continue;
      }

      work.push({ src, row, kind: 'mark', medium, status, auth: absenceAuthority(cs.get(row.route_key), src.status, cov.get(row.route_key)) });
    }
  }
  // **认领了就要说出来。** 归属是一次判断，不是一个事实；不说的话，一份
  // 没有 manifest 的档案会以档案主人的名义静悄悄进来。
  if (adopted.length) {
    warnings.push({
      type: 'account_adopted',
      account: soleAccount.user_id,
      bundles: adopted.slice().sort(),
      message: `${adopted.length} 份档案没有 manifest，按目录里唯一的账号 `
        + `${soleAccount.user_id} 归并。它们的广播仍然不抽（分不清哪条是转发的别人的）。`,
    });
  }
  for (const d of topo.danglingFloors) {
    // 增量只看了地板以上，而地板底下那段**谁也没看过**——那份档案不在目录里。
    // 这是个真实的覆盖空洞，而且它看起来一切正常：条数、连续性、其余告警全是好的。
    warnings.push({
      type: 'missing_floor_bundle', bundle: d.bundle, route_key: d.routeKey, missing: d.missing,
    });
  }

  work.sort((a, b) => (a.row.observed_at < b.row.observed_at ? -1 : 1));

  // **详情页必须全部先读完。**
  //
  // 它们只给作品记录补字段，而记录是列表页建的。同一趟里边读边用的话，
  // 结果就取决于谁先被处理——而抓取顺序天然是「先列表页后详情页」，于是
  // 补进去的东西一个都用不上。实测这个 bug：2102 部电影里只有 44 部拿到了
  // 又名，而抽查显示 96% 的详情页上都有。
  //
  // 这正是 canonical/INGESTION.md §5.2 禁止的那种顺序依赖，而它**不报错**——
  // 只是安静地少了一大半数据。
  //
  // 分完之后详情页还聚在一起，段缓存的命中率反而更好：它们都在同一个
  // catalog 段里。
  work.sort((a, b) => (a.kind === 'detail' ? 0 : 1) - (b.kind === 'detail' ? 0 : 1));

  /** @type {object|null} */
  let lastSrc = null;
  let done = 0;
  for (const { src, row, kind, lfKind, medium, status, auth } of work) {
    // 进度只在这一处报。**它是逐页的**，而 work 已经排好序，所以调用方拿到的
    // 分母从头到尾不变——一个会变的分母比没有分母更糟。
    opts.onProgress?.({ done: done += 1, total: work.length, phase: 'parse' });

    let html;
    try {
      html = await src.payload(row);
    } catch (err) {
      warnings.push({ type: 'unreadable', capture: row.capture_id, error: String(err.message ?? err) });
      continue;
    }
    stats.pages += 1;

    const observationBase = {
      bundle_id: src.bundleId,
      capture_ids: [row.capture_id],
      observed_at: row.observed_at,
      absence_authority: auth,
      surface: row.surface ?? 'html',
    };

    if (kind === 'detail') {
      // **详情页只补充，不创建。** 作品记录的来源是列表页（那才是「我标记过它」
      // 的凭据）；一张详情页单独存在时，我们并不知道用户是否标记过它。
      const d = extractSubjectDetail(html, row.url);
      if (d && (d.aliases.length || (d.info && Object.keys(d.info).length))) {
        details.set(`${d.medium}:${d.id}`, {
          aliases: d.aliases, info: d.info, bundleId: src.bundleId, captureId: row.capture_id,
        });
      }
      continue;
    }

    if (kind === 'doulist') {
      const d = extractDoulist(html, row.url);
      if (!d) {
        // 认不出来就报，**不猜**。一个「标题 null、条目空」的记录与一份真的空豆列
        // 长得一模一样。
        warnings.push({ type: 'extractor_stale', capture: row.capture_id, kind: 'doulist' });
        continue;
      }
      // 按 `start` 收页。同一页被抓过两次（增量重叠）时后到的覆盖先到的——它们
      // 是同一页的两次观测，不是两页。
      const start = Number(/[?&]start=(\d+)/.exec(row.url ?? '')?.[1] ?? 0);
      const key = `${src.bundleId}:${d.id}`;
      if (!doulistPages.has(key)) doulistPages.set(key, { src, id: d.id, pages: new Map() });
      doulistPages.get(key).pages.set(start, { d, observation: { ...observationBase } });
      stats.observations += 1;
      continue;
    }

    if (kind === 'longform') {
      const lf = extractLongform(html, lfKind);
      if (!lf) {
        // 认不出来就报，**不猜**。正文页的结构是从真实抓取的字节里量出来的；
        // 认不出多半意味着豆瓣改版了，而那一页已经如实存进档案，改好重跑即可。
        warnings.push({ type: 'extractor_stale', capture: row.capture_id, kind: lfKind });
        continue;
      }
      stats.observations += 1;
      upsertLongform(longform, { lf, account: accountOf(src), observation: { ...observationBase }, parserVersion });
      continue;
    }

    if (kind === 'broadcast') {
      // **这里刻意不走 `accountOf(src)`。**
      //
      // 认领一个账号来当身份键的一部分，与拿它来判断「这一页上哪几条广播是我的」，
      // 是两件事：前者只影响两条记录合不合并，后者是在**授权**——`extractBroadcasts`
      // 拿 owner 去比对每条广播的 `data-uid`，认错了就会把转发进来的第三方内容
      // 写进档案主人的 canonical。
      //
      // 严格授予、宽松否定：认领用来归并可以，用来筛别人的内容不行。
      const owner = src.manifest?.account?.user_id;
      if (!owner) {
        warnings.push({ type: 'no_owner', capture: row.capture_id });
        continue;
      }
      const { broadcasts: bs, idless: bIdless, unresolvedImages } = extractBroadcasts(html, owner);
      if (bIdless > 0) {
        warnings.push({ type: 'extractor_stale', capture: row.capture_id, kind: 'broadcast', idless: bIdless });
      }
      if (unresolvedImages > 0) {
        // 附图容器在，图却一张都没抽到——豆瓣换了渲染方式，而这种失败是**静默**的：
        // 「没有图」和「不认识这些图」在数据上一模一样。必须报出来，否则一次改版
        // 会让此后所有抓取都悄悄丢图，而且事后无从分辨哪些广播本来就没图。
        warnings.push({
          type: 'extractor_stale', capture: row.capture_id, kind: 'broadcast_images',
          unresolved: unresolvedImages,
        });
      }
      for (const b of bs) {
        stats.observations += 1;
        upsertBroadcast(broadcasts, { b, account: accountOf(src), observation: { ...observationBase }, parserVersion });
      }
      continue;
    }

    const { marks: raw, idless } = extractMarks(html, medium);
    if (idless > 0) {
      // 容器在、有时间、却抽不到 id —— 抽取器跟不上页面了。**必须报**：
      // 静默跳过等于宣布「这一页就这么多」，而那是不可检测的丢失。
      warnings.push({ type: 'extractor_stale', capture: row.capture_id, medium, idless });
    }

    for (const m of raw) {
      stats.observations += 1;

      // 页面自己说的状态与路线说的对不上 —— 路线映射错了或页面变了。
      // 实测 2327 条全部吻合，所以一旦出现就值得看。
      if (m.relStatus && m.relStatus !== status) {
        warnings.push({
          type: 'status_mismatch', capture: row.capture_id,
          subject: m.subjectId, route: status, page: m.relStatus,
        });
      }

      const observation = { ...observationBase };

      upsertMark(marks, markKeys, { m, medium, status, account: accountOf(src), observation, parserVersion, tz });
      upsertSubject(subjects, {
        m, medium, observation, parserVersion,
        detail: details.get(`${medium}:${m.subjectId}`),
      });
    }

    // **段缓存只在换 bundle 时才丢。**
    //
    // 原来每处理完一条捕获就 close 一次，也就是把整个段缓存清掉；下一条捕获
    // 又要把那个段从头读一遍、解一遍。列表页只有 571 张时这只是「有点慢」，
    // 加进 2925 张作品详情页之后就变成了灾难——它们都在同一个 159 MB 的
    // catalog 段里，于是同一个文件被读了两千多遍。
    //
    // work 是按 observed_at 排的，而同一份档案里的捕获时间上连成一片，所以
    // 「换了 bundle 才清」既能让缓存一直命中，又把峰值内存压在一份档案的
    // 段大小上。这与站点生成器里踩过的是同一个坑（那次是 8 分钟对 1.5 秒）。
    if (lastSrc && lastSrc !== src) lastSrc.close();
    lastSrc = src;
  }
  if (lastSrc) lastSrc.close();

  // 一份档案里的一份豆列 = 一次观测，页面按 start 升序拼起来。
  //
  // **次序是内容的一部分**：用户排过的清单，把第 2 页排到第 1 页前面就是改了内容。
  const doulists = new Map();
  for (const { src, pages } of doulistPages.values()) {
    // 拼接规则在 `mergeDoulistPages` 里，与抽取器同一个文件——扩展面板的内容预览
    // 拿的是同一份（`doubak-extension/src/vendor/parser/`）。它原样回传每一页，
    // 所以下面还能取到各页的 observation。
    const merged = mergeDoulistPages([...pages].map(([start, v]) => ({
      start, doulist: v.d, observation: v.observation,
    })));
    if (!merged) continue;
    upsertDoulist(doulists, {
      d: merged.doulist,
      account: accountOf(src),
      observation: merged.pages[0].observation,
      // 每一页都是这条记录的来源，全都要能指回去。
      captureIds: merged.pages.flatMap((p) => p.observation.capture_ids ?? []),
      parserVersion,
    });
  }

  return {
    topology: topo,
    doulists: [...doulists.values()],
    marks: [...marks.values()],
    subjects: [...subjects.values()],
    broadcasts: [...broadcasts.values()],
    longform: [...longform.values()],
    warnings,
    stats,
  };
}

/**
 * 身份分层，**并且跨层归并**。见 canonical/IDENTITY.md §2.3。
 *
 * ## 为什么不能只按每次观测各自定层
 *
 * 第一版就是那样：有 `data-cid` 就用 `u:`，没有就用 `d:`。两个键空间不相交，
 * 于是**同一条标记在不同年代的观测会变成两条记录**。
 *
 * 而这不是假想的情况，IDENTITY.md §2.2 那张表自己就写着：
 *
 * | 情形 | 有 data-cid 吗 |
 * |---|---|
 * | 电影/书/音乐/舞台剧，**2023-12 之后**抓的 | 有 |
 * | 任何媒介，**2023-12 之前**抓的 | 没有 |
 *
 * 也就是说，只要一个目录里同时有 2023-12 前后的档案，每一条跨越那条线的标记都会
 * 一分为二。实测把前代工具 2022-12 → 2024-08 的档案导进来跑一遍：**2526 个作品
 * 出了 4050 条标记**，而且修订史被劈成两半——恰恰是这批数据唯一的价值所在。
 *
 * 失败的形状是最坏的那一种：不报错，而且**看起来像数据变多了**。
 *
 * ## 归并规则
 *
 * `(账号, 媒介, 作品 id)` 这个退化键在一个账号内是稳定的，所以拿它当「这是哪个
 * 作品」的锚点，记住这个作品最终落在哪个 key 上：
 *
 * - 先在没有 `data-cid` 的年代见过、后来拿到了 —— **把那条记录搬到上游键上**，
 *   不另起一条。
 * - 先有上游 id、后来的观测没有 —— 跟着已经确定的那个 key 走。
 * - 同一个作品先后出现**两个不同的**上游 id —— 那是「标了、删了、又重新标」，
 *   **不合并**，那真的是两条记录。这一层信息只有 `data-cid` 给得出，正是它比
 *   退化键强的地方，不能在归并时丢掉。
 *
 * ## 搬过去之后 `identity_layer` 仍然写 `degraded_key`
 *
 * 因为它回答的是「这条记录的身份最弱靠到了哪一层」。早年那几次观测确确实实是
 * 靠退化键攒起来的，改写成 `upstream_id` 会把那件事掩盖掉——而读者判断「这些
 * 修订真的是同一条记录吗」时，要看的正是最弱的那一环。
 *
 * @param {Map<string, object>} store    key → 记录
 * @param {Map<string, string>} resolved 退化键 → 这个作品最终用的 key
 */
function identityOf(store, resolved, m, medium, accountId) {
  const degraded = `d:${accountId}:${medium}:${m.subjectId}`;
  const upstream = m.upstreamId ? `u:${medium}:${m.upstreamId}` : null;
  const prior = resolved.get(degraded);

  if (!upstream) {
    if (prior) return { key: prior, layer: store.get(prior)?.identity_layer ?? 'degraded_key' };
    resolved.set(degraded, degraded);
    return { key: degraded, layer: 'degraded_key' };
  }

  if (!prior || prior === upstream) {
    resolved.set(degraded, upstream);
    return { key: upstream, layer: store.get(upstream)?.identity_layer ?? 'upstream_id' };
  }

  if (prior === degraded) {
    const rec = store.get(degraded);
    if (rec) {
      store.delete(degraded);
      rec.upstream_id = m.upstreamId;
      store.set(upstream, rec);
    }
    resolved.set(degraded, upstream);
    // 搬过去了，层级不变：这条记录的身份最弱靠到过退化键。
    return { key: upstream, layer: rec?.identity_layer ?? 'degraded_key' };
  }

  // prior 是另一个上游 id：同一个作品的第二条上游记录。不合并。
  resolved.set(degraded, upstream);
  return { key: upstream, layer: store.get(upstream)?.identity_layer ?? 'upstream_id' };
}

function upsertMark(store, resolved, { m, medium, status, account, observation, parserVersion, tz }) {
  const accountId = account?.user_id ?? 'unknown';
  const { key, layer } = identityOf(store, resolved, m, medium, accountId);

  const fields = {
    status,
    marked_at: m.date
      ? { raw: m.date, iso: `${m.date}T00:00:00+08:00`, precision: 'day', timezone_assumption: tz }
      : null,
    rating: m.rating,
    comment: m.comment,
    tags: m.tags,
    // **raw_meta 不放这里。**
    //
    // 它是作品目录数据，不是用户写的东西。放进标记的 fields 会让「豆瓣改了演员表」
    // 表现为「用户编辑了这条标记」——实测跑一遍就撞上了 3 条：34943576（配音演员
    // 换了一个）、37314835（上映日期从「2027(美国)」变成「2027(未定)」）、
    // 34430900（演员表调整）。三条的 status/rating/comment/tags 全都没动。
    //
    // 那正是这套设计从头到尾在防的「假编辑」，而且发生在最不该发生的地方：
    // 标记表存的是用户自己写的东西。权威的作品数据在 subjects.ndjson。
  };
  const digests = digestAll(fields);

  let rec = store.get(key);
  if (!rec) {
    rec = {
      canonical_version: CANONICAL_VERSION,
      identity_layer: layer,
      upstream_id: m.upstreamId ?? null,
      account: { user_id: accountId, username: account?.username ?? null },
      medium,
      subject: { id: m.subjectId, url: m.subjectUrl, upstream_deleted: m.upstreamDeleted },
      revisions: [],
    };
    store.set(key, rec);
  }
  // 上游 id 后来才出现（2023-12 起才有 data-cid）——补上，但不改身份层，
  // 因为这条记录此前是靠退化键攒起来的，说成 upstream_id 会掩盖那件事。
  // （记录本身的搬家在 identityOf 里做，这里只管字段。）
  if (!rec.upstream_id && m.upstreamId) rec.upstream_id = m.upstreamId;
  if (m.upstreamDeleted) rec.subject.upstream_deleted = true;

  appendRevision(rec.revisions, { fields, digests, observation, parserVersion });
}

function upsertSubject(store, { m, medium, observation, parserVersion, detail }) {
  const key = `${medium}:${m.subjectId}`;
  const fields = {
    // 上游条目被删时，页面上写的「未知电影」是占位符，不是作品名。
    title: m.upstreamDeleted ? null : m.title,
    // 又名只在详情页上有。**没读到详情页时是 null，不是空数组**——
    // 「这个作品没有又名」与「我们没看过它的详情页」是两件事，
    // 混成一个的话，补抓详情页之后会冒出一批看起来像编辑的修订。
    aliases: detail?.aliases ?? null,
    // 详情页 #info 里那一整块带标签的字段，键用豆瓣自己的标签原样存。
    // **它不替代 raw_meta**：raw_meta 是列表页那一行的原样记录，两者来自
    // 不同的捕获、也可能不一致，而「页面当时就是这么说的」两边都算数。
    info: detail?.info ?? null,
    cover_url: m.coverUrl,
    raw_meta: m.rawMeta,
  };
  const digests = digestAll(fields);

  // 又名来自另一张捕获，出处要跟着记——canonical 的每一条断言都得能指回
  // WARC 里的具体字节。
  if (detail?.captureId && !observation.capture_ids.includes(detail.captureId)) {
    observation = { ...observation, capture_ids: [...observation.capture_ids, detail.captureId] };
  }

  let rec = store.get(key);
  if (!rec) {
    rec = {
      canonical_version: CANONICAL_VERSION,
      medium,
      id: m.subjectId,
      url: m.subjectUrl,
      upstream_deleted: m.upstreamDeleted,
      revisions: [],
    };
    store.set(key, rec);
  }
  if (m.upstreamDeleted) rec.upstream_deleted = true;

  appendRevision(rec.revisions, { fields, digests, observation, parserVersion });
}

/**
 * **只在内容变了时追加一条修订。**
 *
 * 实测 2933 条标记 × 6 次抓取 ≈ 17600 次观测，真正的编辑只有 3 次。按观测追加会让
 * 99.98% 的行是噪音，而「这条什么时候变过」——canonical 存在的理由——反而要从噪音
 * 里筛出来。
 *
 * 观测本身没有丢：没变化的观测延长 `last_observed_at` 并追加进 `observations`。
 */
function appendRevision(revisions, { fields, digests, observation, parserVersion }) {
  const last = revisions[revisions.length - 1];

  // **只与同一个 parser_version 的修订比较。** 换了版本就必须开新修订——否则修好
  // 一个抽取 bug 会让四万条记录看起来像是同时被编辑过，而那不是编辑，是我们换了眼镜。
  if (last && last.parser_version === parserVersion && sameRevision(last.digests, digests)) {
    last.last_observed_at = observation.observed_at;
    last.observations.push(observation);
    return;
  }
  revisions.push({
    parser_version: parserVersion,
    first_observed_at: observation.observed_at,
    last_observed_at: observation.observed_at,
    fields,
    digests,
    observations: [observation],
  });
}

/**
 * 广播：身份是 `data-sid`，实测 100% 有，所以没有退化层。
 *
 * **它应当永远只有一条修订。** 广播发布后不可编辑——多出第二条修订不是「用户改了」，
 * 是抽取器或页面变了，值得去看。这一点与标记正好相反：标记有多条修订是正常的。
 */
function upsertBroadcast(store, { b, account, observation, parserVersion }) {
  const fields = {
    posted_at: b.postedAt
      ? { raw: b.postedAt, iso: b.postedAt.replace(' ', 'T') + '+08:00', precision: 'second', timezone_assumption: 'Asia/Shanghai' }
      : null,
    text: b.text,
    action: b.action,
    status: b.status,
    // 发这条广播时给的星数。**与标记的评分不是一回事**：标记只留最新那个
    // （改一次覆盖一次，豆瓣不留历史），而广播冻结，所以这是「那一天给了几颗星」。
    // 排开同一部作品的几条广播，就是一份豆瓣自己都没有的评分变化史。
    rating: b.rating,
    target_type: b.targetType,
    target_id: b.targetId,
    // 卡片上那个作品名。**接不回本地作品页时，档案靠它才说得出这条广播在讲什么。**
    target_title: b.targetTitle,
    // 附图。字节在档案里，但 canonical 里没有任何东西指向它们的话，站点生成器
    // 就无从摆放——那正是日记内嵌图踩过的坑，同一个形状。
    images: b.images,
    // 正文是不是被豆瓣截断了。**不记的话档案存着半截正文却不说**，
    // 读者无从分辨——与「浏览计数进正文」同一类错：不报错，只是说假话。
    text_truncated: Boolean(b.fullTextUrl),
    // 全文在哪。实测那两条都指向一篇日记，而两篇日记的全文早就在档案里了——
    // 所以这不是缺数据，是缺一个指针。
    full_text_url: b.fullTextUrl ?? null,
  };
  const digests = digestAll(fields);

  let rec = store.get(b.sid);
  if (!rec) {
    rec = {
      canonical_version: CANONICAL_VERSION,
      identity_layer: 'upstream_id',
      upstream_id: b.sid,
      account: { user_id: account?.user_id ?? 'unknown', username: account?.username ?? null },
      url: b.url,
      revisions: [],
    };
    store.set(b.sid, rec);
  }
  appendRevision(rec.revisions, { fields, digests, observation, parserVersion });
}

/**
 * 日记与评论。
 *
 * **与广播相反：长文可以编辑**，所以多条修订是正常的，正是要留住的东西。
 * 而列表页上那份是截断摘要，只有正文页才有全文——这条路线的全部意义就在这儿。
 */
function upsertLongform(store, { lf, account, observation, parserVersion }) {
  const key = `${lf.kind}:${lf.id}`;
  const fields = {
    title: lf.title,
    published_at: lf.publishedAt
      ? { raw: lf.publishedAt, iso: lf.publishedAt.replace(' ', 'T') + '+08:00', precision: 'second', timezone_assumption: 'Asia/Shanghai' }
      : null,
    body: lf.body,
    rating: lf.rating,
    subject_url: lf.subjectUrl,
    location: lf.location,
  };
  const digests = digestAll(fields);

  let rec = store.get(key);
  if (!rec) {
    rec = {
      canonical_version: CANONICAL_VERSION,
      kind: lf.kind,
      identity_layer: 'upstream_id',
      upstream_id: lf.id,
      account: { user_id: account?.user_id ?? 'unknown', username: account?.username ?? null },
      url: lf.url,
      revisions: [],
    };
    store.set(key, rec);
  }
  appendRevision(rec.revisions, { fields, digests, observation, parserVersion });
}

/**
 * 一份豆列。
 *
 * **逐字段摘要，而且 `items` 整体算一个字段。** 加一条新条目与把某条评语重写了
 * 一遍是两件不同的事，但两者都落在 items 上——再往下拆到每个条目才分得开，而那
 * 是下一步的事。眼下至少要保证：**豆瓣的评分不参与摘要**（它自己会变，参与了就
 * 会凭空多出修订，与长文正文吞进「1740人浏览」同一类错）。
 */
function upsertDoulist(store, { d, account, observation, captureIds, parserVersion }) {
  const fields = {
    title: d.title,
    description: d.description,
    visibility: d.visibility,
    // 只留会因为用户动作而变的部分。rating / abstract / cover 是豆瓣的目录数据，
    // 它们变了不代表用户改了什么。
    items: d.items.map((i) => ({
      entry_id: i.entryId,
      upstream_id: i.upstreamId,
      category: i.category,
      url: i.url,
      title: i.title,
      comment: i.comment,
    })),
  };
  const digests = digestAll(fields);

  let rec = store.get(d.id);
  if (!rec) {
    rec = {
      canonical_version: CANONICAL_VERSION,
      identity_layer: 'upstream_id',
      upstream_id: d.id,
      account: { user_id: account?.user_id ?? 'unknown', username: account?.username ?? null },
      // 现在只抓自己编的（intent 是 `doulist.list.created`）。
      ownership: 'created',
      owner: { user_id: account?.user_id ?? null, username: account?.username ?? null },
      url: d.url,
      revisions: [],
    };
    store.set(d.id, rec);
  }
  appendRevision(rec.revisions, {
    fields,
    digests,
    observation: { ...observation, capture_ids: captureIds },
    parserVersion,
  });
  // 目录数据另存一份，不参与摘要，但渲染要用。
  rec.catalog = Object.fromEntries(d.items.map((i) => [i.entryId, {
    abstract: i.abstract, rating: i.rating, cover_url: i.coverUrl, source: i.source,
  }]));
}

function bump(obj, key) { obj[key] = (obj[key] ?? 0) + 1; }
