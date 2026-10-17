/* 【自动同步，请勿手改】来自 doubak-site-generator 的 src/avatar.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/** Avatar selection is evidence-based, independent of directory enumeration and host I/O. */
import { inspectAvatar } from './avatar-image.js';
export { inspectAvatar };

export function selectAvatar(canonical, bundles) {
  // Older title callers may supply a flat profile object, without capture evidence.
  const records = Array.isArray(canonical.profile) ? canonical.profile : [];
  const candidates = [];
  for (const rec of records) {
    for (const rev of rec.revisions ?? []) {
      if (!Object.hasOwn(rev.fields ?? {}, 'avatar_url')) continue;
      for (const obs of rev.observations ?? []) {
        if (obs.omitted_fields?.includes('avatar_url')) continue;
        for (const id of obs.capture_ids ?? []) candidates.push({ rec, rev, obs, id });
      }
    }
  }
  candidates.sort((a, b) => (Date.parse(b.obs.observed_at) - Date.parse(a.obs.observed_at)) || b.id.localeCompare(a.id));
  const chosen = candidates[0];
  const rec = chosen?.rec ?? records[0];
  const latest = rec?.revisions?.at(-1)?.fields ?? {};
  const metadata = {
    version: 1,
    user_id: rec?.account?.user_id ?? null,
    nickname: latest.nickname ?? rec?.account?.nickname ?? null,
    avatar: null,
    observed_at: chosen?.obs.observed_at ?? null,
    status: 'unobserved',
  };
  if (!chosen) return { metadata, hits: [] };
  if (chosen.rev.fields.avatar_url === null) return { metadata: { ...metadata, status: 'default' }, hits: [] };

  const hits = [];
  for (const { host, rows, account } of bundles) {
    if (account?.user_id !== rec.account.user_id) continue;
    const parent = rows.find(r => r.capture_id === chosen.id && r.intent === 'profile.overview'
      && r.surface === 'html' && r.verdict === 'ok');
    if (!parent || !chosen.id.startsWith(chosen.obs.bundle_id + '#')) continue;
    for (const row of rows) {
      if (row.parent_capture_id === chosen.id && row.route_key === 'asset.account_avatar'
        && row.intent === 'asset.image.account_avatar' && row.surface === 'asset' && row.verdict === 'ok'
        && row.url === chosen.rev.fields.avatar_url && row.capture_id.startsWith(chosen.obs.bundle_id + '#')) {
        hits.push({ host, row });
      }
    }
  }
  hits.sort((a, b) => (Date.parse(b.row.observed_at) - Date.parse(a.row.observed_at))
    || b.row.capture_id.localeCompare(a.row.capture_id));
  return { metadata: { ...metadata, status: hits.length ? 'unreadable' : 'missing' }, hits };
}

/** Called after host byte verification. Returns only local paths, never a remote fallback. */
export function avatarOutput(selection, hit, bytes, digest) {
  if (!/^[1-9]\d*$/.test(selection.metadata.user_id)) throw new Error('头像缺少数字 UID');
  if (!/^[a-f0-9]{64}$/.test(digest) || digest !== hit.row.content_sha256?.replace(/^sha256:/, '')) {
    throw new Error('头像摘要不一致');
  }
  const info = inspectAvatar(bytes, hit.row.content_type);
  const path = `assets/profile/${selection.metadata.user_id}/${digest}.${info.ext}`;
  return { ...selection.metadata, avatar: path, status: 'ok', capture_id: hit.row.capture_id, ...info };
}

export function avatarMetadataText(metadata) {
  return JSON.stringify(metadata, null, 2) + '\n';
}

export function avatarNotice(metadata) {
  if (metadata?.status === 'missing') return '当前头像没有对应的已归档图片，站点将保留文字站名。';
  if (metadata?.status === 'unreadable') return '当前头像未通过字节校验，站点将保留文字站名。请检查原档案。';
  return null;
}
