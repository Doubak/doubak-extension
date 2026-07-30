/**
 * 最小 popup（docs/ui.md 的 U1）。
 *
 * 够用来跑通并观察第一次真实抓取，仅此而已。日志、范围选择、覆盖率表格都在
 * 完整面板里（U2 之后），不挤进这里——popup 一失焦就关。
 *
 * ## 两条来自 docs/ui.md 的硬约束
 *
 * **① 界面只读状态、只发命令**，不直接改抓取状态。所有状态都活在 service
 * worker 那边，popup 每次打开都重新读。
 *
 * **② 进度不用百分比。** 豆瓣的计数不可信（审查前后统计口径不一），拿它当
 * 分母会给出一个看起来特别可信的假数字。有时间边界的路线显示**已回溯到的
 * 日期**，那个是真的。
 */

const $ = (id) => document.getElementById(id);

/** @param {object} msg */
function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (r) =>
      resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r),
    );
  });
}

/**
 * 各种停下来的原因该怎么说话。
 *
 * 原则（docs/ui.md §5）：不说「错误」——风控与验证码是正常的抓取过程；
 * 明确「不会自动重试」，那是在保护账号而不是卡住了；每条都给出下一步。
 */
const PAUSE_COPY = {
  challenge: {
    cls: 'warn',
    title: '豆瓣要求验证',
    why: '请在新标签页里完成验证，完成后回来点继续。插件和你共用登录状态。',
    action: '我验证好了，继续',
  },
  blocked: {
    cls: 'warn',
    title: '豆瓣暂时限制了访问',
    why: '已经停下来了，不会自动重试——继续请求可能导致账号被限制。建议等待 30 分钟以上。',
    action: '现在试试',
  },
  session_expired: {
    cls: 'warn',
    title: '登录状态已失效',
    why: '这不是错误，抓取已安全停下，进度都在。请重新登录豆瓣后继续。',
    action: '我登录好了，继续',
  },
  account_switched: {
    cls: 'err',
    title: '账号变了',
    why: '一个档案只能属于一个账号。请切回原来的账号，或另开一次抓取。',
    action: null,
  },
  quota: {
    cls: 'err',
    title: '存储空间不足',
    why: '需要先导出或清理再继续。已经抓到的都还在。',
    action: null,
  },
  host_permission_lost: {
    cls: 'err',
    title: '豆备没有访问豆瓣的权限了',
    why: '请在浏览器的扩展设置里把站点访问权限改回「在所有网站上」。已经抓到的都还在。',
    action: null,
  },
  write_failed: {
    cls: 'err',
    title: '写入档案时出错',
    why: '已经停下来了，以免损坏已有数据。继续之前会先自动修复段文件尾部。',
    action: '我知道了，继续',
  },
  user_paused: { cls: 'idle', title: '已暂停', why: '进度都在，随时可以继续。', action: '继续' },
  // 这一条应当安静，不该吓人
  crash: { cls: 'run', title: '正在从断点恢复', why: '上次被意外中断，没有数据丢失。', action: null },
};

/**
 * popup 也每 2 秒刷一次，同样要避免无谓重建（见 panel.js 里的说明）。
 *
 * @param {string} cls @param {string} title @param {string} [why]
 */
function setState(cls, title, why = '') {
  const el = $('state');
  const key = `${cls}\u0000${title}\u0000${why}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.className = cls;
  el.replaceChildren();
  const b = document.createElement('b');
  b.textContent = title;
  el.append(b);
  if (why) {
    const d = document.createElement('div');
    d.className = 'why';
    d.textContent = why;
    el.append(d);
  }
}

/** @param {Array<[string, string]>} rows */
function setStats(rows) {
  const t = $('stats');
  const key = rows.map((r) => r.join('\u0001')).join('\u0000');
  if (t.dataset.key === key) return;
  t.dataset.key = key;
  t.replaceChildren();
  t.hidden = rows.length === 0;
  for (const [k, v] of rows) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.className = 'k';
    td1.textContent = k;
    const td2 = document.createElement('td');
    td2.textContent = v;
    tr.append(td1, td2);
    t.append(tr);
  }
}

/** 路线名的中文显示。界面上不出现内部术语。 */
const ROUTE_NAMES = {
  'broadcast.timeline': '广播',
  'profile.overview': '个人主页',
  'interest.movie.collect': '电影 · 看过',
  'interest.movie.wish': '电影 · 想看',
  'interest.movie.do': '电影 · 在看',
  'interest.book.collect': '书 · 读过',
  'interest.music.collect': '音乐 · 听过',
  'interest.game.collect': '游戏 · 玩过',
  'interest.drama.collect': '舞台剧 · 看过',
};

/** @param {Array<object>} routes */
function setRoutes(routes) {
  const el = $('routes');
  const key = routes.map((r) => `${r.routeKey}\u0001${r.captured}\u0001${r.oldestSeen ?? ''}`).join('\u0000');
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.replaceChildren();
  for (const r of routes) {
    const row = document.createElement('div');
    const name = document.createElement('span');
    name.textContent = ROUTE_NAMES[r.routeKey] ?? r.routeKey;

    const info = document.createElement('span');
    info.className = 'hw';
    // 进度用「已回溯到 X」而不是百分比——豆瓣的计数不可信。
    // 进度是 `oldestSeen`（本次最旧的一条）。水位线（最新那条）在第一页就定住了，
    // 拿它当进度会一动不动。
    info.textContent = r.oldestSeen
      ? `${r.captured} 条 · 已回溯到 ${r.oldestSeen.slice(0, 10)}`
      : `${r.captured} 条`;

    row.append(name, info);
    el.append(row);
  }
}

/** @param {string} text @param {(() => void) | null} onClick */
function setPrimary(text, onClick) {
  const b = $('primary');
  if (b.textContent !== text) b.textContent = text;
  b.disabled = !onClick;
  b.onclick = onClick;
}

async function refresh() {
  const s = await send({ type: 'status' });

  if (!s?.ok) {
    setState('err', '连不上后台', s?.error ?? '');
    setPrimary('重试', refresh);
    return;
  }

  // 已经在内存里但停下来了。`active` 不等于「正在发请求」——不分开的话，暂停之后
  // 界面还写着「正在抓取」，用户会以为按钮没生效。
  if (s.runner?.active && s.runner.stopped) {
    const copy = PAUSE_COPY[s.runner.stoppedBy] ?? {
      cls: 'warn', title: '抓取已停下', why: `原因：${s.runner.stoppedBy}`, action: '继续',
    };
    setState(copy.cls, copy.title, copy.why);
    setStats([['档案', s.runner.bundleId]]);
    setRoutes(s.runner.routes ?? []);
    setPrimary(copy.action ?? '无法继续', copy.action
      ? async () => { await send({ type: 'resume' }); refresh(); }
      : null);
    $('note').textContent = '';
    return;
  }

  // 正在抓
  if (s.runner?.active) {
    const r = s.runner;
    setState('run', '正在抓取', `档案 ${r.bundleId}`);
    setStats([
      ['已完成', String(r.counts.done)],
      ['待抓', String(r.counts.pending)],
      ['当前间隔', `${(r.intervalMs / 1000).toFixed(1)} 秒${r.backoffLevel ? `（已降速 ${r.backoffLevel} 级）` : ''}`],
    ]);
    setRoutes(r.routes ?? []);
    setPrimary('暂停', async () => {
      setPrimary('正在暂停…', null);
      await send({ type: 'pause' });
      refresh();
    });
    $('note').textContent = '可以关掉这个窗口，抓取在后台继续。';
    return;
  }

  // 停下来了，但有未完成的抓取
  if (s.checkpoint) {
    const copy = PAUSE_COPY[s.checkpoint.pause_reason] ?? {
      cls: 'warn',
      title: '抓取已停下',
      why: `原因：${s.checkpoint.pause_reason}`,
      action: '继续',
    };
    setState(copy.cls, copy.title, copy.why);
    setStats([['档案', s.checkpoint.bundle_id]]);
    setRoutes([]);
    setPrimary(
      copy.action ?? '无法继续',
      copy.action
        ? async () => {
            setPrimary('正在继续…', null);
            const r = await send({ type: 'resume' });
            if (!r?.ok) setState('err', '继续失败', r?.error ?? '');
            refresh();
          }
        : null,
    );
    $('note').textContent = '';
    return;
  }

  // 空闲
  setState('idle', '没有进行中的抓取');
  setStats([]);
  setRoutes([]);
  setPrimary('开始抓取', async () => {
    setPrimary('正在确认账号…', null);
    const r = await send({ type: 'start' });
    if (!r?.ok) {
      setState('err', '无法开始', r.error ?? '');
      setPrimary('重试', refresh);
      return;
    }
    refresh();
  });
  $('note').textContent = '请求全部来自你自己的浏览器和 IP。cookie 不会发送到任何地方。';
}

// 长内容都在完整面板里——popup 一失焦就关，放不下日志与表格。
$('panel').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/panel.html') });
});

refresh();
// 抓取中每两秒刷新一次。popup 关掉就停——它只是个视图。
setInterval(() => {
  if (!document.hidden) refresh();
}, 2000);
