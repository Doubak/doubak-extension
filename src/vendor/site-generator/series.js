/* 【自动同步，请勿手改】来自 doubak-site-generator 的 src/series.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/** Pure, source-labelled directory observations. No entity merging or network lookups. */
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const keyOf = item => `${item.medium}:${item.id}`;
const time = at => { const t = Date.parse(at); return Number.isFinite(t) ? t : 0; };
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function readable(value) {
  const diagnostics = [];
  if (!object(value) || value.kind !== 'douban_same_series' || !Array.isArray(value.items)) return { diagnostics:['unreadable_series'] };
  let scope = ['complete','partial','unknown'].includes(value.scope) ? value.scope : 'unknown';
  if (!['embedded_config','rendered_section'].includes(value.source)) { scope='unknown'; diagnostics.push('unknown_series_source'); }
  const items=[], seen=new Set();
  for (const item of value.items) {
    if (!object(item) || item.medium !== 'movie' || typeof item.id !== 'string' || !/^\d+$/.test(item.id)) {
      diagnostics.push('invalid_series_member'); continue;
    }
    if (seen.has(keyOf(item))) { diagnostics.push('duplicate_series_member'); continue; }
    seen.add(keyOf(item));
    items.push({ medium:'movie', id:item.id, title:typeof item.title==='string'?item.title:null,
      season_label:typeof item.season_label==='string'?item.season_label:null });
  }
  if (diagnostics.some(x=>x !== 'unknown_series_source')) scope='partial';
  return { value:{ kind:value.kind, source:value.source, items, scope,
    claimed_total:Number.isSafeInteger(value.claimed_total)&&value.claimed_total>=0?value.claimed_total:null,
    // Only use the existence of a validated series URL to distinguish empty states.
    series_url:validSeriesUrl(value.series_url) }, diagnostics };
}
function validSeriesUrl(value) {
  if (typeof value !== 'string') return null;
  try { const u=new URL(value); return ['http:','https:'].includes(u.protocol) && u.hostname==='movie.douban.com'
    && !u.port && !u.username && !u.password && /^\/series\/[A-Za-z0-9]+\/?$/.test(u.pathname) ? value : null; }
  catch { return null; }
}
function visible(value) {
  // more_url tracking parameters and unknown extension fields do not make visible edits.
  return stable(value);
}
export function projectSeries(subject) {
  const revisions=subject?.revisions ?? [], latest=revisions.at(-1);
  if (subject?.medium !== 'movie' || !Object.hasOwn(latest?.fields ?? {}, 'series')) return null;
  const current=readable(latest.fields.series), events=[], diagnostics=[...current.diagnostics];
  for (const revision of revisions) {
    if (!Object.hasOwn(revision.fields ?? {}, 'series')) continue;
    const read=readable(revision.fields.series);
    for (const observation of revision.observations ?? []) {
      if (observation.omitted_fields?.includes('series')) continue;
      events.push({ value:read.value, raw:stable(revision.fields.series), at:observation.observed_at,
        parser:revision.parser_version, observation });
    }
  }
  // Revision/observation order is the canonical deterministic tie-break for equal instants.
  events.sort((a,b)=>time(a.at)-time(b.at));
  const evidence=[...events].reverse().find(e=>e.raw===stable(latest.fields.series));
  const selfKey=`movie:${subject.id}`;
  // Union readable snapshots chronologically so each Douban ID keeps its latest title/label;
  // an explicit complete-empty snapshot resets earlier members until a later non-empty list.
  const merged=new Map();
  for (const event of events) {
    if (!event.value) continue;
    if (!event.value.items.length && event.value.scope==='complete') { merged.clear(); continue; }
    for (const item of event.value.items) {
      const k=keyOf(item); if (k===selfKey) continue;
      const prev=merged.get(k);
      merged.set(k,{ medium:'movie', id:item.id, title:item.title??prev?.title??null,
        season_label:item.season_label??null, at:event.at??prev?.at??null });
    }
  }
  const unionItems=[]; let hasHistoryUnionExtras=false;
  if (current.value) {
    const seenCurrent=new Set();
    for (const item of current.value.items) {
      const k=keyOf(item); if (k===selfKey || seenCurrent.has(k)) continue;
      seenCurrent.add(k); unionItems.push(merged.get(k)??item);
    }
    for (const [k,item] of merged) {
      if (!seenCurrent.has(k)) { unionItems.push(item); hasHistoryUnionExtras=true; }
    }
  }
  const laterUnknown=Boolean(evidence && revisions.some(r=>(r.observations??[]).some(o=>
    time(o.observed_at)>time(evidence.at) && ['series','title','cover_url','raw_meta'].every(k=>o.omitted_fields?.includes(k)))));
  return { current:current.value??null, unionItems, hasHistoryUnionExtras, at:evidence?.at??null,
    evidence:evidence?.observation??null, laterUnknown, diagnostics };
}

/** Merge own series snapshots and direct 1-hop incoming references; latest version wins per Douban ID. */
export function seriesNavigation(marks, paths) {
  const byKey=new Map(marks.map(m=>[`${m.medium}:${m.subjectId}`,m]));
  const incoming=new Map();
  for (const m of marks) {
    const source=`${m.medium}:${m.subjectId}`;
    if (!paths.has(source) || !m.series?.current || !m.series.at) continue;
    for (const item of m.series.current.items) {
      const key=keyOf(item); if (key===source || !paths.has(key)) continue;
      if (!incoming.has(key)) incoming.set(key,[]);
      incoming.get(key).push({ source, title:m.title??`作品 ${m.subjectId}`, at:item.at??m.series.at, path:paths.get(source) });
    }
  }
  const out=new Map();
  for (const m of marks) {
    const key=`${m.medium}:${m.subjectId}`;
    const hasInvalidLatest=Boolean(m.series && !m.series.current && m.series.diagnostics?.length);
    if (!m.series && !incoming.has(key)) continue;
    const merged=new Map();
    if (!hasInvalidLatest) {
      for (const item of m.series?.unionItems??[]) {
        if (keyOf(item)===key) continue;
        merged.set(keyOf(item),{ ...item, at:item.at??m.series?.at??null });
      }
    }
    let addedByIncoming=false, unionAt=m.series?.at??null;
    const incList=[...(incoming.get(key)??[])].sort((a,b)=>(time(a.at)-time(b.at))||compareText(a.source,b.source));
    if (!hasInvalidLatest) {
      for (const inc of incList) {
        if (inc.at && (!unionAt || time(inc.at)>time(unionAt))) unionAt=inc.at;
        if (!merged.has(inc.source)) {
          addedByIncoming=true;
          merged.set(inc.source,{ medium:'movie', id:inc.source.split(':')[1], title:inc.title, season_label:null, at:inc.at });
        } else {
          const prev=merged.get(inc.source);
          if (inc.at && (!prev.at || time(inc.at)>=time(prev.at))) {
            merged.set(inc.source,{ ...prev, title:inc.title??prev.title, at:inc.at });
          }
        }
      }
    }
    const items=[];
    for (const [k,item] of merged) {
      const dest=paths.has(k)?byKey.get(k):null;
      items.push({ ...item, title:dest?.title??item.title??`作品 ${item.id}`,
        path:dest?paths.get(k):null, status:dest?.status??null, rating:dest?.rating??null });
    }
    out.set(key,{ ...m.series, current:m.series?.current??null,
      hasUnionExtras:Boolean(m.series?.hasHistoryUnionExtras || addedByIncoming), unionAt, items });
  }
  return out;
}
