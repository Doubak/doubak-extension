/**
 * `src/vendor/parser/` 是解析器抽取器的**同一份**拷贝。
 *
 * ## 为什么抄而不是重写
 *
 * 面板要把档案里的内容显示出来，而把 HTML 变成条目这件事解析器已经做过一遍，且是
 * 对着真实字节一处处量出来的。另写一份浅的，结果是**能力更弱、而且会漂**。
 *
 * 这不是假想：`&#34;` 曾经明晃晃印在 sample.doubak.com 上——当时有**四份**各自演化
 * 的 HTML 实体解码表，其中一份干脆没有。合成一份之后，未解码实体从 196 降到 1，
 * 而那 1 个是对的。
 *
 * ## 这组测试守两件事
 *
 * **① 没漂。** 与解析器逐字节相同（解析器不在场时带原因跳过）。
 * **② 真能用。** 拷贝过来的东西在这边 import 得进、跑得动、结果对——只比对文本
 * 是不够的：一个语法没问题但依赖了 node 内建的文件，文本比对照样全绿，而扩展装上
 * 就报错。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { FILES, findParserDir, renderAll } from '../tools/sync-extractors.mjs';
import { decodeEntities } from '../src/vendor/parser/html-entities.js';
import { extractBroadcasts } from '../src/vendor/parser/extract-broadcast.js';
import { extractDoulistItems, mergeDoulistPages } from '../src/vendor/parser/extract-doulist.js';

const DEST = new URL('../src/vendor/parser/', import.meta.url).pathname;

describe('vendor 的抽取器', () => {
  const parserDir = findParserDir();
  const skip = parserDir ? false : '找不到 doubak-data-parser —— 单独 clone 这一个仓库时这是正常的';

  test('**与解析器逐字节相同**', { skip }, () => {
    // 漂了就红，而不是悄悄分叉。与 spec-constants 是同一套办法。
    const want = renderAll(parserDir);
    const diff = [];
    for (const [name, text] of want) {
      const p = join(DEST, name);
      if (!existsSync(p)) { diff.push(`${name}（缺）`); continue; }
      if (readFileSync(p, 'utf-8') !== text) diff.push(`${name}（不一致）`);
    }
    assert.deepEqual(diff, [],
      `vendor 过期了，请运行 node tools/sync-extractors.mjs：\n${diff.join('\n')}`);
  });

  test('解析器那边删掉的文件，这边不许还留着', { skip }, () => {
    const want = new Set(FILES);
    const extra = readdirSync(DEST).filter((f) => f.endsWith('.js') && !want.has(f));
    assert.deepEqual(extra, [], `这些在解析器那边已经没有了：${extra.join('、')}`);
  });

  test('**名单里每一个都要真的被搬过来**', () => {
    // 名单与目录两头对齐。只查目录的话，名单里加一项却忘了同步，测试照样绿。
    const got = readdirSync(DEST).filter((f) => f.endsWith('.js')).sort();
    assert.deepEqual(got, [...FILES].sort());
  });

  test('**跑得动，不只是文本一致**', () => {
    // 只比对文本挡不住「语法没问题但用了 node 内建」——那种文件文本比对全绿，
    // 扩展装上才报错，而那时离这儿很远。所以这里真的调一次。
    assert.equal(decodeEntities('&amp;lt;'), '&lt;',
      '单趟解码：&amp;lt; 的原文就是四个字符 &lt;，链式 replace 会把它变成 <');
    assert.equal(decodeEntities('&nbsp;'), ' ', 'nbsp 要解成 U+00A0，不是普通空格');
    assert.equal(decodeEntities('&copyright;'), '&copyright;', '不认识的实体原样留着，不许猜');
  });

  test('**抽取器在扩展这边也能出结果**', () => {
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

  test('**拼页的规则也是搬过来的，不是这边另写的**', () => {
    // 一份豆列每页 25 条，「一份豆列」因此跨着好几次捕获。**谁来拼、按什么次序拼
    // 是一条规则**，而这条规则一度有两份实现：解析器 `parse.js` 里一份，面板的
    // 内容预览里一份。两份对同一份豆列可以给出不同的条目次序，而次序错了看起来
    // 完全正常——还是那些作品，还是那些评语。
    //
    // 所以这里验的不是「能跑」，是**这一份确实带着那条规则**：解析器那边把它删了
    // 或改了名，这条会红，而不是让面板悄悄退回自己那份。
    const page = (start, title) => ({ start, doulist: { id: '1', items: [{ title }] } });
    const m = mergeDoulistPages([page(50, '三'), page(0, '一'), page(25, '二')]);
    assert.deepEqual(m.doulist.items.map((i) => i.title), ['一', '二', '三'],
      '按 start 升序 —— 次序是内容的一部分');
    assert.equal(mergeDoulistPages([]), null, '一页都没有要返回 null，不是一份空豆列');
  });
});
