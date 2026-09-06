/* 【自动同步，请勿手改】来自 doubak-site-generator 的 src/projection.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/**
 * canonical → 投影。
 *
 * ## 投影是缓存，而且是**只读**的缓存
 *
 * CLAUDE.md 里那条硬性规则：**用户的编辑追加到 canonical，任何东西都不写投影**。
 * 投影一旦可写，就有了两个真相来源，「无摩擦导出」这个承诺随即作废。
 *
 * 所以这一层只做一件事：把「一条记录 + 它的全部修订」压成「当前是什么样」。
 * 那是有损的，而且**故意**有损——修订历史留在 canonical 里，随时能重新压一遍。
 *
 * ## 取最后一条修订，但要说清「最后」是什么意思
 *
 * 修订按 `first_observed_at` 升序，所以最后一条是**我们最后一次看到的样子**，
 * 不是「上游现在的样子」。两者的差别在这个项目里很实在：一条被删掉的标记，
 * 投影里仍然是它最后一次被看到的样子——那正是想要的，档案的意义就在这儿。
 */

/**
 * @param {object[]} marks       canonical 的 marks.ndjson
 * @param {object[]} subjects    canonical 的 subjects.ndjson
 * @param {object[]} longform    canonical 的 longform.ndjson
 * @param {object[]} broadcasts  canonical 的 broadcasts.ndjson
 * @param {object[]} doulists    canonical 的 doulists.ndjson
 */
export function project({ marks = [], subjects = [], longform = [], broadcasts = [], doulists = [] }) {
  const bySubject = new Map();
  for (const s of subjects) bySubject.set(`${s.medium}:${s.id}`, s);

  const byTarget = broadcastsBySubject(broadcasts, marks);
  const projectedMarks = mergeReMarks(marks).map(
    ({ current, superseded }) => projectMark(
      current,
      bySubject.get(`${current.medium}:${current.subject.id}`),
      byTarget.get(current.subject.id) ?? [],
      superseded,
    ),
  );

  return {
    marks: projectedMarks,
    longform: longform.map(projectLongform),
    doulists: doulists.map(projectDoulist),
    broadcasts: broadcasts.map((b) => projectBroadcast(b, targetIndex(projectedMarks), {
      subjects: new Set(subjects.map((s) => `${s.medium}:${s.id}`)),
      doulists: new Set(doulists.map((d) => d.upstream_id)),
      longform: new Set(longform.map((l) => l.upstream_id)),
    })),
  };
}

/**
 * 一个作品**一页**，哪怕它在豆瓣上被标记过两次。
 *
 * ## 为什么会有两条
 *
 * 用户在豆瓣上**删掉再重标**：豆瓣发一个新的条目 id，解析器据此如实分成两条记录
 * ——那是对的，两个不同的上游 id 就是两次不同的标记（`IDENTITY.md` §2.2：这正是
 * `data-cid` 唯一能看见、而降级键看不见的东西）。canonical 是事件日志，它必须
 * 留着两条。
 *
 * ## 但投影是「当前状态优先」的一张缓存，一个作品只有一个网址
 *
 * 原来这里不做处理，于是两条标记生成**同一个文件名**，后写的把先写的整个盖掉
 * ——先来后到决定谁活下来，而不是任何一条判据。实测《盗梦空间》：2018 年那条
 * 标记的短评与标签就这么从站点上消失了，git 里连一行新增都看不到（页数没变），
 * 只在那一页的 diff 里。**盖掉是静默的，这是最坏的一种。**
 *
 * 现在明确地选一条当页头，其余的**并进时间线**——旧那条的短评、评分、日期因此
 * 一样在页面上，位置也对（2018 年那一行），而不是假装从没发生过。
 *
 * 判据是**最后一次看到它是什么时候**：豆瓣现在还留着的那条，才是最近一次抓取里
 * 出现过的那条。按 `marked_at` 挑是不对的——重标的日期理论上可以更早（补标一部
 * 老片），而那条在豆瓣上仍然是现存的那一条。日期只用来打平手。
 *
 * @param {object[]} marks canonical 的标记
 * @returns {{current: object, superseded: object[]}[]}
 */
function mergeReMarks(marks) {
  /** @type {Map<string, object[]>} */
  const groups = new Map();
  for (const m of marks) {
    const key = `${m.medium}:${m.subject.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  const seenAt = (m) => latest(m).last_observed_at ?? '';
  const markedAt = (m) => latest(m).fields?.marked_at?.iso ?? '';

  return [...groups.values()].map((g) => {
    if (g.length === 1) return { current: g[0], superseded: [] };
    const sorted = [...g].sort((a, b) => {
      if (seenAt(a) !== seenAt(b)) return seenAt(a) < seenAt(b) ? 1 : -1;
      return markedAt(a) < markedAt(b) ? 1 : -1;
    });
    return { current: sorted[0], superseded: sorted.slice(1) };
  });
}

/**
 * 作品 id → 提到它、且带正文的广播。
 *
 * ## 这是这份档案里最值钱的一次连接
 *
 * 标记页上只剩**最新**那条短评：改一次就覆盖一次，而豆瓣不留历史。广播不一样——
 * 发布即冻结、带秒级时间戳，所以每条广播都是「那一刻我说了什么」的定点证据。
 *
 * 把两者接起来，就得到一条**「什么时候 → 说了什么」**的时间线，其中很大一部分
 * 是标记的修订历史里**根本不可能有**的：它们发生在第一次抓取之前。
 *
 * 实测那份档案：标记的修订历史只覆盖 3 条（几次抓取相隔不到一周），而广播里
 * 有 **342 条** 与当前短评不同的发言，涉及 305 个作品——两个数量级的差别。
 *
 * ## 但它不是「编辑检测」
 *
 * 实测那 342 条的构成：
 *
 *     305  状态推进 —— 想看时说一句，看过之后又说一句
 *      32  广播没有状态（转发、纯发言）
 *      15  同一状态下说了别的 —— 这些才最接近「改过」
 *
 * 也就是说 **89% 根本不是编辑，是先后说过的两句话**。把它们呈现成「检测到编辑」，
 * 就是档案在说假话——与「把占位符当标题」「把浏览计数当正文」同一类错。
 * 所以这里只做时间线，不下「改过」的判断。
 *
 * @param {object[]} broadcasts
 * @param {object[]} marks
 */
function broadcastsBySubject(broadcasts, marks) {
  // 跨媒介撞车的一律不接。广播上只有 data-object-id，没有媒介；接错了是档案在说
  // 假话，而且看不出来。（实测这份档案 0 个跨媒介撞车，但这条不能靠运气。）
  //
  // **同一媒介下的两条标记不算撞车**——那是「删掉再重标」，两条说的是同一部作品。
  // 判据与 `targetIndex` 必须一模一样：一边接得回、另一边接不回的话，广播卡片上
  // 有链接而作品页上没有时间线，两边都看不出是谁错了。
  const seen = new Map();
  for (const m of marks) {
    const id = m.subject.id;
    if (!seen.has(id)) { seen.set(id, m); continue; }
    const prev = seen.get(id);
    if (prev === null) continue;
    if (prev.medium !== m.medium) seen.set(id, null);
  }

  /** @type {Map<string, object[]>} */
  const out = new Map();
  for (const b of broadcasts) {
    const f = b.revisions[b.revisions.length - 1].fields;
    // **没有正文、只有状态的广播也要收。**
    //
    // 「2023-03-24 想看 / 2023-03-31 在看 / 2026-07-19 看过」——这三行一个字的
    // 短评都没有，却是这条标记完整的经过；而标记页上只剩一个「看过」加一个日期。
    // 实测：1721 个作品页现在**一点历史都没有**，而广播里记着它们的全过程。
    if (!f.target_id || seen.get(f.target_id) == null) continue;
    if (!f.text && !f.status) continue;
    if (!out.has(f.target_id)) out.set(f.target_id, []);
    out.get(f.target_id).push({
      at: f.posted_at?.iso ?? null,
      atRaw: f.posted_at?.raw ?? null,
      precision: f.posted_at?.precision ?? 'unknown',
      // 广播是**冻结**的：这句话在那一刻就是这样，之后再没变过。
      // 标记的短评则只是「我们最后一次看到的样子」。这个差别必须让读者看见。
      source: 'broadcast',
      textSource: f.text ? 'broadcast' : null,
      status: f.status ?? null,
      action: f.action ?? null,
      // **那一天给了几颗星。** 标记只留最新那个分（改一次覆盖一次，豆瓣不留历史），
      // 而广播冻结。实测这份档案里 17 部作品的分变过——那份变化史豆瓣自己没有。
      rating: f.rating ?? null,
      text: f.text,
      truncated: Boolean(f.text_truncated),
    });
  }
  return out;
}

/**
 * 把标记自己的修订与广播合成一条时间线，新的在上。
 *
 * **同样的话只留一次。** 实测有 10 条是用户转发自己的旧广播，正文一字不差——
 * 列两遍会让人以为他说了两次。
 *
 * @param {object[]} marks 这个作品的全部标记：当前那条，加上被顶掉的（删掉再重标）
 * @param {object[]} fromBroadcasts
 */
function buildTimeline(marks, fromBroadcasts) {
  const rows = [...fromBroadcasts];

  for (const r of marks.flatMap((m) => m.revisions)) {
    const f = r.fields;
    // 短评是空的也收——状态本身就是「什么时候」的答案。实测那三条有多个修订的
    // 标记里，有两条正是「空短评 → 写了短评」，只看短评的话这段经过整个消失。
    rows.push({
      at: f.marked_at?.iso ?? r.first_observed_at,
      atRaw: f.marked_at?.raw ?? null,
      precision: f.marked_at?.precision ?? 'unknown',
      // 标记页上的短评是**可变**的，这里记的是「我们某次抓取时看到的样子」。
      source: 'mark',
      textSource: f.comment ? 'mark' : null,
      status: f.status,
      action: null,
      // 标记页上的评分是**可变**的，与广播那个「那一天给了几颗星」性质不同。
      // 两者都收，归并时取有值的那个。
      rating: f.rating ?? null,
      text: f.comment,
      truncated: false,
    });
  }

  // ── 同一句话只留一条，留哪一条有讲究
  //
  // **① 精度高的优先。** 标记只到天，而 canonical 会把它补成 `T00:00:00`；广播
  // 到秒。单纯按时间早晚挑的话，那个补出来的 00:00:00 永远排在同一天的广播前面，
  // 于是**留下补零的、丢掉真的**——而 partial_date.precision 这个字段存在的全部
  // 意义就是防这件事（「补零之后它们看起来一样精确，那是假的」）。实测踩到过：
  // 那条「能上6分我觉得都是国产好片」的秒级时间就是这样被吃掉的。
  //
  // **② 精度相同时留最早的。** 「吹爆京阿尼」有 2018 的原帖和 2025 的自我转发，
  // 转发不是「又说了一遍」而是把旧的再推一次——这句话真正被说出口的时间是 2018 年。
  // ── 同一件事只留一条。要归并两次，因为「重复」有两种形状。
  //
  // **① 同一次标记被记了两遍。** 一次「玩过」会同时出现在广播里（带秒，但常常
  // 没有短评）和标记的修订里（有短评，但只到天）——同一件事，列两遍等于说他标了
  // 两次。按「状态 + 哪一天」归并：时间取精度高的，短评取有的那个，两样都不丢。
  //
  // **② 同一句话被说了两遍。** 用户转发自己的旧广播，正文一字不差。按正文归并，
  // 留最早的——转发不是「又说了一遍」，是把旧的再推一次（「吹爆京阿尼」的原帖
  // 在 2018 年，转发在 2025 年）。
  //
  // 精度为什么必须参与排序：标记只到天，canonical 会补成 `T00:00:00`，永远排在
  // 同一天的广播前面。单纯比早晚就会**留下补零的、丢掉真的**——而
  // partial_date.precision 存在的全部意义就是防这件事。实测踩到过。
  const RANK = { second: 0, minute: 1, hour: 2, day: 3, month: 4, year: 5, unknown: 6 };
  const rank = (r) => RANK[r.precision] ?? 6;

  /** @type {Map<string, object>} */
  const byEvent = new Map();
  for (const r of rows) {
    const key = `${r.status ?? ''}@${(r.at ?? '').slice(0, 10)}`;
    const prev = byEvent.get(key);
    if (!prev) { byEvent.set(key, { ...r }); continue; }
    const base = rank(r) < rank(prev) ? r : prev;
    const withText = prev.text ? prev : (r.text ? r : null);
    const withRating = prev.rating != null ? prev : (r.rating != null ? r : null);
    byEvent.set(key, {
      ...base,
      text: withText?.text ?? null,
      // 星数与短评一样，可能来自被丢掉的那一条：广播给了准确到秒的时间，
      // 而分可能记在标记那一侧（或反过来）。只按 `...base` 取的话会时有时无。
      rating: withRating?.rating ?? null,
      truncated: prev.truncated || r.truncated,
      // 归并之后**时间和短评可能来自不同的地方**：广播给了准确到秒的时间，
      // 短评却在标记页上。分开记下来，页面上才能说准——否则会读成
      // 「那条广播里写着这句话」，而广播里其实什么都没写。
      textSource: withText?.source ?? null,
    });
  }

  const merged = [...byEvent.values()].sort((a, b) => {
    const p = rank(a) - rank(b);
    if (p !== 0) return p;
    return (a.at ?? '') < (b.at ?? '') ? -1 : 1;
  });

  const seenText = new Set();
  const kept = merged.filter((r) => {
    if (!r.text) return true;
    if (seenText.has(r.text)) return false;
    seenText.add(r.text);
    return true;
  });

  // 归并完再按时间倒序排给页面用。
  kept.sort((a, b) => ((a.at ?? '') < (b.at ?? '') ? 1 : -1));
  return kept;
}

/**
 * 作品 id → 标记，用来把广播接回本地的作品页。
 *
 * **跨媒介撞车的一律不接。** 广播上只有 `data-object-id`，没有媒介；而不同媒介的
 * id 是各自编号的，理论上会撞。撞了还硬接的话，页面上会出现一条指向另一部作品的
 * 链接——**那比不接严重得多**：不接只是少个链接，接错了是档案在说假话，而且看不
 * 出来。
 *
 * ## 这里的「撞车」只可能是跨媒介的，而那是上游保证的
 *
 * 入参是**投影过的**标记，而 `mergeReMarks` 已经按 `媒介:作品id` 归过组——所以
 * 到这一步，两条记录共用一个 `subjectId` 就只可能是媒介不同。判据因此仍然只看
 * id，不必再比一次媒介：那个比较永远为真，而一个永远为真的判断读起来像是在防
 * 什么，实际什么都没防。
 *
 * **这条依赖必须写下来**，因为它一度不成立：`mergeReMarks` 之前，用户在豆瓣上
 * 删掉再重标（豆瓣发一个新条目 id，解析器如实分成两条记录）会让同一部电影出现
 * 两条标记，于是这里判撞车、拒绝接链。实测《盗梦空间》：2018 年那条广播的链接与
 * 封面**一起消失**，作品页上整个「说过什么」栏目也没了——而那正是这份档案最不可
 * 替代的部分（豆瓣自己已经不显示 2018 年那条了）。
 */
function targetIndex(projectedMarks) {
  /** @type {Map<string, object|null>} null = 跨媒介撞车了，不许接 */
  const out = new Map();
  for (const m of projectedMarks) {
    if (out.has(m.subjectId)) out.set(m.subjectId, null);
    else out.set(m.subjectId, m);
  }
  return out;
}

/**
 * 一条广播。
 *
 * 广播是这套档案里**最不可替代**的东西：发布即冻结、可以被静默删除，所以每条都是
 * 「那一刻这句话是什么样」的带日期快照。标记页上的短评会被后来的编辑覆盖，广播里
 * 的不会。
 */
function projectBroadcast(b, targets, have = { subjects: new Set(), doulists: new Set(), longform: new Set() }) {
  const r = b.revisions[b.revisions.length - 1];
  const f = r.fields;
  const target = f.target_id ? (targets.get(f.target_id) ?? null) : null;

  return {
    kind: 'broadcast',
    id: b.upstream_id,
    url: stableStatusUrl(b.url, b.account?.user_id),
    postedAt: f.posted_at?.iso ?? null,
    postedAtRaw: f.posted_at?.raw ?? null,
    text: f.text ?? null,
    action: f.action ?? null,
    // 动作句里那几个链接，已经判好该指本地还是指豆瓣。null = 这句话里没有链接。
    actionParts: resolveActionParts(f.action_parts ?? null, have),
    status: f.status ?? null,
    // 发这条广播时给的星数，见上。
    rating: f.rating ?? null,
    targetId: f.target_id ?? null,
    // 卡片上那个作品名。**接不回本地作品页时，靠它才说得出这条广播在讲什么**——
    // 实测 162 条广播指向本地没有的条目（被豆瓣删了、或豆列这类不产生标记的东西）。
    targetTitle: f.target_title ?? null,
    // 接得回本地作品页的才接。接不回来的（撞车、或者那个作品根本没被标记过）
    // 保持 null——宁可少一个链接。
    target: target ? { medium: target.medium, subjectId: target.subjectId, title: target.title } : null,
    images: f.images ?? [],
    // 正文被豆瓣截断了，`text` 只是开头。**页面上必须说出来**——
    // 显示半截正文而不声明，站点就在替档案说假话。
    textTruncated: Boolean(f.text_truncated),
    // 全文在哪。实测它指向的是一篇日记，而日记的全文本来就在档案里，
    // 所以这里把它接回**本地**的那一页，而不是回退到豆瓣。
    fullText: f.full_text_url ? localLongform(f.full_text_url) : null,
    lastSeenAt: r.last_observed_at,
  };
}

/**
 * 把「全文」的豆瓣 URL 换成本地长文页的相对路径。
 *
 * 接不上就返回 null，**不回退到豆瓣的 URL**——那会让一份号称离线可看的档案
 * 为了一段正文去联网。接不上时页面只说「被截断了」，那是实话。
 *
 * @param {string} url
 */
function localLongform(url) {
  const m = /\/(note|topic|review)\/(\d+)/.exec(url);
  if (!m) return null;
  // /topic/ 与 /note/ 是同一种东西的两种 URL 形状，都落在 note/ 目录下。
  return { kind: m[1] === 'review' ? 'review' : 'note', id: m[2] };
}

/**
 * 动作句里那几个链接，各自该指到哪儿。
 *
 * ## 判据不是「本地有没有」，是「这一类东西我们收不收」
 *
 * 这两件事必须分开，混起来就会违反那条写了三遍的规矩（作品名接不回本地时
 * **绝不回退到豆瓣的 URL**）：
 *
 * | 这一类 | 本地有 | 本地没有 |
 * |---|---|---|
 * | **收**（作品 / 豆列 / 长文） | 站内链接 | **不给链接**，只留文字 |
 * | **不收**（相册 / 小组 / 榜单 / 影人 / 短链） | —— | 豆瓣链接（主题给它加 ↗ 角标） |
 *
 * 第一行是内容：作品是这份存档要替代豆瓣的东西，接不回来就说明这份档案缺了它，
 * 而给个站外链接等于把「缺了」粉饰成「在那边」。第二行不是内容：作品相册里的照片
 * **明确不在范围内**（CLAUDE.md 与 routes.js 的 `UNSUPPORTED_ROUTES` 都写着，判据是
 * 「它属于条目，不属于账号」），小组与影人页同理。对它们，指出去才是诚实的——
 * 这份存档从没声称收过它们。
 *
 * ## 认不出来的形状，按「不收」处理
 *
 * 我们只收三类，而这三类的 URL 形状都认得出。**认不出 = 不是这三类 = 我们没收**，
 * 所以指出去。反过来（认不出就不给链接）会让相册这类东西悄悄变成一句点不动的话，
 * 而那正是这个功能要修的毛病。豆瓣哪天新加一种作品 URL 形状会落进这一支——
 * 代价是那个作品链到豆瓣而不是本地，`test/pages.test.js` 里钉着这三类的形状。
 *
 * @param {{text: string, url?: string}[]|null} parts
 * @param {{ subjects: Set<string>, doulists: Set<string>, longform: Set<string> }} have
 * @returns {{text: string, href?: string, external?: boolean}[]|null}
 */
function resolveActionParts(parts, have) {
  if (!parts) return null;
  return parts.map((p) => {
    if (!p.url) return { text: p.text };

    // **必须钉到结尾。** 作品的 URL 是相册与讨论的**前缀**：
    //
    //     作品   https://www.douban.com/game/30246116/
    //     相册   https://www.douban.com/game/30246116/photos/          ← 只是多了一段
    //     讨论   https://movie.douban.com/subject/26805209/discussion/615303804/
    //
    // 不钉结尾的话，相册被认成作品，于是走「收的那一类」——本地没有那一页就
    // 不给链接，相册链接**静默消失**，而那正是这个字段要修的毛病。
    const subject = /\/(?:subject|game|movie|book|music|drama)\/(\d+)\/?(?:[?#]|$)/.exec(p.url);
    if (subject) {
      const hit = [...have.subjects].find((k) => k.endsWith(`:${subject[1]}`));
      return hit
        ? { text: p.text, href: `${hit.split(':')[0]}/${subject[1]}.md` }
        : { text: p.text }; // 收这一类但本地没有 —— 不给链接，也不回退到豆瓣
    }

    const doulist = /\/doulist\/(\d+)\/?(?:[?#]|$)/.exec(p.url);
    if (doulist) {
      return have.doulists.has(doulist[1])
        ? { text: p.text, href: `doulist/${doulist[1]}.md` }
        : { text: p.text };
    }

    const lf = localLongform(p.url);
    if (lf) {
      return have.longform.has(lf.id)
        ? { text: p.text, href: `${lf.kind}/${lf.id}.md` }
        : { text: p.text };
    }

    // 剩下的都是我们不收的东西：相册、小组、榜单、影人、短链。指出去。
    return { text: p.text, href: p.url, external: true };
  });
}

/**
 * 广播那条豆瓣永久链接，归一化成一个**跨抓取稳定**的形状。
 *
 * ## 记下来的那个 URL 每次抓都不一样
 *
 * 实测 3440 条广播，`data-status-url` **2834 条跨捕获变过**，两个轴，都不是内容：
 *
 *     追踪参数    …/status/4088086916/?_spm_id=ODIxNjA4NzE   （base64 解开就是 uid）
 *     用户段      /people/mewcatcher/  ←→  /people/82160871/  （同一个人的两种写法）
 *
 * 两个都归一化之后：**0 / 3440 再变**。
 *
 * 不处理的话，每次重新生成站点都会有 2827 条链接无缘无故改写 —— 而这个项目是靠
 * 读 diff 来确认「这次只改了该改的东西」的，那种噪音会把真的改动埋掉。同一类的
 * 还有 `(N 有用)` 计数、`1740人浏览`、封面 URL 的 CDN 分片。
 *
 * ## 归一化放在投影里，不放在 canonical 里
 *
 * canonical 存的是**那一刻页面上真的写着什么**（「never normalize at capture time」）。
 * 投影是有损缓存，本来就是「拿它去渲染」的那一份 —— 与 bundle 里 `url_key` 跟
 * `url` 并存是同一个道理：`url_key` 是索引，`url` 才是事实。
 *
 * 用数字 uid 而不是用户名：用户名会改，而数字 id 是这份档案的归属主键。两种写法
 * 豆瓣都认（本人实测过 `/people/82160871/status/9647999566/` 打得开）。
 *
 * @param {string|null|undefined} url @param {string|null|undefined} ownerId
 * @returns {string|null}
 */
function stableStatusUrl(url, ownerId) {
  if (!url) return null;
  const bare = url.split('?')[0].split('#')[0];
  return ownerId ? bare.replace(/\/people\/[^/]+\//, `/people/${ownerId}/`) : bare;
}

/** 最后一条修订。**不是**「最新的上游状态」，是「我们最后一次看到的样子」。 */
const latest = (rec) => rec.revisions[rec.revisions.length - 1];

function projectMark(m, subject, fromBroadcasts = [], superseded = []) {
  const r = latest(m);
  const s = subject ? latest(subject) : null;

  return {
    kind: 'mark',
    medium: m.medium,
    subjectId: m.subject.id,
    url: m.subject.url ?? null,

    // 上游条目被删时作品名是 null——页面上那句「未知电影」是豆瓣的占位符，不是名字。
    // 投影层**不许**拿它填空：那会让占位符一路传到页面标题、外部检索、导出文件里。
    title: s?.fields?.title ?? null,
    upstreamDeleted: Boolean(m.subject.upstream_deleted),
    // 又名：台译名、港译名、原文名。**只有作品详情页上有**，而它正是搜索时
    // 最有用的一项——记得住《重返沉默之丘》却想不起《寂静岭2》的人，
    // 没有它就什么都搜不到。
    aliases: s?.fields?.aliases ?? [],
    coverUrl: realCover(s?.fields?.cover_url),
    rawMeta: s?.fields?.raw_meta ?? null,
    // 详情页 #info 那一整块。键是豆瓣自己的标签，原样带过来——
    // 翻译或跨媒介统一属于 enricher，不是这一层的事。
    info: s?.fields?.info ?? null,

    status: r.fields.status,
    rating: r.fields.rating ?? null,
    comment: r.fields.comment ?? null,
    tags: r.fields.tags ?? [],
    markedAt: r.fields.marked_at?.iso ?? null,
    markedAtRaw: r.fields.marked_at?.raw ?? null,

    // 有多少个版本，以及我们最后一次看到它是什么时候。**这两个数是投影里唯一
    // 保留的历史痕迹**——不是为了展示，是为了让人知道「这条还有更多东西，去看
    // canonical」。把历史整个抹掉的话，投影会显得像是全部真相。
    // 被顶掉的那几条（删掉再重标）的修订也算进来——否则页面会说「只有 1 个版本」，
    // 而它下面的时间线明明列着 2018 和 2026 两次标记。
    revisionCount: [m, ...superseded].reduce((n, x) => n + x.revisions.length, 0),
    lastSeenAt: r.last_observed_at,

    // 「什么时候 → 说了什么」。理由见 broadcastsBySubject。
    timeline: buildTimeline([m, ...superseded], fromBroadcasts),
  };
}

/**
 * 一份豆列。
 *
 * **`visibility` 一路传到底。** 它是用户在豆瓣上明确做过的一个选择，而生成出来的
 * 站点是可以发布到 GitHub Pages 的。眼下渲染不据此过滤（档案主人的决定：先都渲
 * 染出来，把「我们知道它是私密的」这件事显示出来），但那个事实必须**看得见**——
 * 一份私密豆列渲染成和公开的一模一样，等于把这条信息从档案里抹掉。
 *
 * `unknown` 按 `private` 显示：抽取失败与「确实是公开的」不是一回事，而这一档
 * 上说错话的代价是不对称的。
 */
function projectDoulist(rec) {
  const r = latest(rec);
  const cat = rec.catalog ?? {};
  return {
    id: rec.upstream_id,
    url: rec.url ?? null,
    title: r.fields.title ?? null,
    description: r.fields.description ?? null,
    visibility: r.fields.visibility ?? 'unknown',
    ownership: rec.ownership ?? 'created',
    revisionCount: rec.revisions.length,
    lastSeenAt: r.last_observed_at,
    items: (r.fields.items ?? []).map((i) => ({
      entryId: i.entry_id,
      upstreamId: i.upstream_id,
      category: i.category,
      url: i.url ?? null,
      title: i.title ?? null,
      comment: i.comment ?? null,
      // 目录数据不在摘要里，另存的那份拿来渲染。
      abstract: cat[i.entry_id]?.abstract ?? null,
      rating: cat[i.entry_id]?.rating ?? null,
      coverUrl: cat[i.entry_id]?.cover_url ?? null,
    })),
  };
}

function projectLongform(rec) {
  const r = latest(rec);
  return {
    kind: rec.kind, // note | review
    id: rec.upstream_id,
    url: rec.url ?? null,
    title: r.fields.title ?? null,
    body: r.fields.body ?? null,
    publishedAt: r.fields.published_at?.iso ?? null,
    publishedAtRaw: r.fields.published_at?.raw ?? null,
    location: r.fields.location ?? null,
    rating: r.fields.rating ?? null,
    subjectUrl: r.fields.subject_url ?? null,
    revisionCount: rec.revisions.length,
    lastSeenAt: r.last_observed_at,
  };
}

/**
 * 按媒介与状态分组，供首页用。
 *
 * **不算百分比，也不写「完整」。** 完整性的证据在 bundle 的 `crawl_state` 里，
 * 投影这一层没有资格复述一个可能过期的结论（与 coverage 那条同一个理由）。
 *
 * @param {object[]} projectedMarks
 */
export function groupMarks(projectedMarks) {
  /** @type {Map<string, Map<string, object[]>>} */
  const out = new Map();
  for (const m of projectedMarks) {
    if (!out.has(m.medium)) out.set(m.medium, new Map());
    const byStatus = out.get(m.medium);
    if (!byStatus.has(m.status)) byStatus.set(m.status, []);
    byStatus.get(m.status).push(m);
  }
  // 每组内按标记时间倒序——没有时间的排最后，而不是当成 1970 年排最前。
  for (const byStatus of out.values()) {
    for (const list of byStatus.values()) {
      list.sort((a, b) => {
        if (!a.markedAt && !b.markedAt) return 0;
        if (!a.markedAt) return 1;
        if (!b.markedAt) return -1;
        return a.markedAt < b.markedAt ? 1 : -1;
      });
    }
  }
  return out;
}

/**
 * 豆瓣的「暂无封面」占位图当成没有封面。
 *
 * 与「上游被删时作品名保持 null」是同一条规则：**占位符不是内容**。
 * `/cuphead/` 与 `/f/` 是豆瓣的前端静态资源目录，抓取时刻意不存（那不是内容，
 * 而且每个没海报的作品都是同一张）。原样带过去的话，页面上会留一个指向
 * doubanio 的 URL——那让一份号称离线可看的备份，为了一张本来就不存在的图去联网。
 *
 * @param {string|null|undefined} url
 */
function realCover(url) {
  if (!url) return null;
  return /\/(cuphead|f)\//.test(url) ? null : url;
}
