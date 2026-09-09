/**
 * **两万页的导出要叫得停。**
 *
 * 报上来的原话：「we need a button to stop the export because it could take really
 * long time if I have ~20k pages to parse」。在这之前按下「导出」就再也没有出口
 * ——只能等，或者关掉整个面板。
 *
 * 这一组守的是三件事，每一件坏掉的样子都不一样：
 *
 * 1. **真的停**（signal 一路传到解析器，不是只把结果丢掉）；
 * 2. **不说成失败**——按停不是出错，一张红卡片会把人送去查一个不存在的问题；
 * 3. **停完还能再来**——按钮要复位，否则下一次导出时那个唯一的出口是死的。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = (p) => readFile(new URL(`../src/${p}`, import.meta.url), 'utf8');

describe('导出停得下来', () => {
  test('signal 从界面一路传到解析器，中间没有断点', async () => {
    // 断在任何一层，症状都一样：按钮按下去，界面说停了，两万页照跑到底。
    const f = await src('ui/panel/formats.js');
    assert.match(f, /aborter = new AbortController\(\)/, '没有取消器');
    assert.match(f, /signal: aborter\.signal/, 'signal 没传给 parseLibrary');

    const run = await src('pipeline/run.js');
    assert.match(run, /parseLibrary\(\{[\s\S]{0,160}signal,/, 'parseLibrary 没收 signal');
    assert.match(run, /parse\(sources, \{[\s\S]{0,120}signal,/, 'signal 没传给 parse()');

    // 打开档案那一段也要能停：二十几份档案，每份都要把 index 读进来解析。
    assert.match(run, /throwIfAborted\(signal\);\n\s*sources\.push/, '打开档案那一段停不下来');

    // **判据是位置，不是「文件里有这个字符串」。** 第一版写成后者，突变验出来它是空的：
    // 把逐页循环里那一处删掉、只留循环外面那一处，测试照样全绿——而循环里那一处
    // 正是唯一让两万页停得下来的东西。
    //
    // 结构判据：逐页进度报完之后、去取字节（`payload`）之前，必须有一道检查。
    // 「取字节之前」也是有意的：`payload()` 要解压一整个段，放在它后面的话，
    // 按下停之后最坏还要再等一次解压。
    const parse = await src('vendor/parser/parse.js');
    const tick = parse.indexOf("phase: 'parse' }");
    // **从 tick 之后再找**：`src.payload(row)` 头一次出现是在文件开头的注释里
    // （「全函数里唯一等它的地方就是下面那一处 `await src.payload(row)`」），
    // 从 0 找会拿到那一处，于是 payload < tick，判据自己就先坏了。
    const payload = parse.indexOf('await src.payload(row)', tick);
    assert.ok(tick > 0 && payload > tick, '找不到逐页循环 —— 判据自己坏了');
    assert.match(parse.slice(tick, payload), /throwIfAborted\(opts\.signal\)/,
      '逐页循环里没有检查 —— 按下「停」只是把结果丢掉，两万页照跑');
  });

  test('**取消不说成失败**，判据是 name 不是消息文本', async () => {
    // 消息文本会被改、会被翻译；`AbortError` 是平台约定。
    const f = await src('ui/panel/formats.js');
    assert.match(f, /e\?\.name === 'AbortError'/, '没把取消与失败分开');
    const at = f.indexOf("e?.name === 'AbortError'");
    const fail = f.indexOf("b.textContent = '导出失败'");
    assert.ok(at > 0 && fail > 0 && at < fail, '取消那一支排在「导出失败」后面，走不到');
    // 切到这一支自己的 `return` 为止 —— 再往后就是失败那一支了，那里当然有 tone-error。
    const branch = f.slice(at, f.indexOf('return;', at));
    assert.match(branch, /已停下/);
    assert.ok(!/tone-error/.test(branch), '取消用了红色 —— 那是「出错了」的意思');
    assert.match(branch, /tone-idle/, '取消那一支没给卡片定个中性的样子');
  });

  test('三处 throwIfAborted 的定义要一致 —— 否则取消会被当成失败', async () => {
    // 三份实现（解析器 / 扩展流水线 / 导出页），因为那是 `parse.js` 的内部函数，
    // 不在导出面上。抄四行比把内部函数变成公开接口便宜，但**不一致的代价是静默的**：
    // 少设一个 name，界面就把一次主动取消显示成红色的「导出失败」。
    for (const p of ['vendor/parser/parse.js', 'pipeline/run.js', 'ui/panel/formats.js']) {
      const s = await src(p);
      const i = s.indexOf('function throwIfAborted');
      assert.ok(i > 0, `${p} 里没有 throwIfAborted`);
      const body = s.slice(i, i + 220);
      assert.match(body, /name = 'AbortError'/, `${p} 里那份没设 AbortError`);
      assert.match(body, /new Error\('已取消'\)/, `${p} 里那份消息不一样`);
    }
  });

  test('**按钮要复位**，否则第二次导出时唯一的出口是死的', async () => {
    const f = await src('ui/panel/formats.js');
    const i = f.indexOf('function setBusy');
    const body = f.slice(i, f.indexOf('\n}\n', i));
    assert.match(body, /stop\.disabled = false/, '「停下」按完就一直是禁用的');
    assert.match(body, /stop\.textContent = '停下'/, '按钮上还写着「正在停…」');
  });

  test('按下之后进度不许把「正在停下来」盖回去', async () => {
    // 盖回去的话界面又变成「正在解析 12345 / 18838」，看起来就像那一下没按上，
    // 而人会接着再按几下。
    const f = await src('ui/panel/formats.js');
    const i = f.indexOf('function progress(');
    const body = f.slice(i, f.indexOf('\n}\n', i));
    assert.match(body, /aborter\?\.signal\.aborted\) return/, '进度会盖掉「正在停下来」');
  });

  test('界面上真的有那个按钮，而且在进度条那一块里', async () => {
    // 放在三张卡片上就要有三个——而这一页一次只跑一个，「停」也只有一个对象。
    const html = await readFile(new URL('../src/ui/panel.html', import.meta.url), 'utf8');
    const i = html.indexOf('id="formats-progress"');
    assert.ok(i > 0);
    // 切到这一块的结尾（`formats-result` 之前），不是第一个 `</div>`
    // —— 后者是进度文字那个 div 自己的收尾，按钮排在它后面。
    const block = html.slice(i, html.indexOf('id="formats-result"'));
    assert.match(block, /id="formats-stop"/, '「停下」不在进度条那一块里');
    assert.equal((html.match(/id="formats-stop"/g) ?? []).length, 1, '有不止一个「停下」');
  });
});
