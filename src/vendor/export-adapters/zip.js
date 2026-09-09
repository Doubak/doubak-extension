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

/**
 * CRC-32，**可以分块喂**。
 *
 * 流式那条路必须逐块算——整份数据从来不会同时在内存里，而这正是它存在的理由。
 *
 * @param {Uint8Array} buf @param {number} [seed] 上一块算完的中间值
 * @returns {number} 中间值；最后一块之后用 `crcFinal()` 收尾
 */
function crc32Update(buf, seed = -1) {
  let c = seed;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c;
}

/** @param {number} c @returns {number} */
const crcFinal = (c) => (c ^ -1) >>> 0;

/** @param {Uint8Array} buf @returns {number} */
function crc32(buf) {
  return crcFinal(crc32Update(buf));
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
 * 一边算一边往外吐的 ZIP 写出器。
 *
 * ## 为什么需要它，而不是 `zip()` 就够了
 *
 * `zip()` 把整个压缩包在内存里拼出来再返回。给 NeoDB 那个包（几 MB 的 NDJSON）
 * 完全够用，但**档案导出是几百 MB**——一份真实档案 619 MB，单个段文件就有 159 MB。
 * 在浏览器里攒一个 619 MB 的 `Uint8Array`，是这个项目从第一天起就写着不许做的事
 * （「绝不在内存里拼一个巨大的 Blob」）。
 *
 * ## 为什么是给 `zip.js` 加一个入口，不是另写一个写出器
 *
 * 「两个 zip 写出器意味着『NeoDB 收不收得下』要验两遍，而其中一遍多半没人验」
 * ——这句话就写在这个文件开头。所以 `zip()` 现在是**建立在这个类之上的**薄薄一层：
 * 格式只有一份实现，两条路必然一致。
 *
 * ## 大成员怎么做到不进内存：数据描述符
 *
 * ZIP 的本地头要求在**正文之前**写下 CRC 与压缩后长度——而流式的时候两者都还不知道。
 * 标准给了出路：通用标志位第 3 位置 1，本地头里那三个字段写 0，正文之后再补一个
 * **数据描述符**（`PK\x07\x08` + crc + 压缩长 + 原长）。中央目录里写真值。
 * 这是 1989 年就在的机制，`unzip`、macOS 的归档工具、Windows 资源管理器都认
 * ——测试里拿系统的 `unzip -t` 验过，那才是判据，不是我们自己的读回器。
 *
 * 走这条路的成员一律**按「存储」写、不压缩**。判据不是省事：档案里的大文件是
 * `.warc.gz`，**已经压过了**，再 deflate 一遍只会更慢、更大（`zip()` 那边早就有
 * 「压完更大就存储」的回退，这里只是把结论提前）。
 */
export class ZipWriter {
  /**
   * @param {object} opts
   * @param {(chunk: Uint8Array) => void | Promise<void>} opts.write 把字节交出去
   * @param {(b: Uint8Array) => Uint8Array | Promise<Uint8Array>} [opts.deflateRaw]
   *   只有整块写入的成员才用得上。不给的话所有成员按「存储」写。
   */
  constructor({ write, deflateRaw }) {
    if (typeof write !== 'function') throw new Error('ZipWriter 需要一个 write');
    this._write = write;
    this._deflateRaw = deflateRaw;
    /** @type {Array<{name: Uint8Array, method: number, crc: number, csize: number, usize: number, offset: number, streamed: boolean}>} */
    this._entries = [];
    this._offset = 0;
    this._names = new Set();
  }

  /** @param {Uint8Array} bytes */
  async _emit(bytes) {
    await this._write(bytes);
    this._offset += bytes.length;
  }

  /**
   * 加一个成员。
   *
   * @param {string} name zip 内的相对路径
   * @param {Uint8Array | AsyncIterable<Uint8Array> | Iterable<Uint8Array>} source
   *   给 `Uint8Array` 就整块处理（会尝试压缩）；给可迭代的块就走流式（存储 + 数据描述符）。
   */
  async add(name, source) {
    // 重名在 zip 里不是错误，但**解开之后后一个会盖掉前一个**——而这正是档案导出
    // 最不能出的事。响亮地拒绝，别等到用户解压之后才发现少了东西。
    if (this._names.has(name)) throw new Error(`zip 里出现了重复的成员名：${name}`);
    this._names.add(name);

    if (source instanceof Uint8Array) return this._addWhole(name, source);
    return this._addStreamed(name, source);
  }

  /** @param {string} name @param {Uint8Array} data */
  async _addWhole(name, data) {
    const nameBuf = enc.encode(name);
    let body = data;
    let method = 0;
    if (this._deflateRaw) {
      const deflated = await this._deflateRaw(data);
      // 压完反而更大的时候按「存储」写。小 CSV 上真的会发生。
      if (deflated.length < data.length) { body = deflated; method = 8; }
    }
    const crc = crc32(data);
    const offset = this._offset;
    await this._emit(localHeader(nameBuf, method, crc, body.length, data.length, false));
    await this._emit(nameBuf);
    await this._emit(body);
    this._entries.push({
      name: nameBuf, method, crc, csize: body.length, usize: data.length, offset, streamed: false,
    });
  }

  /**
   * 开一个成员，**由调用方一块一块往里推**。
   *
   * 这是流式那条路的原语，`add()` 收可迭代对象的那半边就建立在它上面。
   * 两种形状都要有，是因为两边的调用方天生不同向：导出那条路是「写出器把字节推给
   * 我们」（`{write, close}`，见扩展的 `bundle/exporter.js`），而循环遍历是拉。
   * 只留拉的那一半，就得在中间架一个带背压的队列——**而那是纯粹为了形状而加的一层
   * 会出错的东西**。
   *
   * @param {string} name
   * @returns {Promise<{write: (chunk: Uint8Array) => Promise<void>, close: () => Promise<void>}>}
   */
  async beginMember(name) {
    if (this._names.has(name)) throw new Error(`zip 里出现了重复的成员名：${name}`);
    this._names.add(name);

    const nameBuf = enc.encode(name);
    const offset = this._offset;
    // 本地头里三个字段先写 0，标志位第 3 位置 1，正文之后补数据描述符。
    await this._emit(localHeader(nameBuf, 0, 0, 0, 0, true));
    await this._emit(nameBuf);

    let crc = -1;
    let size = 0;
    let closed = false;

    return {
      write: async (chunk) => {
        if (closed) throw new Error(`${name} 已经收尾了，不能再写`);
        if (!(chunk instanceof Uint8Array)) throw new Error(`${name} 的分块不是 Uint8Array`);
        crc = crc32Update(chunk, crc);
        size += chunk.length;
        await this._emit(chunk);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        const finalCrc = crcFinal(crc);
        const dd = header(16);
        dd.u32(0, 0x08074b50);
        dd.u32(4, finalCrc);
        dd.u32(8, size);
        dd.u32(12, size);
        await this._emit(dd.bytes);
        this._entries.push({
          name: nameBuf, method: 0, crc: finalCrc, csize: size, usize: size, offset, streamed: true,
        });
      },
    };
  }

  /** @param {string} name @param {AsyncIterable<Uint8Array> | Iterable<Uint8Array>} chunks */
  async _addStreamed(name, chunks) {
    // `add()` 已经登记过名字了，这里要让 `beginMember` 自己去登记。
    this._names.delete(name);
    const m = await this.beginMember(name);
    for await (const chunk of chunks) await m.write(chunk);
    await m.close();
  }

  /** 写中央目录与结尾。**调用之后不能再 add。** */
  async finish() {
    const start = this._offset;
    for (const e of this._entries) {
      const central = header(46);
      central.u32(0, 0x02014b50);
      central.u16(4, 20); // version made by
      central.u16(6, 20); // version needed
      central.u16(8, e.streamed ? 0x0808 : 0x0800); // UTF-8，流式的再加数据描述符位
      central.u16(10, e.method);
      central.u16(12, DOS_TIME);
      central.u16(14, DOS_DATE);
      central.u32(16, e.crc);
      central.u32(20, e.csize);
      central.u32(24, e.usize);
      central.u16(28, e.name.length);
      central.u32(38, 0); // external attrs
      central.u32(42, e.offset);
      await this._emit(central.bytes);
      await this._emit(e.name);
    }
    const dirBytes = this._offset - start;

    // **4 GB 是这个格式的天花板**（ZIP64 才能越过它）。悄悄写出一个坏 zip 是最差的
    // 结果——用户以为导出成功了，几个月后才发现解不开，而那时原档案可能已经删了。
    if (start > 0xffffffff || dirBytes > 0xffffffff || this._entries.length > 0xffff) {
      throw new Error(
        `这个 zip 超出了 ZIP 格式的上限（${this._entries.length} 个成员 / ${start} 字节）。`
        + '需要 ZIP64，而这里还没有实现它——请分批导出。',
      );
    }

    const end = header(22);
    end.u32(0, 0x06054b50);
    end.u16(8, this._entries.length);
    end.u16(10, this._entries.length);
    end.u32(12, dirBytes);
    end.u32(16, start);
    await this._emit(end.bytes);
  }
}

/**
 * 一个成员的本地头。两条路共用。
 *
 * @param {Uint8Array} name @param {number} method @param {number} crc
 * @param {number} csize @param {number} usize @param {boolean} streamed
 */
function localHeader(name, method, crc, csize, usize, streamed) {
  const local = header(30);
  local.u32(0, 0x04034b50);
  local.u16(4, 20); // version needed
  // 0x0800 = 文件名是 UTF-8；0x0008 = 正文之后跟数据描述符
  local.u16(6, streamed ? 0x0808 : 0x0800);
  local.u16(8, method);
  local.u16(10, DOS_TIME);
  local.u16(12, DOS_DATE);
  local.u32(14, crc);
  local.u32(18, csize);
  local.u32(22, usize);
  local.u16(26, name.length);
  local.u16(28, 0); // extra
  return local.bytes;
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
  const parts = [];
  const w = new ZipWriter({ write: (c) => { parts.push(c); }, deflateRaw: codec.deflateRaw });
  for (const file of files) await w.add(file.name, enc.encode(file.text));
  await w.finish();
  return concat(parts);
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
