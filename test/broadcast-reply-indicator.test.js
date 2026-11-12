import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMarkdown } from '../src/pipeline/targets.js';
import { withCanonicalShape } from '../src/pipeline/run.js';

const available=existsSync(new URL('../../doubak-site-generator/src/generate.js',import.meta.url));
if(process.env.CI) assert.ok(available,'CI must check out site generator');
test('reply indicators: browser and CLI emit identical Markdown without reading or exporting reply bodies', {skip:!available},async t=>{
  const { generate }=await import('../../doubak-site-generator/src/generate.js');
  const account={user_id:'123'};
  const data=withCanonicalShape({broadcasts:[{account,upstream_id:'42',url:'https://www.douban.com/people/123/status/42/',
    revisions:[{fields:{text:'My broadcast',visibility:'public',posted_at:{iso:'2026-11-11T00:00:00Z'}}}]}]});
  const snapshot={capture_id:'b#1',observed_at:'2026-11-11T01:00:00Z',intent:'broadcast.comments_snapshot',
    route_key:'broadcast.comments_snapshot',surface:'api',verdict:'ok',item_count:2,
    url:'https://m.douban.com/rexxar/api/v2/status/42/comments?start=0&count=20'};
  const sources=[{manifest:{account},index:[snapshot],readRaw:async()=>{throw Error('reply body must not be read');}}];
  const writes=new Map();
  const browser=await buildMarkdown(data,{sources,write:async(n,b)=>writes.set(n,b)});
  const root=mkdtempSync(join(tmpdir(),'doubak-reply-parity-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const bundles=join(root,'bundles'),out=join(root,'out');mkdirSync(bundles);
  writeFileSync(join(bundles,'manifest.json'),JSON.stringify({account}));
  writeFileSync(join(bundles,'index-b.ndjson'),JSON.stringify(snapshot)+'\n');
  generate({canonical:data,bundlesDir:bundles,outDir:out});
  for(const f of browser.files) assert.deepEqual(readFileSync(join(out,f.name)),Buffer.from(f.bytes),f.name);
  for(const [name,bytes] of writes) assert.deepEqual(readFileSync(join(out,name)),Buffer.from(bytes),name);
  const md=new TextDecoder().decode(browser.files.find(f=>f.name==='content/broadcast/2026-11.md').bytes);
  assert.match(md,/2\+ 条回复/);assert.match(md,/不代表完整讨论/);
  const empty=await buildMarkdown(data,{sources:[],write:async()=>{}});
  assert.doesNotMatch(new TextDecoder().decode(empty.files.find(f=>f.name==='content/broadcast/2026-11.md').bytes),/条回复|回复首屏/);
});
