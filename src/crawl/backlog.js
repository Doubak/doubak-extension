/**
 * 从**已经存下来的页面**里补算出当时没抓的附属资源。
 *
 * 规范：bundle/v1/SPEC.md §6.2.1
 *
 * ## 为什么需要这一步
 *
 * 广播附图这条路线（`asset.status_photo`）是**从广播页派生**的：抓到一页广播，
 * 就从那一页里抽出本人上传的图。而广播是增量路线——下一次抓取只取回水位线以上的
 * 新广播，**水位线以下那些页面永远不会再被请求**。
 *
 * 于是在这条路线存在之前发布的所有广播，它们的附图就此成为死角：实测一份真实档案
 * 里有 121 张，分布在 22 张老广播页上。
 *
 * 但那 22 张页面的字节**就在档案里**。图片 URL 写在它们的 HTML 正文中。所以这不是
 * 「重新抓取」的问题，是「把已有捕获再算一遍」的问题——正是 CLAUDE.md 那条不变量的
 * 正向用法：
 *
 * > 丢掉所有派生数据、只靠 captures 离线重建，必须能跑通，零网络请求。
 *
 * 代价实测：4 份档案、索引 6498 行 → 广播记录 176 条、解压 16.6 MB。它随**广播条数**
 * 增长，不随档案体积增长（作品详情页占九成体积，但完全不碰）。
 *
 * ## 每次抓取都跑，而不是跑一次就完事
 *
 * 这让抽取器的 bug 变成**可修复**的：哪天认出了第四种附图形态，下一次抓取就会把
 * 历史上漏掉的自动找回来，不需要任何「重新扫描」的特殊操作。这才是「派生数据可以
 * 随时丢掉重算」真正值钱的地方。
 *
 * ## 这里只放纯函数
 *
 * 读 OPFS、解压、发请求都在调用方。分开是为了让真正的逻辑（挑哪些行、跑抽取器、
 * 减去已有的、带上 parent 与 referer）能拿真实档案的数据测——`offscreen.js` 绑着
 * OPFS worker，那一层现在只能做源码断言。与 `chain.js` 是同一个分层理由。
 */

import { extractStatusPhotos } from './classifier.js';

/**
 * 一条待补抓的资源。
 *
 * @typedef {object} BacklogItem
 * @property {string} url
 * @property {string} routeKey
 * @property {string} parentCaptureId  把这个 URL 放进队列的那次捕获。**跨档案**
 *   （规范 §6.2.1）——它就发生在旧档案里，写 null 等于宣称凭空冒出来。
 * @property {string} referer  那次捕获的页面 URL。豆瓣的图片服务认这个头。
 */

/**
 * 一份档案里可以补算出来的资源。
 *
 * ## 参数为什么长这样
 *
 * `readPayload` 是**注入**的：调用方在 offscreen 里用 `BundleReader.readEntry`
 * 按 offset 解压一条记录，测试里用一个 Map。这个函数本身不认识 OPFS，也不认识 gzip。
 *
 * @param {object} opts
 * @param {Array<object>} opts.indexRows  这份档案 index.ndjson 的全部行
 * @param {(row: object) => Promise<string>} opts.readPayload  取一条记录的正文（已解码）
 * @param {string} opts.ownerUserId  档案主人的数字 ID。**必需**——没有它就分不清
 *   哪些图是转发来的别人的（实测 149 个附图条目里 30 个属于别人）。
 * @param {Set<string>} [opts.alreadyHave]  已经抓到的 url（任何档案里的）
 * @param {(evt: object) => void} [opts.onWarn]  抽取器报警。**必须往外传**——
 *   离线跑和在线跑是同一个抽取器，改版告警也该是同一条路径。
 * @returns {Promise<{items: BacklogItem[], pagesRead: number, skippedOthers: number}>}
 */
export async function backlogFromIndex({
  indexRows,
  readPayload,
  ownerUserId,
  alreadyHave = new Set(),
  onWarn,
}) {
  if (!ownerUserId) throw new Error('backlogFromIndex 需要 ownerUserId，否则会把别人的图也补进来');

  /** @type {BacklogItem[]} */
  const items = [];
  const seen = new Set(alreadyHave);
  let pagesRead = 0;
  let skippedOthers = 0;

  for (const row of indexRows) {
    // 只看广播页，且只看判定为 ok 的。
    //
    // 判定不是 ok 的那些是封锁页或登录页——它们**也在档案里**（这是刻意的，
    // 见 loop.js 的写入顺序），但页面上没有真内容，拿去抽图只会抽出一堆
    // 界面元素或者什么都抽不到。
    if (row.route_key !== 'broadcast.timeline' || row.verdict !== 'ok') continue;

    let html;
    try {
      html = await readPayload(row);
    } catch (err) {
      // 读不出来就跳过这一条。**失败方向是安全的**：漏认只会让这张图这次补不上，
      // 下次抓取还会再算一遍（这一步每次都跑）。而抛出去会让整场抓取起不来。
      onWarn?.({ type: 'backlog_unreadable', captureId: row.capture_id, error: String(err) });
      continue;
    }
    pagesRead += 1;

    const { urls, skippedOthers: others, unresolved } = extractStatusPhotos(html, { ownerUserId });
    skippedOthers += others;

    // 认出了附图容器却一张都没抽到 —— 豆瓣改版了。**这里必须照报**：
    // 静默跳过等于宣布「这一页没有图」，而那是不可检测的丢失。
    if (unresolved > 0) {
      onWarn?.({ type: 'backlog_unresolved', captureId: row.capture_id, url: row.url, count: unresolved });
    }

    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      items.push({
        url,
        routeKey: 'asset.status_photo',
        // 跨档案的 parent。规范 §6.2.1：合法，且 bundle 前缀与本档案不同这件事
        // 本身就说明「这条不是这次从页面上读到的」。
        parentCaptureId: row.capture_id,
        referer: row.url,
      });
    }
  }

  return { items, pagesRead, skippedOthers };
}

/**
 * 哪些资源**已经抓到了**，不必再补。
 *
 * 与 `offscreen.js` 的 `knownSubjects` 是同一个模式，两个限制条件也一样：
 *
 * - **只算 `verdict: ok` 的。** 被拦下、判不出来的那些本来就该重抓。
 * - **按 `url` 比，不按 `url_key`。** 图片 URL 上的 `?imageView2/...` 是尺寸参数，
 *   归一化掉就会把两个不同尺寸当成同一张。而这里要的恰恰是「这个确切的字节流有没有」。
 *
 * @param {Array<object>} indexRows
 * @param {string} [routeKey]
 * @returns {Set<string>}
 */
export function capturedAssets(indexRows, routeKey = 'asset.status_photo') {
  const out = new Set();
  for (const r of indexRows) {
    if (r.route_key === routeKey && r.verdict === 'ok' && r.url) out.add(r.url);
  }
  return out;
}
