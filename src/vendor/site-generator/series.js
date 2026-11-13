/* 【自动同步，请勿手改】来自 doubak-site-generator 的 src/series.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/** Pure, source-labelled directory observations. No entity merging or network lookups. */
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const keyOf = item => `${item.medium}:${item.id}`;
const time = at => Date.parse(at) || 0;
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
  const history=[]; let prior=null;
  for (const event of events) {
    if (!event.value) { prior=null; continue; }
    if (prior && visible(prior.value)!==visible(event.value)) {
      const before=new Map(prior.value.items.map(i=>[keyOf(i),i]));
      const after=new Map(event.value.items.map(i=>[keyOf(i),i]));
      history.push({ at:event.at, parserChanged:prior.parser!==event.parser,
        conflict:time(prior.at)===time(event.at), partial:event.value.scope==='partial',
        added:event.value.items.filter(i=>!before.has(keyOf(i))),
        removed:prior.value.items.filter(i=>!after.has(keyOf(i))),
        changed:!event.value.items.some(i=>!before.has(keyOf(i))) && !prior.value.items.some(i=>!after.has(keyOf(i))) });
    }
    prior=event;
  }
  const laterUnknown=Boolean(evidence && revisions.some(r=>(r.observations??[]).some(o=>
    time(o.observed_at)>time(evidence.at) && ['series','title','cover_url','raw_meta'].every(k=>o.omitted_fields?.includes(k)))));
  return { current:current.value??null, at:evidence?.at??null, evidence:evidence?.observation??null,
    laterUnknown, history, diagnostics };
}

/** Only actual, filtered output pages can supply destinations or reverse evidence. */
export function seriesNavigation(marks, paths) {
  const byKey=new Map(marks.map(m=>[`${m.medium}:${m.subjectId}`,m]));
  const incoming=new Map();
  for (const m of marks) {
    const source=`${m.medium}:${m.subjectId}`;
    if (!paths.has(source) || !m.series?.current || !m.series.at) continue;
    for (const item of m.series.current.items) {
      const key=keyOf(item); if (key===source || !paths.has(key)) continue;
      if (!incoming.has(key)) incoming.set(key,[]);
      incoming.get(key).push({ source, title:m.title??`作品 ${m.subjectId}`, at:m.series.at, path:paths.get(source) });
    }
  }
  const out=new Map();
  for (const m of marks) {
    const key=`${m.medium}:${m.subjectId}`;
    if (!m.series && !incoming.has(key)) continue;
    out.set(key, { ...m.series, incoming:incoming.get(key)??[],
      items:(m.series?.current?.items??[]).filter(i=>keyOf(i)!==key).map(item=>{
        const dest=paths.has(keyOf(item))?byKey.get(keyOf(item)):null;
        return { ...item, title:dest?.title??item.title??`作品 ${item.id}`,
          path:dest?paths.get(keyOf(item)):null, status:dest?.status??null, rating:dest?.rating??null };
      }) });
  }
  return out;
}
