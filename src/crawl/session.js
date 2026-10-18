/**
 * 会话与账号身份。
 *
 * 设计：DESIGN.md F-01
 *
 * ## 为什么登录状态这么要紧
 *
 * 有三条独立的理由，任何一条单独成立都足以让「掉登录还继续抓」成为错误：
 *
 * **① 未登录的配额更低。** 豆瓣给已登录会话的请求频率上限更高。掉了登录
 * 还按原节奏抓，等于拿一个更严的配额去撞——这正是限流升级成封号的路径。
 * 所以会话失效不只是「数据不对」，它同时让**继续抓这件事本身变得危险**。
 *
 * **② 未登录看到的是公开视图。** 私密条目不在里面。把公开视图当成这个账号
 * 的数据存进档案，等于悄悄把一份不完整的列表冒充成完整的。
 *
 * **③ 混进别人的账号是不可逆的污染。** 一个 bundle 只能属于一个账号。
 *
 * 真实旧档案里有 **151 个页面**是在未登录状态下抓的，且页面上有真实数据、
 * 看起来完全正常——前代工具毫无察觉。这不是假想的风险。
 *
 * ## 账号身份从哪里取
 *
 * 实测各页面能拿到的东西不一样，可靠性也不同：
 *
 * | 标识 | 哪里有 | 稳定性 |
 * |---|---|---|
 * | 数字 ID | 只在部分页面（广播条目的 `data-uid`）与个人主页 | **稳定主键** |
 * | 用户名 | 导航栏的 `people/<username>/` 链接 | 会变 |
 * | 昵称 | 导航栏的「<昵称>的账号」 | 会变 |
 *
 * 数字 ID 不是每张页面都有，所以身份确认要靠开头专门的一步（抓个人主页），
 * 之后每页只做「还是不是同一个账号、还在不在登录态」的**廉价复核**。
 */

import { decodeEntities } from '../vendor/parser/html-entities.js';
import { targetUidEvidence } from './profile-identity.js';

/** 已登录的标志：用户菜单或退出链接。 */
const LOGGED_IN = /nav-user-account|\/accounts\/logout/;

/** 未登录的正向标志：导航栏出现登录入口。 */
const LOGGED_OUT = /["']nav-login["']/;

/** 导航栏里的「<昵称>的账号」。 */
const DISPLAY_NAME = /<span\b[^>]*>([^<]+?)的账号<\/span>/;

/**
 * 主页备选只用于登录者自己的主页。导航 UID 是操作者，正文可能是别人，不能拼接。
 * 切片按 div 深度收口；没有 profile 标题时不能越过容器去抓页面后面的 h1。
 */
function ownProfileName(html, userId) {
  if (!userId) return null;
  const opening = /<div\b[^>]*\bid=(["'])db-usr-profile\1[^>]*>/i.exec(html);
  if (!opening) return null;
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = opening.index + opening[0].length;
  let depth = 1;
  let end = -1;
  for (let tag; (tag = tags.exec(html));) {
    depth += /^<\//.test(tag[0]) ? -1 : 1;
    if (depth === 0) { end = tags.lastIndex; break; }
  }
  if (end < 0) return null;
  const profile = html.slice(opening.index, end);
  const avatarId = /\/icon\/up([1-9]\d*)[-.]/.exec(profile)?.[1];
  const linkId = /douban\.com\/people\/([1-9]\d*)\//.exec(profile)?.[1];
  const profileId = avatarId ?? linkId;
  if (profileId !== userId || (linkId && linkId !== userId)) return null;
  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(profile)?.[1];
  // 只取标题文字，后面的 <span> 编辑入口等 UI 不属于昵称。
  return heading ? decodeEntities(heading.split('<')[0]).trim() || null : null;
}

/** 导航栏/页面里指向个人主页的链接。`mine` 是 /mine/ 跳转位，不是用户名。 */
const PEOPLE_LINK = /douban\.com\/people\/([A-Za-z0-9_-]+)\//g;

/**
 * 数字 uid 的取证点。**只用能唯一指向「当前登录用户」的位置。**
 *
 * ## 为什么这条限制比「多找几个模式」重要得多
 *
 * 一开始只找广播条目上的 `data-uid`，而个人主页上不一定有广播条目——于是身份确认
 * 失败。第一反应是「多加几个模式」：头像 URL、数字形式的 `/people/<id>/`、
 * 任意 `uid=`。那样确实能在个人主页上取到值，**但会取错**：
 *
 * | 位置 | 在个人主页上 | 在作品详情页上 |
 * |---|---|---|
 * | `data-uid`（广播条目） | 本人 | **评论者**——别人 |
 * | `/icon/up<id>-*.jpg`（头像） | 第一个是本人 | **第一个可能是别人** |
 * | `/people/<数字>/` | 多半是本人 | 指向任何人 |
 *
 * 而 `SessionGuard.verify()` 会拿这个 ID 在**每一页**上比对，不一致就判
 * `account_switched` 并**整场停机**。所以一个「有时取到别人 ID」的模式，会让抓取
 * 在第一张作品详情页上假装账号被换掉然后停下——那是个只在真实数据上才会出现的
 * 故障。
 *
 * **取错比取不到糟糕得多**：取不到是开不了工，取错是把档案挂在别人名下、或者
 * 让抓取无缘无故停摆。所以宁可少几个模式。
 *
 * ## 选中的四处，全都在全局导航里
 *
 * 这正是它们可靠的原因：全局导航是**每张登录后页面都有**的共享组件，包括作品
 * 详情页。而且这几个字段在语义上就是「当前登录的这个人」，不可能是别人。
 *
 * | 模式 | 出处 | 形如 |
 * |---|---|---|
 * | `_GLOBAL_NAV.USER_ID` | 导航栏的初始化脚本 | `USER_ID: "82160871"` |
 * | `UPLOAD_AUTH_TOKEN` 前缀 | 同上 | `"82160871:a29917..."` |
 * | piwik `setUserId` | 页尾统计脚本 | `_paq.push(['setUserId', '82160871'])` |
 * | 导航项的 `data-moreurl-dict` | 导航栏点击埋点 | `&quot;uid&quot;:&quot;82160871&quot;`（HTML 实体转义过） |
 *
 * 顺序是「语义最明确 → 最不容易被改版动到」。最后一个必须按**转义后**的样子匹配：
 * 那个属性值在 HTML 里是 `&quot;uid&quot;:&quot;123&quot;`，直接找 `"uid":"123"`
 * 一个都匹配不到。
 *
 * 校准于 2026-07-30 的真实页面（`test/fixtures/profile-2026-07.html`）。
 */
const UID_PATTERNS = [
  /USER_ID"?\s*:\s*"([1-9]\d*)"/,
  /UPLOAD_AUTH_TOKEN"?\s*:\s*"([1-9]\d*):/,
  /setUserId'\s*,\s*'([1-9]\d*)'/,
  /&quot;uid&quot;\s*:\s*&quot;([1-9]\d*)&quot;/,
];

/** @typedef {'logged_in' | 'logged_out' | 'unknown'} LoginState */

/**
 * @typedef {object} AccountHints
 * @property {string | null} userId       数字 ID，稳定主键；多数页面上没有
 * @property {string | null} username     会变，不可作主键
 * @property {string | null} displayName  会变
 */

/**
 * @param {string} html
 * @returns {LoginState}
 */
export function detectLoginState(html) {
  if (typeof html !== 'string') return 'unknown';
  if (LOGGED_IN.test(html)) return 'logged_in';
  if (LOGGED_OUT.test(html)) return 'logged_out';
  // 两个标志都没有：可能是接口响应、也可能是改版。不猜。
  return 'unknown';
}

/**
 * 从一张页面上尽量取出账号身份。取不到的字段是 null，**不猜**。
 *
 * @param {string} html
 * @returns {AccountHints}
 */
export function extractAccountHints(html) {
  if (typeof html !== 'string') return { userId: null, username: null, displayName: null };

  /** @type {string | null} */
  let userId = null;
  for (const re of UID_PATTERNS) {
    const m = re.exec(html);
    // '0' 是豆瓣导航埋点的哨兵值（未登录或部分子域名的占位符），不能作为真实用户 ID。
    if (m && m[1] !== '0') {
      userId = m[1];
      break;
    }
  }

  let displayName = null;
  const name = DISPLAY_NAME.exec(html);
  if (name && name[1]?.trim()) {
    displayName = decodeEntities(name[1]).trim();
  } else {
    displayName = ownProfileName(html, userId);
  }

  /** @type {string | null} */
  let username = null;
  PEOPLE_LINK.lastIndex = 0;
  for (const m of html.matchAll(PEOPLE_LINK)) {
    // `/people/mine/` 是跳转位，不是用户名
    if (m[1] !== 'mine') {
      username = m[1];
      break;
    }
  }

  return {
    userId,
    username,
    displayName,
  };
}

/**
 * 豆瓣的手机版站点。
 *
 * 手机 UA 下**每一条路线都会跳到这儿**，而这上面没有全局导航，也就没有登录标志、
 * 没有数字 uid——`detectLoginState` 只能返回 `unknown`。见 `desktop-ua.js`。
 */
const MOBILE_SITE = /^https?:\/\/m\.douban\.com\//;

/**
 * 「两个登录标志都没找到」时说点有用的。
 *
 * ## 为什么这句话本身就是那个缺陷
 *
 * `Doubak/doubak-extension#12`：用户在安卓 Edge 上看到「无法判断登录状态，拒绝开始
 * 抓取」，回帖说「豆瓣网站正常登录的」——他是对的，登录没问题。真实原因是豆瓣给
 * 手机 UA 发了 `m.douban.com`，那张 12 KB 的壳页上什么都没有。
 *
 * **拒绝是对的，措辞把人指向了错误的方向**：他会一遍遍去重新登录，去修一个不存在的
 * 登录问题。这个文件已经为同一件事写过一次（`missing_user_id` 与 `session_expired`
 * 必须分开：前者是改版，后者是没登录，混成一句会让用户反复重登），而
 * 「判断不出来」这一支当时没跟上——它是这两者之外的第三种情况。
 *
 * 手头本来就有判断依据：`transport.fetch` 返回的 `finalUrl` / `status` /
 * `redirectChain` / 字节数，一个都不缺，只是过去全被丢掉了，只把正文传了进来。
 *
 * @param {string} html
 * @param {{finalUrl?: string, status?: number, redirectChain?: string[]} | undefined} probe
 * @returns {string}
 */
export function undecidableMessage(html, probe) {
  const bytes = typeof html === 'string' ? html.length : 0;
  const finalUrl = probe?.finalUrl ?? '';

  if (MOBILE_SITE.test(finalUrl)) {
    return (
      '豆瓣把这次请求转到了手机版站点，而手机版页面上没有这个扩展需要的任何东西' +
      `（登录标志、数字用户 ID 都不在上面），所以判断不出登录状态。最终落在 ${finalUrl}。\n` +
      '这跟你有没有登录无关——你多半是登录着的。\n' +
      '原因是浏览器发出去的 User-Agent 带着手机标记，豆瓣据此发手机版。扩展本来会自动' +
      '去掉那个标记，这次没生效：要么这个浏览器不支持改请求头，要么它的 UA 是我们没' +
      '量过的形状（那种情况下我们宁可不动，也不会编一个 UA 出去）。\n' +
      '浏览器里那个「请求桌面版网站」的开关帮不上忙——它只对标签页有效，而抓取跑在' +
      '离屏文档里，不是标签页。\n' +
      '请把这段话连同调试页上那行 User-Agent 一起贴到 ' +
      'https://github.com/Doubak/doubak-extension/issues/12 ，加一种设备只要加一行判据。'
    );
  }

  // 不是手机版，那就是另一件事：改版、被挡、或者拿回来的根本不是一张页面。
  // **把手上有的都报出来**——少了这些，用户只能看到「判断不出来」，而那句话既可能
  // 意味着没登录、也可能意味着豆瓣改版，两者的下一步完全不同。
  const hops = probe?.redirectChain?.length ?? 0;
  return (
    '无法判断登录状态，拒绝开始抓取：这张页面上「已登录」和「未登录」两个标志都没找到。\n' +
    `最终落在 ${finalUrl || '(未知)'}，HTTP ${probe?.status ?? '(未知)'}，` +
    `跳转 ${hops > 0 ? hops - 1 : 0} 次，正文 ${bytes} 字节。\n` +
    (bytes < 2000
      ? '正文这么短，多半不是一张正常的豆瓣页面（可能是拦截页或空响应）。'
      : '页面够长，更像是豆瓣改版了导航栏。') +
    '\n请把这段话贴到 https://github.com/Doubak/doubak-extension/issues 。'
  );
}

/** 会话守卫抛出的错误，带一个机器可读的原因。 */
export class SessionError extends Error {
  /**
   * `missing_user_id` 与 `session_expired` 必须分开：前者是「豆瓣改版了」，
   * 后者是「你没登录」。混成一句话会让用户反复重新登录去修一个改版问题。
   *
   * @param {'session_expired' | 'account_switched' | 'missing_user_id'} reason
   * @param {string} message
   */
  constructor(reason, message) {
    super(message);
    this.name = 'SessionError';
    this.reason = reason;
  }
}

/**
 * 会话守卫。
 *
 * 抓取开始前确认身份，之后每页复核。任何一次复核失败都是**终止**，不是
 * 可重试错误——见文件开头的三条理由。
 */
export class SessionGuard {
  constructor({ targetAccount = null, visibility = 'self', operatorMode = 'authenticated', operatorUserId = null } = {}) {
    this._expected = targetAccount;
    this._visibility = visibility;
    this._operatorMode = operatorMode;
    this._operatorUserId = operatorUserId;
    /** @type {AccountHints | null} */
    this._account = null;
    /** @type {LoginState} */
    this._state = 'unknown';
  }

  /** 已确认的账号；未做过 preflight 则为 null。 */
  get account() {
    return this._account;
  }

  get state() {
    return this._state;
  }

  get visibility() { return this._visibility; }

  /** 已确认的原目标可以离线装载；真正继续仍需权威握手。 */
  bindTarget(account) { this._expected = { ...account }; this._account = { ...account }; }

  /**
   * 抓取前的身份确认。
   *
   * 必须给出数字 ID——它是 bundle 的归属主键，而且多数页面上取不到，所以
   * 一定要从个人主页这类地方专门取一次。
   *
   * @param {string} html  个人主页的 HTML
   * @param {object} [opts]
   * @param {string} [opts.fallbackFrom]  上一次尝试的失败说明，用来把两次都报出来
   * @returns {AccountHints}
   */
  preflight(html, { fallbackFrom, probe } = {}) {
    const state = detectLoginState(html);
    if (this._visibility === 'public') {
      this._account = { ...this._expected };
      this.verify(html, probe?.finalUrl);
      if (state === 'unknown') throw new SessionError('operator_session_lost', '无法确认操作者状态，拒绝继续。');
      this._state = state;
      return this._account;
    }
    if (state !== 'logged_in') {
      if (state === 'logged_out') {
        throw new SessionError(
          'session_expired',
          '当前未登录豆瓣。请先登录再开始——未登录不仅看不到私密条目，' +
            '请求频率上限也更低，继续抓会更容易撞上限流。',
        );
      }
      throw new SessionError('session_expired', undecidableMessage(html, probe));
    }

    const hints = extractAccountHints(html);
    if (!hints.userId) {
      // 报错要带上**已经找到了什么**。少了这些，用户只能看到「取不到 ID」，
      // 而那句话既可能意味着没登录、也可能意味着豆瓣改版——两者的下一步完全不同。
      throw new SessionError(
        'missing_user_id',
        '这张页面上找不到数字用户 ID（它是档案的归属主键，取不到就不能开始）。' +
          `已识别：用户名 ${hints.username ?? '未找到'}、昵称 ${hints.displayName ?? '未找到'}、` +
          `页面 ${html.length} 字节。豆瓣可能改版了。` +
          (fallbackFrom ? `（此前还试过：${fallbackFrom}）` : ''),
      );
    }

    const mismatch = this._expected && describeMismatch(this._expected, hints, { fields: ['userId'] });
    if (mismatch) throw new SessionError('account_switched', `请切回原抓取账号后继续（${mismatch}）。`);
    this._account = hints;
    this._state = 'logged_in';
    return hints;
  }

  /**
   * 每页的廉价复核。
   *
   * 只做两件事：还在不在登录态、还是不是同一个账号。数字 ID 多数页面没有，
   * 所以能比就比 ID，比不了就比用户名与昵称。
   *
   * @param {string} html
   * @throws {SessionError}
   */
  verify(html, url, { anonymousCatalog = false, powSolved = false } = {}) {
    if (!this._account) throw new Error('尚未 preflight，不能复核');

    // 作品、日记正文和图片没有 people 路径；用户路线不能跳到另一账号。
    if (url && this._expected) {
      const slug = /\/(?:group\/)?people\/([^/?#]+)/.exec(new URL(url).pathname)?.[1];
      if (slug && slug !== this._account.username && slug !== this._account.userId) {
        throw new SessionError('target_changed', '页面跳到了其他目标账号，已安全停止。');
      }
      if (slug) {
        const ids = targetUidEvidence(html);
        if ([...ids].some((id) => id !== this._account.userId)) {
          throw new SessionError('target_changed', '用户资料区块的数字 UID 与原目标不符，已安全停止。');
        }
      }
    }

    const state = detectLoginState(html);
    // 公开目录请求刻意不带 Cookie；它的退出登录导航不代表操作者退出了登录。
    // 仅对这一跳豁免会话检查，不能改变任务绑定或放宽下一张目标账号页面。
    // 若该页面经历过 PoW 求解并下发/携带凭据，则豁免登录态检查（因豆瓣强制要求凭据才能响应 200）。
    if (anonymousCatalog && this._visibility === 'public') {
      if (!powSolved && state === 'logged_in') throw new SessionError('operator_switched', '无登录凭据的作品目录请求返回了登录者页面，已停止以免混入个人内容。');
      return;
    }
    if (this._visibility === 'public') {
      if (this._operatorMode === 'anonymous') {
        if (state === 'logged_in') throw new SessionError('operator_switched', '匿名抓取期间登录状态发生变化，请恢复原操作者状态后继续。');
        return;
      }
      if (state === 'logged_out') throw new SessionError('operator_session_lost', '公开抓取的操作者已退出登录，请登录原操作者账号后继续。');
      if (state === 'logged_in') {
        const actual = extractAccountHints(html).userId;
        if (actual && actual !== this._operatorUserId) throw new SessionError('operator_switched', '公开抓取的操作者发生切换，请切回原操作者后继续。');
      }
      return;
    }
    if (state === 'logged_out') {
      this._state = 'logged_out';
      throw new SessionError(
        'session_expired',
        '会话已失效。这是停止条件而不是可重试错误：继续抓会拿到公开视图' +
          '（缺私密条目），而且未登录的频率上限更低，更容易撞上限流。',
      );
    }
    // 'unknown' 不当作失效——接口响应本来就没有导航栏。
    if (state === 'unknown') return;

    // **只比数字 ID。**
    //
    // 那是唯一一个「一定来自全局导航、一定是当前登录者」的字段
    // （`_GLOBAL_NAV.USER_ID`，每张登录后页面都有）。
    //
    // 用户名与昵称不行：它们是从页面**正文**里扒的，而正文里到处是别人。真实故障
    // ——抓到 `book.douban.com/subject/4820710/` 时，页面上第一个 `/people/<x>/`
    // 是某位**短评作者**的，于是守卫报「用户名 mewcatcher → 163211544，账号发生了
    // 变化」并整场停机。用户的账号一秒都没变过。
    //
    // 这不是「多一层保险」，是**反过来的**：多比一个不可靠的字段，只会凭空制造停机。
    // 而 `verify()` 要防的事（抓到一半用户在另一个标签页换了号）只需要数字 ID 就够，
    // 那本来就是档案的归属主键。
    const hints = extractAccountHints(html);
    const mismatch = describeMismatch(this._account, hints, { fields: ['userId'] });
    if (mismatch) {
      this._state = 'logged_out';
      throw new SessionError(
        'account_switched',
        `账号发生了变化（${mismatch}）。一个 bundle 只能属于一个账号，` +
          `混进别人的数据是不可逆的污染，因此立即停止。`,
      );
    }
  }
}

/**
 * 比对两组身份线索，返回不一致的描述；一致或无从比较则返回 null。
 *
 * **只在两边都有值时比较**——某个字段在这张页面上取不到，不能当成不一致。
 *
 * @param {AccountHints} expected
 * @param {AccountHints} actual
 * @returns {string | null}
 */
export function describeMismatch(expected, actual, { fields = ['userId', 'username', 'displayName'] } = {}) {
  const LABELS = { userId: '数字 ID', username: '用户名', displayName: '昵称' };
  for (const [field, label] of fields.map((f) => [f, LABELS[f]])) {
    const a = expected[field];
    const b = actual[field];
    if (a && b && a !== b) return `${label} ${a} → ${b}`;
  }
  return null;
}
