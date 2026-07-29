/**
 * 权限检查。
 *
 * ## 为什么这是抓取逻辑的一部分，而不是安装时检查一次就完了
 *
 * Chrome 允许用户**在任何时刻**把扩展的站点访问权限改成「点击时」或「仅特定
 * 网站」——chrome://extensions 里两下就改完了，不需要重装、也不会通知我们。
 * 一场几小时的抓取跨过这种改动是完全现实的。
 *
 * 而权限被撤之后 `fetch()` 抛的是 `TypeError`，**和网络故障一模一样**。于是
 * 默认分类会把它判成可重试的网络错误，然后一遍遍重试一个永远不会自己好的
 * 问题。表现出来是「网络怎么这么差」，真实原因是权限没了——用户完全没有
 * 线索。
 *
 * 这和「把风控当网络错误去重试」是同一类错误，只是代价不同：那边赔的是账号，
 * 这边赔的是几小时和一个查不出原因的失败。
 *
 * ## 所以权限丢失是**停止条件**
 *
 * 和会话失效同一档：停下来、说清楚、等人重新授权。绝不重试。
 *
 * ## 为什么不做成可选权限（optional_permissions）
 *
 * 想过。运行时才申请 douban.com 的访问权，安装时的警告会好看一点。但代价是
 * 多一条失败路径（用户点了「拒绝」），而这个扩展**没有权限就什么都做不了**——
 * 把一个必需的东西做成可选的，只是把「装不上」推迟成「用不了」。
 *
 * 安装时就明说要读写 douban.com，反而与这个项目的立场一致：请求全部来自你
 * 自己的浏览器和 IP，凭据一步都不离开设备。
 */

/** 抓取必须能访问的源。与 manifest 的 host_permissions 一致。 */
export const REQUIRED_ORIGINS = [
  'https://*.douban.com/*',
  'https://*.doubanio.com/*',
];

/** 权限没了之后的停机原因。与 session_expired 同一档：停下等人。 */
export const HOST_PERMISSION_LOST = 'host_permission_lost';

export class PermissionError extends Error {
  /** @param {string} message @param {string[]} [missing] */
  constructor(message, missing = []) {
    super(message);
    this.name = 'PermissionError';
    this.reason = HOST_PERMISSION_LOST;
    this.missing = missing;
  }
}

/**
 * 现在还有没有抓取所需的站点权限。
 *
 * `chrome.permissions` 不可用时（Node 测试、或者 API 缺失）返回 `null` 而不是
 * `true`——「查不了」和「有权限」是两件事。把前者当后者，就等于在测试里悄悄
 * 关掉了这条检查。
 *
 * @param {object} [opts]
 * @param {any} [opts.permissions]  注入用；默认 chrome.permissions
 * @param {string[]} [opts.origins]
 * @returns {Promise<{granted: boolean, missing: string[]} | null>}
 */
export async function checkHostAccess({ permissions, origins = REQUIRED_ORIGINS } = {}) {
  const api = permissions ?? globalThis.chrome?.permissions;
  if (!api?.contains) return null;

  /** @type {string[]} */
  const missing = [];
  for (const origin of origins) {
    let ok;
    try {
      ok = await api.contains({ origins: [origin] });
    } catch {
      // contains() 本身抛了——查不了，不假装有。
      return null;
    }
    if (!ok) missing.push(origin);
  }
  return { granted: missing.length === 0, missing };
}

/**
 * 请求已声明但被用户收回的站点权限。
 *
 * **必须在用户手势里调用**，否则 Chrome 直接拒绝。所以它只能从界面的按钮
 * 里发起，不能由后台在恢复流程里自己触发——这也正对：重新授权本来就该是
 * 一个用户明确做的动作。
 *
 * @param {object} [opts]
 * @param {any} [opts.permissions]
 * @param {string[]} [opts.origins]
 * @returns {Promise<boolean>}
 */
export async function requestHostAccess({ permissions, origins = REQUIRED_ORIGINS } = {}) {
  const api = permissions ?? globalThis.chrome?.permissions;
  if (!api?.request) throw new Error('这个浏览器不支持运行时申请权限');
  return api.request({ origins });
}

/**
 * 一次失败的 fetch 到底是网络问题还是权限问题。
 *
 * 只在**已经失败之后**问一次，不在每次请求前问——每页都查一遍权限是给一件
 * 极少发生的事付常态开销。而失败之后再查，正好能把两种长得一样的 `TypeError`
 * 分开。
 *
 * @param {object} [opts]
 * @param {any} [opts.permissions]
 * @param {string[]} [opts.origins]
 * @returns {Promise<PermissionError | null>}  权限没问题（或查不了）就返回 null
 */
export async function permissionErrorIfLost(opts = {}) {
  const r = await checkHostAccess(opts);
  if (!r || r.granted) return null;
  return new PermissionError(
    `豆备已经没有访问 ${r.missing.join('、')} 的权限了。` +
      '请在浏览器的扩展设置里把站点访问权限改回「在所有网站上」，然后回来继续。',
    r.missing,
  );
}
