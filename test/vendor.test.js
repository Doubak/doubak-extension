/**
 * `src/vendor/` 是另外三个仓库那几个文件的**同一份**拷贝。
 *
 * ## 为什么抄而不是重写
 *
 * 面板要把档案解析成 canonical、再导出成 NeoDB 的归档格式与 Markdown。这三件事
 * 上游都做过了，而且是对着真实字节一处处量出来的。另写一份浅的，结果是**能力更弱、
 * 而且会漂**。
 *
 * 这不是假想：`&#34;` 曾经明晃晃印在 sample.doubak.com 上——当时有**四份**各自演化
 * 的 HTML 实体解码表，其中一份干脆没有。合成一份之后，未解码实体从 196 降到 1，
 * 而那 1 个是对的。
 *
 * ## 这组测试守三件事
 *
 * **① 没漂。** 与上游逐字节相同（上游不在场时带原因跳过；CI 里三个仓库都在）。
 * **② 名单两头对齐。** 只查目录的话，名单里加一项却忘了同步，测试照样绿。
 * **③ 真能用。** 拷贝过来的东西在这边 import 得进、跑得动、结果对——只比对文本是
 * 不够的：一个语法没问题但依赖了 node 内建的文件，文本比对照样全绿，而扩展装上就
 * 报错。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { SOURCES, findDir, renderOne } from '../tools/sync-vendor.mjs';
import { decodeEntities } from '../src/vendor/parser/html-entities.js';
import { extractBroadcasts } from '../src/vendor/parser/extract-broadcast.js';
import { extractDoulistItems, mergeDoulistPages } from '../src/vendor/parser/extract-doulist.js';
import { sha256 } from '../src/vendor/parser/sha256.js';
import { fieldDigest } from '../src/vendor/parser/digest.js';
import { parse } from '../src/vendor/parser/parse.js';
import { buildNeodbNdjson } from '../src/vendor/export-adapters/targets/neodb-ndjson.js';
import { plainText } from '../src/vendor/site-generator/markdown.js';

const VENDOR = new URL('../src/vendor/', import.meta.url).pathname;

/** 递归列 .js，与同步脚本里那个一样。 */
function listJs(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listJs(join(dir, e.name), rel));
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

describe('vendor 与上游的一致性', () => {
  for (const source of SOURCES) {
    const dir = findDir(source);
    const skip = dir ? false : `找不到 ${source.repo} —— 单独 clone 这一个仓库时这是正常的`;
    const dest = join(VENDOR, source.dest);

    test(`${source.dest}：**与上游逐字节相同**`, { skip }, () => {
      const want = renderOne(source, dir);
      const diff = [];
      for (const [name, text] of want) {
        const p = join(dest, name);
        if (!existsSync(p)) { diff.push(`${name}（缺）`); continue; }
        if (readFileSync(p, 'utf-8') !== text) diff.push(`${name}（不一致）`);
      }
      assert.deepEqual(diff, [],
        `vendor 过期了，请运行 node tools/sync-vendor.mjs：\n${diff.join('\n')}`);
    });

    test(`${source.dest}：名单与目录两头对齐`, () => {
      // 两个方向都要查：上游删了文件这边还留着（多），名单里加了一项忘了同步（少）。
      assert.deepEqual(listJs(dest).sort(), [...source.files].sort());
    });
  }

  test('三个上游一个都不能漏', () => {
    // SOURCES 被误删一项时，上面那些 test 会跟着一起消失——而消失的测试是绿的。
    assert.deepEqual(SOURCES.map((s) => s.dest).sort(),
      ['export-adapters', 'parser', 'site-generator']);
  });
});

describe('搬过来的东西真的跑得动', () => {
  test('HTML 实体：单趟解码，不认识的原样留着', () => {
    // 只比对文本挡不住「语法没问题但用了 node 内建」——那种文件文本比对全绿，
    // 扩展装上才报错，而那时离这儿很远。所以这里真的调一次。
    assert.equal(decodeEntities('&amp;lt;'), '&lt;',
      '单趟解码：&amp;lt; 的原文就是四个字符 &lt;，链式 replace 会把它变成 <');
    // **写成 ` ` 而不是那个字符本身。** 不间断空格与普通空格在编辑器里长得
    // 一模一样，写字面量就等于把这条断言的成败交给「谁复制粘贴过这一行」。
    assert.equal(decodeEntities('&nbsp;'), ' ', 'nbsp 要解成 U+00A0，不是普通空格');
    assert.equal(decodeEntities('&copyright;'), '&copyright;', '不认识的实体原样留着，不许猜');
  });

  test('摘要：浏览器这边算出来的必须跟命令行一样', async () => {
    // **这条是整条链上最要命的一致性。** 摘要一旦两边不同，同一份档案解析两次
    // 会得出不同的修订，而 canonical 只比较同一 parser_version 的修订——
    // 结果是所有记录同时看起来被编辑过，且不报任何错。
    //
    // 这里用 node:crypto 当标准答案。解析器仓库里有更彻底的对拍（官方向量、
    // 0–130 每个长度、代理对），这一条守的是「搬过来之后还是那一份」。
    const { createHash } = await import('node:crypto');
    for (const s of ['', 'abc', '寂静岭2', '_(:з」∠)_', '👨‍👩‍👧‍👦', 'a'.repeat(56)]) {
      assert.equal(sha256(s), createHash('sha256').update(s, 'utf-8').digest('hex'),
        `${JSON.stringify(s)} 的摘要跟 node:crypto 对不上`);
    }
    assert.match(fieldDigest('abc'), /^sha256:[0-9a-f]{64}$/);
    assert.equal(fieldDigest(null), null, 'null 与「空字符串」是两回事');
  });

  test('抽取器在扩展这边也能出结果', () => {
    // 一个最小的豆列条目：容器上 id 在 class 前面（真实页面就是这样）。
    const html = '<div id="770340559" class="doulist-item" >'
      + '<a data-id="30237482" data-cate="3114" data-url="https://www.douban.com/subject/30237482/"'
      + ' data-title="刺客信条" class="lnk-doulist-add"></a>'
      + '<blockquote class="comment"><span>评语：</span>A$49.21</blockquote></div>';
    const [item] = extractDoulistItems(html);
    assert.equal(item.entryId, '770340559');
    assert.equal(item.upstreamId, '30237482');
    assert.equal(item.comment, 'A$49.21', '用户写的评语要抽得出来 —— 那是这条路线的全部价值');

    // 广播那边只验它接得住调用、不抛：真实结构在解析器仓库里有整套测试，
    // 这里要证明的是「搬过来之后还能跑」，不是重测一遍解析器。
    assert.doesNotThrow(() => extractBroadcasts('<div class="stream-items"></div>', '1'));
  });

  test('拼页的规则也是搬过来的，不是这边另写的', () => {
    // 一份豆列每页 25 条，「一份豆列」因此跨着好几次捕获。**谁来拼、按什么次序拼
    // 是一条规则**，而这条规则一度有两份实现：解析器 `parse.js` 里一份，面板的
    // 内容预览里一份。两份对同一份豆列可以给出不同的条目次序，而次序错了看起来
    // 完全正常——还是那些作品，还是那些评语。
    const page = (start, title) => ({ start, doulist: { id: '1', items: [{ title }] } });
    const m = mergeDoulistPages([page(50, '三'), page(0, '一'), page(25, '二')]);
    assert.deepEqual(m.doulist.items.map((i) => i.title), ['一', '二', '三'],
      '按 start 升序 —— 次序是内容的一部分');
    assert.equal(mergeDoulistPages([]), null, '一页都没有要返回 null，不是一份空豆列');
  });

  test('parse() 搬过来还是 async，空输入不炸', async () => {
    const out = await parse([]);
    assert.deepEqual(out.marks, []);
    assert.deepEqual(out.broadcasts, []);
    assert.ok(Array.isArray(out.warnings));
  });

  test('NeoDB 的 NDJSON 生成器在这边也出得来', () => {
    const r = buildNeodbNdjson({
      marks: [], subjects: [], longform: [], doulists: [], broadcasts: [],
      subjectOf: () => null, account: null, multiRevisionMarks: 0,
    });
    // 空档案也要出两个文件——上传页面是按这两个名字认格式的（`data.html` 里那段
    // JSZip），少一个就是「未知格式」，连传都传不上去。
    const names = r.files.map((f) => f.name).sort();
    assert.deepEqual(names, ['catalog.ndjson', 'journal.ndjson']);
  });

  test('Markdown 转义规则是站点生成器那一份', () => {
    // 用户写的字要当正文转义。这条曾经吃掉过内容：`From <May December>` 里的
    // 片名整个消失，页面上一点痕迹都不留。
    assert.equal(plainText('_(:з」∠)_'), '\\_(:з」∠)\\_', '下划线要转义，否则被当成斜体');
    assert.match(plainText('From <May December>'), /&lt;May December&gt;|\\<May December\\>/,
      '尖括号不能原样留着 —— 那会让片名整个消失');
  });
});
