/**
 * `tools/panel-shot.mjs` 那台量具的假后台，**不许落在面板后面**。
 *
 * ## 为什么这条值得存在
 *
 * 那台量具是用来「看界面长什么样」的。它的假答复要是错了或者缺了，界面照样画得
 * 出来——只是画出来的是**降级之后的样子**，而截图里看不出这是假数据的锅。写它的
 * 时候已经栽过两次，两次都被当成产品的 bug 看了半天：
 *
 * - 路线 key 编成了 `interest.movie.done`，而真实状态词是 `collect / do / wish`，
 *   于是截图里中文名与内部标识混着出现——看起来正像 `route-names.js` 漏了几条
 *   （那件事真发生过，见它的文件头）；
 * - 存储那一栏传了 `quota / usage`，界面读的是 `available / need`，于是显示
 *   「可用 NaN GB」。
 *
 * **量具错了被当成被量的东西错了**，是这个仓库反复记的那一类的又一个变种。
 *
 * ## 判据只钉一件事：有没有答复
 *
 * 字段名对不对钉不住（那要求测试知道每一种答复的形状，等于把假后台再写一遍）。
 * 能钉住而且够用的是**覆盖**：面板发得出的每一种消息，要么这儿有答复，要么明写在
 * 「故意不答」名单里。加一种新消息而忘了管，这条会红——而那正是「截出来的图是
 * 降级状态」最常见的来源。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf-8');

/** 面板发得出的消息类型。**从源码里数，不抄一份清单**——抄的那份会漂。 */
function typesPanelSends() {
  const dir = new URL('../src/ui/panel/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => `src/ui/panel/${f}`);
  files.push('src/ui/panel.js');
  const out = new Set();
  for (const f of files) {
    for (const m of read(f).matchAll(/send\(\{\s*type:\s*'([A-Za-z]+)'/g)) out.add(m[1]);
  }
  return out;
}

describe('截图量具的假后台', () => {
  test('**面板发得出的每一种消息都有着落** —— 要么答，要么明写不答', () => {
    const sends = typesPanelSends();
    assert.ok(sends.size >= 10, `只扫到 ${sends.size} 种消息，正则大概坏了`);

    const harness = read('tools/panel-shot-harness.js');
    const answered = new Set(
      [...harness.matchAll(/^\s{2}([A-Za-z]+):\s*\(\)\s*=>/gm)].map((m) => m[1]),
    );
    const passthrough = new Set(
      [...(harness.match(/const PASSTHROUGH = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? '')
        .matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]),
    );
    assert.ok(answered.size >= 2, `假答复一条都没扫到（${answered.size}）`);
    assert.ok(passthrough.size >= 2, `「故意不答」名单一条都没扫到（${passthrough.size}）`);

    const orphan = [...sends].filter((t) => !answered.has(t) && !passthrough.has(t)).sort();
    assert.deepEqual(orphan, [], `这几种消息量具没管：${orphan.join('、')}`
      + ' —— 它会静默答 { ok: true }，于是截出来的是降级之后的界面，而图上看不出来');

    // 反向：名单里不许留着面板早就不发的类型。留着不报错，只是让人以为还在用。
    const stale = [...answered, ...passthrough].filter((t) => !sends.has(t)).sort();
    assert.deepEqual(stale, [], `量具还管着面板已经不发的消息：${stale.join('、')}`);
  });

  test('**路线 key 用真的**，不许编', async () => {
    // 编出来的 key 在界面上会退化成内部标识（`routeName()` 认不出就原样返回），
    // 而那恰好是 `route-names.js` 真出过的一个 bug 的样子。
    const { routeName } = await import('../src/ui/route-names.js');
    const keys = [...read('tools/panel-shot-harness.js')
      .matchAll(/^\s*\['([a-z][\w.]+)',\s*\d+/gm)].map((m) => m[1]);
    assert.ok(keys.length >= 5, `只扫到 ${keys.length} 个路线 key，正则大概坏了`);
    const nameless = keys.filter((k) => routeName(k) === k);
    assert.deepEqual(nameless, [], `这几个 key 没有中文名，多半是编的：${nameless.join('、')}`);
  });
});
