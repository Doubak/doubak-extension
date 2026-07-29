#!/usr/bin/env node
/**
 * 拿真实档案跑一遍分类器，看它判得对不对。
 *
 *     node tools/classify-archive.mjs <档案目录> [--verdict login] [--limit 50]
 *
 * ## 为什么需要这个
 *
 * 单元测试用的是合成夹具——结构照着真实页面写，但终究是我写的，它只能证明
 * 「分类器符合我对页面的理解」。真实档案里有一批**无法主动制造**的场景：
 * 会话过期的登录页、零字节响应、被审查抑制的中段空洞、跨年的 markup 漂移，
 * 以及最关键的一组——条目数同为 0 的越界终止页与登录页。
 *
 * 这些场景没法靠故意触发豆瓣风控来复现，而那正是这个项目要不惜代价避免的事。
 * 档案里现成就有，等于白捡。
 *
 * ## 隐私
 *
 * 本工具**只读不写**，不复制任何内容，输出里只有文件名、判定与统计。
 * 真实档案是个人数据，不进仓库；这个工具在本地对着它跑。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { classifyResponse, RollingSize, ROUTE_PROFILES } from '../src/crawl/classifier.js';

/** 从前代工具的文件名推断路线。 */
function routeOf(filename) {
  if (filename.includes('_broadcast_')) return 'broadcast.timeline';
  if (/_(movie|book|music|game|drama)_/.test(filename)) return 'interest.list';
  return null;
}

/** 前代工具没有记录最终 URL，这里按文件名回推一个。 */
function urlOf(filename, route) {
  return route === 'broadcast.timeline'
    ? 'https://www.douban.com/people/example/statuses?p=1'
    : 'https://movie.douban.com/people/example/collect?start=0';
}

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('用法: node tools/classify-archive.mjs <档案目录> [--verdict X] [--limit N]');
    process.exit(2);
  }
  const wantVerdict = argValue('--verdict');
  const limit = Number(argValue('--limit') ?? Infinity);

  const files = (await readdir(dir)).filter((f) => f.endsWith('.html')).sort();

  /** @type {Map<string, RollingSize>} */
  const rolling = new Map();
  /** @type {Record<string, number>} */
  const tally = {};
  /** @type {Array<{file: string, verdict: string|null, items: number|null, bytes: number, reasons: string[]}>} */
  const interesting = [];

  let scanned = 0;
  for (const file of files) {
    const route = routeOf(file);
    if (!route) continue;

    const full = path.join(dir, file);
    const bytes = (await stat(full)).size;
    const body = await readFile(full, 'utf-8');

    if (!rolling.has(route)) rolling.set(route, new RollingSize());
    const stats = rolling.get(route).stats();

    const r = classifyResponse({
      finalUrl: urlOf(file, route),
      status: 200, // 前代没记状态码；真实档案里这些都是 200——这正是问题所在
      bodyText: body,
      route: ROUTE_PROFILES[route],
      sizeStats: stats,
    });

    const key = r.verdict ?? '(判不出来)';
    tally[key] = (tally[key] ?? 0) + 1;

    // 只把正常页喂进体积基线，免得封锁页把基线拉低
    if (r.verdict === 'ok') rolling.get(route).add(body.length);

    const notable = r.verdict !== 'ok' || r.itemCount === 0;
    if (notable && (!wantVerdict || key === wantVerdict) && interesting.length < limit) {
      interesting.push({ file, verdict: r.verdict, items: r.itemCount, bytes, reasons: r.reasons });
    }
    scanned += 1;
  }

  console.log(`扫描 ${scanned} 个文件（${dir}）\n`);
  console.log('判定分布：');
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(k).padEnd(14)} ${v}`);
  }

  if (interesting.length) {
    console.log(`\n值得看的（非 ok，或条目数为 0）：`);
    for (const it of interesting) {
      console.log(`\n  ${it.file}`);
      console.log(`    判定 ${it.verdict ?? '(判不出来)'} · 条目 ${it.items} · ${it.bytes} 字节`);
      for (const reason of it.reasons) console.log(`    · ${reason}`);
    }
  }
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

await main();
