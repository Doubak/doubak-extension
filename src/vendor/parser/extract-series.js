/* 【自动同步，请勿手改】来自 doubak-data-parser 的 src/extract-series.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/** Read only the evidenced data literal; never execute archived JavaScript. */
export function movieSubject(url, base) {
  try {
    const u = new URL(url, base);
    if (!['https:', 'http:'].includes(u.protocol) || u.hostname !== 'movie.douban.com'
      || u.port || u.username || u.password) return null;
    return /^\/subject\/(\d+)\/?$/.exec(u.pathname)?.[1] ?? null;
  } catch { return null; }
}

// HTML raw-text elements have different entity rules from visible text. In particular,
// do not decode &quot; in script, or recognize fake scripts in comments/textarea/template.
function* scripts(html) {
  const tags = /<!--[^]*?-->|<![^>]*>|<\/?([a-z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  let template = 0, m;
  while ((m = tags.exec(html))) {
    if (!m[1]) continue;
    const name = m[1].toLowerCase(), closing = /^<\//.test(m[0]);
    if (name === 'template') { template += closing ? -Math.min(template, 1) : 1; continue; }
    if (closing || !['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noscript'].includes(name)) continue;
    const end = new RegExp(`</${name}\\s*>`, 'ig'); end.lastIndex = tags.lastIndex;
    const close = end.exec(html);
    if (!close) return;
    const body = html.slice(tags.lastIndex, close.index);
    tags.lastIndex = end.lastIndex;
    if (name !== 'script' || template) continue;
    const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[0]);
    if (type && !/^(?:text\/javascript|application\/javascript|module)$/i.test(type[1] ?? type[2] ?? type[3])) continue;
    if (/\bsrc\s*=/i.test(m[0])) continue;
    yield body;
  }
}

/** Small lexer: strings/comments are single tokens, so their contents are never code. */
function tokens(text) {
  const out = []; let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (text.startsWith('//', i)) { i = text.indexOf('\n', i + 2); if (i < 0) break; continue; }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2); if (end < 0) throw Error('truncated_comment');
      i = end + 2; continue;
    }
    if (c === '`') throw Error('unsupported_template_literal');
    if (c === '"' || c === "'") {
      const start = i++; let closed = false;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i++] === c) { closed = true; break; }
      }
      if (!closed) throw Error('truncated_string');
      out.push({ kind: 'string', raw: text.slice(start, i) }); continue;
    }
    const word = /^[A-Za-z_$][\w$]*|^\d+(?:\.\d+)?/.exec(text.slice(i));
    if (word) { out.push({ kind: 'word', raw: word[0] }); i += word[0].length; continue; }
    // Unknown slash expressions could be regex literals containing apparent declarations.
    // Reject this script instead of interpreting their contents as configuration.
    if (c === '/') throw Error('unsupported_slash_expression');
    out.push({ kind: 'punct', raw: c }); i++;
  }
  return out;
}
function stringValue(raw) {
  if (raw[0] === '"') return JSON.parse(raw);
  let s = '';
  for (let i = 1; i < raw.length - 1; i++) {
    if (raw[i] !== '\\') { if (/[\r\n]/.test(raw[i])) throw Error('invalid_string'); s += raw[i]; continue; }
    const e = raw[++i];
    if (e === "'" || e === '"' || e === '\\' || e === '/') s += e;
    else if ('bfnrt'.includes(e)) s += { b:'\b', f:'\f', n:'\n', r:'\r', t:'\t' }[e];
    else if (e === 'u' && /^[\da-f]{4}$/i.test(raw.slice(i + 1, i + 5))) { s += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16)); i += 4; }
    else throw Error('unsupported_string_escape');
  }
  return s;
}
// Only data is accepted (no identifiers as values, calls, getters, computed keys or spreads).
function literal(ts, at, depth = 0, jsonOnly = false) {
  if (depth > 32) throw Error('literal_depth_limit');
  const t = ts[at]; if (!t) throw Error('truncated_config');
  if (t.kind === 'string') {
    if (jsonOnly && t.raw[0] !== '"') throw Error('invalid_json_string');
    return [stringValue(t.raw), at + 1];
  }
  if (jsonOnly && ['true', 'false'].includes(t.raw)) return [t.raw === 'true', at + 1];
  if (t.raw === 'null') return [null, at + 1];
  if (/^\d+$/.test(t.raw)) return [Number(t.raw), at + 1];
  if (t.raw !== '{' && t.raw !== '[') throw Error('unsupported_expression');
  const object = t.raw === '{', end = object ? '}' : ']';
  const result = object ? Object.create(null) : []; let i = at + 1;
  while (ts[i]?.raw !== end) {
    let key;
    if (object) {
      const kt = ts[i++]; if (!kt || (kt.kind !== 'string' && !/^[A-Za-z_$][\w$]*$/.test(kt.raw))) throw Error('invalid_key');
      if (jsonOnly && (kt.kind !== 'string' || kt.raw[0] !== '"')) throw Error('invalid_json_key');
      key = kt.kind === 'string' ? stringValue(kt.raw) : kt.raw;
      if (Object.hasOwn(result, key)) throw Error('duplicate_key');
      if (ts[i++]?.raw !== ':') throw Error('unsupported_property');
    }
    const nestedJson = jsonOnly || ['SERIES_OTHER_SUBJECTS', 'SERIES_SEASON_NAMES'].includes(key);
    const start = i;
    const [value, next] = literal(ts, i, depth + 1, nestedJson); i = next;
    // Validate the observed JSON subtrees independently; surrounding _CONFIG is JS data.
    if (nestedJson && !jsonOnly) JSON.parse(ts.slice(start, next).map(t => t.raw).join(' '));
    if (object) result[key] = value; else result.push(value);
    if (ts[i]?.raw === end) break;
    if (ts[i++]?.raw !== ',') throw Error('truncated_config');
    if (jsonOnly && ts[i]?.raw === end) throw Error('invalid_json_trailing_comma');
  }
  return [result, i + 1];
}
function readConfigs(body) {
  const ts = tokens(body), configs = [];
  let depth = 0;
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i].raw;
    if (depth === 0 && (i === 0 || ts[i - 1].raw === ';') && ['var', 'let', 'const'].includes(t) && ts[i + 1]?.raw === '_CONFIG' && ts[i + 2]?.raw === '=') {
      const [value, next] = literal(ts, i + 3);
      if (ts[next] && ![';', 'var', 'let', 'const'].includes(ts[next].raw)) throw Error('unsupported_config_suffix');
      configs.push(value); i = next - 1; continue;
    }
    if (['{', '[', '('].includes(t)) depth++;
    if (['}', ']', ')'].includes(t)) depth--;
  }
  return configs;
}
function seriesUrl(value, base) {
  if (value === '') return null;
  if (typeof value !== 'string') throw Error('invalid_series_url');
  const u = new URL(value, base);
  if (!['https:', 'http:'].includes(u.protocol) || u.hostname !== 'movie.douban.com'
    || u.port || u.username || u.password || !/^\/series\/[A-Za-z0-9]+\/?$/.test(u.pathname)) throw Error('invalid_series_url');
  return u.href;
}
export function extractSeries(html, url) {
  const id = movieSubject(url), diagnostics = [];
  if (!id) return { diagnostics };
  const configs = []; let invalid = false;
  for (const script of scripts(html)) {
    if (!script.includes('_CONFIG') || !/SERIES_OTHER_SUBJECTS|SERIES_SEASON_NAMES/.test(script)) continue;
    try { configs.push(...readConfigs(script)); }
    catch (e) { invalid = true; diagnostics.push(e.message); }
  }
  if (invalid) return { diagnostics };
  if (!configs.length) {
    if (/同系列作品|id\s*=\s*["']series-items["']/.test(html)) diagnostics.push('unrecognized_series_container');
    return { diagnostics };
  }
  try {
    const c = configs[0];
    if (configs.some(x => JSON.stringify(x) !== JSON.stringify(c))) throw Error('conflicting_configs');
    if (c.SUBJECT_ID !== id) throw Error('subject_id_mismatch');
    if (!Array.isArray(c.SERIES_OTHER_SUBJECTS) || !c.SERIES_SEASON_NAMES || typeof c.SERIES_SEASON_NAMES !== 'object'
      || Array.isArray(c.SERIES_SEASON_NAMES) || !c.SERIES || typeof c.SERIES !== 'object') throw Error('missing_series_fields');
    const total = c.SERIES.series_total;
    if (!/^\d+$/.test(String(total)) || !Number.isSafeInteger(Number(total))) throw Error('invalid_total');
    const claimed_total = Number(total), series_url = seriesUrl(c.SERIES.series_url, url);
    const items = [], seen = new Map();
    for (const entry of c.SERIES_OTHER_SUBJECTS) {
      if (!entry || typeof entry.id !== 'string' || !/^\d+$/.test(entry.id)
        || typeof entry.url !== 'string' || movieSubject(entry.url, url) !== entry.id
        || (entry.title != null && typeof entry.title !== 'string')) { diagnostics.push('invalid_member'); continue; }
      const item = { medium: 'movie', id: entry.id, title: entry.title ?? null };
      if (Object.hasOwn(c.SERIES_SEASON_NAMES, entry.id)) {
        const label = c.SERIES_SEASON_NAMES[entry.id];
        if (label === null || typeof label === 'string') item.season_label = label;
        else diagnostics.push('invalid_season_label');
      }
      if (seen.has(item.id)) {
        const prior = seen.get(item.id);
        if (!prior.title) prior.title = item.title;
        else if (item.title && prior.title !== item.title) diagnostics.push('conflicting_member_title');
        continue;
      }
      seen.set(item.id, item); items.push(item);
    }
    if (c.SERIES_OTHER_SUBJECTS.length && !items.length) throw Error('no_readable_members');
    let scope = 'unknown';
    if (!items.length && !diagnostics.length && ((series_url === null && claimed_total === 0) || (series_url && claimed_total === 1))) scope = 'complete';
    else if (!items.length) throw Error('unproven_empty_series');
    else if (diagnostics.length || !series_url || items.length + 1 !== claimed_total || seen.has(id)) {
      scope = 'partial'; diagnostics.push('inconsistent_series_extent');
    } else {
      // SERIES_OTHER_SUBJECTS omits self while series_total counts self, so items.length + 1 === claimed_total confirms completeness.
      scope = 'complete';
    }
    return { value: { kind: 'douban_same_series', source: 'embedded_config', series_url, items, scope, claimed_total, more_url: null }, diagnostics };
  } catch (e) { diagnostics.push(e.message); return { diagnostics }; }
}
