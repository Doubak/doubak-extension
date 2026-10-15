/** 主页的主人与导航栏里的登录者是两种身份，必须分别取证。 */
import { decodeEntities } from '../vendor/parser/html-entities.js';
import { SessionError, extractAccountHints, detectLoginState } from './session.js';
import { profileBlock, targetUidEvidence } from './profile-identity.js';
export { profileBlock } from './profile-identity.js';

export function normalizeTarget(value) {
  const input = String(value ?? '').trim();
  if (!input) return null;
  if (/^[A-Za-z0-9_-]+$/.test(input) && input !== 'mine') return input;
  let url;
  try { url = new URL(input); } catch { /* 下面给出统一说明 */ }
  if (url && url.protocol === 'https:' && ['www.douban.com', 'douban.com'].includes(url.hostname)
    && !url.username && !url.password && !url.port) {
    const m = /^\/people\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
    if (m && m[1] !== 'mine') return m[1];
  }
  throw new SessionError('invalid_target', '请输入豆瓣主页 HTTPS 网址、用户名或数字 UID。');
}

export function assertTargetResponse(probe) {
  if (probe.status === 404 || /该用户已经主动注销账号|该用户已被注销|用户已注销/.test(probe.bodyText)) {
    throw new SessionError('target_unavailable', '目标账号不存在或已注销，无法开始或继续抓取。');
  }
  if (/sec\.douban\.com|passport\/login|accounts\/login/.test(probe.finalUrl)
    || [403, 418, 429].includes(probe.status) || /有异常请求|访问过于频繁/.test(probe.bodyText)) {
    throw new SessionError('blocked', '当前访问受到限制，请在豆瓣确认访问正常后重新查看账号。');
  }
  // 正常公开主页也带「关注用户」的验证码弹窗脚本。脚本源码不是当前页面的挑战。
  const markup = probe.bodyText.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const captchaControl = /<(?:input|iframe)\b[^>]*\s(?:id|name|class|src)\s*=\s*(["'])[^"']*(?:captcha|验证码)[^"']*\1/i.test(markup);
  const captchaPage = /<title\b[^>]*>[^<]*(?:验证码|captcha)[^<]*<\/title>/i.test(markup)
    || (!profileBlock(markup) && /验证码|captcha/i.test(markup));
  if (captchaControl || captchaPage) {
    throw new SessionError('challenge', '豆瓣要求验证，请在浏览器完成后重新查看账号。');
  }
  if (probe.status !== 200 || /<title>\s*登录豆瓣\s*<\/title>/.test(probe.bodyText)) {
    throw new SessionError('target_unavailable', '未取得可识别的目标主页，请确认豆瓣页面可正常访问。');
  }
}

export function extractTargetAccount(html, finalUrl, input) {
  const url = new URL(finalUrl);
  const slug = /^\/people\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)?.[1];
  if (!['www.douban.com', 'douban.com'].includes(url.hostname) || !slug) {
    throw new SessionError('target_changed', '目标主页发生了异常跳转，拒绝抓取。');
  }
  const block = profileBlock(html);
  if (!block) throw new SessionError('target_unavailable', '目标主页缺少用户资料区块，无法安全确认身份。');
  const ids = targetUidEvidence(html);
  if (/^[1-9]\d*$/.test(input ?? '')) ids.add(input);
  if (/^[1-9]\d*$/.test(slug)) ids.add(slug);
  if (ids.size > 1) throw new SessionError('target_changed', '目标主页中的数字 UID 证据不一致，拒绝抓取。');
  const userId = [...ids][0];
  if (!userId) throw new SessionError('missing_user_id', '目标主页找不到稳定数字 UID，请尝试输入数字 UID；不会用用户名冒充账号身份。');
  // 数字主页不一定重定向。只读目标头像的主页链接（不读导航、签名或访客），
  // 使 UID / 域名两种输入都沿用同一增量链。头像 UID 已在上面交叉核对。
  const avatar = /<a\b[^>]*\shref=(["'])(.*?)\1[^>]*>\s*<img\b[^>]*\/icon\/up?[1-9]\d*[-.][^>]*>\s*<\/a>/i.exec(block);
  let username = slug;
  if (avatar) {
    const link = new URL(decodeEntities(avatar[2]), url);
    const ownerSlug = /^\/people\/([A-Za-z0-9_-]+)\/?$/.exec(link.pathname)?.[1];
    if (link.protocol === 'https:' && ['www.douban.com', 'douban.com'].includes(link.hostname)
      && !link.username && !link.password && !link.port && ownerSlug && ownerSlug !== 'mine') {
      if (/^\d+$/.test(ownerSlug) && ownerSlug !== userId) {
        throw new SessionError('target_changed', '目标头像链接与数字 UID 不一致，拒绝抓取。');
      }
      username = ownerSlug;
    }
  }
  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(block)?.[1];
  const alt = /<img\b[^>]*\salt=(["'])(.*?)\1/i.exec(block)?.[2];
  const displayName = decodeEntities(heading?.split('<')[0] || alt || '').trim() || null;
  return { userId, username, displayName };
}

export function inspectTarget(probe, input, { targetUserId = null, operatorUserId = undefined } = {}) {
  assertTargetResponse(probe);
  const account = extractTargetAccount(probe.bodyText, probe.finalUrl, input);
  if (targetUserId && account.userId !== targetUserId) {
    throw new SessionError('target_changed', `目标 UID 已变化（${targetUserId} → ${account.userId}），请重新探测。`);
  }
  const state = detectLoginState(probe.bodyText);
  if (state === 'unknown') throw new SessionError('session_expired', '无法确认操作者登录状态，请先检查豆瓣页面。');
  const operator = state === 'logged_in' ? extractAccountHints(probe.bodyText) : null;
  if (operator && !operator.userId) throw new SessionError('missing_user_id', '无法确认操作者数字 UID，拒绝开始。');
  if (operatorUserId !== undefined && (operator?.userId ?? null) !== operatorUserId) {
    throw new SessionError('operator_switched', '操作者登录账号发生了变化，请重新探测目标。');
  }
  return {
    account,
    visibility: operator?.userId === account.userId ? 'self' : 'public',
    operatorMode: operator ? 'authenticated' : 'anonymous',
    operatorUserId: operator?.userId ?? null,
    operatorName: operator?.displayName ?? null,
  };
}
