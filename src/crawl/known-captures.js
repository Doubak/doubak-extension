/**
 * 「这一份东西我是不是已经抓到过了」——从旧档案的索引行里算出三张跳过名单。
 *
 * ## 为什么单独一个模块
 *
 * 与 `backlog.js` 同一个分层理由：读 OPFS、解压、发请求都在 offscreen，而 offscreen
 * 绑着 `chrome.*` 与 Worker，在 node 里根本 import 不进来——写在那儿的逻辑只能靠
 * 「拿正则去比对源码」来守，而那种判据挡不住语义错误。这里只吃一个数组、吐三张
 * 名单，于是「gone 的还会不会重试」这种问题可以真的跑一遍看。
 *
 * ## 三档，分界线是「上游那份东西还会不会变」
 *
 * | 档 | route_key | 重抓能拿到什么 | 默认 |
 * |---|---|---|---|
 * | 作品详情页 | `interest.item` | 评分、短评数、又名都会变 | 跳过，可选重抓 |
 * | 长文正文 | `note.item` / `review.item` | 日记与影评**可编辑** | 跳过，可选重抓 |
 * | 图 | `asset.*` | **什么都拿不到** | 永远跳过 |
 *
 * 第三档不是一个选项。图片地址是内容地址：换了图会得到一个新的 `p…jpg`，而不是
 * 同一个地址下换一份字节。所以重抓一张已有的图，拿回来的必然是同一批字节。
 *
 * 它一直漏在外面，是因为 `asset.status_photo` 从广播页**派生**：增量必须重读最新
 * 那几页广播（不然发现不了新条目），于是那几页上的图每趟都被重新派生一遍，而派生
 * 出来的东西从来没有经过任何「我是不是已经有了」的判断。实测一次增量重抓了 11 张
 * 已有的图（0.77 MB），其中 3 张已经被抓过三遍。
 *
 * ## 两条限制，坏掉的方向相反
 *
 * **白名单，不是「除了列表页以外都算」。** 列表页的 URL 每次都一样
 * （`collect?start=0`），混进跳过名单会让这次**一页都抓不成**。
 *
 * **只认 `verdict: 'ok'`。** 这是「失败还能重试」的全部依据：名单里只放确实成功的
 * 那些，所以一次失败的抓取在下一趟必然会被再试一次。`gone` 尤其要紧——条目可能
 * 又回来了，而把它记成「已经有了」就再也不会去看一眼。
 */

/**
 * 长文正文这一档。**route_key 从索引行里原样取，不靠 URL 形状猜**——日记的网址
 * 有 `/note/` 和 `/topic/` 两种形状（实测一个真实账号 3 篇日记里就有一篇是
 * `www.douban.com/topic/…`），按形状猜会把它排进影评那条路线，而两条路线的判定
 * 描述、优先级、门控都不一样，并且不会报错。
 */
export const LONGFORM_ROUTES = new Set(['note.item', 'review.item']);

/** 作品详情页这一档。 */
export const SUBJECT_ROUTE = 'interest.item';

/**
 * 一个空的累加器。**跨档案累加**，因为「已经有了」是按账号问的，不是按档案问的。
 *
 * @returns {{subjects: Set<string>, longform: Map<string, string>, assets: Set<string>}}
 */
export function emptyKnownCaptures() {
  return { subjects: new Set(), longform: new Map(), assets: new Set() };
}

/**
 * 把一份档案的索引行并进累加器。
 *
 * 一次一份是有意的：offscreen 那边每份档案各自 try/catch——读不出来的那份当它不
 * 存在（**方向是安全的**：漏认只会让这次多抓一遍），而不是让整趟增量失败。
 *
 * @param {{subjects: Set<string>, longform: Map<string, string>, assets: Set<string>}} acc
 * @param {Iterable<object>} indexRows  一份档案 index.ndjson 的行
 * @returns {typeof acc} 同一个累加器，方便串起来
 */
export function addKnownCaptures(acc, indexRows) {
  for (const row of indexRows) {
    if (!row || row.verdict !== 'ok') continue;
    const key = row.url_key;
    const route = row.route_key;
    if (!key || !route) continue;

    if (route === SUBJECT_ROUTE) acc.subjects.add(key);
    else if (LONGFORM_ROUTES.has(route)) acc.longform.set(key, route);
    // `asset.status_photo`、`asset.longform_embed`、`asset.subject_cover` 都在这儿。
    // 判据是路线前缀而不是一张写死的名单：将来新增一条 `asset.*`，它会自动落进
    // 「抓过就不再抓」——而那个默认对图片是对的。
    else if (route.startsWith('asset.')) acc.assets.add(key);
  }
  return acc;
}

/**
 * 摊成能过 `chrome.runtime.sendMessage` 那条只认 JSON 的通道的形状。
 *
 * `Set` 与 `Map` 过去会**静默变成 `{}`**——不是报错，是一个值悄悄变了形状，
 * 而后果是跳过名单空了、这一趟把什么都重抓一遍。所以边界上一律是数组。
 *
 * @param {{subjects: Set<string>, longform: Map<string, string>, assets: Set<string>}} acc
 * @returns {{subjects: string[], longform: Array<{url: string, routeKey: string}>, assets: string[]}}
 */
export function knownCaptureLists(acc) {
  return {
    subjects: [...acc.subjects],
    longform: [...acc.longform].map(([url, routeKey]) => ({ url, routeKey })),
    assets: [...acc.assets],
  };
}
