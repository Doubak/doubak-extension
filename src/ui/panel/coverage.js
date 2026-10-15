/**
 * 覆盖率页：这条链抓到哪儿了、哪儿有洞。
 */

import { chainRow, chainHeadline, holeText } from '../chain-label.js';
import { routeName, contiguityLabel } from '../route-names.js';
import { $, send, table, GAP_REASONS, scanBundleDirs, getLastStatus } from './shared.js';
import { loadBundleSummary, selectSummaryBundle } from './archive.js';

/**
 * 覆盖率页自己去读档案。
 *
 * 读 OPFS 要经过 Worker，是异步的——所以必须先说「正在读取」。空白会被当成加载中，
 * 而空白其实意味着什么都不会发生。
 */
/**
 * 覆盖率页看的是哪个视角。
 *
 * 增量之后，**单份档案的「实抓」不再有完整性含义**——它可能只有 3 条新的。
 * 完整性是整条**链**的属性，所以默认看合起来。
 *
 * @type {'chain' | 'one'}
 */
let coverageView = 'chain';
let sourceFilter = 'all';
let filterAccount = null;
let coverageGeneration = 0;

export async function loadCoverage() {
  const generation = ++coverageGeneration;
  const el = $('coverage');
  $('chain').replaceChildren();
  el.className = 'muted';
  el.textContent = '正在读取档案…';
  delete el.dataset.stale;

  try {
    const cur = await loadBundleSummary();
    if (generation !== coverageGeneration) return;
    if (!cur) {
      filterAccount = null;
      sourceFilter = 'all';
      $('coverage-accounts').replaceChildren();
      $('coverage-accounts').hidden = true;
      $('coverage-view').replaceChildren();
      $('chain').replaceChildren();
      el.className = 'muted';
      el.textContent = '暂无档案。发起一次抓取后此处将显示对账结果。';
      return;
    }

    const all = await scanBundleDirs();
    if (generation !== coverageGeneration) return;
    const selected = renderAccountScope(cur, all);
    if (!selected.length) {
      renderCoverageSwitch(false);
      $('chain').replaceChildren();
      el.className = 'muted';
      el.textContent = '本次抓取尚未收尾——覆盖率证据在收尾时生成，目前尚不可用。';
      return;
    }
    renderCoverageSwitch(selected.length > 1);
    el.replaceChildren();
    const container = coverageView === 'chain' ? $('chain') : el;
    container.className = '';
    const status = getLastStatus();
    const activeRunner = status?.runner;
    const activeUid = activeRunner?.targetAccount?.userId ?? status?.checkpoint?.run_context?.account?.userId;
    if ((activeRunner?.active || status?.checkpoint) && activeUid && selected.some((item) => item.summary.account?.user_id === activeUid)) {
      const activeNotice = document.createElement('div');
      activeNotice.className = 'card tone-idle';
      const b = document.createElement('b');
      b.textContent = activeRunner?.active && !activeRunner.stopped
        ? '本次抓取正在进行中' : '本次抓取已暂停';
      activeNotice.append(b, document.createTextNode('（实时进度可在「概览」页查看）。覆盖率证据与连续性证明将在本次抓取收尾时生成并合并入链。'));
      container.append(activeNotice);
    }
    for (const item of selected) {
      const section = document.createElement('section');
      section.className = 'coverage-source';
      section.append(sourceNote(item.summary.crawlScope, Boolean(item.summary.account?.user_id)));
      const content = document.createElement('div');
      section.append(content);
      container.append(section);
      if (!item.summary.hasManifest) {
        content.className = 'muted';
        content.textContent = '本次抓取尚未收尾——覆盖率证据在收尾时生成，目前尚不可用。';
      } else if (coverageView === 'chain') {
        await renderChain(item.id, content);
        if (generation !== coverageGeneration) return;
      } else {
        renderCoverage(item.summary.coverage, item.summary.crawlState, item.id, content);
      }
    }
  } catch (e) {
    if (generation !== coverageGeneration) return;
    el.className = 'card tone-error';
    el.textContent = `读不出来：${e.message}`;
  }
}

/** 来源仅用于展示和筛选；链的身份校验仍由后台执行。 */
function scopeOf(scope) {
  if (scope?.visibility !== 'public') return 'self';
  return scope.operator_mode === 'anonymous' ? 'public:anonymous'
    : `public:authenticated:${scope.operator_user_id ?? 'unknown'}`;
}

function sourceLabel(scope) {
  if (scope?.visibility !== 'public') return '本人登录时备份';
  if (scope.operator_mode === 'anonymous') return '公开页面备份 · 未登录';
  return `公开页面备份 · ${scope.operator_user_id ? `登录账号 UID ${scope.operator_user_id}` : '未记录登录账号'}`;
}

function sourceNote(scope, known) {
  const note = document.createElement('div');
  note.className = 'coverage-source-note small';
  const label = document.createElement('b');
  label.textContent = known ? sourceLabel(scope) : '备份来源待确认';
  note.append(label);
  if (scope?.visibility === 'public') {
    const detail = document.createElement('span');
    detail.className = 'muted';
    detail.textContent = '仅反映当时可见的公开内容；数量差值不代表删除或私密条目数。';
    note.append(detail);
  }
  return note;
}

/** 默认按账号展示各来源；只有多种来源时才提供可选筛选。 */
function renderAccountScope(cur, all) {
  const box = $('coverage-accounts');
  box.replaceChildren();
  box.className = 'account-picker';
  const known = all.filter((e) => e.manifest?.account?.user_id);
  const uids = [...new Set(known.map((e) => e.manifest.account.user_id))];

  if (!uids.length) {
    box.hidden = true;
    filterAccount = null;
    sourceFilter = 'all';
    return cur?.summary?.hasManifest ? [cur] : [];
  }

  let uid = (cur?.summary?.hasManifest && cur.summary.account?.user_id && uids.includes(cur.summary.account.user_id))
    ? cur.summary.account.user_id
    : (filterAccount && uids.includes(filterAccount))
      ? filterAccount
      : null;

  if (!uid) {
    const st = getLastStatus();
    const activeUid = st?.runner?.targetAccount?.userId ?? st?.checkpoint?.run_context?.account?.userId;
    if (activeUid && uids.includes(activeUid)) {
      uid = activeUid;
    } else {
      uid = uids[0];
    }
  }

  box.hidden = false;
  if (filterAccount !== uid) {
    filterAccount = uid;
    sourceFilter = 'all';
  }

  const accountSelect = document.createElement('select');
  accountSelect.setAttribute('aria-label', '覆盖率目标账号');
  accountSelect.className = 'account-select';
  for (const id of uids) {
    const account = known.find((e) => e.manifest.account.user_id === id).manifest.account;
    const option = document.createElement('option');
    option.value = id;
    option.textContent = `${account.nickname || account.username || id}（UID ${id}）`;
    option.selected = id === uid;
    accountSelect.append(option);
  }
  accountSelect.value = uid;

  const items = known.filter((e) => e.manifest.account.user_id === uid)
    .sort((a, b) => b.bundleId.localeCompare(a.bundleId));

  // 档案页选中的那份若属于该账号且已收尾，仍作为该来源的起点；其他来源取最近的一份。
  const groups = new Map();
  if (cur?.summary?.hasManifest && cur.summary.account?.user_id === uid) {
    groups.set(scopeOf(cur.summary.crawlScope), cur);
  }
  for (const entry of items) {
    const m = entry.manifest;
    const key = scopeOf(m.crawl_scope);
    if (!groups.has(key)) {
      groups.set(key, {
        id: entry.bundleId,
        summary: {
          hasManifest: true,
          account: m.account,
          crawlScope: m.crawl_scope,
          coverage: m.coverage,
          crawlState: m.crawl_state,
        },
      });
    }
  }

  if (!groups.has(sourceFilter)) sourceFilter = 'all';

  // 同步当前选中的代表性档案给 summary 缓存，避免后续切视角时读到未收尾档案
  const rep = groups.get(sourceFilter) ?? groups.values().next().value;
  if (rep?.id && (!cur?.summary?.hasManifest || cur.summary.account?.user_id !== uid)) {
    selectSummaryBundle(rep.id);
  }

  const addSelect = (title, select) => {
    const label = document.createElement('label');
    label.className = 'account-select-label';
    label.append(document.createTextNode(title), select);
    box.append(label);
  };
  addSelect('账号', accountSelect);

  accountSelect.addEventListener('change', () => {
    const entry = known.filter((e) => e.manifest.account.user_id === accountSelect.value)
      .sort((a, b) => b.bundleId.localeCompare(a.bundleId))[0];
    if (entry) selectSummaryBundle(entry.bundleId);
    filterAccount = accountSelect.value;
    sourceFilter = 'all';
    void loadCoverage();
  });

  if (groups.size > 1) {
    const select = document.createElement('select');
    select.setAttribute('aria-label', '筛选备份来源');
    select.className = 'account-select';
    for (const [key, label] of [['all', '全部来源'], ...[...groups].map(([key, item]) => [key, sourceLabel(item.summary.crawlScope)])]) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = label;
      option.selected = key === sourceFilter;
      select.append(option);
    }
    select.value = sourceFilter;
    select.addEventListener('change', () => {
      sourceFilter = select.value;
      void loadCoverage();
    });
    addSelect('备份来源（可选）', select);
    const note = document.createElement('span');
    note.className = 'muted small';
    note.textContent = '不同来源能看到的内容可能不同，下面分别展示连续性，不合并计数。';
    box.append(note);
  }
  return sourceFilter === 'all' ? [...groups.values()] : [groups.get(sourceFilter)];
}

function renderCoverageSwitch(multiple) {
  const el = $('coverage-view');
  el.replaceChildren();
  for (const [key, label, why] of /** @type {const} */ ([
    ['chain', '合起来', '整条链覆盖到哪儿 —— 完整性是链的属性'],
    ['one', multiple ? '各看一份' : '这一份', '查看所选档案；其他来源各取最近的一份'],
  ])) {
    const b = document.createElement('button');
    b.className = 'act';
    b.textContent = label;
    b.title = why;
    b.disabled = coverageView === key;
    b.onclick = () => { coverageView = key; loadCoverage(); };
    el.append(b);
  }
}

/**
 * 「合起来」：整条链覆盖到哪儿。
 *
 * **主角是连续区间，不是数字。** 刻意不算「合起来一共抓了多少」再跟豆瓣声称的比：
 * 下界是闭区间、档案之间必然重叠，那个数只会误导；而这一页存在的全部理由就是
 * 「计数不能证明完整性，连续性才能」。
 */
async function renderChain(bundleId, el) {
  el.className = 'muted';
  el.textContent = '正在读所有档案…';

  const r = await send({ type: 'chain', bundleId });
  if (!r?.ok) {
    el.className = 'card tone-error';
    el.textContent = `读不出来：${r?.error ?? ''}`;
    return;
  }
  const { routes, bundles, holes, others } = r.chain;
  el.className = '';
  el.replaceChildren();

  if (!routes.length) {
    el.className = 'muted';
    el.textContent = '暂无已收尾的档案。';
    return;
  }

  const head = document.createElement('div');
  head.className = 'card tone-idle';
  const hb = document.createElement('b');
  hb.textContent = chainHeadline(bundles);
  // 箭头指向**更早的那一份**，也就是 `previous_bundle_id` 真正的指向：每一份档案
  // 记着自己接在谁后面。`bundles` 是新→旧，所以从左往右读就是往回走，箭头朝右。
  //
  // 原来这里写的是 `←`，配上新→旧的顺序，读出来是「旧的产出了新的」——方向反了。
  // 一张链条图上，读者唯一要靠的就是方向。约定写在 docs/ui.md「链条画成什么样」。
  head.append(hb, document.createTextNode(bundles.map((b) => b.bundleId).join(' → ')));
  el.append(head);

  el.append(table(
    ['路线', '覆盖区间', '跨几份', '连续性'],
    routes.map(chainRow).map((r) => [
      r.name,
      r.span ?? { text: r.spanNote, muted: true },
      String(r.bundles),
      r.verdict,
    ]),
  ));

  // 不在这条链上的档案要说出来：用户手上可能有好几次独立的全量，而这一页只讲
  // 最新那一条链——不提的话看起来像档案丢了。
  if (others?.length) {
    const c = document.createElement('div');
    c.className = 'card tone-idle';
    const b = document.createElement('b');
    b.textContent = `另有 ${others.length} 组档案不属于此链`;
    c.append(b, document.createTextNode(
      `${others.map((o) => o.head).join('、')}。它们均为独立抓取（未接续任何既有档案），`
      + '因此不能合并计算连续性。启用增量抓取之前的每一次抓取都属于此类。',
    ));
    el.append(c);
  }

  // 链断了要**明说**，而且不能因此把在场的那几份说成无效。
  for (const h of holes) {
    const c = document.createElement('div');
    c.className = 'card tone-warn';
    const b = document.createElement('b');
    b.textContent = holeText(h);
    c.append(b, document.createTextNode(h.detail));
    el.append(c);
  }
}

/** @param {object[]} coverage @param {object[]} crawlState @param {string} [bundleId] */
function renderCoverage(coverage, crawlState, bundleId, el) {
  el.replaceChildren();

  // 说清这是**哪一份**档案的对账。档案页有个下拉可以切换，不写出来的话两页对不上时
  // 没人知道自己在看什么。
  if (bundleId) {
    const which = document.createElement('div');
    which.className = 'muted';
    which.className = which.className ? `${which.className} small` : 'small';
    which.textContent = `档案 ${bundleId}`;
    el.append(which);
  }

  if (!coverage?.length) {
    el.className = 'muted';
    el.append(document.createTextNode('还没有数据——跑完一条路线之后才会有。'));
    return;
  }
  el.className = '';

  const csByRoute = new Map((crawlState ?? []).map((c) => [c.route_key, c]));
  el.append(
    table(
      ['路线', { text: '豆瓣声称', num: true }, { text: '实际抓到', num: true }, { text: '差值', num: true }, '连续性'],
      coverage.map((c) => {
        const cs = csByRoute.get(c.route_key);
        return [
          routeName(c.route_key),
          // null 与 0 是两件事，界面上也必须分开
          c.claimed_count === null ? { text: '—', muted: true, num: true } : { text: String(c.claimed_count), num: true },
          { text: String(c.captured_count), num: true },
          // 差值不用红色、不加感叹号、不写「缺失」——它不是错误
          c.delta === null ? { text: '—', muted: true, num: true } : { text: c.delta > 0 ? `+${c.delta}` : String(c.delta), num: true },
          cs ? (cs.contiguous ? '✔ 已验证' : '未验证') : { text: '—', muted: true },
        ];
      }),
    ),
  );

  // 差值非零时给出最可能的解释，免得用户以为是插件的 bug
  const odd = coverage.filter((c) => c.delta !== null && c.delta !== 0);
  if (odd.length) {
    const p = document.createElement('div');
    p.className = 'hint';
    p.textContent =
      '有差值的路线通常意味着有条目被豆瓣隐藏了——它的计数器知道这些条目存在，' +
      '但列表里不显示。你的备份本身是不是连续的，看「连续性」那一列。';
    el.append(p);
  }

  // 缺口要说出来，不能只显示一个叉
  for (const cs of crawlState ?? []) {
    if (!cs.gaps?.length) continue;
    const g = document.createElement('div');
    g.className = 'card tone-warn';
    const b = document.createElement('b');
    // 与进度表用同一套说法：说结论（有几处缺口），不说「未验证」——后者听起来像
    // 我们的代码没查，而其实查了。见 `contiguityLabel`。
    b.textContent = `${routeName(cs.route_key)} · ${contiguityLabel({
      contiguous: cs.contiguous, settled: true, gaps: cs.gaps,
    })}`;
    // 说人话，并且**把 detail 带出来**——写 detail 的地方正是那些「原因一个词说
    // 不清」的情形（比如「下一页没能入队」），而那句话原本只存在档案里没人看得到。
    const lines = [`有 ${cs.gaps.length} 处缺口。`];
    if (cs.gaps.some((x) => x.reason === 'no_items_observed')) {
      lines.push(
        '其中有一处是「页面声称有条目，但一个都没抽到」——那通常意味着豆瓣改版了，'
        + '抓取的终止判断因此失效。这一页已经如实存进档案，可据此重新校准。',
      );
    } else {
      const why = [...new Set(cs.gaps.map((x) => GAP_REASONS[x.reason] ?? x.reason))];
      lines.push(`原因：${why.join('；')}。`);
      const detail = cs.gaps.find((x) => x.detail)?.detail;
      if (detail) lines.push(detail);
      lines.push('这段区间的内容可能不完整，下次抓取会从上次的下界重走。');
    }
    g.append(b, document.createTextNode(lines.join('')));
    el.append(g);
  }
}
