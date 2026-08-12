/**
 * 抓取方式的三个键。
 *
 * ## 为什么单独一个文件
 *
 * 这三个字符串横跨两个上下文：面板发消息时写一个，offscreen 收到后比一个。两边
 * 各写各的字面量，**对不上时不会报错**——`mode === 'refresh-subjects'` 只是取到
 * false，于是用户选了「重抓可变内容」，跑出来的却是一次普通增量，界面上一切正常。
 * 这正是这个项目反复踩的那类坑：坏了不出声。
 *
 * 放进同一个模块之后，拼错是 `undefined`，两边一起坏，一眼看得见。
 *
 * ## 分界线是「上游那份东西还会不会变」
 *
 * - `INCREMENTAL`：**当作什么都不会变**。列表只抓新增的；作品详情页、长文正文、
 *   用户上传的图，凡是抓过的一律跳过。最省时间，也最少打扰豆瓣。
 * - `REFRESH`：**当作可以编辑的东西都变了**。作品详情页与长文正文全部重抓一遍。
 *   图仍然跳过——图片地址是内容地址，重抓拿回来的必然是同一批字节。
 * - `FULL`：视同从未抓过，一个跳过名单都不带（见 offscreen 里的 `mode === FULL`
 *   分支：它根本不走挑下界那条路径）。产出是一份自足的基准档案。
 *
 * 旧键名是 `refresh-subjects`，那时这个模式只管作品详情页。名字换了，值也换了
 * ——它没有被写进任何档案（manifest 里不记抓取方式），所以改名不影响已有档案。
 */
export const CRAWL_MODES = /** @type {const} */ ({
  INCREMENTAL: 'incremental',
  FULL: 'full',
  REFRESH: 'refresh-editable',
});

/** @typedef {'incremental' | 'full' | 'refresh-editable'} CrawlMode */
