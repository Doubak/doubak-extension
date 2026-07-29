/**
 * 路线注册表。
 *
 * 设计：DESIGN.md F-03a、§9（v0 范围）
 *
 * 每条路线声明：入口 URL、`intent`、留存等级、翻页方式、枚举方式、安全网、
 * 前置依赖、优先级。**新增一条路线 = 加一条注册项**，不改抓取引擎。
 *
 * ## 每条路线都标了出处
 *
 * `source` 字段记录这条路线的 URL 是怎么来的：
 *
 * - `archive`  —— 在真实旧档案里核对过分页链接，可信
 * - `tofu`     —— 抄自同类实现 doufen-org/tofu，**未经核对**
 * - `unknown`  —— 没有可用来源，需要实地发现
 *
 * 这不是文档洁癖。一份混着「验证过的」与「猜的」URL 的注册表会让人误以为
 * 全都靠谱，而抓错 URL 的代价是白白消耗风控预算。
 *
 * ## 翻页优先跟随页面自己的链接
 *
 * 实测发现前代手搓的电影列表 URL 少了一个 `type=all`——豆瓣自己的分页器
 * 给的是另一套参数。所以：**入口 URL 用模板构造，后续翻页优先跟随页面上
 * 的分页器链接**，构造只作兜底。
 *
 * 这同时符合「绝不相信保存下来的页码，跨会话按内容重新定位」（F-03f）：
 * 跟随页面链接本来就是按内容走。
 */

/** 优先级：数字越小越先抓。按不可替代性排（DESIGN.md F-03d）。 */
export const PRIORITY = {
  IDENTITY: 0, // 身份与声明数量，必须最先
  BROADCAST: 10, // 不可编辑、可静默删除、最时间敏感
  LONGFORM: 20, // 日记、影评书评、读书笔记
  IMAGES: 30, // 用户上传的图
  INTERESTS: 40, // 标记列表
  CATALOG: 90, // 作品详情页，最后
};

/** @param {string} u */
const enc = (u) => encodeURIComponent(u);

/**
 * @typedef {object} RouteDef
 * @property {string} key
 * @property {string} intent
 * @property {'data' | 'assets' | 'catalog'} kind
 * @property {'html' | 'api'} surface
 * @property {number} priority
 * @property {'archive' | 'tofu' | 'unknown'} source
 * @property {'bounded' | 'full'} enumeration
 * @property {'contiguity' | 'contiguity+count'} safetyNet
 * @property {{kind: 'page' | 'start', step: number, first: number}} pagination
 * @property {(p: {username: string, offset: number}) => string} [entryUrl]
 * @property {string[]} [requires]  前置路线，必须先跑到 advanced=true
 * @property {string} [note]
 */

/** 标记列表的三种状态。舞台剧没有 do。 */
const STATUS = /** @type {const} */ (['collect', 'wish', 'do']);

/**
 * 各分类标记列表的 URL 构造方式。
 * 参数取自真实档案里页面自己的分页器链接，不是照抄前代的手搓模板。
 */
const INTEREST_URLS = {
  movie: ({ username, offset }) =>
    `https://movie.douban.com/people/${enc(username)}/{status}?start=${offset}` +
    `&sort=time&rating=all&mode=grid&type=all&filter=all`,
  book: ({ username, offset }) =>
    `https://book.douban.com/people/${enc(username)}/{status}?start=${offset}` +
    `&sort=time&rating=all&filter=all&mode=grid`,
  music: ({ username, offset }) =>
    `https://music.douban.com/people/${enc(username)}/{status}?start=${offset}` +
    `&sort=time&rating=all&filter=all&mode=grid`,
  game: ({ username, offset }) =>
    `https://www.douban.com/people/${enc(username)}/games?action={status}&start=${offset}`,
  drama: ({ username, offset }) =>
    `https://www.douban.com/location/people/${enc(username)}/drama/{status}` +
    `?sort=time&start=${offset}&filter=all&mode=grid&tags_sort=count`,
};

/** 各分类支持的状态。 */
const INTEREST_STATUSES = {
  movie: STATUS,
  book: STATUS,
  music: STATUS,
  game: STATUS,
  drama: /** @type {const} */ (['collect', 'wish']), // 实测没有「在看」
};

/** 分类入口页——声明数量与身份都从这里取。 */
const CATEGORY_ENTRY = {
  movie: (u) => `https://movie.douban.com/people/${enc(u)}/`,
  book: (u) => `https://book.douban.com/people/${enc(u)}/`,
  music: (u) => `https://music.douban.com/people/${enc(u)}/`,
  // 游戏与舞台剧没有独立入口页，总数在列表页的 tab 上
  game: (u) => `https://www.douban.com/people/${enc(u)}/games`,
  drama: (u) => `https://www.douban.com/location/people/${enc(u)}/drama/`,
};

/**
 * 构造 v0 的全部路线。
 *
 * @param {object} opts
 * @param {string} opts.username
 * @param {string[]} [opts.mediums]  要抓哪些分类，默认全部六类
 * @param {boolean} [opts.includeCatalog]  是否抓作品详情页
 * @returns {RouteDef[]}
 */
export function buildRoutes({
  username,
  mediums = ['movie', 'book', 'music', 'game', 'drama'],
  includeCatalog = true,
}) {
  if (!username) throw new Error('缺少 username');
  /** @type {RouteDef[]} */
  const routes = [];

  // ── 身份与声明数量
  routes.push({
    key: 'profile.overview',
    intent: 'profile.overview',
    kind: 'data',
    surface: 'html',
    priority: PRIORITY.IDENTITY,
    source: 'archive',
    enumeration: 'full',
    safetyNet: 'contiguity',
    pagination: { kind: 'page', step: 1, first: 1 },
    entryUrl: () => `https://www.douban.com/people/${enc(username)}/`,
    note: '身份确认（数字用户 ID）必须从这里取——多数页面上没有它',
  });

  for (const medium of mediums) {
    if (!CATEGORY_ENTRY[medium]) continue;
    routes.push({
      key: `profile.category_entry.${medium}`,
      intent: `profile.category_entry.${medium}`,
      kind: 'data',
      surface: 'html',
      priority: PRIORITY.IDENTITY,
      source: 'archive',
      enumeration: 'full',
      safetyNet: 'contiguity',
      pagination: { kind: 'page', step: 1, first: 1 },
      entryUrl: () => CATEGORY_ENTRY[medium](username),
    });
  }

  // ── 广播：唯一真正紧急的东西
  routes.push({
    key: 'broadcast.timeline',
    intent: 'broadcast.timeline',
    kind: 'data',
    surface: 'html',
    priority: PRIORITY.BROADCAST,
    source: 'archive',
    // 只走到时间下界，下界以下没看过——下游【不得】据此推断删除
    enumeration: 'bounded',
    safetyNet: 'contiguity',
    pagination: { kind: 'page', step: 1, first: 1 },
    entryUrl: ({ offset }) =>
      `https://www.douban.com/people/${enc(username)}/statuses?p=${offset}`,
    note: '发布后不可编辑、可静默删除、最时间敏感。每页条数不固定（实测 20/21/22）',
  });

  // ── 标记列表
  for (const medium of mediums) {
    const build = INTEREST_URLS[medium];
    if (!build) continue;
    for (const status of INTEREST_STATUSES[medium]) {
      routes.push({
        key: `interest.${medium}.${status}`,
        intent: `interest.list.${medium}.${status}`,
        kind: 'data',
        surface: 'html',
        priority: PRIORITY.INTERESTS,
        source: 'archive',
        // 整份列表从头走到尾，所以「上次有这次没有」是有意义的信号
        enumeration: 'full',
        safetyNet: 'contiguity',
        pagination: { kind: 'start', step: 15, first: 0 },
        entryUrl: (p) => build({ username, offset: p.offset }).replace('{status}', status),
      });
    }
  }

  // ── 作品详情页：受前置依赖门控
  if (includeCatalog) {
    routes.push({
      key: 'interest.item',
      intent: 'interest.item',
      kind: 'catalog', // 单独成段，可整批丢弃
      surface: 'html',
      priority: PRIORITY.CATALOG,
      source: 'archive',
      enumeration: 'full',
      safetyNet: 'contiguity',
      pagination: { kind: 'page', step: 1, first: 1 },
      // 必须等广播抓完。不能拿最不可替代的东西去换最可替代的东西。
      requires: ['broadcast.timeline'],
      note: '生成静态站的必要输入，但占档案九成体积；单独成段以便整批丢弃',
    });
  }

  return routes.sort((a, b) => a.priority - b.priority || (a.key < b.key ? -1 : 1));
}

/**
 * 已知存在、但目前**没有可用 URL** 的路线。
 *
 * 单独列出来而不是塞进 buildRoutes：一条抓不到东西的路线会让覆盖率
 * 报告出现一个永远为 0 的条目，看起来像 bug，实际是「豆瓣这里没入口」。
 */
export const UNRESOLVED_ROUTES = {
  'interest.app': {
    reason:
      '移动应用的标记列表 URL 未知。前代的 category.proto 声明了 app 但没实现爬虫；' +
      'tofu 也没有这条路线；真实档案里不存在 app 的列表页。' +
      '广播里 app 类型条目的 data-object-kind=3064，链接是 douc.cc 短链，真实 URL 藏在跳转后面。' +
      '需要实地发现，也可能豆瓣已经撤掉了这个板块——那样就如实记录「已无此入口」。',
    source: 'unknown',
  },
};

/**
 * 长文与相册路线：URL 来自 tofu，**尚未核对**。
 *
 * 单独放一组并显式标注出处，避免与已核对的路线混在一起。启用前需要实地
 * 确认——移动端 Rexxar 是未公开接口，随时可能变。
 *
 * @param {object} opts
 * @param {string} opts.userId  这些接口用数字 ID，不是用户名
 * @returns {RouteDef[]}
 */
export function buildUnverifiedApiRoutes({ userId }) {
  if (!userId) throw new Error('Rexxar 接口需要数字用户 ID');
  const base = `https://m.douban.com/rexxar/api/v2/user/${enc(userId)}`;
  /** @param {string} key @param {string} path @param {string} intent */
  const api = (key, path, intent) => ({
    key,
    intent,
    kind: /** @type {const} */ ('data'),
    surface: /** @type {const} */ ('api'),
    priority: PRIORITY.LONGFORM,
    source: /** @type {const} */ ('tofu'),
    enumeration: /** @type {const} */ ('full'),
    safetyNet: /** @type {const} */ ('contiguity'),
    pagination: { kind: /** @type {const} */ ('start'), step: 50, first: 0 },
    entryUrl: ({ offset }) => `${base}/${path}?start=${offset}&count=50&for_mobile=1`,
    note: 'URL 抄自 tofu，未经核对。Rexxar 是未公开接口，启用前需实地确认',
  });

  return [
    api('note.list', 'notes', 'note.list'),
    api('review.list', 'reviews', 'review.list'),
    api('annotation.list', 'annotations', 'annotation.list'),
    { ...api('photo.album_list', 'photo_albums', 'photo.album_list'), priority: PRIORITY.IMAGES },
  ];
}

/**
 * 判断一条路线的前置依赖是否已满足。
 *
 * @param {RouteDef} route
 * @param {Set<string>} completedRouteKeys  已达成 advanced=true 的路线
 * @returns {{ready: boolean, waitingFor: string[]}}
 */
export function checkPrerequisites(route, completedRouteKeys) {
  const waitingFor = (route.requires ?? []).filter((k) => !completedRouteKeys.has(k));
  return { ready: waitingFor.length === 0, waitingFor };
}
