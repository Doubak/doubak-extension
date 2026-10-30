/** Measured status HTML / Rexxar first page, 2026-10-29. Raw evidence only. */
import { decodeEntities } from '../vendor/parser/html-entities.js';
import { classifyResponse, stripScriptAndStyle } from './classifier.js';
import { urlKey } from '../core/urlkey.js';

export const DETAIL = 'broadcast.item';
export const COMMENTS = 'broadcast.comments_snapshot';
export const snapshotRoute = (key) => key === DETAIL || key === COMMENTS;

export function assertSnapshotScope(enabled, context) {
  if (typeof enabled !== 'boolean') throw new Error('broadcastReplySnapshot 必须是布尔值');
  if (enabled && (context.visibility !== 'self' || context.operatorMode !== 'authenticated'
    || context.operatorUserId !== context.account.userId)) {
    throw new Error('广播回复首屏仅支持当前登录者自己的账号');
  }
}

/** Validate even restored or injected tasks before any network request. */
export function assertSnapshotRequest(routeKey, rawUrl, account) {
  const url = new URL(rawUrl);
  if (url.username || url.password) throw new Error('广播快照地址不能带登录凭据');
  if (routeKey === COMMENTS && url.origin === 'https://m.douban.com'
    && /^\/rexxar\/api\/v2\/status\/[1-9]\d*\/comments$/.test(url.pathname)
    && url.searchParams.get('start') === '0' && url.searchParams.get('count') === '20'
    && [...url.searchParams].length === 2) return;
  const detail = /^\/people\/([\w-]+)\/status\/[1-9]\d*\/$/.exec(url.pathname);
  if (routeKey === DETAIL && url.origin === 'https://www.douban.com' && detail
    && [account.userId, account.username].includes(detail[1])) return;
  throw new Error('广播快照地址超出本人详情或回复首屏范围');
}

function attr(tag, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag);
  return match ? decodeEntities(match[2]) : null;
}
const hasClass = (tag, name) => (attr(tag, 'class') ?? '').split(/\s+/).includes(name);

// Balanced wrappers prevent a quoted card's reply button from becoming the root's.
function wrappers(html) {
  const clean = stripScriptAndStyle(html).replace(/<!--[\s\S]*?-->/g, '');
  const tags = /<\/?div\b[^>]*>/gi;
  const result = [];
  for (let tag; (tag = tags.exec(clean));) {
    if (!hasClass(tag[0], 'status-wrapper') || /^<\//.test(tag[0])) continue;
    const start = tag.index;
    const opening = tag[0];
    let depth = 1;
    for (let next; depth && (next = tags.exec(clean));) depth += /^<\//.test(next[0]) ? -1 : 1;
    if (depth === 0) result.push({ opening, html: clean.slice(start, tags.lastIndex) });
  }
  return result;
}

export function commentsUrl(sid) {
  return `https://m.douban.com/rexxar/api/v2/status/${sid}/comments?start=0&count=20`;
}

/** Only an owner's root card and its own structural reply count authorize requests. */
export function extractBroadcastSnapshots(html, { ownerUserId, username }) {
  if (!/^[1-9]\d*$/.test(ownerUserId ?? '')) throw new Error('需要目标数字 UID');
  const candidates = new Map();
  const unresolved = [];
  for (const root of wrappers(html)) {
    const sid = attr(root.opening, 'data-sid');
    if (attr(root.opening, 'data-uid') !== ownerUserId || !/^[1-9]\d*$/.test(sid ?? '')) continue;
    for (const match of root.html.matchAll(/<a\b[^>]*>/gi)) {
      const tag = match[0];
      if (!hasClass(tag, 'btn-action-reply') || !/^[1-9]\d*$/.test(attr(tag, 'data-count') ?? '')) continue;
      let url;
      try { url = new URL(attr(tag, 'href'), 'https://www.douban.com/'); } catch { continue; }
      // Measured old cards also link to note/subject-discussion comments. Those
      // counts describe the linked content, not replies to this broadcast SID.
      if ((url.origin === 'https://www.douban.com' && /^\/note\/[1-9]\d*\/$/.test(url.pathname))
        || (/^https:\/\/(?:movie|book|music)\.douban\.com$/.test(url.origin)
          && /^\/subject\/[1-9]\d*\/discussion\/[1-9]\d*\/$/.test(url.pathname))) continue;
      const path = /^\/people\/([\w-]+)\/status\/([1-9]\d*)\/$/.exec(url.pathname);
      if (url.origin === 'https://www.douban.com' && path
        && path[2] === sid && [ownerUserId, username].includes(path[1]) && !url.username && !url.password) {
        candidates.set(sid, { sid, detailUrl: url.href, commentsUrl: commentsUrl(sid) });
      } else if (!path || path[2] === sid) {
        unresolved.push({ sid, url: url.href, reason: 'unsupported_reply_entry' });
      }
      // Other status IDs are quoted cards, not candidates or root gaps.
    }
  }
  return { candidates: [...candidates.values()], unresolved };
}

export function snapshotTasks(html, account, parentCaptureId, referer) {
  const { candidates, unresolved } = extractBroadcastSnapshots(html, {
    ownerUserId: account.userId, username: account.username,
  });
  return { unresolved, items: candidates.flatMap(c => [
    { routeKey: DETAIL, url: c.detailUrl, parentCaptureId, referer },
    { routeKey: COMMENTS, url: c.commentsUrl, parentCaptureId, referer: c.detailUrl },
  ]) };
}

/** No textual punctuation heuristics; errors never turn into successful snapshots. */
export function classifySnapshot(res, { routeKey, requestUrl, ownerUserId }) {
  const fail = (verdict, reason) => ({ verdict, reason, reasons: [reason], itemCount: null });
  const request = new URL(requestUrl);
  const final = new URL(res.finalUrl);
  const detailSid = /\/status\/([1-9]\d*)\/$/.exec(request.pathname)?.[1];
  if (routeKey === DETAIL) {
    const cls = classifyResponse({ ...res, route: {
      urlAnchor: /^https:\/\/www\.douban\.com\/people\/[^/]+\/status\/\d+\//,
      frameAnchors: [/\bfrom-detail\b/, /\bid=["']comments["']/],
    } });
    if (cls.verdict !== 'ok') return cls;
    const roots = wrappers(res.bodyText);
    if (final.pathname !== request.pathname || roots.length !== 1
      || attr(roots[0].opening, 'data-sid') !== detailSid
      || attr(roots[0].opening, 'data-uid') !== ownerUserId) return fail(null, 'detail_identity_mismatch');
    return { ...cls, itemCount: 1 };
  }
  if (res.status === 401) return fail('login', 'session_expired');
  if ([403, 418, 429].includes(res.status)) return fail('blocked', 'api_blocked');
  if (res.status === 404) return fail('gone', 'http_404');
  // HTML login/challenge/error responses still use the ordinary safety classifier.
  let data;
  try { data = JSON.parse(res.bodyText); } catch {
    const cls = classifyResponse({ ...res, route: { frameAnchors: [/^\s*\{/] } });
    return cls.verdict === 'ok' ? fail(null, 'invalid_comments_json') : cls;
  }
  if (res.status !== 200) {
    // Keep the stable verdict_reason, but don't hide actionable HTTP/API evidence
    // behind "unexpected_status" in the failure table. Never copy arbitrary text.
    const details = [`HTTP ${res.status}`];
    if (Number.isInteger(data?.code)) details.push(`API code ${data.code}`);
    if (typeof data?.msg === 'string' && /^[a-z0-9_]{1,64}$/.test(data.msg)) details.push(data.msg);
    return { ...fail(null, 'unexpected_status'), reasons: [details.join(' · ')] };
  }
  if (final.origin !== request.origin || final.pathname !== request.pathname
    || final.searchParams.get('start') !== '0' || final.searchParams.get('count') !== '20') return fail(null, 'url_drifted');
  if (!data || data.start !== 0 || data.count !== 20 || !Number.isInteger(data.total) || data.total < 0
    || !Array.isArray(data.comments) || data.comments.length > 20
    || data.comments.some(c => !c || !/^\d+$/.test(String(c.id)) || typeof c.text !== 'string')) {
    return fail(null, 'invalid_comments_json');
  }
  return { verdict: 'ok', reasons: [], itemCount: data.comments.length, jsonSnapshot: true };
}

/** Historic list replay needs no watermark and no extra durable state. */
export async function snapshotBacklog({ sources, account, mode, onWarn = () => {} }) {
  const known = new Set();
  if (mode === 'full') return { items: [], known: [], unresolved: [] };
  for (const { rows } of sources) for (const row of rows) {
    if (row.verdict === 'ok' && snapshotRoute(row.route_key)
      && (row.route_key === DETAIL || mode !== 'refresh-editable')) known.add(urlKey(row.url));
  }
  const seen = new Set(known);
  const items = [];
  const unresolved = [];
  for (const { rows, readPayload } of sources) for (const row of rows) {
    if (row.route_key !== 'broadcast.timeline' || row.verdict !== 'ok') continue;
    let parsed;
    try { parsed = snapshotTasks(await readPayload(row), account, row.capture_id, row.url); }
    catch (error) { onWarn({ type: 'backlog_unreadable', captureId: row.capture_id, error: String(error) }); continue; }
    unresolved.push(...parsed.unresolved.map(x => ({ ...x, parentCaptureId: row.capture_id })));
    for (const item of parsed.items) if (!seen.has(urlKey(item.url))) {
      seen.add(urlKey(item.url)); items.push(item);
    }
  }
  return { items, known: [...known], unresolved };
}
