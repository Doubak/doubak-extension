/**
 * **同一批档案，两个宿主要产出同样的字节。**
 *
 * 2026-09-09 拿真实档案对过一次：命令行与 Firefox 导出的 `journal.ndjson`
 * **内容逐条相同**（两边独有的行各 0 条），而**保持原序逐行比有 27636 行对不上**。
 * 两份都对——坏掉的是「同样的档案产出同样的字节」。
 *
 * 成因不是解析器（结论与顺序无关，那有测试钉着），是**喂进去的顺序**：
 *
 *     命令行  openAll()          → `.sort((a,b) => a.bundleId < b.bundleId ? -1 : 1)`  升序
 *     扩展    listBundleDirs()   → `.sort().reverse()`                                 降序
 *
 * 扩展那边是**故意降序的**——选择器要最新的在最上面。所以不能去改它，要在
 * 「界面的序」交给流水线的那个点上排一次。产出的行序跟着插入顺序走，而插入顺序
 * 就是喂入顺序。
 *
 * 为什么值得一条测试：这个项目**靠读 diff 确认「这次只改了该改的」**。行序不稳，
 * 两次导出就没法比——而它不报错，两边的数据也都是对的。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parseLibrary } from '../src/pipeline/run.js';

/** 只记录被打开的顺序；解析到不了那一步（source 是空的），也不需要到。 */
function orderProbe(entries) {
  const opened = [];
  return {
    opened,
    run: () => parseLibrary({
      entries,
      openStore: (e) => {
        opened.push(e.bundleId);
        return {
          async list() { return []; },
          async size() { return 0; },
          async read() { throw new Error('停在这儿就够了'); },
          async exists() { return false; },
        };
      },
    }).catch(() => {}),
  };
}

const ids = [
  '20260909T122911Z-edd363',
  '20260731T043423Z-d40c1d',
  '20260904T093818Z-0484cb',
  '20260801T005010Z-3eef52',
];
const entry = (id) => ({ bundleId: id, dir: `doubak-bundle-${id}`, manifest: null });

describe('喂进流水线的顺序，与命令行逐字一致', () => {
  test('**界面给的是降序，流水线拿到的必须是升序**', async () => {
    // 扩展的 `listBundleDirs()` 是 `.sort().reverse()`（选择器要最新的在最上面），
    // 再经过 `entriesFor()` 按账号分组——传到这儿的顺序是给人看的，不是给流水线的。
    const p = orderProbe([...ids].sort().reverse().map(entry));
    await p.run();
    assert.deepEqual(p.opened, [...ids].sort(), '没有按档案编号升序喂进去');
  });

  test('打乱了也一样 —— 排序是无条件的，不是「顺手对了」', async () => {
    // 只测一种输入顺序的话，输入恰好就是想要的顺序时，删掉排序也全绿。
    // bundle 去重那次栽过同一条：V8 的 sort 稳定、readdir 顺序固定，
    // 于是「决定性」那条测试**不可能失败**。
    for (const seed of [[2, 0, 3, 1], [1, 3, 0, 2], [3, 2, 1, 0]]) {
      const p = orderProbe(seed.map((i) => entry(ids[i])));
      await p.run();
      assert.deepEqual(p.opened, [...ids].sort(), `打乱成 ${seed} 之后顺序不对`);
    }
  });

  test('不改调用方传进来的那个数组 —— 那是界面正在用的清单', async () => {
    // 原地 sort 会把选择器的顺序也一起改掉（最新的不再在最上面），而那是另一件事。
    const given = [...ids].sort().reverse().map(entry);
    const before = given.map((e) => e.bundleId);
    const p = orderProbe(given);
    await p.run();
    assert.deepEqual(given.map((e) => e.bundleId), before, '把调用方的数组原地排了');
  });

  test('**判据与命令行那句逐字一致**，不是各写各的', async () => {
    // 两边各写一个比较器，迟早有一天一个按 bundleId、一个按目录名，
    // 而症状是「同一批档案，两边产出的行序不一样」——正是这条测试要防的东西。
    const mine = await readFile(new URL('../src/pipeline/run.js', import.meta.url), 'utf8');
    const cli = await readFile(new URL('../src/vendor/parser/parse.js', import.meta.url), 'utf8')
      .then(() => readFile(new URL('../../doubak-data-parser/src/bundle-source.js', import.meta.url), 'utf8'))
      .catch(() => null);
    const cmp = /\(a, b\) => \(a\.bundleId < b\.bundleId \? -1 : 1\)/;
    assert.match(mine, cmp, '扩展这边的比较器变了');
    if (cli) assert.match(cli, cmp, '命令行那边的比较器变了 —— 两边现在不一致');
  });
});
