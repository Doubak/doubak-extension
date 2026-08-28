/**
 * 在浏览器里把整个档案库解析成 canonical。
 *
 * ## 中间产物一律不落盘
 *
 * canonical 只活在内存里，出完文件就扔。理由不是省空间，是**派生数据落了盘就是
 * 第二个真相来源**——面板已经为这件事付过三次代价（清单缓存、用量陈旧、导出后
 * 那句警告不刷新）。而且它本来就是可重算的：捕获还在，重跑一遍就有。
 *
 * 代价是每次导出都要重新解析一遍。实测这是可以接受的，而且**它换来的是「档案是
 * 唯一真相」这条不变量**：删掉所有派生数据、只靠 captures 重建必须能跑通——
 * 解析器就是那条重建路径本身。
 *
 * ## 整个库一起喂，不让用户挑
 *
 * 解析器的规矩：喂一个装着一堆档案的目录，别让用户挑一条链。分叉很常见（删了
 * 重抓、换机器、同一天跑两次增量），而**合并恰好就是并集**——实测两条链分开喂
 * 各得 2940 / 155 个标记，一起喂 2940，修订数一动不动。挑任何一条都会丢东西。
 *
 * 真该拦的是反过来那件事：**一个库里混了两个账号是错误，不是告警**。合并过的
 * canonical 事后拆不开。扩展这边比命令行更容易撞上——导入过别人的档案就够了。
 */

import { parse } from '../vendor/parser/parse.js';
import { OpfsBundleSource } from './opfs-bundle-source.js';

/**
 * 解析扩展存储里的全部档案。
 *
 * @param {object} opts
 * @param {Array<{bundleId: string, dir: string, manifest: object|null}>} opts.entries
 *   `scanBundleDirs()` 的产物
 * @param {(entry: object) => object} opts.openStore  entry → 一个能 exists/read 的 store
 * @param {(p: {phase: string, done: number, total: number, note?: string}) => void} [opts.onProgress]
 * @param {boolean} [opts.ignoreWarnings] 只放行「混了多个账号」，且照样写进 warnings
 * @returns {Promise<{data: object, sources: object[]}>} `data` 是 `parse()` 的产出，外加 `subjectOf` / `account` /
 *   `multiRevisionMarks`——导出适配器要的是 `loadCanonical()` 那个形状，而它读的是
 *   目录，这边没有目录可读。
 */
export async function parseLibrary({ entries, openStore, onProgress, ignoreWarnings = false }) {
  if (!entries.length) throw new Error('扩展里一份档案都没有');

  onProgress?.({ phase: 'open', done: 0, total: entries.length });
  const sources = [];
  for (const [i, entry] of entries.entries()) {
    sources.push(await OpfsBundleSource.open({ store: openStore(entry), entry }));
    onProgress?.({ phase: 'open', done: i + 1, total: entries.length, note: entry.bundleId });
  }

  const out = await parse(sources, {
    ignoreWarnings,
    onProgress: (p) => onProgress?.({ phase: 'parse', done: p.done, total: p.total }),
  });

  // **sources 一并返回**：Markdown 那一路还要用它们去取图片字节，而重新打开
  // 一遍意味着 index 再解析一次（一份真实档案九千多行）。
  return { data: withCanonicalShape(out), sources };
}

/**
 * 把 `parse()` 的产出补成 `loadCanonical()` 的形状。
 *
 * 导出适配器与站点生成器都按后者写的（`subjectOf` / `account` /
 * `multiRevisionMarks`），而那三个字段是**读目录的那个函数**加上去的，不在
 * canonical 文件里。这几行是那段逻辑的等价物——**照抄它的定义，不要另发明**：
 * `subjectOf` 按 `(medium, id)` 定位，因为豆瓣的 subject id 在不同 medium 下
 * 会撞号，只按 id 找会把一本书的又名安到一部电影上。
 *
 * @param {object} out
 */
export function withCanonicalShape(out) {
  const byKey = new Map();
  for (const s of out.subjects) byKey.set(`${s.medium}:${s.id}`, s);

  return {
    ...out,
    subjectOf: (mark) => byKey.get(`${mark.medium}:${mark.subject?.id}`) ?? null,
    multiRevisionMarks: out.marks.filter((m) => (m.revisions?.length ?? 0) > 1).length,
    account: out.marks[0]?.account ?? out.doulists[0]?.account ?? null,
  };
}

/**
 * canonical 的五个 ndjson 文件。
 *
 * 名字与 `loadCanonical` 认的那五个一致——导出的这一份要能直接喂给命令行的解析器
 * 下游（导出适配器、站点生成器），名字对不上就白导了。
 *
 * **空的那几类也写文件。** 「没有豆列」与「这个版本还不解析豆列」是两件事，
 * 而一个空文件说的是前者。
 *
 * @param {object} data
 * @returns {{name: string, text: string}[]}
 */
export function canonicalFiles(data) {
  const nd = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
  return [
    { name: 'marks.ndjson', text: nd(data.marks) },
    { name: 'subjects.ndjson', text: nd(data.subjects) },
    { name: 'broadcasts.ndjson', text: nd(data.broadcasts) },
    { name: 'longform.ndjson', text: nd(data.longform) },
    { name: 'doulists.ndjson', text: nd(data.doulists) },
  ];
}
