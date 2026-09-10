/* 【自动同步，请勿手改】来自 doubak-data-parser 的 src/cover-url-key.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/**
 * 封面 URL 的**索引**：把量过的 CDN 分片主机抹平。
 *
 * ## 它要解决的是什么
 *
 * 实测（2026-09-10，28 份真实档案 / 2967 个作品 / 8172 条作品修订）：**111 条作品
 * 修订是凭空多出来的**，两版之间唯一的差别是封面 URL 的主机——
 *
 * ```
 * https://img1.doubanio.com/view/photo/s_ratio_poster/public/p2888584528.webp
 * https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2888584528.webp
 * ```
 *
 * 路径一模一样，也就是同一张图。
 *
 * ## 这不是噪声，是一次真实但没有意义的变化
 *
 * 曾经以为「豆瓣按请求随机挑分片」。**量过之后这句话是错的**：436197 条图片路径里，
 * 同一份档案内主机不一致的 **0 条**；589 张海报的主机变过，而**每一张只变过一次、
 * 没有一张换回去过**。所以是豆瓣某个时点把图挪了一次，然后就稳在那儿。
 *
 * 所以它归的类是 `(N 有用)` 计数、`1740人浏览` 那一类——**真实的观测，无意义的差别，
 * 被记成了一次编辑**——而不是「每次渲染都不一样的 `data-status-url`」那一类。
 *
 * ## 只抹掉不携带身份的那一段
 *
 * 主机可以抹，是因为路径里的图片 id 已经唯一标识了这张图。实测 5820 个原始值收成
 * 5231 个 key，589 个 key 各吃掉一个原始值，而**一个 key 底下出现两条不同路径的：0 个**。
 *
 * **尺寸段绝不能抹**（`s_ratio_poster` / `m` / `small`）——不同尺寸是不同的字节，抹了
 * 就是两张不同的图被静默并成一张。这是这条规则唯一的危险方向，写在这儿免得有人
 * 「顺手再归一化一点」。
 *
 * ## 不认得的形状一律不动
 *
 * 档案里除 `img1/img2/img3/img9` 之外还有 `qnmob3.doubanio.com`（4 次）。
 * **「不要把图片主机当成闭集」在 CLAUDE.md 里是明令**，来源是抽取器那次真实的漏抓。
 * 所以判据只认量过的那一族，其余照抄——宁可少收一个 key，不可多并一张图。
 *
 * ## 这个 key 只做判据，绝不用来改写 `cover_url`
 *
 * 档案里**没有任何一条路径被从两个主机各抓过一次**（11997 条资源捕获 / 3108 条路径
 * / 0 条），所以「几个分片提供的字节完全相同」本地证不了。把主机改写成某一个固定
 * 分片，就是在做一个没有证据的断言。**事实与索引并存，索引不覆盖事实**——与 bundle
 * 的 `url` / `url_key` 是同一条规矩。
 */

/**
 * 规则版本。
 *
 * 照 bundle 的 `url_key_rules`：将来发现新的分片家族时，可以对存量 canonical 重算
 * key，而 `cover_url` 永远不动。版本号是「这批 key 是按哪套规则算的」的唯一答案。
 */
export const COVER_URL_KEY_RULES = 'doubanio-shard/1';

/** 量过的那一族分片主机。**只有它。** */
const SHARD = /^(https?:\/\/)img\d+\.doubanio\.com(\/)/;

/** key 里用的占位主机。**不要去取它**——它未必存在，它只是个索引里的名字。 */
const PLACEHOLDER = 'img.doubanio.com';

/**
 * @param {string|null|undefined} url  原样的封面 URL
 * @returns {string|null} 抹平分片之后的索引；认不出的形状原样返回
 */
export function coverUrlKey(url) {
  if (url === null || url === undefined) return null;
  if (typeof url !== 'string') return null;
  return url.replace(SHARD, `$1${PLACEHOLDER}$2`);
}
