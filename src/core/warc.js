/**
 * WARC 记录构造。
 *
 * 规范：doubak-data-specs/bundle/v1/SPEC.md §4
 *
 * 两条硬约束：
 *
 * 1. **WARC 保持原味。** 不加任何私有扩展头——pywb 与 ReplayWeb.page 必须
 *    能不加改造地打开这些段文件。所有 doubak 专有元数据一律放 index.ndjson。
 *
 * 2. **每条记录压成独立的 gzip member。** 这样每条记录可按偏移量单独定位与
 *    解压，并且撕裂的文件尾部可被检测（崩溃恢复靠这个性质）。多个 member
 *    拼接后仍是合法的 .gz，既能整体读也能单条读。
 *
 * ## 为什么只写 response 记录，不写 request 记录
 *
 * WARC 允许把请求也记下来（`WARC-Type: request`），乍看更完整。但我们的
 * 请求头里带着**用户的 Cookie**——而 bundle 是要导出、甚至可能公开的。
 * 把会话凭据写进一份准备分享出去的档案，是不可接受的。
 *
 * 请求侧真正有归档价值的信息（URL、时间、为什么抓）已经在 index.ndjson 里
 * 了，所以这里没有损失。
 */

const CRLF = '\r\n';
const encoder = new TextEncoder();

/** @param {...Uint8Array} parts */
function concatBytes(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** @param {string} s */
function utf8(s) {
  return encoder.encode(s);
}

/**
 * WARC 的日期格式：UTC，秒级，形如 `2026-07-28T02:15:00Z`。
 *
 * 注意这与 index.ndjson 里的 `observed_at` 不是一回事——那个要求带显式
 * 本地偏移量。WARC 头这里用 UTC 是 WARC 规范的要求。
 *
 * @param {Date} date
 */
export function warcDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('无效的 Date');
  }
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 构造一条 WARC 记录的字节。
 *
 * @param {object} opts
 * @param {string} opts.type              WARC-Type，如 'response' / 'warcinfo'
 * @param {string} opts.recordId          `urn:uuid:...`（不带尖括号，本函数负责加）
 * @param {Date} opts.date
 * @param {Uint8Array} opts.block         记录体
 * @param {string} [opts.contentType]
 * @param {string} [opts.targetUri]
 * @param {[string, string][]} [opts.headers]  其余 WARC 头，按给定顺序输出
 * @returns {Uint8Array}
 */
export function buildWarcRecord({
  type,
  recordId,
  date,
  block,
  contentType,
  targetUri,
  headers = [],
}) {
  if (!type) throw new Error('缺少 WARC-Type');
  if (!recordId?.startsWith('urn:uuid:')) {
    throw new Error(`WARC-Record-ID 必须是 urn:uuid 形式: ${recordId}`);
  }
  if (!(block instanceof Uint8Array)) throw new Error('block 必须是 Uint8Array');

  /** @type {[string, string][]} */
  const all = [
    ['WARC-Type', type],
    // WARC 规范要求记录 ID 用尖括号包裹。index.ndjson 里存的是不带尖括号的裸 URI。
    ['WARC-Record-ID', `<${recordId}>`],
    ['WARC-Date', warcDate(date)],
  ];
  if (targetUri) all.push(['WARC-Target-URI', targetUri]);
  all.push(...headers);
  if (contentType) all.push(['Content-Type', contentType]);

  // Content-Length 必须是【字节数】而不是字符数。中文内容一个字符占三个
  // 字节，用 string.length 会让整个段文件从这条记录起全部错位。
  all.push(['Content-Length', String(block.length)]);

  let head = `WARC/1.1${CRLF}`;
  for (const [k, v] of all) {
    if (/[\r\n]/.test(v)) throw new Error(`WARC 头 ${k} 的值不得含换行`);
    head += `${k}: ${v}${CRLF}`;
  }
  head += CRLF;

  // 记录以两个 CRLF 结尾，这是 WARC 规定的记录分隔。
  return concatBytes(utf8(head), block, utf8(CRLF + CRLF));
}

/**
 * 构造 HTTP 响应块（`application/http;msgtype=response` 的内容）。
 *
 * @param {object} opts
 * @param {string} opts.statusLine  如 `HTTP/1.1 200 OK`
 * @param {[string, string][]} opts.headers
 * @param {Uint8Array} opts.body
 * @returns {Uint8Array}
 */
export function buildHttpResponseBlock({ statusLine, headers, body }) {
  if (!(body instanceof Uint8Array)) throw new Error('body 必须是 Uint8Array');
  let head = `${statusLine}${CRLF}`;
  for (const [k, v] of headers) {
    if (/[\r\n]/.test(v)) throw new Error(`HTTP 头 ${k} 的值不得含换行`);
    head += `${k}: ${v}${CRLF}`;
  }
  head += CRLF;
  return concatBytes(utf8(head), body);
}

/**
 * 段文件开头的 warcinfo 记录。
 *
 * @param {object} opts
 * @param {string} opts.recordId
 * @param {Date} opts.date
 * @param {string} opts.filename    本段的文件名
 * @param {string} opts.bundleId
 * @param {string} opts.software    如 `doubak-extension/0.0.1`
 * @param {string} [opts.specUrl]
 * @returns {Uint8Array}
 */
export function buildWarcinfoRecord({
  recordId,
  date,
  filename,
  bundleId,
  software,
  specUrl = 'https://spec.doubak.com/bundle/v1/',
}) {
  const fields =
    `software: ${software}${CRLF}` +
    `format: WARC File Format 1.1${CRLF}` +
    `isPartOf: ${bundleId}${CRLF}` +
    `conformsTo: ${specUrl}${CRLF}`;

  return buildWarcRecord({
    type: 'warcinfo',
    recordId,
    date,
    block: utf8(fields),
    contentType: 'application/warc-fields',
    headers: [['WARC-Filename', filename]],
  });
}

/**
 * 把一段字节压成【独立的 gzip member】。
 *
 * 这是段文件的核心性质。不要改成「整个段文件压一次」——那样就无法按偏移量
 * 单独取出一条记录，崩溃后也无法检测撕裂的尾部。
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function gzipMember(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('gzipMember 需要 Uint8Array');
  return pump(new CompressionStream('gzip'), bytes);
}

/**
 * 解开一个 gzip member。
 *
 * 崩溃恢复会拿**可能已经撕裂**的字节来试探，所以这个函数必须在遇到坏数据时
 * 干净地 reject，而不是留下一个未处理的 rejection。
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function gunzip(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('gunzip 需要 Uint8Array');
  return pump(new DecompressionStream('gzip'), bytes);
}

/**
 * 把字节喂进一个转换流并收集输出。
 *
 * 写入侧的 promise 必须显式吞掉：流出错时 `write()` 与 `close()` 都会
 * reject，若放任不管就会产生 unhandled rejection——在 service worker 里
 * 那是会把整个 worker 拖垮的。真正的错误由读取侧统一报出。
 *
 * @param {TransformStream<Uint8Array, Uint8Array>} stream
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
async function pump(stream, bytes) {
  const writer = stream.writable.getWriter();
  const noop = () => {};
  writer.write(bytes).catch(noop);
  writer.close().catch(noop);
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}
