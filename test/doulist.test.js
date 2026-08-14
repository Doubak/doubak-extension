/**
 * 豆列两条路线，对着**真实页面**验。
 *
 * ## 为什么这一组必须用真实页面
 *
 * 这条路线的判断几乎全是「量出来的」而不是「推出来的」，而这个仓库在「拿手上的样本
 * 推出一个封闭集合」上已经错过四次（游戏的评分与短评、广播附图的三种形态、日记的两种
 * URL、图片域名的收窄）。自己捏的夹具只会把当初的假设原样重放一遍。
 *
 * 夹具是档案主人从自己账号上另存的 4 份页面：
 *
 * | 文件 | 是什么 | 条目 | 带评语 |
 * |---|---|---|---|
 * | `doulists-index.html`            | 我创建的豆列（索引） | 6 | — |
 * | `doulist-detail-comments.html`   | 游戏购买小账本       | 25 | 24 |
 * | `doulist-detail-bookmarks.html`  | 我的收藏（纯书签夹） | 25 | **0** |
 * | `doulist-detail-private.html`    | SELECTS（私密）      | 1 | 0 |
 *
 * 后两份是**对照组**，不是凑数：一份证明「0 条评语」是合法形态而不是抽取失败，
 * 另一份证明私密标记在详情页上确实存在。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  profileForRoute, extractDetailLinks, extractItemPairs, extractPagination,
} from '../src/crawl/classifier.js';
import { buildRoutes } from '../src/crawl/routes.js';

const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf-8');

const INDEX = fixture('doulists-index.html');
const WITH_COMMENTS = fixture('doulist-detail-comments.html');
const BOOKMARKS = fixture('doulist-detail-bookmarks.html');
const PRIVATE = fixture('doulist-detail-private.html');
// **这两份是真实抓取到的字节**（bundle 20260814T223824Z-4b82f3），不是浏览器另存的。
// 上面那四份是另存的，够用来校准结构；而翻页这条判据关系到「还要不要再发一个请求」，
// 必须对着真的抓回来的东西验。
const PAGINATED = fixture('doulist-detail-paginated.html');
const SINGLE = fixture('doulist-detail-singlepage.html');

const routes = buildRoutes({ username: 'mewcatcher' });
const listRoute = routes.find((r) => r.key === 'doulist.list');
const itemRoute = routes.find((r) => r.key === 'doulist.item');

describe('豆列：路线定义', () => {
  test('索引路线的 intent 带 ownership —— 少了它，两类豆列在档案里分不开', () => {
    // 「我编的」与「我关注的」性质完全不同：前者每个字都是你写的，后者只是一个指向
    // 他人内容的书签。而 intent 是不可恢复的三个字段之一，bundle 有人跑过就冻结。
    assert.equal(listRoute.intent, 'doulist.list.created');
  });

  test('详情路线没有 entryUrl —— 有的话会被当成种子路线', () => {
    // 它的 URL 全部来自索引页。给了 entryUrl，`seedFrontier` 会拿它当入口去抓一个
    // 不存在的地址（实测：直接 Invalid URL）。与 note.item / interest.item 同理。
    assert.equal(itemRoute.entryUrl, undefined);
    assert.equal(itemRoute.ordered, undefined, '叶子集合不该被推成有序');
  });

  test('详情页自己翻页，基址跟着条目走', () => {
    // 实测 25 条那份，豆瓣自己的翻页器给的是 ?start=25 / ?start=50，所以页长可以写死。
    assert.equal(itemRoute.pagination.step, 25);
    const next = itemRoute.nextPageUrl({ url: 'https://www.douban.com/doulist/45473911/' }, 25);
    assert.equal(next, 'https://www.douban.com/doulist/45473911/?start=25');
  });

  test('算不出下一页时返回 null，而不是拼一个出来', () => {
    // 拼一个的后果是发一个注定 404 的请求——对一个「每个请求都算账」的工具，
    // 那是白扔风控预算。
    assert.equal(itemRoute.nextPageUrl({ url: 'https://www.douban.com/people/x/' }, 25), null);
    assert.equal(itemRoute.nextPageUrl({}, 25), null);
    assert.equal(itemRoute.nextPageUrl({ url: '' }, 0), null);
  });
});

describe('豆列：索引页（真实页面）', () => {
  const profile = profileForRoute('doulist.list');

  test('框架与条目锚点都命中', () => {
    assert.ok(profile.frameAnchors.every((re) => re.test(INDEX)), '框架标志没中');
    assert.ok(profile.urlAnchor.test('https://www.douban.com/people/mewcatcher/doulists/all'));
  });

  test('6 条豆列，一条不多一条不少', () => {
    const urls = extractDetailLinks(INDEX, profile);
    assert.equal(urls.length, 6);
    assert.ok(urls.every((u) => /\/doulist\/\d+\/$/.test(u)), `形状不对：${urls}`);
  });

  test('**每条有两处同样的链接，去重之后才是条目数**', () => {
    // 封面一处、标题一处。不去重就是 12 —— 与舞台剧那次「3 部剧抽出 6 个 id」同一个坑，
    // 而那次的后果是 highWaterIds 记错，下次增量在边界上去重会去错。
    const all = INDEX.match(/douban\.com\/doulist\/\d+/g) ?? [];
    assert.equal(all.length, 12, '真实页面上就是每条两处');
    assert.equal(new Set(all).size, 6);
  });

  test('id 与时间成对抽出来，一条都不缺', () => {
    const pairs = extractItemPairs(INDEX, profile);
    assert.equal(pairs.ids.length, 6);
    assert.equal(pairs.idless, 0, 'idless 大于 0 会触发 extractor_stale');
    assert.ok(pairs.times.every((t) => t), '每条都有「更新」时间');
  });

  test('**不取页面上那排数字当声称数**', () => {
    // 页面上写着「豆列(18) 片单(5) 书单(8) 地点豆列(3)」，但这条路线只抓「我创建的」，
    // 实测只有 6 条。拿 18 当分母会写出「声称 18 / 抓到 6」的永久假账，而 bundle 冻结、
    // 假账改不掉。佐证：档案主人实测「地点豆列(3)」点进去是 0 条，那排数字自己就不可信。
    assert.equal(profile.claimedCount, null);
    assert.match(INDEX, /豆列\(18\)/, '这排数字确实在页面上，是我们选择不用它');
  });
});

describe('豆列：详情页（真实页面）', () => {
  const profile = profileForRoute('doulist.item');

  test('三份形态各异的详情页，框架锚点都命中', () => {
    for (const [name, html] of [['带评语', WITH_COMMENTS], ['书签夹', BOOKMARKS], ['私密', PRIVATE]]) {
      assert.ok(profile.frameAnchors.every((re) => re.test(html)), `${name} 没中框架标志`);
    }
  });

  test('条目数与真实页面一致', () => {
    const count = (h) => extractItemPairs(h, profile).ids.length;
    assert.equal(count(WITH_COMMENTS), 25);
    assert.equal(count(BOOKMARKS), 25);
    assert.equal(count(PRIVATE), 1);
  });

  test('**条目的 id 是收藏动作的 id，不是作品的 id**', () => {
    // 容器写作 <div id="770340559" class="doulist-item">，而作品 id 在 data-id 上。
    // 同一个作品可以出现在多份豆列里，所以身份是前者。
    const { ids } = extractItemPairs(WITH_COMMENTS, profile);
    assert.ok(ids.every((i) => /^\d+$/.test(i)));
    assert.ok(ids.includes('770340559'));
    assert.equal(new Set(ids).size, ids.length, 'id 不该重复');
  });

  test('容器上 id 在 class 前面 —— 选择器不能假设属性顺序', () => {
    assert.match(WITH_COMMENTS, /<div\s+id="\d+"\s+class="doulist-item"/);
  });

  test('没有时间锚点，如实写成 null', () => {
    // 豆列条目不带时间。硬凑一个的后果是水位线算错，而水位线错了下次增量会从错的
    // 位置开始——比没有水位线糟得多。
    assert.equal(profile.timeAnchor, null);
  });
});

describe('豆列：私密标记（这一条错了会把用户明确隐藏的东西发出去）', () => {
  /** 判据：详情页 `<h1>` 里有没有 `is-private`。**必须限定在 h1 内**。 */
  const visibility = (html) => {
    const h1 = /<h1>([\s\S]*?)<\/h1>/.exec(html);
    if (!h1) return 'unknown';
    return /class="is-private"/.test(h1[1]) ? 'private' : 'public';
  };

  test('私密豆列判 private，公开的判 public', () => {
    assert.equal(visibility(PRIVATE), 'private');
    assert.equal(visibility(WITH_COMMENTS), 'public');
    assert.equal(visibility(BOOKMARKS), 'public');
  });

  test('**「找不到 h1」必须是第三种结果，不能并进 public**', () => {
    // 并进去的话，豆瓣改版那天所有私密豆列会静默变成公开——而用户已经明确表达过
    // 「不公开」。与封面抽取那条同理：「本来就没有」与「抽取失败」必须分开。
    assert.equal(visibility('<html><body>没有标题</body></html>'), 'unknown');
  });

  test('**这个判据只能用在详情页上，用在索引页上会得到错的答案**', () => {
    // 两件事叠在一起，任何一件单独看都不像问题：
    //
    //   1. 索引页把私密标记放在 `<h3>` 里（每条一个），而据档案主人实测**那个不可靠**
    //      （本项目未复现其失效方式，如实标注出处）；
    //   2. 索引页自己也有一个 `<h1>`，内容是「我的豆列」。
    //
    // 于是把这个判据喂给索引页，它会一路走到「h1 里没有 is-private」→ **public**。
    // 一个错的答案，而且方向正是最坏的那个：把私密说成公开。
    //
    // 所以判据不能只写成「在 HTML 里找」，必须先确认这一份捕获是 doulist.item。
    // 这条测试就是钉住那个前提的。
    assert.match(INDEX, /<h3>[\s\S]*?class="is-private"/, '索引页上确实也有一个标记');
    assert.match(INDEX, /<h1>\s*我的豆列\s*<\/h1>/, '而且它也有自己的 h1');
    assert.equal(
      visibility(INDEX), 'public',
      '这就是那个错的答案 —— 记录在案，提醒解析器必须先按 intent 分流',
    );
  });
});

describe('豆列：条目里真正值钱的是评语', () => {
  const comments = (html) => [...html.matchAll(/<blockquote class="comment">([\s\S]*?)<\/blockquote>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, '').replace('评语：', '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  test('自建豆列里 25 条有 24 条带评语', () => {
    const cs = comments(WITH_COMMENTS);
    assert.equal(cs.length, 24);
    assert.ok(cs.some((c) => c.includes('amazon')), `实测那条消费记录不见了：${cs[0]}`);
  });

  test('**0 条评语是合法形态，不是抽取失败**', () => {
    // 「我的收藏」是个纯书签夹：25 条全指向他人的 /review/，一条评语都没有。
    // 把「一条都没抽到」当成故障，会让这一类豆列每次抓取都报一次假警。
    assert.equal(comments(BOOKMARKS).length, 0);
    assert.equal(extractItemPairs(BOOKMARKS, profileForRoute('doulist.item')).ids.length, 25);
  });

  test('评语与豆瓣写的简介必须分开 —— 一个是你写的，一个不是', () => {
    assert.match(WITH_COMMENTS, /<div class="abstract">/, '简介是目录数据');
    assert.ok(comments(WITH_COMMENTS)[0].length > 0, '评语是用户数据');
  });
});

describe('豆列：翻页器决定还要不要再发一个请求', () => {
  const profile = profileForRoute('doulist.item');

  test('多页豆列：读得出「第几页 / 共几页」', () => {
    // 真实抓取的字节：<span class="thispage" data-total-page="3">1</span>
    assert.deepEqual(extractPagination(PAGINATED, profile), { page: 1, totalPages: 3 });
  });

  test('单页豆列没有翻页器，返回 null', () => {
    // **null 不等于「只有一页」。** 实测 6 份豆列里单页的都没有翻页器，但那是 n=6，
    // 不足以据此收尾——没有翻页器时退回原来的走法（走到空页为止）。
    assert.equal(extractPagination(SINGLE, profile), null);
  });

  test('**判据取当前页的数字，不取第一页的**', () => {
    // 一份豆列在抓取期间可以变长变短，每一页都带着它当时的总数。拿第一页的结论
    // 去判第五页，是拿一个过期的假设当事实。所以这个函数只吃一页的 HTML，
    // 压根没有「记住上次」的余地——这一条靠形状保证，不靠纪律。
    const p2 = PAGINATED.replace('data-total-page="3">1<', 'data-total-page="9">7<');
    assert.deepEqual(extractPagination(p2, profile), { page: 7, totalPages: 9 });
  });

  test('残缺或不合理的翻页器一律当没有', () => {
    // 认不出来就退回原来的走法，而不是猜一个数——猜错的方向是**提前收尾**，
    // 那等于静默截断。
    assert.equal(extractPagination('<span class="thispage">1</span>', profile), null);
    assert.equal(extractPagination('<span class="thispage" data-total-page="0">0</span>', profile), null);
    assert.equal(extractPagination(null, profile), null);
    assert.equal(extractPagination(PAGINATED, { paginator: undefined }), null);
  });

  test('循环在「这一页说自己是最后一页」时收尾', () => {
    const src = readFileSync(new URL('../src/crawl/loop.js', import.meta.url), 'utf-8');
    const fn = src.slice(src.indexOf('_enqueueNextPage('), src.indexOf('function itemTimeRange'));
    assert.match(fn, /pg\.page >= pg\.totalPages/);
    // **必须排在算下一页地址之前**，否则省不掉那个请求——而省掉它正是这条的全部目的。
    assert.ok(
      fn.indexOf('pg.page >= pg.totalPages') < fn.indexOf('const nextUrl'),
      '这道判断要在算下一页之前',
    );
  });

  test('**没有翻页器时不许自作主张收尾**', () => {
    // 「没有翻页器 ⇒ 只有一页」是从 6 份豆列推出来的。这个仓库在「拿手上的样本推出
    // 一个封闭集合」上已经错过四次，而这一次猜错的后果是每份豆列只存前 25 条，
    // 而且不报错。
    const src = readFileSync(new URL('../src/crawl/loop.js', import.meta.url), 'utf-8');
    const fn = src.slice(src.indexOf('_enqueueNextPage('), src.indexOf('function itemTimeRange'));
    assert.match(fn, /if \(pg &&/, '判断必须先确认 pg 存在');
  });
});
