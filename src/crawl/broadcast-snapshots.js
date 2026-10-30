/** Measured status + personal-topic HTML / Rexxar first pages. Raw evidence only. */
import { decodeEntities } from '../vendor/parser/html-entities.js';
import { classifyResponse, stripScriptAndStyle } from './classifier.js';
import { urlKey } from '../core/urlkey.js';

export const DETAIL = 'broadcast.item';
export const COMMENTS = 'broadcast.comments_snapshot';
export const snapshotRoute = (key) => key === DETAIL || key === COMMENTS;

const TOPIC_PATH = /^\/topic\/([1-9]\d*)\/$/;
const TOPIC_API_PATH = /^\/rexxar\/api\/v2\/group\/topic\/([1-9]\d*)\/comments$/;

export function topicCommentsUrl(id) {
  return `https://m.douban.com/rexxar/api/v2/group/topic/${id}/comments?resp_type=c_dict&topic_id=${id}&start=0&count=20&order_by=time_asc&nested=1`;
}

/** Personal-topic bodies are editable; a status snapshot is not. */
export function editableSnapshotDetail(url) {
  const u = new URL(url);
  return u.origin === 'https://www.douban.com' && TOPIC_PATH.test(u.pathname);
}

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
  const topicApi = TOPIC_API_PATH.exec(url.pathname);
  if (routeKey === COMMENTS && url.origin === 'https://m.douban.com' && topicApi
    && urlKey(url.href) === urlKey(topicCommentsUrl(topicApi[1]))
    && [...url.searchParams].length === 6) return;
  if (routeKey === DETAIL && editableSnapshotDetail(url.href)
    && !url.searchParams.has('ck') && new URL(urlKey(url.href)).search === '') return;
  const detail = /^\/people\/([\w-]+)\/status\/[1-9]\d*\/$/.exec(url.pathname);
  if (routeKey === DETAIL && url.origin === 'https://www.douban.com' && detail
    && [account.userId, account.username].includes(detail[1])) return;
  throw new Error('广播快照地址超出本人详情或回复首屏范围');
}

/** Scheduling identity only. WARC URLs and the versioned index url_key stay intact. */
export function snapshotQueueKey(routeKey, url, account) {
  assertSnapshotRequest(routeKey, url, account);
  const path = new URL(url).pathname;
  const topic = TOPIC_PATH.exec(path) ?? TOPIC_API_PATH.exec(path);
  if (topic) return `${routeKey}:${account.userId}:topic:${topic[1]}`;
  const sid = /\/status\/([1-9]\d*)\//.exec(path)[1];
  return `${routeKey}:${account.userId}:${sid}`;
}

/** Collapse pre-fix checkpoint aliases without turning a failed task into a retry. */
export function dedupeSnapshotFrontier(items, account) {
  const out = [];
  const positions = new Map();
  const rank = { pending: 0, in_flight: 0, failed: 1, awaiting_human: 2, terminal_stop: 3 };
  for (const item of items) {
    if (!snapshotRoute(item.route_key)) { out.push(item); continue; }
    const key = snapshotQueueKey(item.route_key, item.url, account);
    if (!positions.has(key)) { positions.set(key, out.length); out.push(item); continue; }
    const at = positions.get(key);
    const previous = out[at];
    const keep = (rank[item.state] ?? 0) > (rank[previous.state] ?? 0) ? item : previous;
    out[at] = { ...keep, attempts: Math.max(previous.attempts ?? 0, item.attempts ?? 0) };
  }
  return out;
}

/** Tracking links to the same unsupported entry describe one gap per route. */
export function snapshotGapKey(gap) {
  if (gap.reason !== 'unsupported_reply_entry' || !gap.url) return null;
  try { return `${gap.reason}:${urlKey(gap.url)}`; } catch { return null; }
}

export function dedupeSnapshotGaps(gaps) {
  const seen = new Set();
  return gaps.filter(gap => {
    const key = snapshotGapKey(gap);
    if (key === null) return true; // Preserve other errors and malformed evidence.
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Heal only this route's obsolete unsupported-entry gap after a successful capture. */
export function resolvedSnapshotGap(gap, routeKey, capturedUrl, account) {
  if (gap.reason !== 'unsupported_reply_entry') return false;
  try {
    const topic = TOPIC_PATH.exec(new URL(gap.url).pathname);
    assertSnapshotRequest(DETAIL, gap.url, account);
    const expected = routeKey === COMMENTS && topic ? topicCommentsUrl(topic[1]) : gap.url;
    return snapshotQueueKey(routeKey, expected, account) === snapshotQueueKey(routeKey, capturedUrl, account);
  } catch { return false; }
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

/** Read the measured server-rendered configuration as data; never evaluate JS. */
function personalTopicIdentity(html) {
  const scripts = [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)]
    .map(m => m[1]).filter(s => /^\s*var\s+_COMMENTS_CONFIG\s*=\s*\{/m.test(s));
  if (scripts.length !== 1) return null;
  const config = scripts[0];
  if (!/^\s*var\s+FRODO_API_PREFIX\s*=\s*['"]https:\/\/m\.douban\.com\/rexxar['"];\s*$/m.test(config)
    || !/^\s*['"]service['"]\s*:\s*['"]group['"],\s*$/m.test(config)
    || !/^\s*['"]comments['"]\s*:\s*FRODO_API_PREFIX\s*\+\s*['"]\/api\/v2\/group\/topic\/:topic_id\/comments['"],\s*$/m.test(config)) return null;
  // author is one JSON object on its own line in the successful saved page.
  // target is a JS literal with an id first. Do not read user.id (the viewer).
  const authors = [...config.matchAll(/^\s*['"]author['"]\s*:\s*(\{[^\r\n]*\}),\s*$/gm)];
  const targets = [...config.matchAll(/^\s*['"]target['"]\s*:\s*\{\s*['"]id['"]\s*:\s*['"]([1-9]\d*)['"]/gm)];
  if (authors.length !== 1 || targets.length !== 1) return null;
  try {
    const author = JSON.parse(authors[0][1]);
    return /^[1-9]\d*$/.test(author.id ?? '') ? { ownerUserId: author.id, topicId: targets[0][1] } : null;
  } catch { return null; }
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
      const topic = TOPIC_PATH.exec(url.pathname);
      if (url.origin === 'https://www.douban.com' && topic && !url.username && !url.password
        && !url.searchParams.has('ck') && new URL(urlKey(url.href)).search === ''
        && attr(root.opening, 'data-atype') === 'topic'
        && attr(root.opening, 'data-subtype') === 'personal'
        && attr(root.opening, 'data-aid') === topic[1]) {
        candidates.set(`topic:${topic[1]}`, { sid, topicId: topic[1], detailUrl: url.href, commentsUrl: topicCommentsUrl(topic[1]) });
        continue;
      }
      if (url.origin === 'https://www.douban.com' && path
        && path[2] === sid && [ownerUserId, username].includes(path[1]) && !url.username && !url.password) {
        candidates.set(sid, { sid, detailUrl: url.href, commentsUrl: commentsUrl(sid) });
      } else if (!path || path[2] === sid) {
        unresolved.push({ sid, url: url.href, reason: 'unsupported_reply_entry' });
      }
      // Other status IDs are quoted cards, not candidates or root gaps.
    }
  }
  return { candidates: [...candidates.values()], unresolved: dedupeSnapshotGaps(unresolved) };
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
    const topicId = TOPIC_PATH.exec(request.pathname)?.[1];
    if (topicId) {
      const cls = classifyResponse({ ...res, route: {
        urlAnchor: /^https:\/\/www\.douban\.com\/topic\/[1-9]\d*\//,
        frameAnchors: [/\bclass=["']personal-topic["']/, /\bid=["']topic-content["']/, /\bid=["']comments["']/],
      } });
      if (cls.verdict !== 'ok') return cls;
      const identity = personalTopicIdentity(res.bodyText);
      if (urlKey(final.href) !== urlKey(request.href)
        || !identity || identity.topicId !== topicId || identity.ownerUserId !== ownerUserId) {
        return fail(null, 'detail_identity_mismatch');
      }
      return { ...cls, itemCount: 1 };
    }
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
  if (TOPIC_API_PATH.test(request.pathname) && urlKey(final.href) !== urlKey(request.href)) return fail(null, 'url_drifted');
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
    if (row.verdict === 'ok' && snapshotRoute(row.route_key)) {
      try {
        const key = snapshotQueueKey(row.route_key, row.url, account);
        if (mode !== 'refresh-editable' || (row.route_key === DETAIL && !editableSnapshotDetail(row.url))) known.add(key);
      }
      catch (error) { onWarn({ type: 'backlog_unreadable', captureId: row.capture_id, error: String(error) }); }
    }
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
    for (const item of parsed.items) {
      const key = snapshotQueueKey(item.routeKey, item.url, account);
      if (!seen.has(key)) { seen.add(key); items.push(item); }
    }
  }
  return { items, known: [...known], unresolved: dedupeSnapshotGaps(unresolved) };
}
