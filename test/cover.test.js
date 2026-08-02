/**
 * 作品封面图。
 *
 * ## 为什么这件事值得一个单独的测试文件
 *
 * 「不抓图片」正是「备份必须联网才能看」的病根（DESIGN F-04e）。在这之前，四份
 * 真实档案里 **3797 条捕获全是 text/html，一张图都没有**——打开任何一页，封面、
 * 头像、自己上传的照片全是指向 doubanio.com 的 URL。豆瓣哪天关了，这些页面就是
 * 一堆带叉的方框。
 *
 * 而抓图片这件事有两个特别容易悄悄做错的地方，都在这里守着：
 *
 * ① **抽哪一张。** 一个作品详情页上有 20~40 个 doubanio 图片 URL，绝大多数是推荐
 *    区的别的作品、评论者头像、界面雪碧图。抽错的代价不是「少一张图」，而是几千
 *    张同样的小图标。
 * ② **图片响应怎么判定。** 判定的一般做法是找页面里的结构锚点，而图片没有结构。
 *    照搬那套逻辑，一张封锁页伪装成的「图片」会被判成 ok。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, openSync, readSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';

import { extractCoverImage, classifyAsset } from '../src/crawl/classifier.js';
import { buildRoutes, PRIORITY } from '../src/crawl/routes.js';
import { Frontier } from '../src/crawl/frontier.js';
import { buildCheckpoint } from '../src/crawl/run-store.js';
import { CrawlLoop } from '../src/crawl/loop.js';
import { Transport } from '../src/crawl/transport.js';
import { Pacer, RequestGate } from '../src/crawl/pacing.js';
import { SessionGuard } from '../src/crawl/session.js';
import { BundleWriter } from '../src/bundle/bundle-writer.js';
import { MemoryFileStore } from '../src/storage/file-store.js';
import { indexFilename } from '../src/core/ids.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

const NAV = `<li class="nav-user-account"><a href="/accounts/logout">退出</a>
<span>示例的账号</span></li><a href="https://www.douban.com/people/example/">主页</a>
<script>;window._GLOBAL_NAV = { USER_ID: "10001" };</script>`;

// ── 真实标记，逐字取自 ~/downloads 里的真实档案 ────────────────────────────
//
// 手写「差不多长这样」的 HTML 会让测试通过而线上抽不到——这四种形态各不相同，
// 而不同之处恰好就是抽取器要处理的那些。

const BOOK = `<div id="mainpic">        <a class="nbg"       href="https://img9.doubanio.com/view/subject/l/public/s33436746.jpg" title="富爸爸穷爸爸">     <img src="https://img9.doubanio.com/view/subject/s/public/s33436746.jpg" title="点击看大图" alt="富爸爸穷爸爸"        rel="v:photo" style="max-width: 135px;max-height: 200px;">   </a></div>`;

const MOVIE = `<div id="mainpic">     <a class="nbgnbg" href="https://movie.douban.com/subject/34965089/photos?type=R" title="点击看更多海报">         <img src="https://img2.doubanio.com/view/photo/s_ratio_poster/public/p2929227011.jpg" title="点击看更多海报" alt="Return to Silent Hill" rel="v:image" />    </a></div>`;

const MUSIC = `<div id="mainpic">         <span class="ckd-collect">             <a class="nbg" href="https://img1.doubanio.com/view/subject/m/public/s29084369.jpg"             title="点击看大图">                 <img src="https://img1.doubanio.com/view/subject/m/public/s29084369.jpg"                     alt="恋 (初回限定盤)" rel="v:photo"/></a></span></div>`;

// 游戏页用的是另一套模板：**没有 #mainpic**，而且页面上第一个 doubanio 图片是
// 界面雪碧图。这两点合起来正是「退回到第一张图」那种写法会翻车的地方。
const GAME = `<img src="https://img3.doubanio.com/f/shire/e49eca1517424a941871a2667a8957fd6c72d632/pics/new_menu.gif" alt="new" style="position: absolute; top: -7px; right: -13px;" />
<div class="pic">             <a href="https://img2.doubanio.com/lpic/s34308681.jpg"><img width="115" src="https://img2.doubanio.com/lpic/s34308681.jpg" alt="莱莎的炼金工房3"></a>             <div class="th-modify"></div></div>`;

// 没有海报的作品：豆瓣塞一张自己的占位图，旁边写着「上传海报图片」。
const NO_POSTER = `<div id="mainpic">     <a class="nbgnbg" href="https://movie.douban.com/subject/36980405/photos?type=R" title="点击看更多海报">         <img src="https://img2.doubanio.com/cuphead/movie-static/pics/movie_default_large.png" title="点击看更多海报" alt="Paris 2024" rel="v:image" />    </a>     <p class="pl">&gt; <a href="https://movie.douban.com/subject/36980405/update_image">上传海报图片</a></p></div>`;

/** 一张能过判定的电影详情页：URL 锚点靠 frontier 里的 URL，内容区块靠 mainpic。 */
const SUBJECT_PAGE = `<html><head><title>寂静岭 (豆瓣)</title></head><body>${NAV}
<div id="wrapper"><div id="content"><h1><span property="v:itemreviewed">寂静岭</span></h1>
${MOVIE}<div id="interest_sectl"></div></div></div></body></html>`;

describe('抽封面：四种媒介各有各的模板', () => {
  test('书 —— #mainpic 里的 img，不是 a 上那个大图链接', () => {
    // 容器里 `<a href="...l/public/....jpg">` 排在 `<img>` 前面。取 a 的 href 会
    // 拿到大图（体积几倍），而项目的取舍是明确跳过全尺寸海报。
    assert.deepEqual(extractCoverImage(BOOK), {
      url: 'https://img9.doubanio.com/view/subject/s/public/s33436746.jpg',
      reason: 'ok',
    });
  });

  test('电影 —— a 的 href 是相册页，只有 img 才是海报', () => {
    assert.equal(
      extractCoverImage(MOVIE).url,
      'https://img2.doubanio.com/view/photo/s_ratio_poster/public/p2929227011.jpg',
    );
  });

  test('音乐 —— 容器与 img 之间隔着 span 与 a', () => {
    assert.equal(
      extractCoverImage(MUSIC).url,
      'https://img1.doubanio.com/view/subject/m/public/s29084369.jpg',
    );
  });

  test('游戏 —— 没有 #mainpic，且第一张图是界面雪碧图', () => {
    // **这条最要紧。** 退回到「页面上第一个 doubanio 图片」的话，594 个游戏会各
    // 存一份同样的 new_menu.gif，而真正的封面一张都没有。
    const r = extractCoverImage(GAME);
    assert.equal(r.url, 'https://img2.doubanio.com/lpic/s34308681.jpg');
    assert.ok(!r.url.includes('new_menu'), '抓到了界面雪碧图');
  });
});

describe('抽不到的时候要分清是哪一种抽不到', () => {
  test('作品本来就没有海报 → placeholder，不报警', () => {
    // 实测 2916 个作品详情页里有 7 个是这样。把它们说成「找不到封面」，那 7 条
    // 正常情况就成了天天出现的噪音，真正的改版信号会淹死在里面。
    assert.deepEqual(extractCoverImage(NO_POSTER), { url: null, reason: 'placeholder' });
  });

  test('连容器都没有 → not_found，这是要报警的那种', () => {
    assert.deepEqual(extractCoverImage('<html><body>什么都没有</body></html>'), {
      url: null,
      reason: 'not_found',
    });
  });

  test('不猜：容器里是别人的头像也不算封面', () => {
    const html = '<div class="pic"><img src="https://img1.doubanio.com/icon/up82160871-12.jpg"></div>';
    assert.equal(extractCoverImage(html).url, null);
  });

  test('非字符串输入不炸', () => {
    assert.equal(extractCoverImage(null).url, null);
    assert.equal(extractCoverImage(undefined).reason, 'not_found');
  });
});

describe('图片响应的判定 —— 没有结构锚点可用', () => {
  const base = { finalUrl: 'https://img1.doubanio.com/x.jpg', status: 200 };

  test('image/* 且非空 → ok', () => {
    const c = classifyAsset({ ...base, contentType: 'image/jpeg', byteLength: 20480 });
    assert.equal(c.verdict, 'ok');
  });

  test('**请求图片却收到 HTML → 绝不判 ok**', () => {
    // 豆瓣以 HTTP 200 返回封锁页是这个项目反复处理的既有事实，图片请求没有理由
    // 被豁免。判 ok 的话，档案里会多出一堆标着 ok、内容却是「有异常请求」的「图片」。
    const c = classifyAsset({
      ...base,
      contentType: 'text/html; charset=utf-8',
      byteLength: 4096,
      bodyText: '<html><body><p>有异常请求，请输入验证码后继续</p></body></html>',
    });
    assert.notEqual(c.verdict, 'ok');
    assert.equal(c.verdict, 'challenge');
    assert.ok(c.reasons.some((r) => r.includes('收到 text/html')));
  });

  test('拿回一张看起来完全正常的网页也不算成功', () => {
    // 就算 HTML 那套判定说不出问题，我们要的仍然是图片。
    const c = classifyAsset({
      ...base,
      contentType: 'text/html',
      byteLength: 100,
      bodyText: '<html><body>随便什么</body></html>',
    });
    assert.notEqual(c.verdict, 'ok');
  });

  test('**Content-Type 靠不住时按字节认**', () => {
    // 这条是实测逼出来的：一次真实抓取里 123 张封面全部判成「抓不下来」，
    // 而字节明明已经在档案里了。第一版只认 `Content-Type: image/*`——那是在
    // 判标签而不是判内容，正好是这个项目一贯反对的做法（豆瓣以 200 送封锁页，
    // 所以状态码不算数；同理，头也只是头）。CDN 把 .jpg 标成
    // application/octet-stream、或者压根不给这个头，都是常事。
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
    for (const ct of ['application/octet-stream', 'binary/octet-stream', null, '']) {
      const c = classifyAsset({ ...base, contentType: ct, byteLength: jpeg.length, body: jpeg });
      assert.equal(c.verdict, 'ok', `Content-Type=${JSON.stringify(ct)} 时把好图判成了失败`);
    }
  });

  test('认得 PNG / GIF / WebP', () => {
    const cases = {
      png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13],
      gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0],
      webp: [0x52, 0x49, 0x46, 0x46, 0x1a, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
    };
    for (const [name, bytes] of Object.entries(cases)) {
      const body = new Uint8Array(bytes);
      const c = classifyAsset({ ...base, contentType: null, byteLength: body.length, body });
      assert.equal(c.verdict, 'ok', `没认出 ${name}`);
    }
  });

  test('字节不像图片、标签也不说是图片 → 仍然判不出来', () => {
    // 放松的是标签，不是底线。随便什么二进制都算数的话，这条判定就没用了。
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const c = classifyAsset({
      ...base, contentType: 'application/json', byteLength: junk.length, body: junk,
    });
    assert.equal(c.verdict, null);
  });

  test('**收到 HTML 时不看字节** —— 那条底线不放松', () => {
    // 放松标签是为了不冤枉好图；而「拿回来的是网页」是封锁页伪装成图片的样子，
    // 与标签宽松与否无关。
    const html = new TextEncoder().encode('<html><body>有异常请求</body></html>');
    const c = classifyAsset({
      ...base, contentType: 'text/html', byteLength: html.length, body: html,
      bodyText: '<html><body>有异常请求，请输入验证码后继续</body></html>',
    });
    assert.notEqual(c.verdict, 'ok');
  });

  test('0 字节的 200 不是图片', () => {
    const c = classifyAsset({ ...base, contentType: 'image/jpeg', byteLength: 0 });
    assert.equal(c.verdict, null);
  });

  test('两条都不成立就不放行：标签不说是图片，也拿不到字节', () => {
    // 拿不到字节时只能退回看标签。此时**不放行**是对的：判不出来就说判不出来，
    // 「大概没事」是这套系统里最危险的一句话。
    assert.equal(classifyAsset({ ...base, contentType: null, byteLength: 99 }).verdict, null);
    assert.equal(
      classifyAsset({ ...base, contentType: 'application/json', byteLength: 99 }).verdict,
      null,
    );
  });

  test('**418 是封锁，不是判不出来** —— 图片这条路上尤其要紧', () => {
    // 实测真实响应：
    //
    //     Status Code: 418 I'm a teapot
    //     content-type: image/jpeg
    //     content-length: 13
    //
    // 13 字节、还标着 image/jpeg——**看 Content-Type 认不出来，只能看状态码**。
    // 而这正是那次 123 张封面全军覆没的真相：每一个都判成「判不出来」，然后接着
    // 抓下一张，一路撞过去。
    const c = classifyAsset({
      ...base, status: 418, contentType: 'image/jpeg', byteLength: 13,
      body: new Uint8Array(13),
    });
    assert.equal(c.verdict, 'blocked');
    assert.ok(c.reasons.some((r) => r.includes('418')));
  });

  test('404 是 gone，403 是 blocked', () => {
    assert.equal(classifyAsset({ ...base, status: 404, contentType: 'image/jpeg', byteLength: 0 }).verdict, 'gone');
    assert.equal(classifyAsset({ ...base, status: 403, contentType: 'image/jpeg', byteLength: 0 }).verdict, 'blocked');
  });
});

describe('路线定义', () => {
  const routes = buildRoutes({ username: 'x', includeCatalog: true });
  const cover = routes.find((r) => r.key === 'asset.subject_cover');

  test('存在，且走 asset 面', () => {
    assert.ok(cover, '没有这条路线');
    assert.equal(cover.surface, 'asset');
  });

  test('归 catalog 段 —— 封面是目录数据，可整批丢弃', () => {
    // 判据是「谁上传的」，不是「长什么样」（规范 §6.6.2）。用户自己上传的图才进
    // assets-*。分错的后果不是显示问题，是留存等级错位。
    assert.equal(cover.kind, 'catalog');
    assert.equal(cover.intent, 'asset.image.catalog_thumbnail');
  });

  test('排在作品详情页之后', () => {
    // 封面是从详情页里抽出来的，详情页没抓到就无从谈起。
    assert.ok(cover.priority > PRIORITY.CATALOG, '优先级必须低于作品详情页');
  });

  test('是叶子：不分页、不有序', () => {
    // 有序的话，一张图取不到会连带堵死其余几千张。
    assert.equal(cover.pagination, undefined);
    assert.equal(cover.ordered, false);
  });

  test('includeCatalog:false 时不出现', () => {
    const lean = buildRoutes({ username: 'x', includeCatalog: false });
    assert.equal(lean.find((r) => r.key === 'asset.subject_cover'), undefined);
  });
});

describe('每个条目自己的 Referer', () => {
  const REFERER = 'https://movie.douban.com/subject/1292052/';

  /** 一条待抓的封面图。 */
  function pendingCover() {
    const f = new Frontier();
    f.enqueue({
      url: 'https://img1.doubanio.com/x.jpg',
      urlKey: 'https://img1.doubanio.com/x.jpg',
      routeKey: 'asset.subject_cover',
      intent: 'asset.image.catalog_thumbnail',
      ordered: false,
      referer: REFERER,
    });
    return f;
  }

  test('入队时带上', () => {
    assert.equal(pendingCover().snapshot()[0].referer, REFERER);
  });

  test('**必须挺过 checkpoint 这一趟**，不只是内存里的 restore', () => {
    // 这条测试原来测的是 `Frontier.restore(f.snapshot())`——**而暂停/恢复根本
    // 不走那条路**。真实路径是 `buildCheckpoint()` 把条目逐字段摊成 JSON，
    // `CrawlRunner.resume()` 再逐字段读回来，两处都是白名单。写完那条测试它就
    // 绿了，而 referer 在真实路径上是**丢的**（实测确认过）。
    //
    // 后果：被打断过的抓取里那些图带着空 Referer 去取，没被打断的不会——同一个
    // URL 的行为取决于中途有没有崩过。
    const cp = buildCheckpoint({
      bundleId: '20260801T000000Z-aaaaaa',
      frontier: pendingCover(),
      pacer: new Pacer({}),
      routes: new Map(),
      lastCaptureId: null,
      pauseReason: 'user_paused',
    });

    // ① 写得出去
    const onDisk = JSON.parse(JSON.stringify(cp)); // checkpoint 是要落成 JSON 的
    assert.equal(onDisk.frontier[0].referer, REFERER, 'checkpoint 里丢了 referer');

    // ② 读得回来。`CrawlRunner.resume()` 那一侧也是**白名单**——逐字段重建条目，
    //    漏一个不会报错，只会静默地少一样东西。在这里照抄一份来断言等于测我自己的
    //    副本，所以改成盯真正那份源码。
    const src = readFileSync(new URL('../src/crawl/runner.js', import.meta.url), 'utf-8');
    assert.match(
      src,
      /referer: it\.referer/,
      'CrawlRunner.resume() 重建条目时没把 referer 读回来',
    );
  });

  test('没给就是 null，不是 undefined', () => {
    // undefined 在 JSON 里会整个字段消失，两次序列化之后形状就不一样了。
    const f = new Frontier();
    f.enqueue({ url: 'u', urlKey: 'u', routeKey: 'r', intent: 'i' });
    assert.equal(f.snapshot()[0].referer, null);
  });
});

describe('整条链路：详情页 → 抽封面 → 取图 → 进 catalog 段', () => {
  /**
   * 搭一套真链路，只有 HTTP 层是假的。
   *
   * 比起单独测抽取器，这里守的是**接线**：抽取器再准，没有人调用它也是零张图。
   */
  async function run(imageResponse) {
    const store = new MemoryFileStore();
    const events = [];
    let now = 0;

    const pacer = new Pacer({ intervalMs: 1, jitterRatio: 0 });
    const gate = new RequestGate({ pacer, now: () => now, sleep: async (ms) => { now += ms; } });

    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      const isImage = url.includes('doubanio.com');
      const body = isImage
        ? new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]) // JPEG 头
        : enc.encode(SUBJECT_PAGE);
      const r = isImage ? imageResponse : { status: 200, contentType: 'text/html; charset=utf-8' };
      const bytes = r.body ?? body;
      return {
        status: r.status,
        url,
        headers: new Headers({ 'content-type': r.contentType }),
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    };

    const transport = new Transport({ gate, fetchImpl, now: () => now });
    const writer = new BundleWriter({
      store,
      account: { user_id: '10001', username: 'example' },
      now: () => new Date(1750000000000 + now),
    });
    const session = new SessionGuard();
    session.preflight(SUBJECT_PAGE);

    const frontier = new Frontier();
    const routeDefs = buildRoutes({ username: 'example', includeCatalog: true });
    const routes = new Map(routeDefs.map((r) => [r.key, r]));

    const SUBJECT = 'https://movie.douban.com/subject/34965089/';
    frontier.enqueue({
      url: SUBJECT,
      urlKey: SUBJECT,
      routeKey: 'interest.item',
      intent: 'interest.item',
      ordered: false,
    });

    const loop = new CrawlLoop({
      frontier, transport, writer, session, pacer, routes,
      onEvent: (e) => events.push(e),
    });
    await loop.run({ maxCaptures: 10 });
    const manifest = await writer.finalize();

    const name = indexFilename(writer.bundleId);
    const index = (await store.exists(name))
      ? dec.decode(await store.read(name)).trimEnd().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    return { index, events, calls, manifest };
  }

  test('封面被抓下来，写成 surface=asset 的一条捕获', async () => {
    const { index, calls } = await run({ status: 200, contentType: 'image/jpeg' });

    const img = index.find((e) => e.url.includes('doubanio.com'));
    assert.ok(img, '封面没有进档案');
    assert.equal(img.surface, 'asset');
    assert.equal(img.verdict, 'ok');
    assert.equal(img.route_key, 'asset.subject_cover');
    assert.equal(img.intent, 'asset.image.catalog_thumbnail');
    assert.match(img.content_type, /^image\//);
    // **进 catalog 段**：封面是目录数据，跟着作品详情页一起可丢。
    assert.match(img.segment, /^catalog-/);
    // 派生关系要留下：这张图是从哪一页上抽出来的。
    const page = index.find((e) => e.route_key === 'interest.item');
    assert.equal(img.parent_capture_id, page.capture_id);

    // Referer 必须是那张作品页，而不是路线上的静态值。
    const imgCall = calls.find((c) => c.url.includes('doubanio.com'));
    assert.equal(imgCall.init.headers['X-Override-Referer'], 'https://movie.douban.com/subject/34965089/');
  });

  test('图片取回来是封锁页 → 不判 ok，但照样存进档案', async () => {
    // 存下来才能在不重抓的前提下重训分类器。这条与页面的处理是同一条规则。
    const { index } = await run({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: enc.encode('<html><body><p>有异常请求，请输入验证码后继续</p></body></html>'),
    });
    const img = index.find((e) => e.url.includes('doubanio.com'));
    assert.ok(img, '判定失败的响应也必须进档案');
    assert.notEqual(img.verdict, 'ok');
  });

  test('**图片的字节不得被当成会话状态来读**', async () => {
    // 会话复核的做法是在响应里找导航栏的登录状态与用户 ID。图片没有导航栏，但
    // 图片的**字节**什么都可能有——EXIF、内嵌缩略图、任意元数据都可以带文本。
    //
    // 这里就构造这种情况：一张图片，它的字节里恰好出现了另一个账号的 USER_ID。
    // 若对它做会话复核，整场抓取会被判成「账号被换掉」当场停机——**用户什么都没
    // 做错，一张图片的元数据就废掉了一次几小时的抓取**。
    const poisoned = enc.encode(
      `\xff\xd8\xff\xe0<li class="nav-user-account">x</li>;window._GLOBAL_NAV = { USER_ID: "99999" };`,
    );
    const { index, events } = await run({
      status: 200,
      contentType: 'image/jpeg',
      body: poisoned,
    });

    const stopped = events.find((e) => e.type === 'stopped');
    assert.equal(stopped, undefined, `因为图片里的字节停机了：${JSON.stringify(stopped)}`);
    assert.ok(index.some((e) => e.url.includes('doubanio.com')), '图片没进档案');
  });
});

// ── 对着真实档案跑一遍 ──────────────────────────────────────────────────
//
// 上面那些是从真实页面里摘出来的片段；这一条是**整份档案**。片段测试证明不了
// 「没有第五种模板」，只有几千页真数据能。

describe('真实档案（有就跑，没有就跳过）', () => {
  test('2900+ 个作品详情页都抽得到封面，且形状对得上', () => {
    const dir = `${homedir()}/downloads/doubak-bundle-20260731T051333Z-786e5c`;
    let idxName;
    try {
      idxName = readdirSync(dir).find((f) => f.startsWith('index-'));
    } catch {
      return; // 这台机器上没有这份档案
    }
    if (!idxName) return;

    const caps = readFileSync(`${dir}/${idxName}`, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((o) => o.route_key === 'interest.item' && o.verdict === 'ok');

    const fds = new Map();
    const read = (o) => {
      if (!fds.has(o.segment)) fds.set(o.segment, openSync(`${dir}/${o.segment}`, 'r'));
      const buf = Buffer.alloc(o.length);
      readSync(fds.get(o.segment), buf, 0, o.length, o.offset);
      return gunzipSync(buf).toString('utf-8');
    };

    let ok = 0;
    let placeholder = 0;
    const notFound = [];
    for (const o of caps) {
      const r = extractCoverImage(read(o));
      if (r.url) {
        ok += 1;
        // 抽到的必须是**目录图片**，不能是界面资源或头像。
        assert.match(r.url, /^https:\/\/img\d\.doubanio\.com\//, o.url);
        assert.ok(!/\/(f|cuphead)\/|\/icon\//.test(r.url), `抽到了界面资源：${r.url}`);
      } else if (r.reason === 'placeholder') {
        placeholder += 1;
      } else {
        notFound.push(o.url);
      }
    }

    assert.ok(caps.length > 2000, `只找到 ${caps.length} 个作品详情页，档案不对`);
    // **一个 not_found 都不许有。** 有的话就是遇到了没见过的模板，那正是这条
    // 测试存在的意义——它会指名道姓地告诉你是哪一页。
    assert.deepEqual(notFound.slice(0, 5), [], `${notFound.length} 页没找到封面容器`);
    assert.ok(ok / caps.length > 0.99, `抽到率只有 ${((ok / caps.length) * 100).toFixed(1)}%`);
    assert.ok(placeholder < caps.length * 0.01, `占位图比例异常：${placeholder}`);
  });
});
