/**
 * 让豆瓣把桌面版页面发给我们。
 *
 * ## 症状：手机上「无法判断登录状态，拒绝开始抓取」
 *
 * `Doubak/doubak-extension#12`。用户在 Edge 151（安卓）上装了扩展，豆瓣确实登录着，
 * 一按开始就是这句话。**它不是登录检测坏了，是这套抓取器根本没拿到它认得的页面。**
 *
 * 实测（2026-09-09，真实请求，未登录态即可复现跳转）：
 *
 * ```
 * 手机 UA   https://www.douban.com/people/<用户名>/     → https://m.douban.com/people/<用户名>/
 * 桌面 UA   https://www.douban.com/people/<用户名>/     → 不跳转
 * ```
 *
 * 而 `m.douban.com` 那张页面上，`session.js` 要找的东西**一个都没有**：
 * `nav-user-account` 0 处、`/accounts/logout` 0 处、`nav-login` 0 处，四个取 uid 的
 * 模式（`USER_ID` / `UPLOAD_AUTH_TOKEN` / `setUserId` / `&quot;uid&quot;`）也全是 0——
 * 整张页面只有 12549 字节，是个壳。于是 `detectLoginState` 两个标志都找不到，返回
 * `unknown`，preflight 照约定拒绝开工。**那个拒绝是对的**，错的是它把原因说成了
 * 「判断不出登录状态」。
 *
 * 而且这不只是身份确认那一步的事——**每一条路线都跳**：
 *
 * ```
 * movie.douban.com/people/<u>/collect  → m.douban.com/people/<u>/movie/done
 * www.douban.com/people/<u>/statuses   → m.douban.com/people/<u>/statuses
 * book.douban.com/subject/4820710/     → m.douban.com/book/subject/4820710/
 * ```
 *
 * 所以在手机 UA 下，这个扩展不是「少一个功能」，是**一页都抓不成**。
 *
 * ## 判据是 UA 里的那个词，而且只能靠**删**
 *
 * 逐项测过，豆瓣认的既不是客户端提示、也不是「UA 里有没有 Mobile 这几个字母」：
 *
 * | 发出去的 UA | 拿到哪个站 |
 * |---|---|
 * | 安卓 Chromium UA | m |
 * | 同一个 UA + `Sec-CH-UA-Mobile: ?0` | **m**（客户端提示不看） |
 * | 同一个 UA，去掉 ` Mobile` 这个词 | **www** |
 * | 桌面 UA + `Sec-CH-UA-Mobile: ?1` | www |
 * | 桌面 UA 后面**加**上 ` Mobile` | **www**（加了没用） |
 * | 桌面 UA 后面加上 ` iPhone` | m |
 * | 安卓**平板** Chromium UA（本来就没有 `Mobile`） | **www** |
 * | Firefox 安卓手机 `(Android 14; Mobile; rv:…)` | m |
 * | Firefox 安卓**平板** `(Android 14; Tablet; rv:…)` | **m**（平板也跳） |
 * | Firefox 桌面 `(X11; Linux x86_64; rv:…)` | www |
 *
 * 两个结论，都要紧：
 *
 * - **加不管用，只有删管用。** 判据与位置有关（安卓那段在前、`Mobile` 在后才算），
 *   所以「拼一个桌面 UA 出来」和「把手机标记删掉」不是同一件事，只有后者被量过。
 * - **删掉之后得到的不是编出来的 UA。** 安卓 Chromium 去掉 `Mobile` 恰好就是
 *   **安卓平板**上同一个浏览器发的那一个（表里最后一行量过：平板 UA 本来就没有
 *   这个词，拿到的就是桌面版）。同一个浏览器、同一个系统、同一份 TLS 指纹。
 *
 * 这一条直接决定了做法，因为规范里有一句相反方向的硬规矩
 * （`bundle/v1/manifest.schema.json` 的 `producer.user_agent`）：
 *
 * > 抓取时浏览器的真实 User-Agent，原样记录。**生产者不得伪造 UA**：伪造出的 UA
 * > 与 TLS 指纹及其他请求头不一致，反而更易被风控识别。
 *
 * 那句话防的是「装成另一个浏览器」——而那正是它给出的理由：不一致才危险。**删掉一个
 * 词得到的是同一个浏览器在平板上的真实形态，处处一致**，所以它站得住；换成一个
 * 编造的 `(X11; Linux x86_64)` 就正好撞在那句话上：安卓的 TLS 指纹配 Linux 桌面的
 * UA，是这个项目最不能承担的那种「更容易被风控盯上」。
 *
 * **所以这个模块只会删词，永远不会拼一个 UA 出来。** 认不出来的形状就不动，
 * 并且如实说「没动」——猜一个 UA 比不支持这台设备糟糕得多。
 *
 * 这条判据同时**把 Firefox 安卓排除在外**，见下面 `MOBILE_TOKENS` 里那段：它那两种
 * 真实形态（`Mobile;` / `Tablet;`）都会被跳到手机版，而唯一能拿到桌面版的是货真价实
 * 的桌面 UA——在安卓上发它就正好是那句禁令针对的东西。**不是少写了一行，是这个方案
 * 在 Firefox 上不成立。**
 *
 * ## 只改我们自己发的请求
 *
 * 与 `referer-rule.js` 同一条：`tabIds: [-1]` 限定在不属于任何标签页的请求上，
 * 也就是扩展自己发的。用户在自己标签页里逛豆瓣不受影响——他在手机上多半**就是想要**
 * 手机版，替他改掉是越界。
 *
 * 这也解释了 #12 里那位用户试过的办法为什么没用：浏览器的「请求桌面版网站」是
 * **按标签页**生效的，而抓取跑在离屏文档里，压根不是一个标签页。
 *
 * ## 这一步做完，手机上就一定能抓了吗
 *
 * 不知道，而且不该在这儿假装知道。这一条解决的是**内容那一侧**：页面回到桌面模板，
 * 分类器、抽取器、路线表就都对得上了。剩下的是运行时那一侧——离屏文档在移动版
 * Chromium 上能活多久、几小时的抓取扛不扛得住——那要真机跑过才知道。
 */

/** 规则 ID。与 `referer-rule.js` 的 1 错开，两条规则同时装。 */
export const DESKTOP_UA_RULE_ID = 2;

/**
 * 豆瓣的域。图片域（doubanio）不看 UA，也没有手机版，所以不必管。
 */
export const PAGE_HOST_FILTER = '||douban.com';

/**
 * 已知的手机标记，**按形状逐个列出，不做通配**。
 *
 * 每一条都对应上面那张表里量过的一行。列不出来的形状一律不动——见文件开头：
 * 这个模块只删词，不拼 UA。
 *
 * @type {Array<{shape: RegExp, replace: string, note: string}>}
 */
const MOBILE_TOKENS = [
  // 安卓 Chromium（Chrome / Edge / 三星浏览器…）：`… Chrome/151.0.0.0 Mobile Safari/537.36`
  //
  // 删掉之后**恰好就是同一个浏览器在安卓平板上发的那一个**——实测过：平板 UA 本来就
  // 没有这个词，而且它直接拿到 www.douban.com。这是这条规则唯一站得住的理由。
  { shape: / Mobile(?= |$)/, replace: '', note: '安卓 Chromium' },

  // **Firefox 安卓不在这张表里，而这不是「还没做」。**
  //
  // 一度写了一条 `Mobile; ` 的判据。删掉确实能拿到桌面版（量过），但得到的
  // `(Android 14; rv:141.0)` 是**任何 Firefox 都不会发的 UA**——Firefox 安卓只有
  // 两种形态，而**两种都被跳到手机版**：
  //
  //     (Android 14; Mobile; rv:141.0)  → m.douban.com
  //     (Android 14; Tablet; rv:141.0)  → m.douban.com     ← 平板也跳
  //     (X11; Linux x86_64; rv:141.0)   → www.douban.com   ← 只有桌面那个行
  //
  // 也就是说，Firefox 安卓上**不存在**一个满足本文件那条不变量的 UA：能拿到桌面版的
  // 只有货真价实的桌面 UA，而在安卓上发它就是「安卓的 TLS 指纹配 Linux 桌面的 UA」,
  // 正是规范那句禁令针对的东西。这不是我们少写了一行，是这个方案在 Firefox 上不成立。
  //
  // 这一条留给 #11（Firefox 支持）的第 0 步去定，那时能在真机上量。现在写上等于一条
  // 永远不会触发（Firefox 还不是宿主）、而且**头一句就是假的**的判据。
];

/**
 * 这个 UA 会不会让豆瓣发手机版？
 *
 * **只回答「我们认不认得出并且改得动」**，不是「这是不是一台手机」。iOS Safari 的
 * `Mobile/15E148` 实测也会跳转，但它是个带版本号的整体，删掉得不到任何真实存在的
 * UA，所以这里**不认它**——认了就得编，而编 UA 是上面那条规范明令禁止的。
 *
 * @param {string} ua
 * @returns {boolean}
 */
export function looksMobile(ua) {
  return typeof ua === 'string' && MOBILE_TOKENS.some((t) => t.shape.test(ua));
}

/**
 * 从真实 UA 推出一个能拿到桌面版的 UA。
 *
 * **认不出就返回 null**，调用方据此什么都不做。返回 null 与返回原串是两件事：
 * 前者是「这台设备我们没办法」，后者会让调用方装上一条什么都不改的规则，
 * 于是「规则装上了」这个信号变成假的。
 *
 * @param {string} ua  `navigator.userAgent`
 * @returns {{userAgent: string, note: string} | null}
 */
export function desktopUserAgent(ua) {
  if (typeof ua !== 'string' || !ua) return null;
  for (const t of MOBILE_TOKENS) {
    if (!t.shape.test(ua)) continue;
    const next = ua.replace(t.shape, t.replace);
    // 删完还认得出手机标记，说明这个形状不是我们以为的那个——不动，让它响亮地
    // 失败在 preflight 那句话上，而不是发一个我们没量过的 UA 出去。
    if (next === ua || looksMobile(next)) return null;
    return { userAgent: next, note: t.note };
  }
  return null;
}

/**
 * 规则本身。单独导出，便于在 Node 里断言它的形状。
 *
 * @param {string} userAgent
 */
export function desktopUaRule(userAgent) {
  return {
    id: DESKTOP_UA_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'User-Agent', operation: 'set', value: userAgent }],
    },
    condition: {
      urlFilter: PAGE_HOST_FILTER,
      resourceTypes: ['xmlhttprequest'],
      // 只管扩展自己发的请求。用户在标签页里逛豆瓣照样是手机版——那多半正是他要的。
      tabIds: [-1],
    },
  };
}

/**
 * 装上规则。**桌面浏览器上什么都不做**，连规则都不装。
 *
 * 那不是省事，是把风险面收窄到零：现在能正常工作的每一个用户，发出去的 UA 与今天
 * 逐字节相同。这条改动只能影响本来就一页都抓不成的那批设备。
 *
 * 装不上不抛：后果是抓取会停在 preflight 那句话上——响亮，而且现在那句话会自己
 * 说出原因（见 `session.js`），不是整个扩展起不来。
 *
 * @param {object} [deps]
 * @param {any} [deps.dnr]  注入 chrome.declarativeNetRequest，测试用
 * @param {string} [deps.userAgent]  注入 UA，测试用
 * @param {(msg: string, err?: unknown) => void} [deps.onError]
 * @returns {Promise<{installed: boolean, sentUserAgent: string | null, reason: string}>}
 */
export async function installDesktopUaRule({ dnr, userAgent, onError } = {}) {
  const ua = userAgent ?? globalThis.navigator?.userAgent ?? '';
  const desktop = desktopUserAgent(ua);

  if (!desktop) {
    return {
      installed: false,
      sentUserAgent: null,
      reason: looksMobile(ua)
        ? '认出这是手机浏览器，但没有量过它的桌面形态，不猜。'
        : '桌面浏览器，不需要改。',
    };
  }

  const api = dnr ?? globalThis.chrome?.declarativeNetRequest;
  if (!api?.updateSessionRules) {
    onError?.(
      '浏览器没有提供 declarativeNetRequest.updateSessionRules，无法把请求改成桌面版。' +
        '豆瓣会给手机 UA 发 m.douban.com，那上面没有这个扩展需要的任何东西，一页都抓不成。',
    );
    return { installed: false, sentUserAgent: null, reason: '浏览器不支持 updateSessionRules。' };
  }

  try {
    await api.updateSessionRules({
      // 先删后加：service worker 会被反复叫醒，不先删会撞「规则 ID 已存在」。
      removeRuleIds: [DESKTOP_UA_RULE_ID],
      addRules: [desktopUaRule(desktop.userAgent)],
    });
    return {
      installed: true,
      sentUserAgent: desktop.userAgent,
      reason: `${desktop.note}：去掉了 UA 里的手机标记，豆瓣才会发桌面版页面。`,
    };
  } catch (err) {
    onError?.('把请求改成桌面版的规则没装上，豆瓣会一直发 m.douban.com。', err);
    return { installed: false, sentUserAgent: null, reason: '规则没装上。' };
  }
}
