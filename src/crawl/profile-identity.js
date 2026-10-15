/** 页面主人的身份证据限于资料区块与 head 的 RSS 元数据。 */
export function profileBlock(html) {
  const opening = /<div\b[^>]*\sid\s*=\s*(["'])db-usr-profile\1[^>]*>/i.exec(html);
  if (!opening) return null;
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = opening.index + opening[0].length;
  let depth = 1;
  for (let tag; (tag = tags.exec(html));) {
    depth += /^<\//.test(tag[0]) ? -1 : 1;
    if (!depth) return html.slice(opening.index, tags.lastIndex);
  }
  return null;
}

export function targetUidEvidence(html) {
  const block = profileBlock(html);
  if (!block) return new Set();
  const ids = new Set();
  for (const link of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\srel\s*=\s*(["'])alternate\1/i.test(link[0])) continue;
    const id = /\/feed\/people\/([1-9]\d*)\/interests\b/.exec(link[0])?.[1];
    if (id) ids.add(id);
  }
  const avatarId = /\/icon\/up?([1-9]\d*)[-.]/.exec(block)?.[1];
  if (avatarId) ids.add(avatarId);
  return ids;
}
