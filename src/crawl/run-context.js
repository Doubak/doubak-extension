/** 断点携带原目标身份；恢复绝不能用当前登录者替换档案的主人。 */
import { BundleReader } from '../bundle/bundle-reader.js';
import { extractAccountHints, SessionError } from './session.js';

export function assertRunContext(context) {
  if (!/^[1-9]\d*$/.test(context?.account?.userId ?? '')) {
    throw new SessionError('resume_identity_missing', '断点缺少原目标数字 UID，无法安全恢复。请中止后重新抓取。');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(context.account.username ?? '') || context.account.username === 'mine') {
    throw new SessionError('resume_identity_missing', '断点缺少原目标的有效域名，无法安全恢复。');
  }
  if (!['self', 'public'].includes(context.visibility)) {
    throw new SessionError('resume_identity_missing', '断点中的抓取视角无法识别，拒绝恢复。');
  }
  if (!['authenticated', 'anonymous'].includes(context.operatorMode)
    || (context.operatorMode === 'authenticated' && !/^[1-9]\d*$/.test(context.operatorUserId ?? ''))
    || (context.operatorMode === 'anonymous' && context.operatorUserId != null)
    || (context.visibility === 'self' && (context.operatorMode !== 'authenticated' || context.operatorUserId !== context.account.userId))) {
    throw new SessionError('resume_identity_missing', '断点中的原操作者与抓取视角不一致，拒绝恢复。');
  }
  return context;
}

export async function contextForResume(pointer, cp, store) {
  if (cp?.bundle_id !== pointer.bundleId) {
    throw new SessionError('resume_identity_mismatch', '断点与当前档案编号不一致，拒绝恢复。');
  }
  if (cp.run_context && pointer.runContext && JSON.stringify(cp.run_context) !== JSON.stringify(pointer.runContext)) {
    throw new SessionError('resume_identity_mismatch', '断点与运行指针中的原目标或范围不一致，拒绝恢复。');
  }
  const context = cp.run_context ?? pointer.runContext;
  if (context) return assertRunContext(context);

  // 升级前的本人断点：只从已归档的原主页取证，不能凭当前 Cookie 或可被抢注的 slug 补 UID。
  const reader = new BundleReader({ store, bundleId: pointer.bundleId });
  const entry = (await reader.index()).find((e) => e.verdict === 'ok' && e.intent === 'profile.overview');
  if (entry) {
    const account = extractAccountHints((await reader.readEntry(entry)).bodyText);
    if (account.userId) return assertRunContext({
      account: { ...account, username: pointer.username },
      visibility: 'self', operatorMode: 'authenticated', operatorUserId: account.userId,
    });
  }
  throw new SessionError('resume_identity_missing', '旧断点没有原目标 UID，也没有可取证的主页捕获，无法安全恢复。');
}
