/**
 * 自检页的结果必须**复制得出来**。
 *
 * ## 为什么这是正确性问题，不是体验问题
 *
 * 自检的用途就是「跑一遍，把结果贴给别人看」。而通过/失败的记号原来是 CSS 的
 * `::before` 伪元素——**复制走的文本里根本没有它**。于是贴出来的报告里 58 行长得
 * 一模一样，看不出哪条失败了。
 *
 * 这不是「不好看」，是这个功能对着它唯一的用途失效了。实际发生过一次：贴过来的
 * 报告里失败与通过混在一起，只能靠猜。
 *
 * 这里用源码断言而不是跑 DOM，因为要钉的是**渲染方式的选择**（真文本 vs 伪元素），
 * 而那件事在假 DOM 里看不出来——假 DOM 压根不实现 CSS。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (rel) => readFile(new URL(`../${rel}`, import.meta.url), 'utf-8');

/**
 * 只取 `buildReport` 这一个函数的源码。
 *
 * 切到「下一个顶层 `}`」为止，而不是切到某个后面的字符串——后者会把整段无关代码
 * 都圈进来，于是断言「这里面没有 DOM 操作」永远失败，而失败原因跟 buildReport
 * 毫无关系。
 *
 * @param {string} js
 */
function buildReportSource(js) {
  const start = js.indexOf('function buildReport');
  const end = js.indexOf('\n}', start);
  return js.slice(start, end);
}

describe('自检报告可复制', () => {
  test('通过/失败的记号是真文本，不是 CSS 伪元素', async () => {
    const css = await read('selftest/index.html');
    assert.equal(
      /\.case\.(ok|no)::before/.test(css),
      false,
      '记号又变回 ::before 了 —— 复制出来会全部丢掉',
    );

    const js = await read('selftest/main.js');
    // textContent 里必须带上记号
    assert.match(js, /textContent = `\$\{c\.ok \? '✔' : '✖'\} \$\{c\.name\}`/);
  });

  test('报告从结构化数据生成，不从 DOM 里扒', async () => {
    // 扒 DOM 会把伪元素、缩进、按钮文字一起带进去，而且一改样式就坏。
    const js = await read('selftest/main.js');
    const fn = buildReportSource(js);
    assert.equal(/querySelector|innerText|textContent/.test(fn), false, 'buildReport 在读 DOM');
    assert.match(fn, /report\b/, '应当从 report 数组生成');
  });

  test('报告用 [PASS]/[FAIL] 而不是只靠符号', async () => {
    // ✔ 与 ✖ 在等宽字体和某些终端里长得很像，而这份报告的用途就是贴给别人看。
    const js = await read('selftest/main.js');
    const fn = buildReportSource(js);
    assert.match(fn, /\[PASS\]/);
    assert.match(fn, /\[FAIL\]/);
  });

  test('失败项汇总在开头', async () => {
    // 否则要在几十行通过里找。
    const js = await read('selftest/main.js');
    const fn = buildReportSource(js);
    assert.match(fn, /失败汇总/);
    // 汇总里要带错误信息，不然还得往下翻
    assert.match(fn, /\[FAIL\] \$\{f\.group\} \/ \$\{f\.name\}: \$\{f\.error/);
  });

  test('环境信息进报告 —— 排查第一句就是「什么浏览器、配额多少」', async () => {
    const js = await read('selftest/main.js');
    assert.match(js, /kind: 'env', name: k, value: v/);
    const fn = buildReportSource(js);
    assert.match(fn, /kind === 'env'/);
  });

  test('剪贴板不可用时有退路', async () => {
    // 「复制失败」而没有别的办法，等于这个功能不存在。
    const js = await read('selftest/main.js');
    assert.match(js, /report-fallback/);
    assert.match(js, /report-text/);
    const html = await read('selftest/index.html');
    assert.match(html, /id="report-text"/);
  });

  test('中断时也能复制 —— 那时候报告最有用', async () => {
    const js = await read('selftest/main.js');
    // fatal / onerror / onmessageerror 三条路径都要把按钮放开
    const enables = js.match(/\$\('copy'\)\.disabled = false/g) ?? [];
    assert.ok(enables.length >= 4, `只有 ${enables.length} 处放开了复制按钮`);
  });
});

describe('自检用例之间必须隔离', () => {
  test('RPC 契约每条用一个新目录', async () => {
    // 第一版复用了同一个目录，于是 20 条里报了 7 条失败——看起来像 RPC 那一层坏了，
    // **而那些失败全是脚手架自己造的**：「不存在的文件长度为 0（期望 0，实际 9）」、
    // 「起初不存在（期望 false，实际 true）」、list 里冒出别的用例的文件。
    //
    // 旁边的 runContract() 一开始就是每条一个新目录。
    const js = await read('selftest/worker.js');
    const fn = js.slice(js.indexOf('async function runRpcContract'), js.indexOf('async function runWriter'));

    assert.match(fn, /for \(const \[i, c\] of cases\.entries\(\)\)/, '要按序号建不同的目录');
    assert.match(fn, /doubak-bundle-rpc-\$\{i\}/);
    // 每条跑完要清掉，否则下次跑自检还是脏的
    assert.match(fn, /finally \{[\s\S]*?destroy/);
  });

  test('OPFS 契约也是每条一个新目录（原本就对，别退化）', async () => {
    const js = await read('selftest/worker.js');
    const fn = js.slice(js.indexOf('async function runContract'), js.indexOf('async function check'));
    assert.match(fn, /doubak-selftest-contract-\$\{i\}/);
  });
});
