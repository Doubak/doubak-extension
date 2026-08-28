/* 【自动同步，请勿手改】来自 doubak-site-generator 的 src/image-index.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/**
 * 「档案里的哪张图是哪张」——**纯函数，不碰内建模块。**
 *
 * 从 `images.js` 里拆出来的，理由与 `pages.js` 一样：那个文件同时在读文件系统和
 * 做判定，而浏览器扩展要做同样的判定、读的却是 OPFS。**判定只能有一份**，因为它
 * 错了两边一起错，而且错得看不出来——图片路径不同的两个站点，打开都很正常。
 *
 * 输入是「若干份档案的 index 行」，输出是两张表。字节怎么取、写到哪儿，由宿主管。
 */

/**
 * 从作品详情页的 URL 里取 id。五种媒介五种形状，与抓取那边同一套。
 * @param {string} url
 */
export function subjectIdOf(url) {
  const m = /(?:\/subject\/|douban\.com\/(?:game|app)\/|\/location\/drama\/)(\d+)/.exec(url);
  return m ? m[1] : null;
}

/**
 * 从 Content-Type 推一个扩展名。认不出来就用 `.bin` —— **不猜**。
 * @param {string|null|undefined} contentType
 */
export function extOf(contentType) {
  const ct = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }[ct] ?? '.bin';
}

/**
 * 文件名取 URL 的最后一段。
 *
 * 豆瓣的图片名本来就是内容哈希一样的东西（`p742323977.jpg`、`b79771d06053dd7.jpg`），
 * 天然唯一且稳定。**不重新编号**：重新生成之后文件名不变，站点的链接才不会全变。
 *
 * @param {string} url @param {string|null|undefined} contentType
 */
export function fileNameFor(url, contentType) {
  const base = url.split('?')[0].split('/').pop() || 'image';
  const clean = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return /\.[A-Za-z0-9]{2,5}$/.test(clean) ? clean : clean + extOf(contentType);
}

/** 一张图该放进 `covers/` 还是 `uploads/`。 */
export function subdirFor(row) {
  return row.route_key === 'asset.subject_cover' ? 'covers' : 'uploads';
}

/**
 * 把若干份档案的 index 行编成两张索引。
 *
 * ## 为什么不能只按 URL 找
 *
 * canonical 里的 `cover_url` 取自**列表页的缩略图**，而档案里存的是**详情页的
 * 封面**——多数媒介两者恰好是同一个文件，但不是全部。实测舞台剧：
 *
 *     列表页  …/pview/drama_subject_poster/small/public/561e90f2.jpg
 *     详情页  …/pview/drama_subject_poster/m/public/561e90f2.jpg
 *
 * 只按 URL 找的话，这类封面全部落空——实测 95 张，而它们**明明就在档案里**。
 *
 * 所以再建一张按作品 id 的表。id 从封面那条记录的 parent（作品详情页）的 URL 上
 * 取——那条边正是为「整张抓取图可以离线重建」而存在的（规范 §6.2）。
 *
 * @param {Array<{host: unknown, rows: object[]}>} bundles
 *   `host` 原样带回结果里，宿主用它知道该去哪份档案取字节（Node 传目录，扩展传
 *   打开着的 source）。这一层不解释它。
 * @returns {{byUrl: Map<string, {host: unknown, row: object}>,
 *            bySubject: Map<string, {host: unknown, row: object}>}}
 */
export function buildImageIndex(bundles) {
  const byUrl = new Map();
  const bySubject = new Map();
  /** capture_id → 那条记录的 URL，用来把封面接回它的作品详情页。 */
  const captureUrl = new Map();

  for (const { host, rows } of bundles) {
    for (const row of rows) {
      if (row.verdict !== 'ok') continue;
      if (row.intent === 'interest.item') { captureUrl.set(row.capture_id, row.url); continue; }
      if (row.surface !== 'asset') continue;
      // 同一张图可能在多份档案里都有。**留最新的那条**——它们字节相同（sha256 会
      // 证明），但取新的能少读一个旧的大段文件。
      byUrl.set(row.url, { host, row });

      if (row.route_key === 'asset.subject_cover' && row.parent_capture_id) {
        const id = subjectIdOf(captureUrl.get(row.parent_capture_id) ?? '');
        if (id) bySubject.set(id, { host, row });
      }
    }
  }
  return { byUrl, bySubject };
}

/**
 * 一张按 URL 没找到的图，算不算「缺」。
 *
 * 两条都不算：
 *
 * - **按作品 id 已经找到了。** 那是同一张图的两个尺寸，不是缺。
 * - **占位图。** `/cuphead/`、`/f/` 是豆瓣的前端静态资源目录，抓取时就刻意不存
 *   （那不是内容，而且每个没海报的作品都是同一张）。
 *
 * 这不是洁癖：**一条永远存在的假告警会让真的那条也被忽略。** 实测「缺 95 张」
 * 曾经天天出现，而那 95 张一张都不缺。
 *
 * @param {string} url @param {Set<string>} coveredUrls 已经按作品 id 找到的那些
 */
export function reallyMissing(url, coveredUrls) {
  return !coveredUrls.has(url) && !/\/(cuphead|f)\//.test(url);
}
