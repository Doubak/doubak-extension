import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  extractBroadcastSnapshots, snapshotTasks, snapshotBacklog, snapshotQueueKey,
  assertSnapshotRequest, classifySnapshot, topicCommentsUrl, resolvedSnapshotGap, DETAIL, COMMENTS,
} from '../src/crawl/broadcast-snapshots.js';
import { commentsRefererRule } from '../src/crawl/referer-rule.js';
const fixture = name => readFileSync(new URL(`./fixtures/broadcast-snapshots/${name}`, import.meta.url), 'utf8');
const list = fixture('personal-topic-list.html');
const detail = fixture('personal-topic.html');
const json = fixture('personal-topic-comments.json');
const account = { userId: '111', username: 'example' };
const opts = { ownerUserId: account.userId, username: account.username };
const row = { route_key: 'broadcast.timeline', verdict: 'ok', capture_id: 'old#000001', url: 'https://www.douban.com/people/example/statuses?p=1' };
const tasks = snapshotTasks(list, account, row.capture_id, row.url);
const detailUrl = 'https://www.douban.com/topic/987/?_spm_id=example';
const apiUrl = topicCommentsUrl('987');

test('personal topic links use root aid, never SID or group discussion identities', () => {
  const found = extractBroadcastSnapshots(list, opts);
  assert.deepEqual(found.candidates, [{ sid: '789', topicId: '987', detailUrl, commentsUrl: apiUrl }]);
  assert.deepEqual(found.unresolved, []);
  assert.deepEqual(tasks.items.map(t => t.routeKey), [DETAIL, COMMENTS]);
  assert.equal(tasks.items[1].referer, detailUrl);
  assert.ok(tasks.items.every(t => t.parentCaptureId === row.capture_id));
  for (const invalid of [
    list.replaceAll('data-uid="111"', 'data-uid="222"'),
    list.replaceAll('data-aid="987"', 'data-aid="789"'),
    list.replaceAll('data-subtype="personal"', 'data-subtype="group"'),
    list.replaceAll('data-atype="topic"', 'data-atype="status"'),
    list.replace('data-count="2"', 'data-count="0"'),
    list.replaceAll('/topic/987/', '/group/topic/987/'),
    list.replaceAll('/topic/987/', '/topic/988/'),
    list.replaceAll('_spm_id=example', 'type=like'),
  ]) assert.equal(extractBroadcastSnapshots(invalid, opts).candidates.length, 0);
});

test('topic URLs are constrained to a measured first-page view without credentials or recursion', () => {
  assert.doesNotThrow(() => assertSnapshotRequest(DETAIL, detailUrl, account));
  assert.doesNotThrow(() => assertSnapshotRequest(COMMENTS, apiUrl, account));
  for (const url of [apiUrl.replace('start=0', 'start=20'), apiUrl.replace('nested=1', 'nested=0'),
    apiUrl.replace('order_by=time_asc', 'order_by=hot'), apiUrl.replace('topic_id=987', 'topic_id=789'),
    apiUrl + '&ck=secret', apiUrl + '&count=20', apiUrl.replace('count=20', 'count=100'),
    apiUrl.replace('/topic/987/comments', '/topic/comment/1001/replies'),
    apiUrl.replace('m.douban.com', 'example.org')]) assert.throws(() => assertSnapshotRequest(COMMENTS, url, account));
  for (const url of [detailUrl + '&ck=secret', detailUrl + '&type=rec', detailUrl.replace('/topic/', '/group/topic/')]) {
    assert.throws(() => assertSnapshotRequest(DETAIL, url, account));
  }
  assert.notEqual(snapshotQueueKey(DETAIL, detailUrl, account), snapshotQueueKey(DETAIL, 'https://www.douban.com/people/111/status/987/', account));
  assert.notEqual(snapshotQueueKey(COMMENTS, apiUrl, account), snapshotQueueKey(COMMENTS, 'https://m.douban.com/rexxar/api/v2/status/987/comments?start=0&count=20', account));
});

test('personal-topic classifier checks author rather than viewer and exact topic identity', () => {
  const res = { status: 200, finalUrl: detailUrl, bodyText: detail };
  const options = { routeKey: DETAIL, requestUrl: detailUrl, ownerUserId: '111' };
  assert.equal(classifySnapshot(res, options).verdict, 'ok');
  for (const bodyText of [
    detail.replace("'author': {\"id\":\"111\"", "'author': {\"id\":\"222\""),
    detail.replace("'id': '987'", "'id': '789'"),
    detail.replace("'service': 'group'", "'service': 'status'"),
    detail.replace('/api/v2/group/topic/:topic_id/comments', '/api/v2/status/:topic_id/comments'),
    detail.replace('class="personal-topic"', 'class="group-topic"'),
    detail.replace("'author':", "'other':"),
    detail + detail,
    detail.replace("'author': {\"id\":\"111\",\"uid\":\"example\"}", "'author': {unquoted: true}"),
  ]) assert.notEqual(classifySnapshot({ ...res, bodyText }, options).verdict, 'ok');
  assert.notEqual(classifySnapshot({ ...res, finalUrl: detailUrl + '&type=rec' }, options).verdict, 'ok');
  assert.equal(classifySnapshot({ ...res, status: 403, bodyText: '<title>没有访问权限</title>' }, options).verdict, 'blocked');
});

test('nested preview JSON is accepted whole, not enumerated or interpreted as complete discussion', () => {
  const res = { status: 200, finalUrl: apiUrl, bodyText: json };
  const options = { routeKey: COMMENTS, requestUrl: apiUrl, ownerUserId: '111' };
  const result = classifySnapshot(res, options);
  assert.equal(result.verdict, 'ok');
  assert.equal(result.itemCount, 1);
  const data = JSON.parse(json); data.total = 100; data.comments[0].total_replies = 25;
  assert.equal(classifySnapshot({ ...res, bodyText: JSON.stringify(data) }, options).verdict, 'ok');
  assert.equal(classifySnapshot({ ...res, finalUrl: apiUrl.replace('nested=1', 'nested=0') }, options).reason, 'url_drifted');
  assert.equal(classifySnapshot({ ...res, status: 403 }, options).verdict, 'blocked');
});

for (const mode of ['incremental', 'refresh-editable', 'full']) {
  test(`topic mode ${mode}: editable HTML and reply first page have separate successful identities`, async () => {
    const saved = tasks.items.map(it => ({ route_key: it.routeKey, url: it.url, verdict: 'ok' }));
    const result = await snapshotBacklog({ sources: [{ rows: [row, ...saved], readPayload: async () => list }], account, mode });
    assert.deepEqual(result.items.map(it => it.routeKey), mode === 'refresh-editable' ? [DETAIL, COMMENTS] : []);
    assert.equal(result.known.length, mode === 'incremental' ? 2 : 0);
  });
}

test('a topic API success heals only its own old unsupported gap, not detail or another topic', () => {
  const gap = { reason: 'unsupported_reply_entry', url: 'https://www.douban.com/topic/987/?_i=old' };
  assert.equal(resolvedSnapshotGap(gap, COMMENTS, apiUrl, account), true);
  assert.equal(resolvedSnapshotGap(gap, DETAIL, detailUrl, account), true);
  assert.equal(resolvedSnapshotGap(gap, DETAIL, apiUrl, account), false);
  assert.equal(resolvedSnapshotGap(gap, COMMENTS, topicCommentsUrl('988'), account), false);
  assert.equal(resolvedSnapshotGap({ ...gap, reason: 'blocked' }, COMMENTS, apiUrl, account), false);
});

test('DNR covers personal topic first-page API but no nested reply or unrelated group endpoint', () => {
  const pattern = new RegExp(commentsRefererRule().condition.regexFilter);
  assert.ok(pattern.test(apiUrl));
  assert.equal(pattern.test('https://m.douban.com/rexxar/api/v2/group/topic/comment/1001/replies?start=0'), false);
  assert.equal(pattern.test('https://m.douban.com/rexxar/api/v2/group/123/topics?start=0'), false);
});
