/* 【自动同步，请勿手改】来自 doubak-export-adapters 的 src/zip.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/**
 * ZIP 写出器，只用 `Uint8Array` 与 `DataView`，一个内建模块都不碰。
 *
 * ## 为什么不装一个 zip 库
 *
 * NeoDB 的导入收的是一个 zip。整个项目的前提是「一个陌生人在 2040 年还能把它重建
 * 出来」，而 ZIP 的存储格式是 1989 年定死的、公开的、每个操作系统都自带解压——
 * **它跟 WARC 是同一类东西：几段定长头，加上负载。**
 *
 * 这跟站点生成器不把 Hugo 收成 npm 依赖是同一条线。
 *
 * ## 为什么压缩函数是传进来的
 *
 * 这个文件要在两个地方跑：Node 里的命令行，和浏览器扩展里的「导出」页。两边都有
 * 现成的 raw deflate，但**一个同步一个异步**——`node:zlib` 的 `deflateRawSync`
 * 与浏览器的 `CompressionStream('deflate-raw')`。所以压缩不写死在这里，由调用方
 * 给一个 `(Uint8Array) => Promise<Uint8Array>`。
 *
 * Node 那一路的绑定在 `zip-node.js`，扩展那一路在扩展仓库里。**格式这一半只有
 * 一份实现**——两边各写一个 zip 写出器的话，「NeoDB 收不收得下」这件事就要验两遍，
 * 而其中一遍多半没人验。
 *
 * ## 时间戳一律写 1980-01-01
 *
 * 同样一份 canonical 导两次，产物应当逐字节相同——扩展打包脚本已经是这么做的。
 * 带上真实时间的话，「这次导出跟上次有什么不一样」就永远答不了，因为**每次都不一样**。
 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

/** @param {Uint8Array} buf @returns {number} */
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// 1980-01-01 00:00:00，DOS 时间戳能表示的最小值。
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** @param {Uint8Array[]} parts */
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** 定长小端头的写入器。`Buffer.writeUInt32LE` 的替代，两边都有。 */
function header(size) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  return {
    bytes,
    u16: (at, v) => view.setUint16(at, v, true),
    u32: (at, v) => view.setUint32(at, v, true),
  };
}

/**
 * 打一个 zip。
 *
 * @param {{name: string, text: string}[]} files 名字是 zip 内的相对路径
 * @param {{deflateRaw: (b: Uint8Array) => Uint8Array | Promise<Uint8Array>}} codec
 * @returns {Promise<Uint8Array>}
 */
export async function zip(files, codec) {
  if (!codec?.deflateRaw) throw new Error('zip() 需要一个 deflateRaw —— 见 zip-node.js');

  /** @type {Uint8Array[]} */
  const locals = [];
  /** @type {Uint8Array[]} */
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = enc.encode(file.name);
    const data = enc.encode(file.text);
    const deflated = await codec.deflateRaw(data);
    // 压完反而更大的时候按「存储」写。小 CSV 上真的会发生。
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(data);

    const local = header(30);
    local.u32(0, 0x04034b50);
    local.u16(4, 20); // version needed
    local.u16(6, 0x0800); // 文件名是 UTF-8
    local.u16(8, method);
    local.u16(10, DOS_TIME);
    local.u16(12, DOS_DATE);
    local.u32(14, crc);
    local.u32(18, body.length);
    local.u32(22, data.length);
    local.u16(26, name.length);
    local.u16(28, 0); // extra
    locals.push(local.bytes, name, body);

    const central = header(46);
    central.u32(0, 0x02014b50);
    central.u16(4, 20); // version made by
    central.u16(6, 20); // version needed
    central.u16(8, 0x0800);
    central.u16(10, method);
    central.u16(12, DOS_TIME);
    central.u16(14, DOS_DATE);
    central.u32(16, crc);
    central.u32(20, body.length);
    central.u32(24, data.length);
    central.u16(28, name.length);
    central.u32(38, 0); // external attrs
    central.u32(42, offset);
    centrals.push(central.bytes, name);

    offset += local.bytes.length + name.length + body.length;
  }

  const dir = concat(centrals);
  const end = header(22);
  end.u32(0, 0x06054b50);
  end.u16(8, files.length);
  end.u16(10, files.length);
  end.u32(12, dir.length);
  end.u32(16, offset);

  return concat([...locals, dir, end.bytes]);
}

/**
 * 把 zip 拆回来。**只认这个写出器会写出的那两种压缩方式**，不是一个通用解压器。
 *
 * 它存在是为了「上传之前先看看里面到底是什么」——`tools/check-export.mjs` 用它，
 * 测试也用它。写出器和读回器同源确实证明不了太多，所以真正的判据在测试里：
 * 系统的 `unzip -t` 认不认。
 *
 * @param {Uint8Array} buf
 * @param {{inflateRaw: (b: Uint8Array) => Uint8Array | Promise<Uint8Array>}} codec
 * @returns {Promise<Map<string, string>>} 文件名 → 内容
 */
export async function unzip(buf, codec) {
  if (!codec?.inflateRaw) throw new Error('unzip() 需要一个 inflateRaw —— 见 zip-node.js');

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Map();
  let at = 0;
  while (at + 30 <= buf.length && view.getUint32(at, true) === 0x04034b50) {
    const method = view.getUint16(at + 8, true);
    const compressed = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const extraLen = view.getUint16(at + 28, true);
    const name = dec.decode(buf.subarray(at + 30, at + 30 + nameLen));
    const start = at + 30 + nameLen + extraLen;
    const body = buf.subarray(start, start + compressed);
    if (method !== 0 && method !== 8) throw new Error(`${name} 用了不认识的压缩方式 ${method}`);
    out.set(name, dec.decode(method === 8 ? await codec.inflateRaw(body) : body));
    at = start + compressed;
  }
  return out;
}
