/* 【自动同步，请勿手改】来自 doubak-export-adapters 的 src/classify.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/**
 * 把 canonical 的 `medium` + 作品的 `info` 块，翻成目标平台认识的东西。
 *
 * ## 豆瓣的「电影」里有三成是剧集
 *
 * 豆瓣把电影和剧集放在同一种 subject 下（都是 `movie.douban.com/subject/`），
 * canonical 忠实地照抄了这一点。但三个目标平台没有一个是这么分的：
 *
 * - **Letterboxd 只收电影。** 剧集导进去要么匹配不上，要么匹配到一部同名电影上——
 *   后者更糟，因为它看起来成功了。
 * - **NeoDB 把 movie 和 tv 分成两个 category**，而 CSV 导入是**按文件名**分的
 *   （`movie_mark.csv` / `tv_mark.csv`），放错文件就是放错分类。
 *
 * 实测这份档案 2107 个「电影」里 **638 个是剧集**（30%）。这不是边角情况，
 * 是必须做对的一步。
 *
 * ## 判据用 `info` 里有没有剧集专属的行，不用标题也不用类型
 *
 * 三个键任一存在即判为剧集：`集数`、`首播`、`季数`。实测覆盖 624 / 637 / 271，
 * 并集 638。豆瓣的电影条目**从不**出现这三行——它们是剧集模板才有的。
 *
 * 反过来（拿「类型」里有没有「剧情」之类去猜）会错得很难看，而且是静默的。
 *
 * ## 没有 `info` 的一律当电影，并且要数出来
 *
 * 游戏和舞台剧压根没有 `#info` 块（CLAUDE.md 里记着这条），电影里也有 8 个没有
 * ——那是详情页没抓到的。没有 `info` 就没有判据，只能退回默认值「电影」，
 * 而**默认值是猜的**。所以导出报告里单列一行「没读到详情页，按电影处理」，
 * 让用户能自己去看那几条。
 */

/** canonical 的 medium → NeoDB 的 ItemCategory。`movie` 要再分一次。 */
const CATEGORY = {
  book: 'book',
  music: 'music',
  game: 'game',
  drama: 'performance',
};

/** `info` 里出现任一即为剧集。实测：集数 624、首播 637、季数 271，并集 638。 */
const TV_KEYS = ['集数', '首播', '季数'];

/**
 * 判定目标平台意义上的分类。
 * @param {string} medium canonical 的 medium
 * @param {object|null} subjectFields 作品当前状态的 fields（可能没有）
 * @returns {{category: string, guessed: boolean}} guessed 表示没有详情页、走了默认值
 */
export function classify(medium, subjectFields) {
  if (CATEGORY[medium]) return { category: CATEGORY[medium], guessed: false };
  if (medium !== 'movie') return { category: medium, guessed: false };

  const info = subjectFields?.info;
  if (!info || typeof info !== 'object') return { category: 'movie', guessed: true };
  const tv = TV_KEYS.some((k) => Array.isArray(info[k]) && info[k].length > 0);
  return { category: tv ? 'tv' : 'movie', guessed: false };
}

/** `info` 里一行的第一个值，没有就是 null。 */
function first(info, key) {
  const v = info?.[key];
  return Array.isArray(v) && v.length ? v[0] : null;
}

/**
 * 年份。取所有日期里**最早**的那一个——一部片子的年份是它首次公映的年份，
 * 而豆瓣的「上映日期」是按地区列的一串，次序不保证。
 * @param {object|null} info
 * @param {string[]} keys 按优先级排的键名
 * @returns {string|null} 四位数字，或 null
 */
function earliestYear(info, keys) {
  let best = null;
  for (const key of keys) {
    for (const v of info?.[key] ?? []) {
      const m = /(\d{4})/.exec(String(v));
      if (m && (best === null || m[1] < best)) best = m[1];
    }
  }
  return best;
}

/**
 * 抽出跨平台匹配用的标识。这几个字段决定导入能不能对上——
 * **豆瓣的中文标题在这三个平台上几乎没有匹配价值**，IMDb / ISBN 才有。
 *
 * 实测覆盖：电影 1423/1465 有 IMDb（97%）、剧集 589/638（92%）、图书 145/145 有 ISBN。
 *
 * @param {object|null} subjectFields
 * @returns {{imdb: string|null, isbn: string|null, year: string|null,
 *            seasons: string|null, episodes: string|null, directors: string[]}}
 */
export function identifiers(subjectFields) {
  const info = subjectFields?.info ?? null;
  const imdbRaw = first(info, 'IMDb');
  // 只认 tt + 数字。豆瓣这一行里出现过别的东西，而一个格式不对的 id 会让
  // 整行匹配失败——留空反而能退回标题匹配。
  const imdb = imdbRaw && /^tt\d+$/.test(imdbRaw.trim()) ? imdbRaw.trim() : null;

  const isbnRaw = first(info, 'ISBN');
  const isbn = isbnRaw ? isbnRaw.replace(/[^0-9Xx]/g, '').toUpperCase() || null : null;

  return {
    imdb,
    isbn,
    year: earliestYear(info, ['上映日期', '首播', '出版年', '发行时间']),
    seasons: first(info, '季数'),
    episodes: first(info, '集数'),
    directors: info?.['导演'] ?? [],
  };
}

/**
 * 豆瓣的标题是「中文名 原名」，解析器存成 `中文名 / 原名`（实测 2107 部电影里
 * 1779 部是这个形状）。
 *
 * 往外导的时候要的是**原名**：Letterboxd 和 Goodreads 的库里没有中文条目，
 * 拿「重返寂静岭」去猜匹配是猜不中的，「Return to Silent Hill」才有机会。
 * 按**第一个** ` / ` 切——原名里也可能有斜杠，中文名里不会有这个写法。
 *
 * @param {string|null} title
 * @returns {{local: string, original: string|null}}
 */
export function splitTitle(title) {
  const t = (title ?? '').trim();
  const at = t.indexOf(' / ');
  if (at < 0) return { local: t, original: null };
  return { local: t.slice(0, at).trim(), original: t.slice(at + 3).trim() || null };
}
