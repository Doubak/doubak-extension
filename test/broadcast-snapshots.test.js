import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractBroadcastSnapshots, snapshotTasks, snapshotQueueKey, dedupeSnapshotGaps, dedupeSnapshotFrontier, snapshotBacklog, classifySnapshot, assertSnapshotScope, assertSnapshotRequest, commentsUrl, DETAIL, COMMENTS } from '../src/crawl/broadcast-snapshots.js';
import { buildRoutes } from '../src/crawl/routes.js';
import { hasRouteName } from '../src/ui/route-names.js';
const html = readFileSync(new URL('./fixtures/broadcast-snapshots/timeline.html', import.meta.url), 'utf8');
const json = readFileSync(new URL('./fixtures/broadcast-snapshots/comments.json', import.meta.url), 'utf8');
const account = { userId: '111', username: 'example' };
const opts = { ownerUserId: '111', username: 'example' };
const row = { route_key: 'broadcast.timeline', verdict: 'ok', capture_id: 'old#000001', url: 'https://www.douban.com/people/example/statuses?p=30' };
const tasks = snapshotTasks(html, account, row.capture_id, row.url);

test('root identity and reply count, never punctuation, quote count, topic aid or delete button', () => {
  const found = extractBroadcastSnapshots(html, opts);
  assert.deepEqual(found.candidates.map(c => c.sid), ['123']);
  assert.equal(found.candidates[0].commentsUrl, commentsUrl('123'));
  assert.equal(found.unresolved.length, 1);
  assert.equal(found.unresolved[0].sid, '789');
  assert.match(found.unresolved[0].url, /topic\/987/);
  assert.equal(extractBroadcastSnapshots(html.replace('data-count="3"', 'data-count="0"'), opts).candidates.length, 0);
  assert.equal(extractBroadcastSnapshots(`<script>${html}</script><!--${html.replace(/<!--[\s\S]*?-->/g, '')}-->`, opts).candidates.length, 0);
  assert.equal(tasks.items.length, 2);
  assert.ok(tasks.items.every(t => t.parentCaptureId === row.capture_id));
});

for (const mode of ['incremental', 'refresh-editable', 'full']) for (const view of ['self', 'public-authenticated', 'public-anonymous']) {
  test(`mode/view: ${mode} × ${view}`, async () => {
    const self = view === 'self';
    const context = { account, visibility: self ? 'self' : 'public', operatorMode: view.endsWith('anonymous') ? 'anonymous' : 'authenticated', operatorUserId: self ? '111' : '222' };
    assert.doesNotThrow(() => assertSnapshotScope(false, context));
    if (self) assert.doesNotThrow(() => assertSnapshotScope(true, context));
    else assert.throws(() => assertSnapshotScope(true, context), /本人|自己的账号/);
    const routes = buildRoutes({ username: 'example', visibility: context.visibility, broadcastReplySnapshot: true });
    assert.equal(routes.some(r => r.key === COMMENTS), self);
    for (const r of routes.filter(r => [DETAIL, COMMENTS].includes(r.key))) {
      assert.equal(r.enumeration, 'bounded'); assert.equal(r.pagination, undefined);
      assert.equal(r.withCk, false); assert.ok(hasRouteName(r.key));
    }
    const saved = tasks.items.map(t => ({ route_key: t.routeKey, url: t.url, verdict: 'ok' }));
    const sources = [{ rows: [row, ...saved], readPayload: async () => html }];
    const result = await snapshotBacklog({ sources, account, mode });
    assert.deepEqual(result.items.map(i => i.routeKey), mode === 'refresh-editable' ? [COMMENTS] : []);
    assert.equal(result.known.length, mode === 'full' ? 0 : mode === 'incremental' ? 2 : 1);
  });
}

test('default off; backlog before any watermark, independent failures and provenance', async () => {
  assert.ok(!buildRoutes({ username: 'example' }).some(r => r.key === COMMENTS));
  const failed = { route_key: COMMENTS, url: commentsUrl('123'), verdict: 'blocked' };
  const haveDetail = { route_key: DETAIL, url: tasks.items[0].url, verdict: 'ok' };
  const result = await snapshotBacklog({ sources: [{ rows: [row, haveDetail, failed], readPayload: async () => html }], account, mode: 'incremental' });
  assert.deepEqual(result.items.map(i => i.routeKey), [COMMENTS]);
  assert.equal(result.items[0].parentCaptureId, row.capture_id);
  assert.deepEqual(result.known, [snapshotQueueKey(DETAIL, haveDetail.url, account)]);
});

test('strict API response, no full-discussion inference and no text-based safety flags', () => {
  const res = { status: 200, finalUrl: commentsUrl('123'), bodyText: json };
  const options = { routeKey: COMMENTS, requestUrl: commentsUrl('123'), ownerUserId: '111' };
  assert.equal(classifySnapshot(res, options).verdict, 'ok');
  assert.equal(classifySnapshot(res, options).itemCount, 1);
  for (const bodyText of ['{}', '[]', json.replace('"start":0', '"start":20'), '{broken']) {
    assert.notEqual(classifySnapshot({ ...res, bodyText }, options).verdict, 'ok');
  }
  assert.equal(classifySnapshot({ ...res, status: 403 }, options).verdict, 'blocked');
  assert.equal(classifySnapshot({ ...res, status: 401 }, options).verdict, 'login');
  assert.equal(classifySnapshot({ ...res, finalUrl: commentsUrl('456') }, options).verdict, null);
  assert.equal(classifySnapshot({ ...res, bodyText: '<title>登录豆瓣</title><div class="nav-login"></div>' }, options).verdict, 'login');
});

test('detail must match root SID and owner, not quoted SID or another 200 page', () => {
  const root = '<div class="new-status status-wrapper from-detail" data-sid="123" data-uid="111"><div class="status-item"></div></div><div id="comments"></div>';
  const res = { status: 200, finalUrl: tasks.items[0].url, bodyText: '<li class="nav-user-account"></li>' + root };
  const options = { routeKey: DETAIL, requestUrl: res.finalUrl, ownerUserId: '111' };
  assert.equal(classifySnapshot(res, options).verdict, 'ok');
  assert.equal(classifySnapshot({ ...res, bodyText: res.bodyText.replace('data-uid="111"', 'data-uid="222"') }, options).verdict, null);
});


test('restored tasks cannot request another root owner, later pages, ck or a foreign origin', () => {
  assert.doesNotThrow(() => assertSnapshotRequest(COMMENTS, commentsUrl('123'), account));
  assert.doesNotThrow(() => assertSnapshotRequest(DETAIL, tasks.items[0].url, account));
  for (const url of [commentsUrl('123').replace('start=0', 'start=20'), commentsUrl('123') + '&ck=token',
    commentsUrl('123').replace('m.douban.com', 'example.com'), commentsUrl('123').replace('/comments', '/likes')]) {
    assert.throws(() => assertSnapshotRequest(COMMENTS, url, account));
  }
  assert.throws(() => assertSnapshotRequest(DETAIL, tasks.items[0].url.replace('/people/111/', '/people/222/'), account));
  assert.equal(extractBroadcastSnapshots(html.replaceAll('class=', 'data-class='), opts).candidates.length, 0);
});


test('reply buttons for a note or subject discussion are outside broadcast scope, not missing snapshots', () => {
  for (const href of ['https://www.douban.com/note/872015292/', 'https://movie.douban.com/subject/26805209/discussion/615298952/']) {
    const card = `<div class="new-status status-wrapper" data-sid="123" data-uid="111"><div class="status-item" data-sid="123"><a class="btn-action-reply" data-count="5" href="${href}">5回应</a></div></div>`;
    assert.deepEqual(extractBroadcastSnapshots(card, opts), { candidates: [], unresolved: [] });
  }
});


test('API error diagnostics do not echo arbitrary response text', () => {
  const result = classifySnapshot({ status: 400, finalUrl: commentsUrl('123'),
    bodyText: JSON.stringify({ code: 1287, msg: '<private user text>' }) },
    { routeKey: COMMENTS, requestUrl: commentsUrl('123'), ownerUserId: '111' });
  assert.equal(result.verdict, null);
  assert.equal(result.reason, 'unexpected_status');
  assert.deepEqual(result.reasons, ['HTTP 400 · API code 1287']);
});

const aliasHtml = html.replaceAll('/people/111/status/123/', '/people/example/status/123/?_spm_id=old');
const aliasSources = [
  { rows: [row], readPayload: async () => html },
  { rows: [{ ...row, capture_id: 'older#000001' }], readPayload: async () => aliasHtml },
];

test('historical UID/username aliases schedule one detail and one API without rewriting source URLs', async () => {
  for (const sources of [aliasSources, [...aliasSources].reverse()]) {
    const result = await snapshotBacklog({ sources, account, mode: 'incremental' });
    assert.deepEqual(result.items.map(i => i.routeKey), [DETAIL, COMMENTS]);
    assert.equal(result.items[0].parentCaptureId, sources[0].rows[0].capture_id);
    assert.equal(result.items[0].url, sources[0] === aliasSources[0]
      ? tasks.items[0].url : 'https://www.douban.com/people/example/status/123/?_spm_id=old');
  }
});

for (const savedAlias of ['111', 'example']) for (const mode of ['incremental', 'refresh-editable', 'full']) {
  test(`saved ${savedAlias} detail suppresses both aliases in ${mode}`, async () => {
    const saved = [
      { route_key: DETAIL, url: `https://www.douban.com/people/${savedAlias}/status/123/?_i=old`, verdict: 'ok' },
      { route_key: COMMENTS, url: commentsUrl('123'), verdict: 'ok' },
    ];
    const result = await snapshotBacklog({ sources: [...aliasSources, { rows: saved }], account, mode });
    assert.deepEqual(result.items.map(i => i.routeKey), mode === 'refresh-editable' ? [COMMENTS] : []);
    assert.equal(result.known.length, mode === 'full' ? 0 : mode === 'incremental' ? 2 : 1);
  });
}

test('identity keys separate SID, owner and route; foreign aliases cannot suppress own captures', async () => {
  assert.equal(snapshotQueueKey(DETAIL, tasks.items[0].url, account),
    snapshotQueueKey(DETAIL, 'https://www.douban.com/people/example/status/123/?_i=x#replies', account));
  assert.notEqual(snapshotQueueKey(DETAIL, tasks.items[0].url, account), snapshotQueueKey(COMMENTS, commentsUrl('123'), account));
  assert.notEqual(snapshotQueueKey(COMMENTS, commentsUrl('123'), account), snapshotQueueKey(COMMENTS, commentsUrl('456'), account));
  assert.notEqual(snapshotQueueKey(COMMENTS, commentsUrl('123'), account), snapshotQueueKey(COMMENTS, commentsUrl('123'), { userId: '222' }));
  const warnings = [];
  const result = await snapshotBacklog({ sources: [...aliasSources, { rows: [
    { route_key: DETAIL, url: 'https://www.douban.com/people/222/status/123/', verdict: 'ok' },
    { route_key: DETAIL, url: tasks.items[0].url, verdict: 'unknown' },
  ] }], account, mode: 'incremental', onWarn: w => warnings.push(w) });
  assert.equal(result.items.length, 2);
  assert.equal(result.known.length, 0);
  assert.equal(warnings.length, 1);
});

test('legacy duplicate checkpoint retains failed state and retry budget in either ordering', () => {
  const pending = { route_key: DETAIL, url: tasks.items[0].url, state: 'pending', attempts: 0 };
  const failed = { ...pending, url: 'https://www.douban.com/people/example/status/123/', state: 'failed', attempts: 3, last_error: 'unclassified' };
  for (const entries of [[pending, failed], [failed, pending]]) {
    assert.deepEqual(dedupeSnapshotFrontier(entries, account), [failed]);
  }
});


test('unsupported entry gaps collapse tracking variants across lists but retain distinct entries/errors', async () => {
  const result = await snapshotBacklog({ sources: aliasSources, account, mode: 'incremental' });
  assert.equal(result.unresolved.length, 1);
  const first = { reason: 'unsupported_reply_entry', url: 'https://www.douban.com/topic/987/?_spm_id=one', parentCaptureId: 'old#000001' };
  const variant = { ...first, url: 'https://www.douban.com/topic/987/?_i=two#replies', parentCaptureId: 'other#000001' };
  const second = { ...first, url: 'https://www.douban.com/topic/988/' };
  const error = { reason: 'blocked', url: first.url };
  const malformed = { reason: 'unsupported_reply_entry', url: 'not a URL' };
  assert.deepEqual(dedupeSnapshotGaps([first, variant, second, error, malformed]), [first, second, error, malformed]);
  assert.equal(extractBroadcastSnapshots(html + html, opts).unresolved.length, 1);
});
