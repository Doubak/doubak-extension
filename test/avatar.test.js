import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CrawlRunner } from '../src/crawl/runner.js';
import { RunStore } from '../src/crawl/run-store.js';
import { MemoryKvStore } from '../src/storage/kv-store.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { BundleReader } from '../src/bundle/bundle-reader.js';
import { OpfsBundleSource } from '../src/pipeline/opfs-bundle-source.js';
import { parse } from '../src/vendor/parser/parse.js';
import { exportAvatar, imageBytes } from '../src/pipeline/images.js';
import { buildMarkdown } from '../src/pipeline/targets.js';
import { withCanonicalShape, canonicalFiles } from '../src/pipeline/run.js';
import { urlKey } from '../src/core/urlkey.js';
import { addKnownCaptures, emptyKnownCaptures } from '../src/crawl/known-captures.js';
import { TEST_PRODUCER_VERSION } from './helpers/producer.js';
const bytes=readFileSync(new URL('./fixtures/avatar.png',import.meta.url));
const owner='82160871', other='154611037';
const avatar=id=>`https://img3.doubanio.com/icon/up${id}-1.png`;
const page=id=>`<html><head><title>Owner</title><link rel="alternate" href="https://www.douban.com/feed/people/${id}/interests"></head><body>
<li class="nav-user-account"><a href="/accounts/logout">退出</a></li><script>window._GLOBAL_NAV={USER_ID:"${owner}"};</script>
<img src="${avatar(owner)}"><div id="db-usr-profile"><div class="pic"><a href="https://www.douban.com/people/${id}/"><img src="${avatar(id)}"></a></div><div class="info"><h1>Owner</h1></div></div></body></html>`;
function harness(id=owner, anonymous=false) {
 const dirs=new Map(), calls=[];const openBundle=async dir=>{if(!dirs.has(dir))dirs.set(dir,new MemoryFileStore());return dirs.get(dir);};
 const runStore=new RunStore({kv:new MemoryKvStore(),openBundle});
 const state={bad:false,redirect:false,challenge:false,networkFailures:0};
 const fetchImpl=async (url,opts)=>{
  calls.push({url,opts});const asset=url.includes('doubanio.com');
  if(asset&&state.networkFailures>0) { state.networkFailures--; throw new TypeError('fetch failed'); }
  const body=asset&&state.challenge?new TextEncoder().encode('<html><title>验证</title>请输入验证码</html>'):asset&&!state.bad?bytes:new TextEncoder().encode(asset?'not an image':anonymous ? page(id).replace(/<li class="nav-user-account">[\s\S]*?<\/script>/, '<a class="nav-login" href="/accounts/login">登录</a>') : page(id));
  return {url,status:asset&&state.bad?404:asset&&state.redirect?302:200,headers:new Headers({'content-type':asset&&!state.challenge?'image/png':'text/html',...(asset&&state.redirect?{location:'https://evil.example/'}:{})}),arrayBuffer:async()=>body.buffer.slice(body.byteOffset,body.byteOffset+body.byteLength)};
 };
 const make=()=>new CrawlRunner({producerVersion:TEST_PRODUCER_VERSION,runStore,openBundle,fetchImpl,batchSize:1,pacerOptions:{intervalMs:1,jitterRatio:0}});
 return {runner:make(),make,runStore,openBundle,calls,state,id};
}
async function start(h) {
 await h.runner.start({targetInput:h.id,onlyRoutes:['profile.overview','asset.account_avatar'],includeCatalog:false,includeCovers:false,knownAssetUrlKeys:[urlKey(avatar(h.id))]});
 await h.runner.runBatch();
}
async function rows(h) {const p=await h.runStore.getCurrentRun();return new BundleReader({store:await h.openBundle(p.dir),bundleId:p.bundleId}).index();}
for(const [id,anonymous] of [[owner,false],[other,false],[other,true]]) test(`capture and export target ${id}, anonymous=${anonymous}: anonymous asset, real WARC, parser and local Markdown`,async()=>{
 const h=harness(id,anonymous);await start(h);await h.runner.runBatch();
 const index=await rows(h),a=index.find(r=>r.route_key==='asset.account_avatar');assert.ok(a,index);
 assert.equal(a.verdict,'ok');assert.equal(a.parent_capture_id,index[0].capture_id);assert.match(a.segment,/^assets-/);
 const req=h.calls.find(r=>r.url===avatar(id));assert.equal(req.opts.credentials,'omit');assert.equal(req.opts.cache,'no-store');assert.equal(req.opts.redirect,'error');
 const pointer=await h.runStore.getCurrentRun(),store=await h.openBundle(pointer.dir);
 await h.runner.finish();const manifest=JSON.parse(new TextDecoder().decode(await store.read('manifest.json')));
 const src=await OpfsBundleSource.open({store,entry:{...pointer,manifest}});
 const parsed=await parse([src]);assert.equal(parsed.profile[0].account.user_id,id);
 assert.ok(canonicalFiles(parsed).some(f=>f.name==='profile.ndjson'));
 assert.deepEqual(Buffer.from(await imageBytes({host:src,row:a})),bytes,'WARC terminator is not part of image bytes');
 const output=new Map(),write=async(n,b)=>output.set(n,b);
 const meta=await exportAvatar({canonical:parsed,sources:[src],write});assert.equal(meta.status,'ok');assert.match(meta.avatar,new RegExp(`/profile/${id}/`));
 assert.deepEqual(Buffer.from(output.get('static/'+meta.avatar)),bytes);
 const md=await buildMarkdown(withCanonicalShape(parsed),{sources:[src],write});assert.equal(md.report.avatar.status,'ok');
 assert.equal(addKnownCaptures(emptyKnownCaptures(),index).assets.size,0,'avatar is never reused across bundles');
});
for(const cold of [false,true]) test(`${cold?'cold':'hot'} resume does not duplicate pending or completed avatar`,async()=>{
 const h=harness();await start(h);await h.runner.pause();
 const cp=await h.runStore.loadCheckpoint();if(cold)h.runner=h.make();await h.runner.resume(cp);
 await h.runner.runBatch();assert.equal(h.calls.filter(r=>r.url===avatar(owner)).length,1);
 await h.runner.pause();const cp2=await h.runStore.loadCheckpoint();h.runner=h.make();await h.runner.resume(cp2);await h.runner.runBatch();
 assert.equal(h.calls.filter(r=>r.url===avatar(owner)).length,1);
});
test('cold resume reconstructs lost derivation from archived profile without refetching profile',async()=>{
 const h=harness(other);await h.runner.start({targetInput:other,onlyRoutes:['profile.overview','asset.account_avatar']});
 const before=await h.runStore.loadCheckpoint();await h.runner.runBatch();
 h.runner=h.make();await h.runner.resume(before,{loadOnly:true});
 assert.equal(h.calls.length,2,'preflight and captured profile only; load-only is offline');
 const cp=await h.runStore.loadCheckpoint();await h.runner.resume(cp);await h.runner.runBatch();
 assert.equal((await rows(h)).filter(r=>r.route_key==='profile.overview').length,1);
 assert.equal((await rows(h)).filter(r=>r.route_key==='asset.account_avatar').length,1);
});
test('404 avatar is an explicit non-ordered gap; failed attempts survive reload and explicit retry heals',async()=>{
 const h=harness();h.state.bad=true;await start(h);await h.runner.runBatch();
 const index=await rows(h);assert.equal(index.at(-1).verdict,'unknown');
 const cp=await h.runStore.loadCheckpoint();assert.equal(cp.frontier.find(r=>r.route_key==='asset.account_avatar').state,'failed');
 h.runner=h.make();await h.runner.resume(cp);await h.runner.runBatch();assert.equal(h.calls.filter(r=>r.url===avatar(owner)).length,1);
 h.state.bad=false;await h.runner.retryFailed();await h.runner.runBatch();assert.equal((await rows(h)).at(-1).verdict,'ok');
 assert.equal(h.runner._run.loop.stateFor('asset.account_avatar').gaps.length,0);
});
test('redirect response never follows Location or becomes a successful avatar',async()=>{
 const h=harness();h.state.redirect=true;await start(h);await h.runner.runBatch();
 assert.ok(h.calls.every(r=>!r.url.includes('evil.example')));
 assert.notEqual((await rows(h)).at(-1).verdict,'ok');
});

test('avatar verification challenge pauses once and cold resume preserves target and parent',async()=>{
 const h=harness(other);h.state.challenge=true;await start(h);await h.runner.runBatch();
 assert.equal((await rows(h)).at(-1).verdict,'challenge');
 const cp=await h.runStore.loadCheckpoint();assert.equal(cp.frontier.find(r=>r.route_key==='asset.account_avatar').state,'awaiting_human');
 await h.runner.runBatch();assert.equal(h.calls.filter(r=>r.url===avatar(other)).length,1);
 h.state.challenge=false;h.runner=h.make();await h.runner.resume(cp);await h.runner.runBatch();
 const captured=await rows(h);assert.equal(captured.at(-1).verdict,'ok');
 assert.equal(captured.at(-1).parent_capture_id,captured[0].capture_id);
 assert.equal(captured[1].verdict,'challenge','historical challenge remains in archive');
});
test('transient avatar network error retries in the same task without refetching the profile',async()=>{
 const h=harness();await start(h);h.state.networkFailures=1;
 h.runner._run.loop._retryBackoffMs=0;await h.runner.runBatch();
 if(!(await rows(h)).some(r=>r.route_key==='asset.account_avatar'))await h.runner.runBatch();
 const captured=await rows(h);assert.equal(captured.at(-1).verdict,'ok');
 assert.equal(captured.filter(r=>r.route_key==='profile.overview').length,1);
 assert.equal(h.calls.filter(r=>r.url===avatar(owner)).length,2);
});
