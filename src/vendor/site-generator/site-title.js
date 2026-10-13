/* 【自动同步，请勿手改】来自 doubak-site-generator 的 src/site-title.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/** 站点作者与标题的纯计算；CLI 和浏览器扩展使用同一份实现。 */

const RECORD_TYPES = [
  'marks', 'broadcasts', 'longform', 'doulists', 'albums',
  'group_topics', 'group_joins', 'groupTopics', 'groupJoins',
];

/** @param {unknown} value @returns {string|null} */
function nonblank(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * 显式标题 → nickname / displayName → username → user_id → 通用标题。
 * 只读档案账号与 profile，不读 owner / author 等第三方内容作者。
 * 多 UID 输入先拒绝，显式标题也不能让一个站点混进两个人的记录。
 *
 * @param {object} canonical
 * @param {string|null} [explicitTitle]
 * @param {object[]} [manifestAccounts] 宿主已按 UID 合并的 manifest 资料，可补充空档案
 * @returns {string}
 */
export function resolveSiteTitle(canonical, explicitTitle = null, manifestAccounts = []) {
  const profiles = Array.isArray(canonical?.profile) ? canonical.profile : [canonical?.profile];
  const accounts = [...profiles.map((p) => p?.account ?? p), canonical?.account, ...manifestAccounts];
  for (const type of RECORD_TYPES) {
    for (const record of canonical?.[type] ?? []) accounts.push(record?.account);
  }
  const ids = new Set(accounts.map((a) => nonblank(a?.user_id)).filter((id) => id && id !== 'unknown'));
  if (ids.size > 1) {
    throw new Error(`输入中有多个账号（${[...ids].sort().join('、')}）。请按账号分开生成站点。`);
  }

  const override = nonblank(explicitTitle);
  if (override) return override;
  for (const field of ['nickname', 'displayName', 'username', 'user_id']) {
    for (const account of accounts) {
      const value = nonblank(account?.[field]);
      if (value && !(field === 'user_id' && value === 'unknown')) return `${value}的豆瓣存档`;
    }
  }
  return '我的豆瓣存档';
}
