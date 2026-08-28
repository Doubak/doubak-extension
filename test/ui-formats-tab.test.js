/**
 * 「导出」页的界面判据。
 *
 * 这些都是**只能静态查**的东西：真正的失败要在一个装好的扩展里、点开那个标签页、
 * 选一个文件夹之后才会发生，而那个环境没有任何测试进得去。所以这里读源码，
 * 并且每条都断言自己真的扫到了东西——正则写坏之后变成空跑、永远绿，是这类检查
 * 最常见的失效方式。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (rel) => readFile(new URL(`../${rel}`, import.meta.url), 'utf-8');

describe('导出页的骨架', () => {
  test('标签按钮与 section 对得上', async () => {
    const html = await read('src/ui/panel.html');
    assert.match(html, /<button data-tab="formats"[^>]*>导出<\/button>/);
    assert.match(html, /<section id="tab-formats" hidden>/);
  });

  test('三种产出各有一个按钮，一个都不能少', async () => {
    const html = await read('src/ui/panel.html');
    for (const id of ['export-neodb', 'export-canonical', 'export-markdown']) {
      assert.match(html, new RegExp(`id="${id}"`), `少了 ${id}`);
    }
  });

  test('**每一种都要给出「拿它干什么」的去处**', async () => {
    // 一个导出按钮旁边没有任何说明，等于把「接下来干什么」整个丢给用户——
    // 而在此之前，面板里唯一提到下游的地方是帮助页那张仓库链接表，那是一排
    // 代码仓库，不是一句「你可以这么做」。
    const html = await read('src/ui/panel.html');
    const section = html.slice(html.indexOf('<section id="tab-formats"'), html.indexOf('<section id="tab-debug"'));
    const cards = section.split('<div class="format-card">').slice(1);
    assert.equal(cards.length, 3, `卡片数不对：${cards.length}`);
    for (const card of cards) {
      assert.match(card, /<a href="https:\/\/[^"]+"[^>]*>[^<]*↗<\/a>/,
        '每张卡片至少要有一个指向文档或上传页的链接');
    }
  });

  test('外链一律带 rel="noreferrer noopener"', async () => {
    const html = await read('src/ui/panel.html');
    const section = html.slice(html.indexOf('<section id="tab-formats"'), html.indexOf('<section id="tab-debug"'));
    const externals = [...section.matchAll(/<a href="https:[^>]*>/g)].map((m) => m[0]);
    assert.ok(externals.length >= 5, `只找到 ${externals.length} 个外链，正则大概坏了`);
    for (const a of externals) {
      assert.match(a, /rel="noreferrer noopener"/, `这个外链没带 rel：${a}`);
      assert.match(a, /target="_blank"/, `这个外链没带 target：${a}`);
    }
  });

  test('**有一条通往档案页的出口**', async () => {
    // 「我要的是档案本身，不是这些算出来的东西」是一定会出现的念头，
    // 而这一页上没有任何东西提到 WARC。
    const html = await read('src/ui/panel.html');
    assert.match(html, /id="go-archive"/);
    const js = await read('src/ui/panel/formats.js');
    // **点那个标签按钮，不自己复制一遍切换逻辑**：那段逻辑还负责按需加载。
    assert.match(js, /button\[data-tab="archive"\]/);
  });
});

describe('导出页的行为约束', () => {
  test('**一次只跑一个**：跑起来其余按钮全禁掉', async () => {
    const js = await read('src/ui/panel/formats.js');
    assert.match(js, /function setBusy/, '没有 setBusy');
    assert.match(js, /btn\.disabled = on/, 'setBusy 没有真的禁按钮');
    assert.match(js, /if \(running\) return;/, '点击时没有挡住并发');
  });

  test('**进度条不写宽度**，样式全在 CSS 里', async () => {
    // 面板有一条硬规则：JS 里不许出现行内样式（`test/ui.test.js` 守着）。
    // 这里再钉一次那个具体的解法：用原生 <progress>，靠 value 属性表达进度。
    const html = await read('src/ui/panel.html');
    assert.match(html, /<progress id="formats-bar" max="100">/);
    const js = await read('src/ui/panel/formats.js');
    assert.ok(!/\.style\./.test(js), 'formats.js 里出现了行内样式');
  });

  test('**没有分母时不写 value**，让它进不确定状态', async () => {
    // 「正在生成文件」这种阶段算不出总数。显示 0% 会看起来像卡住了，
    // 而卡住与「在动但不知道还有多久」是两件必须分清的事。
    const js = await read('src/ui/panel/formats.js');
    assert.match(js, /else bar\.removeAttribute\('value'\)/);
  });

  test('**三种产出各占一个子目录**', async () => {
    // 平铺的话 README 之类会互相覆盖 —— 档案页早就为这件事付过一次代价：
    // 用户的下载目录里只剩最后一次导出的 manifest。
    const js = await read('src/ui/panel/formats.js');
    const dirs = [...js.matchAll(/dir: '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(dirs, ['doubak-neodb', 'doubak-canonical', 'doubak-markdown']);
    assert.equal(new Set(dirs).size, dirs.length, '子目录名撞了');
  });

  test('**用 createWritable 写，不先攒后写**', async () => {
    // 它写的是临时文件，只在 close() 那一刻整体换上去 —— 中断留下的是
    // 「没有这个文件」，而不是「半个文件」。档案导出器依赖的是同一个性质。
    const js = await read('src/ui/panel/formats.js');
    assert.match(js, /createWritable\(\)/);
    assert.match(js, /await w\.close\(\)/);
  });

  test('**不往 OPFS 里中转**：这一页不碰任何写入接口', async () => {
    // 中间产物落盘就是第二个真相来源。这一页只读 OPFS（解析要读档案），
    // 写只往用户选的文件夹写。
    const js = await read('src/ui/panel/formats.js');
    // 挑的是**存储层特有**的名字。`append(` / `replace(` 不能用来判断 ——
    // 前者是 DOM 的，后者是字符串的，那样查出来的全是误报，而一条天天误报的
    // 检查等于没有检查。
    for (const bad of ['opfs-rw-worker', 'store.append(', 'store.truncate(', 'store.remove(']) {
      assert.ok(!js.includes(bad), `导出页不该用到 ${bad}`);
    }
    // 反过来钉一条正的：它确实在用只读那个 worker。
    assert.match(js, /getOpfsWorker/);
  });

  test('**混了账号时给的是这一侧能做的事**，不是命令行的开关', async () => {
    // 解析器那条消息的结尾是「加 --ignore-warnings」——给命令行写的。原样印在
    // 面板上等于让人去找一个不存在的开关。同时**不做**一个「照样合并」的按钮：
    // 那道拦截存在的理由是合并过的 canonical 事后拆不开，而一个就在旁边的按钮
    // 会把「停下来」变成一次点击。
    const js = await read('src/ui/panel/formats.js');
    assert.match(js, /混着 \\d\+ 个账号/, '没有识别那条错误');
    assert.match(js, /到「档案」页/, '没有给出这一侧能做的事');
    assert.ok(!js.includes('ignoreWarnings: true'), '面板上不该有「照样合并」这条路');
  });

  test('**解析告警要露面**，不许静静吞掉', async () => {
    // 静静吞掉会让这一页看起来比实际可靠。混了两个账号尤其要说 ——
    // 合并过的 canonical 事后拆不开。
    const js = await read('src/ui/panel/formats.js');
    assert.match(js, /data\.warnings/);
    assert.match(js, /multiple_accounts/);
    // 认不出来的告警要原样印出去，不能被 `return null` 吃掉。
    assert.match(js, /lines\.push\(JSON\.stringify\(w\)\)/);
  });
});

describe('依赖方向', () => {
  test('formats.js 只 import shared 与 pipeline，不反过来依赖别的标签页', async () => {
    // 面板的依赖是单向的，破了就等于摊成十个文件的 panel.js。
    const js = await read('src/ui/panel/formats.js');
    const local = [...js.matchAll(/from '\.\/([\w-]+)\.js'/g)].map((m) => m[1]);
    assert.deepEqual(local, ['shared'], `formats.js 多依赖了：${local.join('、')}`);
  });

  test('panel.js 显式调用 initFormats / resetFormats', async () => {
    // 「模块加载 == 面板打开」在拆分之后不再成立，所以每一页都要显式清、显式绑。
    const js = await read('src/ui/panel.js');
    assert.match(js, /import \{ initFormats, resetFormats \}/);
    assert.match(js, /^resetFormats\(\);$/m);
    assert.match(js, /^initFormats\(\);$/m);
  });
});

describe('告警怎么显示', () => {
  test('**同一类合成一行**——一个永远有内容的清单没人看', async () => {
    // 实测：一次真实导出出了 41 条 implausible_full，每条一行原始 JSON。
    // 而它们是**永久性的**：那几份档案在生产者 bug 修好之前就写下了假的
    // enumeration: full，而 bundle 是冻结的。也就是说每一次导出都会看到这 41 行，
    // 足够盖住第 42 行真的问题。
    const { warningLines } = await import('../src/ui/panel/formats.js');
    const many = Array.from({ length: 41 }, (_, i) => ({
      type: 'implausible_full', bundle: `b${i % 6}`, route_key: 'interest.movie.collect',
      claimed: 1336, captured: 15,
    }));
    const lines = warningLines(many);
    assert.equal(lines.length, 1, `41 条应该合成 1 行，实际 ${lines.length} 行`);
    assert.match(lines[0], /41 处/);
    assert.match(lines[0], /6 份档案/);
    // **必须说清它不代表这次少了东西**，否则用户会以为导出坏了。
    assert.match(lines[0], /不代表这次导出少了东西/);
  });

  test('**真的覆盖空洞与那个说不通的声明，措辞必须相反**', async () => {
    // implausible_full 是「别信那句声明」，missing_floor_bundle 是「真的缺了一块」。
    // 两者都只是一行 ⚠，措辞是唯一能区分它们的东西。
    const { warningLines } = await import('../src/ui/panel/formats.js');
    const [gap] = warningLines([
      { type: 'missing_floor_bundle', bundle: 'b1', route_key: 'r', missing: 'b0' },
    ]);
    assert.match(gap, /真的缺了一块/);
    assert.match(gap, /导入/, '要给出下一步');
    const [claim] = warningLines([
      { type: 'implausible_full', bundle: 'b1', route_key: 'r', claimed: 1336, captured: 15 },
    ]);
    assert.ok(!/真的缺了一块/.test(claim), '两条的措辞不能混起来');
  });

  test('**认不出来的类型一条一行、原样印出去**，不许折叠进「其它」', async () => {
    // 上游加一个新类型时，折叠等于把一条我们还不理解的告警藏起来。
    // 难看的东西会被人看见，然后被处理掉。
    const { warningLines } = await import('../src/ui/panel/formats.js');
    const lines = warningLines([
      { type: 'brand_new_thing', a: 1 },
      { type: 'brand_new_thing', a: 2 },
    ]);
    assert.equal(lines.length, 2, '认不出来的不许合并');
    assert.match(lines[0], /brand_new_thing/);
    assert.match(lines[0], /"a":1/);
  });

  test('每一种已知类型都说人话，没有一个漏成 JSON', async () => {
    // 漏掉一种的表现是页面上突然出现一行原始 JSON —— 那正是这次要修的毛病。
    const { warningLines } = await import('../src/ui/panel/formats.js');
    const known = [
      { type: 'multiple_accounts', accounts: ['1', '2'] },
      { type: 'implausible_full', bundle: 'b', route_key: 'r', claimed: 9, captured: 1 },
      { type: 'missing_floor_bundle', bundle: 'b', route_key: 'r', missing: 'a' },
      { type: 'unreadable', capture: 'c1', error: 'x' },
      { type: 'extractor_stale', capture: 'c1', kind: 'broadcast' },
      { type: 'unknown_verdict', verdict: 'weird', capture: 'c1' },
      { type: 'no_owner', capture: 'c1' },
    ];
    for (const w of known) {
      const [line] = warningLines([w]);
      assert.ok(!line.startsWith('{'), `${w.type} 漏了，印成了 JSON：${line}`);
    }
  });
});
