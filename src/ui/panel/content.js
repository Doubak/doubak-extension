/**
 * 「查看内容」：把这一份档案里的页面解析成条目显示出来。
 *
 * ## 它要回答的问题只有一个
 *
 * **「抓到的确实是我的东西吗。」**
 *
 * 在这之前，用户手上是一堆 WARC，而要看清里面有什么得先装 Node、clone 两个仓库、
 * 跑两条命令——对多数人来说那就是链路的终点。「翻看捕获」能看的是**生的**那一面
 * （URL、判定、时刻），证明字节在；这一页看的是**熟的**那一面，证明那些字节是
 * 你的短评、你的广播、你写的评语。
 *
 * ## 刻意不做的
 *
 * **不做站点。** 站点生成器已经是那个东西——有封面、有固定链接、有搜索。这里做成
 * 第二个阅读器只会两头不讨好，而且迟早与真正的那份不一致。这里是**抽查**。
 *
 * **不缓存、不预处理。** 每次点开都现解析。缓存意味着第二份真相，而这个面板已经
 * 为这件事付过三次代价（`invalidateBundles`、用量陈旧、导出之后那句警告不刷新）。
 * 现解析也够快：一条捕获取出、解压、抽取合计约 15 毫秒，而只解析看得见的那些。
 *
 * ## 抽取器是解析器那一份的拷贝，不是另写的
 *
 * 见 `tools/sync-extractors.mjs`。另写一份浅的会漂，而漂的代价是「面板说的」与
 * 「解析出来的」不一样——那正是这一页想消除的疑虑。
 *
 * ## 显示的是这一份档案的全部内容，不是「本次新增」
 *
 * 增量抓取会重读最新几页列表，所以一份增量档案里的广播多半上次就存过了。把它说成
 * 「本次新增」是句错话，页面上的提示因此写的是「这一份档案里的内容」。
 */

import { $ } from './shared.js';
import { extractMarks } from '../../vendor/parser/extract.js';
import { extractBroadcasts } from '../../vendor/parser/extract-broadcast.js';
import { extractLongform } from '../../vendor/parser/extract-longform.js';
import { extractDoulist } from '../../vendor/parser/extract-doulist.js';

/**
 * 一次解析多少**页**捕获。
 *
 * 单位是页不是条：一页标记列表有十五条，一页广播二三十条，所以 30 页已经是好几百
 * 条摊在屏幕上了。真实档案里标记列表有 244 页——把上限定得高一点看似大方，实际
 * 只是让人多滚一会儿，而这一页要回答的问题（「抓到的确实是我的东西吗」）在头几屏
 * 就已经答完了。要通读请用站点生成器，那才是为阅读做的东西。
 */
const PAGE = 30;

/**
 * intent → 这一类叫什么、怎么抽。
 *
 * **按 intent 分流，不按 URL 猜**。intent 是抓取时写下的「我们为什么取这一页」，
 * 是规范里三个不可恢复字段之一；URL 形状会变，intent 不会。
 *
 * ## `extract` 一页一页地出，`merge` 是给「一条记录横跨几页」准备的
 *
 * 多数路线是一页多条：一页标记列表十五个标记，一页广播二三十条广播，各页之间没有
 * 关系，抽出来直接就能画。**豆列不是**——一份豆列每页 25 个条目，五十个条目就是
 * 三页，而那三页说的是**同一份豆列**。不合并的话，一份豆列在页面上出现三次，
 * 条数还各不相同（25 / 25 / 8），读起来像是重复，或者像是三份同名的豆列。
 *
 * 所以豆列这一类的 `extract` 交出的是**零件**，由 `merge` 合成能画的行。合并规则
 * 与解析器一致（`parse.js` 的 `doulistPages`）：按 `start` 升序拼接条目——
 * **次序是内容的一部分**，用户排过的清单，把第二页排到第一页前面就是改了内容。
 */
const KINDS = [
  {
    key: 'broadcast',
    name: '广播',
    match: (i) => i === 'broadcast.timeline',
    // 广播要按 uid 过滤掉转发进来的别人的内容，所以要知道自己是谁。
    extract: (html, { userId }) => extractBroadcasts(html, userId).broadcasts.map((b) => ({
      title: b.action ?? '广播',
      meta: [b.postedAt, b.rating ? '★'.repeat(b.rating) : null].filter(Boolean).join(' · '),
      own: b.text,
    })),
  },
  {
    key: 'mark',
    name: '标记',
    match: (i) => i.startsWith('interest.list.'),
    extract: (html, { intent }) => extractMarks(html, intent.split('.')[2]).marks.map((m) => ({
      title: m.title ?? '（标题抽不出来）',
      meta: [m.date, m.rating ? '★'.repeat(m.rating) : null, (m.tags ?? []).join(' ')]
        .filter(Boolean).join(' · '),
      own: m.comment,
    })),
  },
  {
    key: 'longform',
    name: '日记 / 影评',
    match: (i) => i === 'note.item' || i === 'review.item',
    extract: (html, { intent }) => {
      const r = extractLongform(html, intent === 'note.item' ? 'note' : 'review');
      return r ? [{
        title: r.title ?? '（无标题）',
        meta: [r.publishedAt, r.location].filter(Boolean).join(' · '),
        own: r.body,
      }] : [];
    },
  },
  {
    key: 'doulist',
    name: '豆列',
    match: (i) => i === 'doulist.item',
    // 零件：这一页属于哪份豆列、是第几页起。见上面 KINDS 的说明。
    extract: (html, { url }) => {
      const d = extractDoulist(html, url);
      return d ? [{ id: d.id, start: startOf(url), d }] : [];
    },
    merge: (parts) => {
      /** @type {Map<string, object[]>} */
      const by = new Map();
      for (const p of parts) by.set(p.id, [...(by.get(p.id) ?? []), p]);

      return [...by.values()].map((pages) => {
        // 次序是内容的一部分，所以按 start 升序拼，不按抓取顺序。
        pages.sort((a, b) => a.start - b.start);
        const { d } = pages[0];
        const items = pages.flatMap((p) => p.d.items);
        // 条目上自己写的评语——那才是这条路线的价值所在。
        const notes = items.filter((i) => i.comment)
          .map((i) => `${i.title ?? '（未命名）'}：${i.comment}`);
        // **只数出过条目的那些页。** 一份豆列的末尾常常跟着一两页空的：没有翻页器的
        // 豆列（实测 6 份里有 4 份）只能靠「再要一页、拿回来是空的」才知道到头了，
        // 那一页照样进档案。把它算进来，一份只有 1 个条目的豆列会写着「由 3 页拼成」
        // ——说的是抓取过程，而这一行说的是这份豆列。整份档案抓了多少页在最上面那行。
        const filled = pages.filter((p) => p.d.items.length > 0).length;
        return {
          title: (d.visibility === 'public' ? '' : '🔒 ') + (d.title ?? '（无标题）'),
          meta: `${items.length} 个条目 · ${notes.length} 条评语`
            + (filled > 1 ? ` · 由 ${filled} 页拼成` : ''),
          own: notes.join('\n'),
        };
      });
    },
  },
];

/** 豆列翻页写在 `?start=25` 里（routes.js：步长 25，实测出来的）。 */
function startOf(url) {
  return Number(/[?&]start=(\d+)/.exec(String(url ?? ''))?.[1] ?? 0);
}

let current = null;

/** 这一份档案里有哪几类、各多少条捕获。 */
function tally(entries) {
  return KINDS
    .map((k) => ({ ...k, rows: entries.filter((e) => e.verdict === 'ok' && k.match(String(e.intent ?? ''))) }))
    .filter((k) => k.rows.length > 0);
}

/**
 * 画一条。用户自己写的字单独一块，与豆瓣的目录数据分开——
 * 不分开的话，读的人分不出哪句话是自己写的，而这一页的全部意义就在那几句。
 */
function itemEl({ title, meta, own }) {
  const el = document.createElement('div');
  el.className = 'content-item';
  const t = document.createElement('div');
  t.className = 't';
  t.textContent = title;
  el.append(t);
  if (meta) {
    const m = document.createElement('div');
    m.className = 'm';
    m.textContent = meta;
    el.append(m);
  }
  if (own) {
    const o = document.createElement('div');
    o.className = 'own';
    o.textContent = own;
    el.append(o);
  }
  return el;
}

/** 抽不出来的那些也要露面 —— 静静吞掉会让这一页看起来比实际完整。 */
function badEl(text) {
  const el = document.createElement('div');
  el.className = 'content-item bad';
  const t = document.createElement('div');
  t.className = 't';
  t.textContent = text;
  el.append(t);
  return el;
}

/**
 * 渲染某一类。
 *
 * `reader` 是**传进来的**，不是 import 的：档案页已经建好了一个 `BundleReader`，
 * 而这个模块反过来 import 档案页会成环（档案页要 import 它来渲染）。
 * `test/ui-modules.test.js` 守着不许有环。
 *
 * @param {object} kind
 * @param {{reader: object, userId: string|null}} ctx
 */
async function renderKind(kind, ctx) {
  const box = $('content-list');
  box.className = 'muted';
  box.textContent = `正在解析 ${kind.name}…`;

  const rows = kind.rows.slice(0, PAGE);
  const collected = [];
  let failed = 0;

  for (const row of rows) {
    try {
      const r = await ctx.reader.readEntry(row);
      collected.push(...kind.extract(
        r.bodyText, { intent: String(row.intent), url: row.url, userId: ctx.userId },
      ));
    } catch {
      // 抽取器抛了：**报出来，不吞掉**。这一页是用来建立信任的，
      // 一个静静少掉的条目比一句「这条读不出来」糟得多。
      failed += 1;
    }
  }

  // 横跨几页的记录在这里合成一条（目前只有豆列）。见 KINDS 的说明。
  const items = kind.merge ? kind.merge(collected) : collected;
  const out = document.createElement('div');
  for (const it of items) out.append(itemEl(it));

  box.className = '';
  box.replaceChildren(scopeEl({ kind, shown: items.length, failed }), out);
  if (!items.length && !failed) out.append(badEl('这一类里没有解析出条目'));
}

/**
 * 「解析了前 30 页（共 244 页），列出 812 条」——**摆在清单最上面**。
 *
 * 原来这句话缀在清单末尾，而这一页恰恰是给「只看前几屏」准备的：滚到底才知道
 * 自己看的不是全部，等于没说。
 *
 * 条数只能在解析完之后才知道，所以这个元素是**最后造、插到最前面**的。上面那排
 * 类别按钮写的是**页数**（`广播（173 页）`），因为那才是 index 里现成有的数——
 * 把页数写成不带单位的 `广播（173）`，读的人会当成一百七十三条广播，而实测一份
 * 档案里那 173 页装着好几千条。
 */
function scopeEl({ kind, shown, failed }) {
  const el = document.createElement('div');
  el.className = 'muted small content-scope';
  const total = kind.rows.length;
  const bits = [total > PAGE
    ? `解析了前 ${PAGE} 页（共 ${total} 页），列出 ${shown} 条 —— 这一页是抽查，不是完整阅读`
    : `解析了全部 ${total} 页，列出 ${shown} 条`];
  if (failed) {
    bits.push(`另有 ${failed} 页没能解析出内容（原始字节仍在档案里，可在「翻看捕获」中查看）`);
  }
  el.textContent = bits.join('；');
  return el;
}

/**
 * 画类别切换条并渲染第一类。
 *
 * @param {{entries: object[], reader: object, userId: string|null}} ctx
 */
export async function renderContent(ctx) {
  const kinds = tally(ctx.entries);
  const bar = $('content-kinds');
  bar.replaceChildren();

  if (!kinds.length) {
    $('content-list').className = 'muted';
    $('content-list').textContent = '这份档案里没有可解析成条目的页面（例如只抓了图片或详情页）。';
    return;
  }

  for (const k of kinds) {
    const b = document.createElement('button');
    b.className = 'act';
    // **带单位**：这个数是捕获的**页数**，不是条数。见 `scopeEl`。
    b.textContent = `${k.name}（${k.rows.length} 页）`;
    b.setAttribute('aria-selected', String(k.key === (current ?? kinds[0].key)));
    b.addEventListener('click', () => {
      current = k.key;
      for (const other of bar.querySelectorAll('button')) {
        other.setAttribute('aria-selected', String(other === b));
      }
      void renderKind(k, ctx);
    });
    bar.append(b);
  }

  const pick = kinds.find((k) => k.key === current) ?? kinds[0];
  current = pick.key;
  await renderKind(pick, ctx);
}

/** 换档案时忘掉上次选的类别。 */
export function resetContent() {
  current = null;
}
