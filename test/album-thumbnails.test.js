import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildMarkdown } from '../src/pipeline/targets.js';
import { withCanonicalShape } from '../src/pipeline/run.js';

test('browser Markdown export uses a local album original without reporting its uncaptured thumbnail as missing or remote',async()=>{
 const original='https://img3.doubanio.com/view/photo/large/public/p123.png';
 const thumbnail='https://img3.doubanio.com/view/photo/m/public/p123.png';
 const bytes=readFileSync(new URL('./fixtures/avatar.png',import.meta.url));
 const http=Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: image/png\r\n\r\n'),bytes]);
 const raw=Buffer.concat([Buffer.from(`WARC/1.1\r\nContent-Length: ${http.length}\r\n\r\n`),http,Buffer.from('\r\n\r\n')]);
 const row={capture_id:'b#1',url:original,route_key:'asset.photo_image',surface:'asset',verdict:'ok',content_type:'image/png'};
 const sources=[{manifest:{account:{user_id:'123'}},index:[row],readRaw:async()=>raw}];
 const album={upstream_id:'42',account:{user_id:'123'},revisions:[{last_observed_at:'2026-10-17T00:00:00Z',fields:{title:'Album',photos:[{id:'123',image_url:original,thumbnail_url:thumbnail}]}}]};
 const data=withCanonicalShape({marks:[],subjects:[],broadcasts:[],longform:[],doulists:[],albums:[album]});
 const written=new Map(),result=await buildMarkdown(data,{sources,write:async(n,b)=>written.set(n,b)});
 assert.equal(result.report.images,1);assert.deepEqual(result.report.missing,[]);assert.deepEqual(result.report.remote,[]);
 const md=new TextDecoder().decode(result.files.find(f=>f.name==='content/album/42.md').bytes);
 assert.match(md,/\/uploads\/p123\.png/);assert.doesNotMatch(md,/view\/photo\/m\/public/);
 assert.deepEqual(Buffer.from(written.get('static/uploads/p123.png')),bytes);
});
