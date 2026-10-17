/* 【自动同步，请勿手改】来自 doubak-data-parser 的 src/extract-profile.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/** Target profile evidence only. Shared by the parser and the capture host. */
import { decodeEntities } from './html-entities.js';

export function profileMarkup(html) {
  // One pass: comment-looking strings inside scripts must not eat the real markup.
  return String(html).replace(/<!--[\s\S]*?(?:-->|$)|<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
}
function attr(tag, name) {
  return decodeEntities(new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag)?.[2] ?? '');
}
function divBlock(html, predicate) {
  for (const opening of html.matchAll(/<div\b[^>]*>/gi)) {
    if (!predicate(opening[0])) continue;
    const tags = /<\/?div\b[^>]*>/gi;
    tags.lastIndex = opening.index + opening[0].length;
    let depth = 1;
    for (let tag; (tag = tags.exec(html));) {
      depth += /^<\//.test(tag[0]) ? -1 : 1;
      if (!depth) return html.slice(opening.index, tags.lastIndex);
    }
    return null;
  }
  return null;
}
export function avatarUrl(value) {
  try {
    const u = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port
      || !/^(?:img\d*|img-fm\d*)\.doubanio\.com$/i.test(u.hostname)) return null;
    return u.href;
  } catch { return null; }
}
function peopleUrl(value, base) {
  try {
    const u = new URL(value, base);
    const slug = /^\/people\/([A-Za-z0-9_-]+)\/?$/.exec(u.pathname)?.[1];
    return u.protocol === 'https:' && ['www.douban.com', 'douban.com'].includes(u.hostname)
      && !u.username && !u.password && !u.port && slug && slug !== 'mine' ? { u, slug } : null;
  } catch { return null; }
}

/** Missing fields mean unobserved, null avatar means a positively identified default. */
export function extractProfile(html, url, userId) {
  if (!/^[1-9]\d*$/.test(String(userId))) return null;
  userId = String(userId);
  const page = peopleUrl(url);
  if (!page) return null;
  const markup = profileMarkup(html);
  const block = divBlock(markup, tag => attr(tag, 'id') === 'db-usr-profile');
  if (!block) return null;
  const pic = divBlock(block, tag => /(?:^|\s)(?:pic|user-face)(?:\s|$)/.test(attr(tag, 'class')));
  const images = [...(pic ?? '').matchAll(/<img\b[^>]*>/gi)];
  // Ambiguous avatar containers do not establish ownership.
  if (images.length > 1) return null;
  const img = images[0]?.[0];
  const src = img ? avatarUrl(attr(img, 'src')) : null;
  const ids = new Set();
  const avatarId = src && /\/icon\/u(?:p|l)?([1-9]\d*)[-.]/.exec(new URL(src).pathname)?.[1];
  if (avatarId) ids.add(avatarId);
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(markup)?.[1] ?? '';
  for (const tag of head.matchAll(/<link\b[^>]*>/gi)) {
    if (attr(tag[0], 'rel') !== 'alternate') continue;
    try {
      const feed = new URL(attr(tag[0], 'href'), url);
      const id = /^\/feed\/people\/([1-9]\d*)\/interests\/?$/.exec(feed.pathname)?.[1];
      if (feed.protocol === 'https:' && feed.hostname === 'www.douban.com' && id) ids.add(id);
    } catch { /* Not identity evidence. */ }
  }
  if (!ids.size) return null;
  if (/^\d+$/.test(page.slug)) ids.add(page.slug);
  if (ids.size !== 1 || !ids.has(userId)) return null;
  let username = page.slug;
  const anchor = /<a\b[^>]*>\s*<img\b[^>]*>\s*<\/a>/i.exec(pic ?? '')?.[0];
  const owner = anchor && peopleUrl(attr(anchor, 'href'), url);
  if (owner) {
    if (/^\d+$/.test(owner.slug) && owner.slug !== userId) return null;
    username = owner.slug;
  }
  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(block)?.[1];
  const nickname = decodeEntities(heading?.split('<')[0] ?? (img ? attr(img, 'alt') : '')).trim();
  const fields = {};
  if (owner || !/^\d+$/.test(username)) fields.username = username;
  if (nickname) fields.nickname = nickname;
  if (src && avatarId) fields.avatar_url = src;
  else if (src && /^\/icon\/user_(?:normal|large|small)\.jpg$/.test(new URL(src).pathname)) fields.avatar_url = null;
  return { userId, url: `https://www.douban.com/people/${username}/`, fields };
}
