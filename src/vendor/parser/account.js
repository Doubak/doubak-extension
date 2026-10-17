/* 【自动同步，请勿手改】来自 doubak-data-parser 的 src/account.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/** 账号展示资料。只按数字 UID 合并，不参与内容修订。 */

/** @param {unknown} value @returns {string|null} */
function nonblank(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** @param {object|null|undefined} account @param {string|null} [defaultId] */
export function canonicalAccount(account, defaultId = 'unknown') {
  return {
    user_id: account?.user_id ?? defaultId,
    username: nonblank(account?.username),
    nickname: nonblank(account?.nickname),
  };
}

/**
 * 先汇齐整个输入的账号资料，再给所有记录使用（包括未被新增量重抓的记录）。
 * bundle_id 以 UTC 抓取时间打头；完整编号打破同秒并列。每个字段取最新的非空值，
 * 所以输入次序不决定昵称，缺失资料也不会抹掉已知值。输入 manifest 保持原样。
 *
 * @param {Array<{bundleId: string, manifest: object|null}>} sources
 * @returns {Map<string, {user_id: string, username: string|null, nickname: string|null}>}
 */
export function accountsFromSources(sources) {
  const accounts = new Map();
  const ordered = [...sources].sort((a, b) => a.bundleId < b.bundleId ? -1 : a.bundleId > b.bundleId ? 1 : 0);
  for (const source of ordered) {
    const observed = source.manifest?.account;
    if (!observed?.user_id) continue;
    const id = String(observed.user_id);
    const next = canonicalAccount(observed);
    const merged = accounts.get(id) ?? { user_id: id, username: null, nickname: null };
    if (next.username !== null) merged.username = next.username;
    if (next.nickname !== null) merged.nickname = next.nickname;
    accounts.set(id, merged);
  }
  return accounts;
}

/**
 * 按指定账号 UID 过滤 sources。
 * 保留指定账号的 bundle 以及其链条中的祖先无 manifest bundle。
 *
 * @param {Array<{bundleId: string, manifest: object|null}>} sources
 * @param {string} targetUid
 * @returns {Array<{bundleId: string, manifest: object|null}>}
 */
export function filterSourcesByAccount(sources, targetUid) {
  const target = String(targetUid);
  const matching = new Set(sources.filter((s) => String(s.manifest?.account?.user_id) === target));
  if (matching.size === 0) return [];

  let changed = true;
  while (changed) {
    changed = false;
    for (const s of matching) {
      const prev = s.manifest?.previous_bundle_id;
      if (prev) {
        const parent = sources.find((other) => other.bundleId === prev && !matching.has(other));
        if (parent && (!parent.manifest?.account || String(parent.manifest.account.user_id) === target)) {
          matching.add(parent);
          changed = true;
        }
      }
      for (const cs of s.manifest?.crawl_state ?? []) {
        const floor = cs.floor_from_bundle_id;
        if (floor) {
          const ancestor = sources.find((other) => other.bundleId === floor && !matching.has(other));
          if (ancestor && (!ancestor.manifest?.account || String(ancestor.manifest.account.user_id) === target)) {
            matching.add(ancestor);
            changed = true;
          }
        }
      }
    }
  }

  return sources.filter((s) => matching.has(s));
}

/**
 * 将 sources 按账号 UID 分组。
 *
 * @param {Array<{bundleId: string, manifest: object|null}>} sources
 * @returns {Map<string, Array<{bundleId: string, manifest: object|null}>>}
 */
export function groupSourcesByAccount(sources) {
  const accounts = accountsFromSources(sources);
  const groups = new Map();
  for (const uid of accounts.keys()) {
    const filtered = filterSourcesByAccount(sources, uid);
    if (filtered.length) groups.set(uid, filtered);
  }
  return groups;
}

