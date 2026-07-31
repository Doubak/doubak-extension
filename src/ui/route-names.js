/**
 * 路线在界面上的说法：名字，以及「连续性」那一列。
 *
 * ## 为什么不是一张手写的表
 *
 * 原来就是。结果界面上混着出现这种东西：
 *
 * ```
 * 舞台剧 · 看过         0    —    进行中
 * interest.drama.wish   0    —    进行中
 * 游戏 · 玩过          15    2023-08-13
 * interest.game.do     14    2019-11-16
 * ```
 *
 * 手写表漏了五条：`interest.drama.wish`、`interest.game.do`、`interest.game.wish`、
 * `interest.music.do`、`interest.music.wish`。漏的都不是随机的——它们是 15 条
 * 标记列表里**不那么常用**的那几个状态，也正是写表时容易想不起来的那几个。
 *
 * 路线是**生成**的（媒介 × 状态的笛卡儿积），名字却是手抄的，两边迟早对不上。
 * 所以名字也按同一组维度生成，并用一条测试钉住：`buildRoutes()` 吐出来的每一个
 * key 都必须有中文名。加一种媒介、加一个状态，测试会先红。
 *
 * ## 状态词跟着媒介走
 *
 * 豆瓣对每种媒介用不同的动词，这不是可以统一的东西——「看过一本书」是错的。
 */

/** 媒介名。 */
const MEDIUM = {
  movie: '电影',
  book: '书',
  music: '音乐',
  game: '游戏',
  drama: '舞台剧',
};

/**
 * 状态词。**每种媒介用的动词不同**，豆瓣自己就是这么显示的。
 *
 * 顺序固定为 collect / do / wish：已完成、进行中、想要。
 */
const STATUS = {
  movie: { collect: '看过', do: '在看', wish: '想看' },
  book: { collect: '读过', do: '在读', wish: '想读' },
  music: { collect: '听过', do: '在听', wish: '想听' },
  game: { collect: '玩过', do: '在玩', wish: '想玩' },
  drama: { collect: '看过', do: '在看', wish: '想看' },
};

/** 不按媒介 × 状态生成的那几条。 */
const FIXED = {
  'broadcast.timeline': '广播',
  'profile.overview': '个人主页',
  'interest.item': '作品详情页',
  'diary.list': '日记',
  'review.list': '影评 / 书评',
  'photo.album_list': '相册',
};

/**
 * 路线 key → 中文名。
 *
 * 认不出来的**原样返回 key**，而不是返回「未知路线」之类的话：界面上突然冒出一个
 * `interest.game.do` 是丑，但至少还认得出是哪条线；换成「未知路线」就彻底断了线索，
 * 而这一行本来是给人排查用的。丑是能被看见的 bug，那正是我们想要的。
 *
 * @param {string} key
 * @returns {string}
 */
export function routeName(key) {
  if (FIXED[key]) return FIXED[key];

  const interest = /^interest\.([a-z]+)\.([a-z]+)$/.exec(key);
  if (interest) {
    const [, medium, status] = interest;
    const m = MEDIUM[medium];
    const s = STATUS[medium]?.[status];
    if (m && s) return `${m} · ${s}`;
  }

  const entry = /^profile\.category_entry\.([a-z]+)$/.exec(key);
  if (entry && MEDIUM[entry[1]]) return `${MEDIUM[entry[1]]} · 分类入口`;

  return key;
}

/** 这个 key 有没有中文名。测试用——界面上不该出现内部标识。 */
export function hasRouteName(key) {
  return routeName(key) !== key;
}


/**
 * 「连续性」那一列写什么。
 *
 * ## 说结论，不说我们对自己的信心
 *
 * 这一列经历了三版，每一版都是被同一个问题咬出来的：**它说的到底是「档案怎么样」
 * 还是「我们查得怎么样」？**
 *
 * | 版本 | 毛病 |
 * |---|---|
 * | 「进行中」 | 抓完的档案里也这么写——叫人一直等一件已经结束的事 |
 * | 「未验证 · 有缺口」 | 「未验证」听起来像**我们的代码没查**，而其实查了，结论就是有缺口 |
 * | 「有 1 处缺口」 | ← 说的是档案本身的结论 |
 *
 * **不能写「已验证 · 有缺口」。** 「已验证」在这个项目里有确切含义：连续性证明
 * 成立，也就是「这条线以上全都抓到了」。有缺口时它不成立。两个词并排放，读快一点
 * 就会看成「验证通过」——而假的完整性声明是这个项目最不能出的错，宁可措辞笨一点。
 *
 * 四种结论：
 *
 * | 情形 | 写什么 | 意思 |
 * |---|---|---|
 * | 连续 | ✔ 已验证 | 这条线以上全都抓到了 |
 * | 还在跑 | 进行中 | 等着 |
 * | 抓完了、有缺口 | 有 N 处缺口 | 中间断过，缺口如实记着 |
 * | 抓完了、没缺口、也不连续 | 没走完 | 这条线没走到终点（没到下界、也没停滞终止） |
 *
 * 埋在面板里的时候这条逻辑没法测——与 `capture-label.js` 是同一个理由。
 *
 * @param {{contiguous?: boolean, settled?: boolean, gaps?: Array<object>}} r
 * @returns {string}
 */
export function contiguityLabel(r) {
  if (r.contiguous) return '✔ 已验证';
  if (!r.settled) return '进行中';
  const n = r.gaps?.length ?? 0;
  return n > 0 ? `有 ${n} 处缺口` : '没走完';
}
