/**
 * 真实档案在哪，以及怎么从里头读一条捕获。
 *
 * 这个仓库里有一批**对着真实档案跑**的测试——它们证明的是「几千页真数据上没有
 * 第五种模板」，合成夹具证明不了这个（合成夹具证明的是我自己写的假设）。真实
 * 档案是私人数据，不进仓库也不进 CI，所以在别处它们会「带原因跳过」。
 *
 * 这一份的存在只为一件事：**路径只写一处。**
 *
 * 起因是路径烂过一次，而且是无声的：档案本来在 `~/downloads/20260806`，后来
 * 归拢进 `~/downloads/exports/`，几处写死的字面量就此全部指空——那批测试从
 * 「跳过」变成**永远跳过**，`npm test` 照样全绿。而永远跳过的检查等于没有。
 *
 * `DOUBAK_ARCHIVE_DIR` 可以指到别处。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** 一堆 bundle 的根目录。 */
export const ARCHIVE = process.env.DOUBAK_ARCHIVE_DIR ?? join(homedir(), 'downloads', 'exports');

/** 里头那份按日期归拢的档案集合（24 份，横跨四个格式版本）。 */
export const ARCHIVE_20260806 = join(ARCHIVE, '20260806');

/** @param {string} name bundle 目录名 @returns {string} */
export const realBundle = (name) => join(ARCHIVE_20260806, name);

/**
 * 读一份真实档案的索引。不在这台机器上就返回 null。
 * @param {string} name bundle 目录名
 * @returns {{dir: string, rows: object[]} | null}
 */
export function openReal(name) {
  const dir = realBundle(name);
  if (!existsSync(dir)) return null;
  const idxName = readdirSync(dir).find((f) => f.startsWith('index-'));
  if (!idxName) return null;
  const rows = readFileSync(join(dir, idxName), 'utf-8')
    .trimEnd().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l));
  return { dir, rows };
}

/**
 * 按 offset 解压一条 WARC 记录，取出 HTTP 正文。
 *
 * **这是测试里的读法，不是产品代码里的读法**——扩展自己读的是 OPFS。放在这儿
 * 是因为原来有三处各写了一遍，而它们只在「怎么读字节」上一样，很容易各自漂。
 *
 * @param {string} dir @param {object} row @returns {string}
 */
export function payloadOf(dir, row) {
  const fd = readFileSync(join(dir, row.segment));
  const raw = gunzipSync(fd.subarray(row.offset, row.offset + row.length));
  const head = raw.indexOf('\r\n\r\n');
  const len = Number(/^Content-Length: (\d+)$/m.exec(raw.subarray(0, head).toString())[1]);
  const block = raw.subarray(head + 4, head + 4 + len);
  return block.subarray(block.indexOf('\r\n\r\n') + 4).toString('utf-8');
}

/**
 * 取一条指定 capture_id 的正文。
 *
 * 有几条测试原来读的是 `~/downloads/` 下手工另存的散页，而那些散页早就没了
 * ——测试于是**永远跳过**。同一张页面本来就在档案里，冻着，跑不掉。
 *
 * @param {string} name bundle 目录名 @param {string} captureId
 * @returns {string | null} 档案不在、或那条不在里头，都是 null
 */
export function readCapture(name, captureId) {
  const b = openReal(name);
  if (!b) return null;
  const row = b.rows.find((r) => r.capture_id === captureId);
  return row ? payloadOf(b.dir, row) : null;
}
