/**
 * 广播里用户自己上传的图。
 *
 * ## 为什么这条路线排在封面前面
 *
 * 封面是目录数据——豆瓣还在就能重抓，所以它归 `catalog-*`，可以整批 `rm`。这些是
 * 本人拍的、传的，而广播「发布后不可编辑、可静默删除」：图跟着广播一起没，删除
 * 不留任何痕迹。CLAUDE.md 把抓取顺序按「补不回来的程度」排，这一批排第三，而排在
 * 它后面的标记列表与作品详情页早就抓完了。
 *
 * ## 这个抽取器最容易做错的两件事
 *
 * 1. **把别人的图也存下来。** 转发别人的广播会把对方的附图一并渲染在自己的时间线上。
 * 2. **把缩略版当原件存下来。** 同一张图有 4 个尺寸，存错了事后无从分辨。
 *
 * 下面的用例全部对着 `fixtures/broadcast-photos.html` ——那是从真实档案里**原样截出**
 * 的四条广播（只删了无关的兄弟节点），四种形态各一条。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { extractStatusPhotos } from '../src/crawl/classifier.js';
import { buildRoutes } from '../src/crawl/routes.js';

const OWNER = '82160871';
const real = () =>
  readFileSync(new URL('./fixtures/broadcast-photos.html', import.meta.url), 'utf-8');

describe('从真实广播页抽本人上传的图', () => {
  test('四种形态一条不漏，且一张缩略版都没混进来', () => {
    // 实测同一份档案里同时存在这四种：
    //   view/status/l    新版 JSON，广播直接附图（本人 81 张）
    //   view/status/raw  老版单图广播，原件挂在 data-raw-src（2 张）
    //   view/photo/large 讨论/话题附图，JSON 里 raw.url 是空串（2 张）
    //   view/*/small|medium|ismall|normal —— 全是缩略版，一张都不该要
    const { urls, unresolved } = extractStatusPhotos(real(), { ownerUserId: OWNER });

    assert.equal(unresolved, 0, '认出了附图条目却取不到原件——豆瓣改结构了');
    assert.equal(urls.length, 5);
    assert.equal(urls.filter((u) => /\/view\/status\/l\//.test(u)).length, 2);
    assert.equal(urls.filter((u) => /\/view\/status\/raw\//.test(u)).length, 1);
    assert.equal(urls.filter((u) => /\/view\/photo\/large\//.test(u)).length, 2);

    for (const u of urls) {
      assert.doesNotMatch(u, /\/(small|medium|ismall)\//, `取到的是缩略版：${u}`);
    }
  });

  test('**转发进来的图一张都不要**', () => {
    // fixture 里那条转发的广播带着 9 张别人的图。它们要是进了 assets-*，
    // 「这一层里都是本人不可替代的东西」这条判断就没了——而那一层的语义就是
    // 「永不丢弃」。第三方内容也不该被我们连带发布出去。
    const { urls, skippedOthers } = extractStatusPhotos(real(), { ownerUserId: OWNER });
    assert.equal(skippedOthers, 9);
    // 那 9 张全在 view/status/l 下，和本人的图长得一模一样——只能靠 data-uid 分开。
    assert.equal(urls.length, 5, '有别人的图混进来了');
  });

  test('换一个主人，本人的图就变成别人的', () => {
    // 判据真的是 data-uid，而不是「碰巧只有一处 var photos」之类的偶然。
    // 51665133 是 fixture 里那条被转发的广播的原作者。
    const { urls, skippedOthers } = extractStatusPhotos(real(), { ownerUserId: '51665133' });
    assert.equal(urls.length, 9);
    assert.equal(skippedOthers, 5);
  });

  test('拿不到主人是谁就直接拒绝，不是「先抓了再说」', () => {
    // 不知道主人是谁却往 assets-* 里写东西，等于把「谁的」这个判断悄悄跳过。
    assert.throws(() => extractStatusPhotos(real(), { ownerUserId: '' }), /ownerUserId/);
  });
});

describe('抽不到要说抽不到', () => {
  test('认出了附图条目却取不到原件 —— 报出来', () => {
    // 静默返回空数组等于宣布「这一页没有图」。那是不可检测的丢失：几年后打开档案
    // 才发现少了，而那时广播可能已经不在了。
    const html = `<div class="new-status status-wrapper" data-uid="${OWNER}">
      <script>var photos = [{"image": {"normal": {"url": "https://img1.doubanio.com/view/status/medium/public/a.jpg"}}}];</script>
    </div>`;
    const { urls, unresolved } = extractStatusPhotos(html, { ownerUserId: OWNER });
    assert.deepEqual(urls, [], '**不许拿 normal 顶替原件**');
    assert.equal(unresolved, 1);
  });

  test('JSON 解析不了也算取不到，不算没有图', () => {
    const html = `<div class="new-status status-wrapper" data-uid="${OWNER}">
      <script>var photos = [{"image": {"large": }];</script>
    </div>`;
    assert.equal(extractStatusPhotos(html, { ownerUserId: OWNER }).unresolved, 1);
  });

  test('**容器在、一张都没抽到 —— 报出来**', () => {
    // 这是豆瓣改版时唯一还站得住的信号。上面两条抽取路径都靠具体写法（`var photos =`、
    // `data-raw-src=`），换个变量名两条就一起哑掉，而「没有图」和「图我们不认识了」
    // 在数据上一模一样。容器的 class 是另一套标记：实测 175 张页面上，带容器的
    // wrapper 与抽得到图的 wrapper 都是 33 个，一一对应。
    const html = `<div class="new-status status-wrapper" data-uid="${OWNER}">
      <div class="pics-wrapper"><script>var pics = [{"src": "https://i.doubanio.com/x.jpg"}];</script></div>
    </div>`;
    const r = extractStatusPhotos(html, { ownerUserId: OWNER });
    assert.deepEqual(r.urls, []);
    assert.equal(r.unresolved, 1, '结构变了却一声不吭 —— 这正是不可检测的丢失');
  });

  test('别人的广播里容器抽不到，不算我们的问题', () => {
    // 那本来就不该抽。记成 unresolved 会让改版告警被别人的内容淹掉。
    const html = `<div class="new-status status-wrapper" data-uid="99999">
      <div class="pics-wrapper"><script>var pics = [];</script></div>
    </div>`;
    assert.equal(extractStatusPhotos(html, { ownerUserId: OWNER }).unresolved, 0);
  });

  test('没有附图的广播不产生噪音', () => {
    const html = `<div class="new-status status-wrapper" data-uid="${OWNER}"><p>只是一句话</p></div>`;
    assert.deepEqual(extractStatusPhotos(html, { ownerUserId: OWNER }), {
      urls: [], skippedOthers: 0, unresolved: 0,
    });
  });

  test('只截到 `];` 为止 —— 后面还有别的语句', () => {
    // 整段 <script> 喂给 JSON.parse 必然失败，而那会把「有图」变成「没有图」。
    const html = `<div class="new-status status-wrapper" data-uid="${OWNER}"><script>
      (function () {
        var photos = [{"image": {"large": {"url": "https://img1.doubanio.com/view/status/l/public/a.jpg"}}}];
        if (window.X) { render(photos); }
      })();
    </script></div>`;
    assert.deepEqual(extractStatusPhotos(html, { ownerUserId: OWNER }).urls, [
      'https://img1.doubanio.com/view/status/l/public/a.jpg',
    ]);
  });

  test('raw 非空时优先于 large', () => {
    // 老版单图广播里 raw 才是原件；新版讨论附图的 raw 是空串，那时才退回 large。
    const html = `<div class="new-status status-wrapper" data-uid="${OWNER}"><script>
      var photos = [{"image": {"large": {"url": "https://i.doubanio.com/view/status/l/public/a.jpg"},
                               "raw": {"url": "https://i.doubanio.com/view/status/raw/public/a.jpg"}}}];
    </script></div>`;
    assert.deepEqual(extractStatusPhotos(html, { ownerUserId: OWNER }).urls, [
      'https://i.doubanio.com/view/status/raw/public/a.jpg',
    ]);
  });
});

describe('路线定义', () => {
  const routes = buildRoutes({ username: 'x', includeCatalog: true });
  const photo = routes.find((r) => r.key === 'asset.status_photo');

  test('**归 assets 段，不是 catalog**', () => {
    // 判据是谁上传的，不是长什么样（规范 §6.6.2）。catalog-* 的存在意义就是
    // 「可以整批 rm」，把本人的照片放进去等于让那条操作变得危险。
    assert.equal(photo.kind, 'assets');
    assert.equal(photo.intent, 'asset.image.user_upload');
    assert.equal(photo.surface, 'asset');
  });

  test('优先级排在标记列表与作品详情页之前', () => {
    // 按「补不回来的程度」排：广播 → 本人长文 → 本人上传的图 → 标记 → 作品详情页。
    const at = (k) => routes.find((r) => r.key === k).priority;
    assert.ok(photo.priority > at('broadcast.timeline'));
    assert.ok(photo.priority < at('interest.movie.collect'));
    assert.ok(photo.priority < at('interest.item'));
  });

  test('叶子：一张图取不到不连累其余的', () => {
    assert.equal(photo.ordered, false);
  });

  test('enumeration 是 bounded —— 下游不得据此推断某张图被删了', () => {
    // 图是跟着广播页派生的，广播走到哪儿就派生到哪儿，本身没有「整份枚举」的概念。
    assert.equal(photo.enumeration, 'bounded');
  });

  test('不受 includeCatalog 影响 —— 它跟目录数据毫无关系', () => {
    const noCatalog = buildRoutes({ username: 'x', includeCatalog: false });
    assert.ok(noCatalog.some((r) => r.key === 'asset.status_photo'));
    assert.ok(!noCatalog.some((r) => r.key === 'asset.subject_cover'));
  });
});
