import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractBroadcastSnapshots, snapshotTasks, snapshotBacklog, classifySnapshot, assertSnapshotScope, assertSnapshotRequest, commentsUrl, DETAIL, COMMENTS } from '../src/crawl/broadcast-snapshots.js';
import { buildRoutes } from '../src/crawl/routes.js';
import { hasRouteName } from '../src/ui/route-names.js';
import { urlKey } from '../src/core/urlkey.js';
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
  assert.deepEqual(result.known, [urlKey(haveDetail.url)]);
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
