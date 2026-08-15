/**
 * 覆盖率页：这条链抓到哪儿了、哪儿有洞。
 */

import { chainRow, chainHeadline, holeText } from '../chain-label.js';
import { routeName, contiguityLabel } from '../route-names.js';
import { $, send, table, GAP_REASONS } from './shared.js';
import { loadBundleSummary } from './archive.js';

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

export async function loadCoverage() {
  const el = $('coverage');
  el.className = 'muted';
  el.textContent = '正在读取档案…';
  delete el.dataset.stale;

  try {
    const cur = await loadBundleSummary();
    if (!cur) {
      $('coverage-view').replaceChildren();
      $('chain').replaceChildren();
      el.className = 'muted';
      el.textContent = '还没有档案。开始一次抓取之后这里会显示对账结果。';
      return;
    }

    renderCoverageSwitch();

    if (coverageView === 'chain') {
      $('coverage').replaceChildren();
      await renderChain();
      return;
    }

    $('chain').replaceChildren();
    if (!cur.summary.hasManifest) {
      el.className = 'muted';
      el.textContent = '这次抓取还没收尾——覆盖率证据是收尾时才攒的，现在还没有。';
      return;
    }
    renderCoverage(cur.summary.coverage, cur.summary.crawlState, cur.id);
  } catch (e) {
    el.className = 'card tone-error';
    el.textContent = `读不出来：${e.message}`;
  }
}

/** 「合起来 / 这一份」的切换。 */
function renderCoverageSwitch() {
  const el = $('coverage-view');
  el.replaceChildren();
  for (const [key, label, why] of /** @type {const} */ ([
    ['chain', '合起来', '整条链覆盖到哪儿 —— 完整性是链的属性'],
    ['one', '这一份', '这一次抓取自己做了什么'],
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
async function renderChain() {
  const el = $('chain');
  el.className = 'muted';
  el.textContent = '正在读所有档案…';

  const r = await send({ type: 'chain' });
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
    el.textContent = '还没有收尾的档案。';
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
function renderCoverage(coverage, crawlState, bundleId) {
  const el = $('coverage');
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
    el.textContent = '还没有数据——跑完一条路线之后才会有。';
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
