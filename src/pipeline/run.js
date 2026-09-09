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
import { canonicalShape } from '../vendor/export-adapters/record.js';
import { OpfsBundleSource } from './opfs-bundle-source.js';

/**
 * 取消就抛，`name` 与解析器那边一致。
 *
 * **不从 vendor 里 import 它**：那是 `parse.js` 的内部函数，不在导出面上。抄这四行
 * 比把一个内部函数变成公开接口便宜——而两边一旦不一致，症状是界面把一次主动取消
 * 显示成一张红色的「导出失败」，测试钉着这一条。
 *
 * @param {AbortSignal} [signal]
 */
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const e = new Error('已取消');
  e.name = 'AbortError';
  throw e;
}

/**
 * 解析扩展存储里的全部档案。
 *
 * @param {object} opts
 * @param {Array<{bundleId: string, dir: string, manifest: object|null}>} opts.entries
 *   `scanBundleDirs()` 的产物
 * @param {(entry: object) => object} opts.openStore  entry → 一个能 exists/read 的 store
 * @param {(p: {phase: string, done: number, total: number, note?: string}) => void} [opts.onProgress]
 * @param {boolean} [opts.ignoreWarnings] 只放行「混了多个账号」，且照样写进 warnings
 * @param {AbortSignal} [opts.signal] 用户按了「停下」。逐页那个循环下一轮就抛
 *   `AbortError`，产出全部丢弃——canonical 只活在内存里，所以取消不留半份东西。
 * @returns {Promise<{data: object, sources: object[]}>} `data` 是 `parse()` 的产出，外加 `subjectOf` / `account` /
 *   `multiRevisionMarks`——导出适配器要的是 `loadCanonical()` 那个形状，而它读的是
 *   目录，这边没有目录可读。
 */
export async function parseLibrary({
  entries, openStore, onProgress, ignoreWarnings = false, signal,
}) {
  if (!entries.length) throw new Error('扩展里一份档案都没有');

  // **按档案编号升序喂进去，与命令行那边逐字一致**（`bundle-source.js` 的 `openAll`
  // 结尾那句 `.sort((a, b) => a.bundleId < b.bundleId ? -1 : 1)`）。
  //
  // 结论与顺序无关——那是解析器的既有性质，有测试钉着。但**产出的行顺序跟着插入
  // 顺序走**，而插入顺序就是这里的喂入顺序。传进来的 `entries` 排的是**界面的序**：
  // `listBundleDirs()` 是 `.sort().reverse()`（选择器要最新的在最上面），
  // `entriesFor()` 又按账号分了组。于是同一批档案，命令行与扩展导出的
  // `journal.ndjson` 内容一模一样、行序完全不同。
  //
  // 实测（2026-09-09，同一批 28 份真实档案）：内容逐条相同（两边独有的行各 0 条），
  // 而保持原序逐行比有 27636 行对不上。**这不是「谁对谁错」，两份都对**——坏掉的是
  // 「同样的档案产出同样的字节」，而这个项目正是靠读 diff 确认「这次只改了该改的」。
  //
  // 排序放在这儿而不是调用方：调用方排的是给人看的序，两件事在同一个数组上，
  // 而下一个调用方不会知道还得再排一次。**界面的序到这里为止。**
  const ordered = [...entries].sort((a, b) => (a.bundleId < b.bundleId ? -1 : 1));

  onProgress?.({ phase: 'open', done: 0, total: ordered.length });
  const sources = [];
  for (const [i, entry] of ordered.entries()) {
    // **打开这一段也要能停。** 二十几份档案，每份都要把 index 读进来解析（一份真实
    // 档案九千多行），所以「还没开始解析」不等于「按了停就立刻停」。
    throwIfAborted(signal);
    sources.push(await OpfsBundleSource.open({ store: openStore(entry), entry }));
    onProgress?.({ phase: 'open', done: i + 1, total: ordered.length, note: entry.bundleId });
  }

  const out = await parse(sources, {
    ignoreWarnings,
    signal,
    onProgress: (p) => onProgress?.({ phase: 'parse', done: p.done, total: p.total }),
  });

  // **sources 一并返回**：Markdown 那一路还要用它们去取图片字节，而重新打开
  // 一遍意味着 index 再解析一次（一份真实档案九千多行）。
  return { data: withCanonicalShape(out), sources };
}

/**
 * 把 `parse()` 的产出补成 `loadCanonical()` 的形状。
 *
 * **这里已经不再自己算了。** 那几行（`subjectOf` / `multiRevisionMarks` /
 * `account` / 「删掉再重标并成一条」）全是纯计算，属于「字节是什么意思」那一半，
 * 而那一半只能有一份实现——所以它们在 `vendor/export-adapters/record.js` 的
 * `canonicalShape()` 里，命令行的 `loadCanonical()` 调的是同一个函数。
 *
 * 原来这里是照着那边抄的一份，注释还写着「照抄它的定义，不要另发明」。
 * **2026-09-07 就漂了**：那边加了删掉再重标的合并，这边没有，于是同一份档案从
 * 扩展导出会多一条 `ShelfMember`（实测《盗梦空间》2 条），而且不报错、包照样生成、
 * 导入照样成功——NeoDB 上那个作品的书架条目由文件里的先后决定。一句注释拦不住这个，
 * byte-copy 的 vendor 检查拦得住（两边 CI 都跑）。
 *
 * 留着这个函数只为一件事：**名字是这一侧的词汇**，而且调用点不必知道形状逻辑
 * 搬去了哪儿。
 *
 * @param {object} out
 */
export function withCanonicalShape(out) {
  return canonicalShape(out);
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
