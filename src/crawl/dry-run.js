/**
 * 演练：用固定夹具跑完整条链路，**一个网络请求都不发**。
 *
 * ## 为什么需要它
 *
 * 有些场景**不能靠真实抓取来验证**：
 *
 * | 场景 | 为什么不能真跑 |
 * |---|---|
 * | 被风控拦截 | 唯一的触发办法是真的去撞，而那正是要不惜代价避免的事 |
 * | 验证码挑战 | 同上 |
 * | 会话失效 | 得让用户中途退出登录，太折腾 |
 * | 账号被换掉 | 需要两个账号 |
 *
 * 而这些恰恰是**最要紧**的路径——判错方向的代价是账号。所以给它们一条不碰
 * 豆瓣的验证路子：拿手写的夹具喂进真实的传输层之上，让分类器、frontier、
 * 写入器、水位线全部真跑一遍。
 *
 * 除了网络，其余每一块都是生产代码。
 *
 * ## 与单元测试的区别
 *
 * 单元测试跑在 Node 里，用的是内存存储。演练跑在**浏览器里**，写的是真的
 * OPFS，走的是真的 service worker。它验证的是「这些部件装进浏览器之后还能
 * 一起工作」——而那是 Node 测不到的一层。
 */

// `_GLOBAL_NAV.USER_ID` 是数字 uid 的唯一来源。真实页面上它就在全局导航里，
// 而全局导航每张登录后页面都有——包括作品详情页。见 src/crawl/session.js。
const NAV_IN = `<li class="nav-user-account"><a href="/accounts/logout">退出</a>
<span>演练的账号</span></li><a href="https://www.douban.com/people/dryrun/">主页</a>
<script>;window._GLOBAL_NAV = { USER_ID: "99000001" };</script>`;

const NAV_OUT = `<a href="https://accounts.douban.com/passport/login" class="nav-login">登录/注册</a>`;

/** @param {number} n @param {number} from @param {string} day */
function broadcastPage(n, from, day = '26') {
  let items = '';
  for (let i = 0; i < n; i++) {
    items += `<div class="status-item" data-sid="${from + i}" data-uid="99000001"
      data-action="1" data-target-type="movie">
      <span class="created_at" title="2026-07-${day} 1${i % 9}:0${i % 6}:00">7月${day}日</span>
      <div class="others"><div class="comments"><div class="comments-items"></div></div></div>
    </div>`;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>
    演练的广播
</title></head><body><div id="db-global-nav">${NAV_IN}</div>
<div class="stream-items">${items}</div></body></html>`;
}

/** 个人主页：必须能取到数字用户 ID，否则连开始都开始不了。 */
const PROFILE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>演练的账号</title></head>
<body><div id="db-global-nav">${NAV_IN}</div>
<div class="status-item" data-sid="1" data-uid="99000001">x</div></body></html>`;

/** 会话过期的登录页。真实档案里出现过两个，被当数据写进了磁盘。 */
const LOGIN = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>
    登录豆瓣
</title></head><body><form><input name="username"><div>请输入验证码</div></form></body></html>`;

/** 风控拦截页，HTTP 200 —— 只看状态码等于完全没有检测。 */
const BLOCKED = `<!DOCTYPE html><html><head><title>豆瓣</title></head>
<body><p>访问过于频繁，请稍后再试</p></body></html>`;

const CHALLENGE = `<!DOCTYPE html><html><head><title>豆瓣</title></head>
<body><p>有异常请求，请输入验证码后继续</p><img src="/captcha"></body></html>`;

/** 未登录但有数据——真实档案里 151 个页面就是这样，看起来完全正常。 */
const ANON_WITH_DATA = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>
    某人的广播
</title></head><body><div id="db-global-nav">${NAV_OUT}</div>
<div class="status-item" data-sid="777" data-uid="12345">
<span class="created_at" title="2026-07-26 12:00:00">x</span></div></body></html>`;

/**
 * 可选的演练剧本。每个都对准一条**必须走对**的路径。
 *
 * @type {Record<string, {title: string, expect: string, pages: (p: number) => {status?: number, body: string}}>}
 */
export const SCENARIOS = {
  clean: {
    title: '正常抓完（停滞终止）',
    expect: '三页内容之后是空的越界页，连续三页无进展触发停滞 → 干净完成，水位线可推进',
    pages: (p) => {
      if (p <= 3) return { body: broadcastPage(20, (p - 1) * 20, String(26 - p)) };
      return { body: broadcastPage(0, 0) }; // 越界终止页：0 条但页面完全正常
    },
  },

  terminator_vs_login: {
    title: '越界页 vs 登录页（都是 0 条）',
    expect:
      '第 2 页是 0 条的正常终止页（判 ok），第 4 页是 0 条的登录页（判 login 并停机）——' +
      '两者条目数相同，判定必须不同',
    pages: (p) => {
      if (p === 1) return { body: broadcastPage(20, 0) };
      if (p === 2) return { body: broadcastPage(0, 0) };
      if (p === 3) return { body: broadcastPage(20, 20, '24') };
      return { body: LOGIN };
    },
  },

  blocked: {
    title: '被风控拦截',
    expect: '第 2 页返回 HTTP 200 的封锁页 → 判 blocked、写进档案、降速、转等待人工、不重试',
    pages: (p) => (p === 1 ? { body: broadcastPage(20, 0) } : { body: BLOCKED }),
  },

  challenge: {
    title: '要求验证码',
    expect: '第 2 页带验证码 → 判 challenge、转等待人工、绝不自动重试',
    pages: (p) => (p === 1 ? { body: broadcastPage(20, 0) } : { body: CHALLENGE }),
  },

  session_lost: {
    title: '抓到一半掉登录',
    expect: '第 3 页变成登录页 → 整场停机（停止条件，不是可重试错误），已抓的照样留在档案里',
    pages: (p) => (p <= 2 ? { body: broadcastPage(20, (p - 1) * 20) } : { body: LOGIN }),
  },

  anon_with_data: {
    title: '未登录但页面有数据',
    expect:
      '页面看起来完全正常、有真实条目，但导航栏是登录入口 → 必须判 login。' +
      '公开视图里没有私密条目，当成账号数据就是把不完整的列表冒充成完整的',
    pages: () => ({ body: ANON_WITH_DATA }),
  },

  server_error: {
    title: '服务端错误',
    expect: '连续 5xx → 判不出来，按可重试处理，重试用尽后判失败并阻塞该路线',
    pages: () => ({ status: 503, body: '<html>server error</html>' }),
  },

  unknown_page: {
    title: '完全不认识的页面',
    expect: '登录状态还在，但页面框架对不上 → 判不出来（不是 ok），如实写进档案并记下判定依据',
    pages: () => ({
      body: `<!DOCTYPE html><html><head><meta charset="utf-8"><title>豆瓣</title></head>
<body><div id="db-global-nav">${NAV_IN}</div><div>改版之后完全不认识的结构</div></body></html>`,
    }),
  },
};

/**
 * 造一个只认夹具的 fetch。
 *
 * **它不会发出任何网络请求**——这是演练模式的全部意义。
 *
 * @param {string} scenarioKey
 * @param {(info: object) => void} [onRequest]
 * @returns {typeof fetch}
 */
export function dryRunFetch(scenarioKey, onRequest = () => {}) {
  const scenario = SCENARIOS[scenarioKey];
  if (!scenario) throw new Error(`没有这个演练剧本：${scenarioKey}`);

  return async (url) => {
    const u = String(url);
    onRequest({ url: u });

    // 个人主页：身份确认与 /mine/ 跳转都走这里
    if (u.includes('/people/') && !u.includes('statuses') && !u.includes('collect')) {
      return fakeResponse(u, 200, PROFILE);
    }
    if (u.endsWith('/mine/')) {
      return fakeResponse(u, 302, '', { location: 'https://www.douban.com/people/dryrun/' });
    }

    // 广播分页
    const m = /[?&]p=(\d+)/.exec(u);
    if (u.includes('statuses')) {
      const { status = 200, body } = scenario.pages(m ? Number(m[1]) : 1);
      return fakeResponse(u, status, body);
    }

    // 其余路线一律给空的正常页，免得演练被无关路线拖长
    return fakeResponse(u, 200, broadcastPage(0, 0));
  };
}

/** @param {string} url @param {number} status @param {string} body @param {Record<string,string>} [headers] */
function fakeResponse(url, status, body, headers = {}) {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    url,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8', ...headers }),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}
