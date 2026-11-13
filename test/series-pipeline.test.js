import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BundleWriter } from '../src/bundle/bundle-writer.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { OpfsBundleSource } from '../src/pipeline/opfs-bundle-source.js';
import { buildMarkdown } from '../src/pipeline/targets.js';
import { parse as portableParse } from '../src/vendor/parser/parse.js';
import { TEST_PRODUCER } from './helpers/producer.js';
import { bundleDirName } from '../src/core/ids.js';

const parserUrl=new URL('../../doubak-data-parser/src/parse.js',import.meta.url);
const generatorUrl=new URL('../../doubak-site-generator/src/pages.js',import.meta.url);
const available=existsSync(parserUrl)&&existsSync(generatorUrl);
if(process.env.CI) assert.ok(available,'Cross-host tests require upstream repos');
test('same WARC bytes through Node and OPFS produce identical canonical and series Markdown', {skip:!available}, async t=>{
  const {parse}=await import(parserUrl);
  const {openAll}=await import(new URL('../../doubak-data-parser/src/bundle-source.js',import.meta.url));
  const {project}=await import(new URL('../../doubak-site-generator/src/projection.js',import.meta.url));
  const {buildPages}=await import(generatorUrl);
  const store=new MemoryFileStore(), writer=new BundleWriter({store,producer:TEST_PRODUCER,account:{user_id:'111',username:'tester'},now:()=>new Date('2026-11-13T00:00:00Z')});
  const list=['36848001','1304585'].map(id=>`<div class="item" data-cid="${id}"><div class="info"><ul><li class="title"><a href="https://movie.douban.com/subject/${id}/"><em>Film ${id}</em></a></li><li><span class="date">2026-01-01</span><span class="rating4-t"></span></li><li><span class="comment">我的短评</span></li></ul></div></div>`).join('');
  let n=0;
  async function capture(body, detail) {
    const url=detail?'https://movie.douban.com/subject/36848001/':'https://movie.douban.com/people/tester/collect';
    await writer.writeCapture({url,urlKey:url.replace('https://',''),urlKeyRules:'v1',
      intent:detail?'interest.item':'interest.list.movie.collect',routeKey:detail?'interest.item':'interest.movie.collect',
      surface:'html',verdict:'ok',captureFidelity:'decoded_body+observed_headers',body:new TextEncoder().encode(body),
      observedAt:`2026-11-13T00:00:0${n++}Z`,httpStatus:200,headers:[['Content-Type','text/html; charset=utf-8']],contentType:'text/html; charset=utf-8'});
  }
  await capture(list,false);
  for(const name of ['film-before','film-after']) await capture(readFileSync(new URL(`../docs/designs/fixtures/subject-series/${name}.html`,import.meta.url),'utf8'),true);
  await writer.finalize();
  const manifest=JSON.parse(new TextDecoder().decode(await store.read('manifest.json')));
  const source=await OpfsBundleSource.open({store,entry:{bundleId:writer.bundleId,dir:bundleDirName(writer.bundleId),manifest}});
  const dir=mkdtempSync(join(tmpdir(),'doubak-series-hosts-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  for(const name of await store.list()) writeFileSync(join(dir,name),await store.read(name));
  const disk=openAll(dir), node=await parse(disk), browser=await portableParse([source]);
  for(const key of ['marks','subjects','broadcasts','longform','doulists','albums','groupTopics','groupJoins','profile']) assert.deepEqual(browser[key],node[key],key);
  assert.deepEqual(node.subjects.find(s=>s.id==='36848001').revisions.filter(r=>r.fields.series).map(r=>r.fields.series.items.length),[3,4]);
  const md=await buildMarkdown(browser,{sources:[source],write:async name=>{assert.equal(name,'site-profile.json','Series must not export thumbnails');}});
  const nodeFiles=buildPages(project(node),{siteTitle:'tester的豆瓣存档'}).files;
  const portableFiles=md.files.map(f=>[f.name,new TextDecoder().decode(f.bytes)]).filter(([name])=>name.startsWith('content/'));
  assert.deepEqual(portableFiles,nodeFiles.filter(([name])=>name.startsWith('content/')));
  const byName = new Map(portableFiles);
  assert.match(byName.get('content/movie/36848001.md'), /该页面的完整列表（含本作共 5 项）/);
  assert.match(byName.get('content/movie/36848001.md'), /\.\.\/movie\/1304585\.md/);
  assert.match(byName.get('content/movie/36848001.md'), /BJ单身日记2：理性边缘 · 本档案未收录/);
  assert.match(byName.get('content/movie/1304585.md'), /## 同系列作品[\s\S]*\.\.\/movie\/36848001\.md/);
  assert.doesNotMatch(byName.get('content/movie/1304585.md'), /BJ单身日记2|其他作品页中的关联|系列列表的观测变化/);
  assert.equal(byName.has('content/movie/1308819.md'), false);
  const searchJs = new TextDecoder().decode(md.files.find(f => f.name === 'static/search-index.js').bytes);
  assert.doesNotMatch(searchJs, /1308819|理性边缘/);
});
