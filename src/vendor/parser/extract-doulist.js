/* 【自动同步，请勿手改】来自 doubak-data-parser 的 src/extract-doulist.js
 * 改动请在解析器仓库里做，然后运行 node tools/sync-extractors.mjs。
 * 理由见 tools/sync-extractors.mjs：两份实现对同一段 HTML 得出不同结论，只是早晚的事。
 */
/**
 * 从豆列页抽出清单本身与它的条目。
 *
 * ## 这条路线的价值全在「评语」上
 *
 * 一份豆列的其余字段——标题旁的封面、条目的简介、评分——**全是豆瓣的目录数据**，
 * 随处可得，豆瓣没了也能从别处补。只有挂在每个条目上的 `comment`（页面上写作
 * 「评语：」）是用户自己写的，豆瓣不导出，档案里也没有第二处能推出它。
 *
 * 实测三份真实自建豆列：24/25、9/15、9/12 条带评语，其中一份是带价格和购买渠道的
 * 游戏消费流水。**抽取器坏在别的字段上只是丢目录数据，坏在这个字段上是丢用户的字。**
 *
 * ## 两种形态共用一个抽取器
 *
 * | | 条目 | 带评语 | 是什么 |
 * |---|---|---|---|
 * | 游戏购买小账本 | 25 | 24 | 自己写的流水 |
 * | 我的收藏 | 25 | **0** | 纯书签夹，每条都指向他人的 `/review/` |
 *
 * 「一条评语都没有」是**合法形态**，不是抽取失败。把它当故障，这一类豆列每次抓取
 * 都会报一次假警——而假警报多了，真警报就没人看了。
 *
 * ## 抽取面在 `data-*` 上，不在渲染出来的文字上
 *
 * 每个条目里有一个「添加到豆列」按钮，它带着这一条的全部要害：
 *
 *     <a data-id="30237482" data-cate="3114"
 *        data-url="https://www.douban.com/subject/30237482/"
 *        data-title="刺客信条 奥德赛" data-picture="https://…/s35253256.jpg"
 *        class="lnk-doulist-add">
 *
 * 比解析标题块稳得多。tofu 也是从这里抽的——两套实现独立选中同一处，是这个判断
 * 可靠的旁证。
 *
 * ## ⚠ 校准样本是浏览器另存的页面，不是抓取到的字节
 *
 * `extract-longform.js` 顶上记着一次真实的教训：浏览器另存的那份跑过 JS，`<h1>`
 * 里已经是纯文字；而抓取拿到的原始 HTML 里 `<h1>` 套着 `<span property="v:summary">`。
 * **照另存的那份写选择器会在真实数据上落空。**
 *
 * 这里的样本同样是另存的。降低风险的做法是只用**服务端渲染**的抽取面：`data-*`
 * 属性、`blockquote.comment`、`id="doulist-info"`——这些不可能由前端脚本生成。
 * 检查过那 4 份样本里没有 `<base href>`、没有「saved from url」注释、没有相对化的
 * 资源路径，也就是说它们是「另存源码」而不是「另存完整网页」。
 *
 * **但这仍然是推断，不是测量。** 第一次真实抓取之后必须拿真实字节复核一遍——
 * 尤其是 `visibility` 那一条，它错了会把用户明确隐藏的东西发出去。
 */

import { decodeEntities } from './html-entities.js';

/** 去标签、合空白、解实体。用户文本一律走这里。 */
function text(s) {
  if (typeof s !== 'string') return null;
  const t = decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  return t || null;
}

/** 属性取值，允许单双引号（豆瓣两种都用过）。 */
function attr(tag, name) {
  const m = new RegExp(`${name}=(?:"([^"]*)"|'([^']*)')`).exec(tag);
  const v = m ? (m[1] ?? m[2]) : null;
  return v == null ? null : (decodeEntities(v) || null);
}

/**
 * 一份豆列的可见性。
 *
 * **三个取值，不是两个。** 判据是详情页 `<h1>` 里有没有 `is-private`：
 *
 *   在   → private
 *   不在 → public
 *   连 `<h1>` 都找不到 → **unknown**
 *
 * 把「抽取失败」并进「公开」，等于在豆瓣改版那天把所有私密豆列静默变成公开——
 * 而用户已经明确表达过「不公开」。发布路径必须把 unknown 当 private 处理：漏发一份
 * 公开豆列，用户看得见、可以改；误发一份私密豆列，撤不回来。
 *
 * **判据必须限定在 `<h1>` 内。** 索引页上也有同名的 `is-private`（在 `<h3>` 里，
 * 每条一个），而据档案主人实测**索引页那个不可靠**（本项目未复现其失效方式）。
 * 更要命的是索引页自己也有一个 `<h1>`（内容是「我的豆列」），所以把这个函数喂给
 * 索引页会一路走到「h1 里没有标记」→ public——一个错的答案，方向还是最坏的那个。
 * 所以**调用方必须先确认这份捕获是 `doulist.item`**。
 *
 * @param {string} html
 * @returns {'public'|'private'|'unknown'}
 */
export function extractVisibility(html) {
  if (typeof html !== 'string') return 'unknown';
  const h1 = /<h1>([\s\S]*?)<\/h1>/.exec(html);
  if (!h1) return 'unknown';
  return /class="is-private"/.test(h1[1]) ? 'private' : 'public';
}

/**
 * 索引页上的豆列链接。
 *
 * **每条有两处一模一样的地址**（封面一处、标题一处），实测 6 条抽出 12 个。限定在
 * `<h3>` 里就只剩一处，不必依赖去重——与舞台剧那次「3 部剧抽出 6 个 id」同一个坑。
 *
 * 只认 `/doulist/N`。「我关注的」那半边会混进
 * `doubanapp/dispatch?uri=/subject_collection/…`（豆瓣自己编的榜单），实测 5 条里有
 * 3 条是那种。采集端只抓自己编的，所以今天不会遇到；真要处理那半边，这里会**静默
 * 少三条**，得先解决那个形状。
 *
 * @param {string} html
 * @returns {string[]}
 */
export function extractDoulistLinks(html) {
  if (typeof html !== 'string') return [];
  const re = /<h3>\s*<a href="(https:\/\/www\.douban\.com\/doulist\/\d+\/?)"/g;
  const out = new Set();
  for (let m = re.exec(html); m; m = re.exec(html)) out.add(m[1]);
  return [...out];
}

/**
 * 一份豆列详情页。
 *
 * @param {string} html
 * @param {string} [url]  这一页的地址，用来取 id
 * @returns {object|null} 认不出来返回 null —— **不猜**
 */
export function extractDoulist(html, url) {
  if (typeof html !== 'string') return null;
  // 框架标志：认不出就别往下走。豆瓣以 200 送封锁页是既有事实，而一个「标题为 null、
  // 条目为空」的记录看起来跟一份空豆列一模一样。
  if (!/id="doulist-info"/.test(html)) return null;

  const id = /\/doulist\/(\d+)/.exec(String(url ?? '')) ?? /\/doulist\/(\d+)/.exec(html);
  if (!id) return null;

  const h1 = /<h1>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? '';
  const about = /<div class="doulist-about"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1];

  return {
    id: id[1],
    url: url ?? null,
    // `<h1>` 里除了标题还有那个私密图标，去标签之后剩下的就是标题。
    title: text(h1),
    description: text(about),
    visibility: extractVisibility(html),
    items: extractDoulistItems(html),
  };
}

/**
 * 一份豆列里的条目，按页面次序。
 *
 * **次序是内容的一部分**：用户排过的清单，重排等于改内容。所以这里返回数组而不是
 * 按 id 索引的对象。
 *
 * @param {string} html
 * @returns {object[]}
 */
export function extractDoulistItems(html) {
  if (typeof html !== 'string') return [];

  // **切片必须从 `<div` 开始。** 容器写作 `<div id="770340559" class="doulist-item">`
  // ——id 在 class 前面。只匹配 `class="doulist-item"` 的话，切片起点落在 id 后面，
  // 每一片里都找不到条目 id。抓取那边踩过同一个坑：实测 25 条抽出 0 条，而且不报错。
  const re = /<div\s+id="(\d+)"\s+class="doulist-item"/g;
  /** @type {{entryId: string, at: number}[]} */
  const marks = [];
  for (let m = re.exec(html); m; m = re.exec(html)) marks.push({ entryId: m[1], at: m.index });

  return marks.map(({ entryId, at }, i) => {
    const seg = html.slice(at, i + 1 < marks.length ? marks[i + 1].at : undefined);
    const btn = /<a\s[^>]*class="lnk-doulist-add"/.test(seg)
      ? /<a\s([\s\S]*?)class="lnk-doulist-add"/.exec(seg)?.[1] ?? ''
      : '';

    return {
      // 这一条「收藏动作」的 id。**不是作品的 id**——同一个作品可以出现在多份豆列里，
      // 所以身份是前者。作品 id 在 data-id 上。
      entryId,
      upstreamId: attr(btn, 'data-id'),
      // 豆瓣的内容类型码，**原样保留字符串，不要映射成 medium**：豆列里装得下作品
      // 之外的东西（实测 1012 是他人的评论，tofu 另见 3055 广播），而 medium 描述的
      // 是作品。翻译它等于把一个开放词表压进一个封闭词表。
      category: attr(btn, 'data-cate'),
      // 目标页的地址。**目标页不在档案里**——豆列条目的目标不跟进去抓，因为这一页
      // 已经带了标题/简介/评分/封面。所以这是个外部指针。
      url: attr(btn, 'data-url'),
      title: attr(btn, 'data-title'),
      coverUrl: attr(btn, 'data-picture'),
      abstract: text(/<div class="abstract">([\s\S]*?)<\/div>/.exec(seg)?.[1]),
      // 豆瓣的评分文本。**原样存字符串，不解析成数字，也绝不参与摘要**——它会自己
      // 变，拿它算摘要，豆瓣评分一动就凭空多一条修订。与长文正文吞进「1740人浏览」
      // 是同一类错。
      rating: text(/<div class="rating">([\s\S]*?)<\/div>/.exec(seg)?.[1]),
      source: text(/<div class="source">([\s\S]*?)<\/div>/.exec(seg)?.[1]),
      // **用户自己写的评语。** 这是整条路线存在的理由。
      // 「评语：」那三个字是 UI 标签不是内容，与「（全文）」「未知作品」同理：
      // **占位符不是内容**。
      comment: text((/<blockquote class="comment">([\s\S]*?)<\/blockquote>/.exec(seg)?.[1] ?? '')
        .replace(/<span>\s*评语：\s*<\/span>/, '')),
    };
  });
}

/**
 * 把**同一份豆列**的几页拼成一份。
 *
 * ## 为什么这条规则住在抽取器旁边
 *
 * 一份豆列每页 25 条（实测有 4 页的），所以「一份豆列」跨着好几次捕获。谁来拼、
 * 按什么次序拼，是一条规则；而这条规则原来有**两份实现**——解析器 `parse.js` 里
 * 一份，扩展面板的内容预览里一份。两份实现对同一份豆列可以给出不同的条目次序，
 * 而**次序错了看起来完全正常**：还是那些作品，还是那些评语。
 *
 * 这个仓库为「同一件事有好几份实现」付过一次明码标价的钱：`&#34;` 印在
 * sample.doubak.com 上，根因是四份各自演化的 HTML 实体解码表。所以这条规则收在
 * 产生这些页面的抽取器旁边，扩展那边按 `tools/sync-extractors.mjs` 原样拿过去。
 *
 * ## 按 `start` 升序，不按抓取顺序
 *
 * **次序是内容的一部分**：用户排过的清单，把第 2 页排到第 1 页前面就是改了内容。
 * 抓取顺序不可靠——广度优先的 frontier 会把几份豆列的页面交错排开，重试还会让某
 * 一页迟到。
 *
 * **分组不在这里做。** 两个调用方的分组键不一样（解析器按「哪份档案里的哪份豆列」，
 * 面板按豆列），而会悄悄出错的是拼接次序，不是分组。
 *
 * 传进来的对象原样回传（在 `pages` 里），所以调用方可以在上面挂自己的东西
 * ——解析器就靠这一点把每一页的 observation 带回去。
 *
 * @param {Array<{start: number, doulist: object}>} pages 同一份豆列的几页，次序随意
 * @returns {{doulist: object, pages: Array<{start: number, doulist: object}>} | null}
 *   `null` = 一页都没有
 */
export function mergeDoulistPages(pages) {
  const ordered = [...pages].sort((a, b) => a.start - b.start);
  if (!ordered.length) return null;
  return {
    // 标题、简介、可见性取第一页的：它们在每一页上都一样，而第一页是必然存在的那页。
    doulist: {
      ...ordered[0].doulist,
      items: ordered.flatMap((p) => p.doulist?.items ?? []),
    },
    pages: ordered,
  };
}
