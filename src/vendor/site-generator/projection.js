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
  const projectedMarks = marks.map(
    (m) => projectMark(m, bySubject.get(`${m.medium}:${m.subject.id}`), byTarget.get(m.subject.id) ?? []),
  );

  return {
    marks: projectedMarks,
    longform: longform.map(projectLongform),
    doulists: doulists.map(projectDoulist),
    broadcasts: broadcasts.map((b) => projectBroadcast(b, targetIndex(projectedMarks))),
  };
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
  // 撞车的一律不接。广播上只有 data-object-id，没有媒介；接错了是档案在说假话，
  // 而且看不出来。（实测这份档案 0 个撞车，但这条不能靠运气。）
  const seen = new Map();
  for (const m of marks) {
    seen.set(m.subject.id, seen.has(m.subject.id) ? null : m);
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
 * @param {object} m canonical 的标记
 * @param {object[]} fromBroadcasts
 */
function buildTimeline(m, fromBroadcasts) {
  const rows = [...fromBroadcasts];

  for (const r of m.revisions) {
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
 * **id 撞车的一律不接。** 广播上只有 `data-object-id`，没有媒介；而不同媒介的 id
 * 是各自编号的，理论上会撞。撞了还硬接的话，页面上会出现一条指向另一部作品的链接
 * ——**那比不接严重得多**：不接只是少个链接，接错了是档案在说假话，而且看不出来。
 */
function targetIndex(projectedMarks) {
  /** @type {Map<string, object|null>} null = 撞车了，不许接 */
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
function projectBroadcast(b, targets) {
  const r = b.revisions[b.revisions.length - 1];
  const f = r.fields;
  const target = f.target_id ? (targets.get(f.target_id) ?? null) : null;

  return {
    kind: 'broadcast',
    id: b.upstream_id,
    url: b.url ?? null,
    postedAt: f.posted_at?.iso ?? null,
    postedAtRaw: f.posted_at?.raw ?? null,
    text: f.text ?? null,
    action: f.action ?? null,
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

/** 最后一条修订。**不是**「最新的上游状态」，是「我们最后一次看到的样子」。 */
const latest = (rec) => rec.revisions[rec.revisions.length - 1];

function projectMark(m, subject, fromBroadcasts = []) {
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
    revisionCount: m.revisions.length,
    lastSeenAt: r.last_observed_at,

    // 「什么时候 → 说了什么」。理由见 broadcastsBySubject。
    timeline: buildTimeline(m, fromBroadcasts),
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
