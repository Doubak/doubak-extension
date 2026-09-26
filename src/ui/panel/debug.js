/**
 * 调试页：演练、小范围试跑、导出诊断。
 *
 * 这一页里全是**会改变抓取行为**的东西。删档案那种日常操作不放在这儿——
 * 摆在这儿等于训练用户往调试页找东西。
 */

import { SCENARIOS } from '../../crawl/dry-run.js';
import { $, send, bytes, table, VERDICT_NAMES } from './shared.js';
import { refresh } from './overview.js';

let debugLoaded = false;

/**
 * 一行「标题 + 说明 + 按钮」。
 *
 * @param {string} label @param {string} why @param {() => void} onClick
 */
function actionRow(label, why, onClick) {
  const row = document.createElement('div');
  row.className = 'lined-row';
  const b = document.createElement('button');
  b.className = 'act';
  b.textContent = label;

  b.onclick = onClick;
  const note = document.createElement('span');
  note.className = 'muted';
  note.className = note.className ? `${note.className} small` : 'small';
  note.textContent = why;
  row.append(b, note);
  return row;
}

export async function loadDebug() {
  if (debugLoaded) return;
  debugLoaded = true;

  // 演练剧本：每一个都对准一条**必须走对**的路径。
  const el = $('scenarios');
  el.replaceChildren();
  for (const [key, s] of Object.entries(SCENARIOS)) {
    el.append(actionRow(s.title, s.expect, () => runDryRun(key)));
  }

  // 小范围试跑
  const sc = $('scoped');
  sc.replaceChildren();
  const opts = [
    ['最近 7 天的广播', { days: 7 },
      '到达下界后正常终止并推进水位线，与常规增量抓取流程一致'],
    ['最近 30 天的广播', { days: 30 }, '逻辑同上，测试更大时间跨度'],
    ['舞台剧 · 看过（整条路线）', { routes: ['interest.drama.collect'] },
      '数据量较小的路线，可完整走完生命周期无需截断'],
    ['最多 10 条（安全阀）', { maxCaptures: 10 },
      '人为中断：不标记为完成且不推进水位线，生成未收尾档案'],
    ['作品详情页与封面图（约 20 次请求）',
      {
        routes: ['interest.drama.collect', 'interest.item', 'asset.subject_cover'],
        maxCaptures: 20,
        bypassGates: true,
      },
      '抓取单页舞台剧列表、对应作品详情及封面图——这两条路线占实际档案的大部分体积，' +
      '在全量抓取中排在最后；此处仅需约 20 次请求即可完整验证存储链路'],
  ];
  for (const [label, cfg, why] of opts) sc.append(actionRow(label, why, () => startScoped(cfg)));

  // 绕过门控这件事必须说出来，而不是藏在按钮说明里
  const gateNote = document.createElement('div');
  gateNote.className = 'card tone-idle';
  const gb = document.createElement('b');
  gb.textContent = '作品详情页选项将跳过默认抓取优先级';
  gateNote.append(gb, document.createTextNode(
    '在标准抓取流程中，作品详情页在动态抓取完成后才开始——动态可能被静默删除且无法恢复，' +
    '而作品详情页可随时重新获取。此调试项跳过默认优先级以便快速验证完整链路，仅建议在调试时使用。',
  ));
  sc.append(gateNote);

  // 环境自检
  const env = $('env');
  const rows = [
    ['OPFS', navigator.storage?.getDirectory ? '可用' : '不可用（致命）'],
    ['CompressionStream', typeof CompressionStream === 'function' ? '可用' : '不可用（致命）'],
    ['File System Access', typeof window.showDirectoryPicker === 'function' ? '可用' : '不可用（导不出档案）'],
  ];
  if (navigator.storage?.estimate) {
    const { usage, quota } = await navigator.storage.estimate();
    rows.push(['存储', `已用 ${bytes(usage ?? 0)} / 配额 ${bytes(quota ?? 0)}`]);
  }

  // 发给豆瓣的 User-Agent。**手机浏览器上这一行是能不能开工的关键**：UA 里带着
  // 手机标记的话豆瓣发的是 m.douban.com，那上面没有登录标志也没有数字 uid，
  // 抓取会停在「无法判断登录状态」上——而那句话过去不会说出真正的原因。
  // 见 crawl/desktop-ua.js 与 issue #12。
  const ua = await send({ type: 'desktopUa' }).catch(() => null);
  if (ua?.ok) {
    rows.push(['浏览器 User-Agent', ua.browserUserAgent ?? '(读不到)']);
    rows.push([
      '发给豆瓣的 User-Agent',
      ua.installed
        ? `${ua.sentUserAgent}（已去掉手机标记：${ua.reason}）`
        : `与上面相同 —— ${ua.reason}`,
    ]);
  }
  // 不显示 persist()：它在扩展里恒为 false，是预期行为而不是风险信号，
  // 保护来自 unlimitedStorage 权限。摆出来只会制造假的不确定性。
  env.replaceChildren(table(['项', '值'], rows));
}

/** @param {string} key */
async function runDryRun(key) {
  const el = $('dryrun-result');
  el.className = 'card tone-idle';
  el.textContent = `正在演练「${SCENARIOS[key].title}」…（不发出任何网络请求）`;

  const r = await send({ type: 'dryRun', scenario: key });
  if (!r?.ok) {
    el.className = 'card tone-error';
    el.textContent = `演练失败：${r?.error ?? ''}`;
    return;
  }

  const d = r.result;
  el.className = 'card tone-ok';
  el.replaceChildren();
  const b = document.createElement('b');
  b.textContent = `演练完成：${SCENARIOS[key].title}`;
  el.append(b);
  el.append(
    table(
      ['项', '结果'],
      [
        ['写入档案', `${d.captured} 条`],
        ['失败', String(d.failed)],
        ['停机原因', d.stoppedBy ?? '（没有，走到终点）'],
        ['判定分布',
          Object.entries(d.byVerdict ?? {})
            .map(([k, v]) => `${VERDICT_NAMES[k] ?? (k === 'unclassified' ? '判不出来' : k)} ${v}`)
            .join(' · ') || '—'],
        ['水位线是否推进', d.advanced === null ? '—' : d.advanced ? '是' : '否'],
      ],
    ),
  );
  const why = document.createElement('div');
  why.className = 'muted';
  why.className = why.className ? `${why.className} small` : 'small';
  why.textContent = `预期：${SCENARIOS[key].expect}`;
  el.append(why);
}

/** @param {object} cfg */
async function startScoped(cfg) {
  const r = await send({ type: 'start', scope: cfg });
  if (!r?.ok) {
    alert(`无法开始：${r?.error ?? ''}`);
    return;
  }
  // 跳回概览——试跑跟真实抓取一样，要在同一个地方观察。
  for (const b of $('tabs').querySelectorAll('button')) {
    const on = b.dataset.tab === 'overview';
    b.setAttribute('aria-selected', String(on));
    $(`tab-${b.dataset.tab}`).hidden = !on;
  }
  refresh();
}

/**
 * 把这一页的视图状态清回「刚打开面板」的样子。
 *
 * 拆分之前这件事是**隐式**的：整个面板就是一个模块，模块被加载 = 面板被打开，
 * 于是模块级变量天然是新的。拆成十个模块之后这个等号不再成立——壳可以重新跑，
 * 而各页的模块实例还在，上一次的 `preflightShown` 之类会跟着留下来。
 *
 * 所以现在由 `panel.js` 的启动段显式调用。生产环境里它每次都作用在全新的状态上，
 * 是个空操作；而测试里同一个进程要反复开面板，靠的就是它。
 */
export function resetDebug() {
  debugLoaded = false;
}
