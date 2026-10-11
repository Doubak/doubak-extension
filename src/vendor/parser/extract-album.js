/* 【自动同步，请勿手改】来自 doubak-data-parser 的 src/extract-album.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/**
 * 从相册页抽出个人相册元信息与照片列表。
 *
 * ## 个人自建相册与作品公共相册严格区分
 *
 * 上传至图书/电影/音乐/游戏等条目公共相册的照片属于公共目录资产，
 * 个人在 `/people/<user>/photos` 下创建的相册为不可替代的个人数字资产。
 * 原图大图来自 asset.photo_image 路线。
 */

import { decodeEntities } from './html-entities.js';

function text(s) {
  if (typeof s !== 'string') return null;
  const t = decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  return t || null;
}

/**
 * 抽取相册列表页（photo.album_list）上的相册概览。
 *
 * @param {string} html
 * @returns {Array<object>}
 */
export function extractAlbumList(html) {
  if (typeof html !== 'string') return [];
  const albums = [];
  const re = /<div class="albumlst">([\s\S]*?)(?=<div class="albumlst">|<\/body>|$)/g;
  for (const m of html.matchAll(re)) {
    const block = m[1];
    const linkMatch = /href="https:\/\/www\.douban\.com\/photos\/album\/(\d+)\/?"/.exec(block);
    if (!linkMatch) continue;
    const id = linkMatch[1];
    const titleMatch = /<div class="pl2">\s*<a[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const title = text(titleMatch?.[1]);
    const desc = text(/<div class="albumlst_descri">([\s\S]*?)<\/div>/i.exec(block)?.[1]);
    const countMatch = /(\d+)\s*张照片/.exec(block);
    const claimedCount = countMatch ? Number(countMatch[1]) : null;
    const updateMatch = /([\d-]{10})\s*更新/.exec(block);
    const coverMatch = /<img class="album"[^>]*src="([^"]*\/p(\d+)\.[^"]+)"/i.exec(block);
    const coverPhotoId = coverMatch?.[2] ?? null;

    albums.push({
      id,
      url: `https://www.douban.com/photos/album/${id}/`,
      title,
      desc,
      claimedCount,
      updatedAt: updateMatch?.[1] ?? null,
      coverPhotoId,
    });
  }
  return albums;
}

/**
 * 抽取相册详情页（photo.album）的元信息与单页照片。
 *
 * @param {string} html
 * @param {string} [url]
 * @returns {object|null}
 */
export function extractAlbumDetail(html, url = '') {
  if (typeof html !== 'string') return null;

  const idMatch = url.match(/\/photos\/album\/(\d+)/)
    ?? html.match(/href="https:\/\/www\.douban\.com\/photos\/album\/(\d+)\/edit"/)
    ?? html.match(/href="https:\/\/www\.douban\.com\/photos\/album\/(\d+)\/?"/);
  const id = idMatch?.[1] ?? null;
  if (!id) return null;

  // 标题：去掉前缀「我的相册-」或「<nickname>的相册-」
  const h1Raw = /<div class="info">\s*<h1>([\s\S]*?)<\/h1>/i.exec(html)?.[1]
    ?? /<h1>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  let title = text(h1Raw);
  if (title) {
    title = title.replace(/^.*?(?:我的相册|的相册)\s*-\s*/, '').trim() || title;
  }

  const desc = text(/<p class="description">([\s\S]*?)<\/p>/i.exec(html)?.[1]);
  const countMatch = /<span>\s*共\s*(\d+)\s*张照片\s*<\/span>/.exec(html)
    ?? /(\d+)\s*张照片/.exec(html);
  const claimedCount = countMatch ? Number(countMatch[1]) : null;

  const claimText = /<div class="copyright-claim">([\s\S]*?)<\/div>/i.exec(html)?.[1] ?? '';
  const createdMatch = /([\d-]{10}(?:\s*[\d:]{8})?)\s*创建/.exec(claimText);
  const updatedMatch = /([\d-]{10}(?:\s*[\d:]{8})?)\s*更新/.exec(claimText);

  const isPrivate = /class="is-private"|class="album-private"/.test(html);
  const privacy = isPrivate ? 'author' : 'public';

  // 照片列表
  const photos = [];
  const photoRe = /<div class="photo_wrap">([\s\S]*?)<\/div>\s*(?:<div class="clear"><\/div>)?/g;
  for (const pm of html.matchAll(photoRe)) {
    const wrap = pm[1];
    const pidMatch = /href="https:\/\/www\.douban\.com\/photos\/photo\/(\d+)\/?"/.exec(wrap);
    if (!pidMatch) continue;
    const pid = pidMatch[1];
    const imgMatch = /<img[^>]+src="([^"]+)"/i.exec(wrap);
    const thumbUrl = imgMatch?.[1] ?? null;
    const largeUrl = thumbUrl
      ? thumbUrl.replace(/\/view\/photo\/[a-z0-9_]+\//, '/view/photo/large/')
      : null;

    // 优先从 title 属性取未截断的文字说明，否则从 pl 取
    const titleAttr = /class="photolst_photo"[^>]*title="([^"]*)"/i.exec(wrap)?.[1];
    const plText = /<div class="pl">([\s\S]*?)<\/div>/i.exec(wrap)?.[1];
    const caption = text(titleAttr) || text(plText) || null;

    photos.push({
      id: pid,
      url: `https://www.douban.com/photos/photo/${pid}/`,
      image_url: largeUrl,
      thumbnail_url: thumbUrl,
      caption,
      seq: null,
    });
  }

  return {
    id,
    url: `https://www.douban.com/photos/album/${id}/`,
    title,
    desc,
    claimedCount,
    createdAt: createdMatch?.[1] ?? null,
    updatedAt: updatedMatch?.[1] ?? null,
    privacy,
    photos,
  };
}

/**
 * 合并同一个相册的多页捕获。
 *
 * @param {Array<{start: number, album: object, observation: object}>} pages
 * @returns {{album: object, pages: Array<object>} | null}
 */
export function mergeAlbumPages(pages) {
  const ordered = [...pages].sort((a, b) => a.start - b.start);
  if (!ordered.length) return null;

  const first = ordered[0].album;
  // 照片按出现顺序追加去重
  const seenPhotoIds = new Set();
  const allPhotos = [];
  for (const p of ordered) {
    for (const ph of p.album?.photos ?? []) {
      if (!seenPhotoIds.has(ph.id)) {
        seenPhotoIds.add(ph.id);
        allPhotos.push({
          ...ph,
          seq: allPhotos.length,
        });
      }
    }
  }

  // 元数据优先取有值的
  const title = ordered.map((p) => p.album?.title).find(Boolean) ?? first.title;
  const desc = ordered.map((p) => p.album?.desc).find(Boolean) ?? first.desc;
  const claimedCount = ordered.map((p) => p.album?.claimedCount).find((v) => typeof v === 'number') ?? first.claimedCount;
  const createdAt = ordered.map((p) => p.album?.createdAt).find(Boolean) ?? first.createdAt;
  const updatedAt = ordered.map((p) => p.album?.updatedAt).find(Boolean) ?? first.updatedAt;
  const privacy = ordered.map((p) => p.album?.privacy).find(Boolean) ?? first.privacy;

  return {
    album: {
      id: first.id,
      url: first.url,
      title,
      desc,
      claimedCount,
      createdAt,
      updatedAt,
      privacy,
      photos: allPhotos,
    },
    pages: ordered,
  };
}
