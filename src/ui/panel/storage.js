/**
 * 档案页上「整批」的那一层：占了多少、哪些没导出、清空、删一份。
 *
 * ## 为什么它不再是一个标签页
 *
 * 「存储」原来自己占一页，列的却是与档案页同一批档案，只是换了几列。两份清单意味着
 * 两处要各自记得失效、各自扫一遍盘，而用户还要在两页之间对「刚才看的是哪一份」。
 *
 * 合成一页之后分工是清楚的：**这个模块管整批，`archive.js` 管选中的那一份。**
 * 清单只有一份（档案页左边那个选择器），它已经把每份的时间、体积、条数、导出状态都
 * 说出来了——存储页那张表其实是它的一个子集。
 *
 * 留下来的是那张表**不能**表达的东西：总占用与配额、一次清空、以及「能不能删」
 * 那套判断（`storage-usage.js`，纯函数，因为删除不可逆）。
 */

import { summarizeBundles, checkDeletable, totalBytes } from '../../storage/storage-usage.js';
import {
  $, send, bytes,
  getStorageUsage, setStorageUsage, scanBundleDirs, invalidateBundleScan, getLastStatus,
} from './shared.js';
import {
  loadArchive, invalidateBundles, setArchiveButtons, clearSelection, currentBundleId,
} from './archive.js';
import { refreshOpenTab } from './overview.js';

/**
 * 统计占用与导出状态。
 *
 * 走的是面板自己的只读 Worker，不必把 offscreen 拉起来——列表本身是**只读**的。
 * 删除才需要它（那是唯一的写入路径）。
 */
export async function loadStorage() {
  const el = $('storage');
  el.className = 'muted small';
  el.textContent = '正在统计…';

  try {
    const dirs = await scanBundleDirs();
    const rec = await send({ type: 'exportRecords', bundleIds: dirs.map((d) => d.bundleId) });
    const active = getLastStatus()?.runner?.active ? getLastStatus().runner.bundleId : null;

    setStorageUsage(summarizeBundles({
      dirs,
      activeBundleId: active,
      exportedAt: rec?.exportedAt ?? {},
      // 记录读不出来时不许显示成「未导出」——那是替用户下一个我们没资格下的判断。
      exportRecordsUsable: Boolean(rec?.ok),
    }));

    renderStorage();
  } catch (e) {
    el.className = 'card err';
    el.textContent = `统计不出来：${e.message}`;
  }
}

function renderStorage() {
  const el = $('storage');
  const usage = getStorageUsage();
  const all = $('delete-all');

  if (usage.length === 0) {
    el.className = 'muted small';
    el.textContent = '扩展里还没有档案。抓一次，或者从文件夹导入以前导出过的。';
    all.disabled = true;
    all.textContent = '清空全部';
    return;
  }

  all.disabled = usage.every((u) => !u.deletable);
  all.textContent = `清空全部（${usage.length} 份 · ${bytes(totalBytes(usage))}）`;

  // 一行小字，说三件事：多少份、多大、其中几份还只有这一个副本。
  // **「未导出」要显眼**——那是「删了就没了」的意思，而这一行紧挨着「清空全部」。
  const unexported = usage.filter((u) => u.exportState !== 'exported');
  el.className = unexported.length ? 'warn-text small' : 'muted small';
  el.textContent = `${usage.length} 份 · ${bytes(totalBytes(usage))}`
    + (unexported.length
      ? ` · ⚠ 其中 ${unexported.length} 份没有导出记录，浏览器里这一份可能是唯一的副本`
      : ' · 全部导出过');
}

/**
 * 删一份档案。
 *
 * `report` 让调用方决定把结果写到哪儿——否则从档案详情里删完之后，成功/失败的消息
 * 会出现在一个用户没在看的地方。
 *
 * @param {string} bundleId
 * @param {object} [opts]
 * @param {(cls: string, text: string) => void} [opts.report]
 * @returns {Promise<boolean>} 是否真的删掉了
 */
export async function deleteBundle(bundleId, { report = setStorageResult } = {}) {
  // 用量可能还没算过，而确认框要说出「多大、导出过没有」，那些都在里面。
  if (!getStorageUsage().length) await loadStorage();

  // 界面上那个确认框是给人看的，`checkDeletable` 是给代码守的。**两者都要有**——
  // 用户可能点得很快。
  const check = checkDeletable(getStorageUsage(), bundleId);
  if (!check.ok) {
    report('err', check.error);
    return false;
  }
  const u = check.target;

  // 确认框要把**要失去的具体东西**说出来：哪一份、多大、导出过没有。
  // 一句「确定删除吗？」等于什么都没说。
  const lines = [
    `删除档案 ${u.bundleId}？`,
    `${bytes(u.bytes)} · ${u.files} 个文件 · ${u.hasManifest ? '已完成' : '未收尾'}`,
    '',
    u.exportState === 'exported'
      ? `你在 ${u.exportedAt.slice(0, 16).replace('T', ' ')} 导出过它。`
      : '⚠ 没有导出记录 —— 浏览器里这一份可能是唯一的副本。',
    '',
    '删除不可逆，没有回收站。',
  ];
  if (!confirm(lines.join('\n'))) return false;

  report('idle', `正在删除 ${u.bundleId}…`);
  const r = await send({ type: 'deleteBundle', bundleId: u.bundleId, dir: u.dir });
  if (!r?.ok) {
    report('err', `删不掉：${r?.error ?? ''}`);
    return false;
  }
  report('good', `已删除 ${u.bundleId}（释放 ${bytes(u.bytes)}）`);
  // 存储变了：两处缓存都作废，并且如果当前选中的那份就是被删的那个，取消选中。
  // 不取消的话，下一次读取会去开一个不存在的目录然后报「读不出来」，
  // 而真实情况只是它被删了。
  invalidateBundleScan();
  invalidateBundles(getStorageUsage().filter((x) => x.bundleId !== u.bundleId).map((x) => x.bundleId));
  await loadStorage();
  await refreshOpenTab();
  return true;
}

async function deleteAll() {
  const deletable = getStorageUsage().filter((u) => u.deletable);
  const blocked = getStorageUsage().filter((u) => !u.deletable);
  if (deletable.length === 0) {
    setStorageResult('err', '没有可删的档案' + (blocked.length ? '（正在抓的那份不能删）' : ''));
    return;
  }

  const unexported = deletable.filter((u) => u.exportState !== 'exported');
  const lines = [
    `清空 ${deletable.length} 份档案，共 ${bytes(totalBytes(deletable))}？`,
    '',
    ...deletable.map((u) => `· ${u.bundleId} ${bytes(u.bytes)}`),
    '',
  ];
  if (unexported.length) {
    lines.push(`⚠ 其中 ${unexported.length} 份没有导出记录，可能是唯一的副本。`, '');
  }
  if (blocked.length) lines.push(`（${blocked.length} 份正在抓，会保留）`, '');
  lines.push('删除不可逆，没有回收站。');
  if (!confirm(lines.join('\n'))) return;

  // 逐个删而不是一把梭：一份失败不该让其余的也不删，而且要说清哪些成了。
  const failed = [];
  for (const u of deletable) {
    setStorageResult('idle', `正在删除 ${u.bundleId}…`);
    const r = await send({ type: 'deleteBundle', bundleId: u.bundleId, dir: u.dir });
    if (!r?.ok) failed.push(`${u.bundleId}（${r?.error ?? ''}）`);
  }

  invalidateBundleScan();
  invalidateBundles(blocked.map((x) => x.bundleId));
  if (failed.length) setStorageResult('err', `有 ${failed.length} 份删不掉：${failed.join('；')}`);
  else setStorageResult('good', `已清空 ${deletable.length} 份档案`);
  await loadStorage();
  await loadArchive();
  await refreshOpenTab();
}

/** @param {string} cls @param {string} text */
function setStorageResult(cls, text) {
  const el = $('storage-result');
  el.className = `card ${cls}`;
  el.textContent = text;
}

/** 绑事件。 */
export function initStorage() {
  $('delete-all').addEventListener('click', deleteAll);

  $('delete-this').addEventListener('click', async () => {
    if (!currentBundleId) return;
    const gone = await deleteBundle(currentBundleId, {
      report: (cls, text) => {
        const el = $('export-result');
        el.className = `card ${cls}`;
        el.textContent = text;
      },
    });
    if (!gone) return;
    // 删掉的正是当前打开的这一份：清空视图，别让用户对着一份不存在的档案的数字看。
    clearSelection();
    $('archive-summary').replaceChildren();
    $('vanished').replaceChildren();
    setArchiveButtons(false);
    await loadArchive();
  });

  $('selftest').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('selftest/index.html') });
  });
}

/**
 * 把这一页的视图状态清回「刚打开面板」的样子。
 *
 * 拆分之前这件事是**隐式**的：整个面板就是一个模块，模块被加载 = 面板被打开，
 * 于是模块级变量天然是新的。拆成多个模块之后这个等号不再成立——壳可以重新跑，
 * 而各页的模块实例还在。所以现在由 `panel.js` 的启动段显式调用。
 */
export function resetStorage() {
  setStorageUsage([]);
  invalidateBundleScan();
}
