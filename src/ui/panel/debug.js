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
      '到达下界后干净终止 → 水位线推进。这也是每次增量抓取的正常形态'],
    ['最近 30 天的广播', { days: 30 }, '同上，范围大一点'],
    ['舞台剧 · 看过（整条路线）', { routes: ['interest.drama.collect'] },
      '天然就很小的一条路线，能完整走完整个生命周期而不必截断'],
    ['最多 10 条（安全阀）', { maxCaptures: 10 },
      '人为截断 → 不算完成，水位线不推进，产出的是不完整的档案'],
    ['作品详情页与封面图（约 20 次请求）',
      {
        routes: ['interest.drama.collect', 'interest.item', 'asset.subject_cover'],
        maxCaptures: 20,
        bypassGates: true,
      },
      '先抓一页舞台剧列表，再抓它上面的作品详情页，最后抓这些作品的封面图 —— ' +
      '这两条路线占真实档案九成体积，但在全量抓取里排在最后，几小时之后才轮到。' +
      '这里几十次请求就能验完，包括「图片到底存进去了没有」'],
  ];
  for (const [label, cfg, why] of opts) sc.append(actionRow(label, why, () => startScoped(cfg)));

  // 绕过门控这件事必须说出来，而不是藏在按钮说明里
  const gateNote = document.createElement('div');
  gateNote.className = 'card tone-idle';
  const gb = document.createElement('b');
  gb.textContent = '作品详情页那一项会绕过抓取顺序';
  gateNote.append(gb, document.createTextNode(
    '正常抓取里，作品详情页要等广播抓完才开始——广播可以被静默删除，删了就再也拿不' +
    '回来；而作品详情页随时能重抓。不能拿最不可替代的东西去换最可替代的。' +
    '这一项为了几十次请求就能验完那条路线，显式跳过了这个顺序，所以它只适合调试。',
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
