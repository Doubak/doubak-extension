/**
 * 存储页：看占用、删档案。
 *
 * **删档案是日常操作，不是调试操作**，所以它有自己的一页。
 */

import { summarizeBundles, checkDeletable, totalBytes, hasUnexported } from '../../storage/storage-usage.js';
import { WorkerFileStore } from '../../storage/worker-file-store.js';
import { bundleIdFromDirName } from '../../core/ids.js';
import {
  $, send, bytes, table, getOpfsWorker,
  getStorageUsage, setStorageUsage, invalidateStorageUsage, getLastStatus,
} from './shared.js';
import { loadArchive, invalidateBundles, setArchiveButtons, clearSelection } from './archive.js';
import { refreshOpenTab } from './overview.js';

/** @type {import('../storage/storage-usage.js').BundleUsage[]} */

/**
 * 列出所有档案，标出体积与导出状态。
 *
 * 列表本身是**只读**的，所以走面板自己的只读 Worker，不必把 offscreen 拉起来。
 * 删除才需要它（那是唯一的写入路径）。
 */
export async function loadStorage() {
  const el = $('storage');
  el.className = 'muted';
  el.textContent = '正在统计…';

  try {
    const worker = getOpfsWorker();
    const dirNames = await WorkerFileStore.listBundleDirs(worker);

    /** @type {Array<{bundleId: string, dir: string, files: Array<{name: string, bytes: number}>}>} */
    const dirs = [];
    for (const dir of dirNames) {
      const bundleId = bundleIdFromDirName(dir);
      if (!bundleId) continue;
      const store = new WorkerFileStore({ worker, dir });
      const names = await store.list();
      const files = [];
      for (const name of names) files.push({ name, bytes: await store.size(name) });
      dirs.push({ bundleId, dir, files });
    }

    const ids = dirs.map((d) => d.bundleId);
    const rec = await send({ type: 'exportRecords', bundleIds: ids });
    const active = getLastStatus()?.runner?.active ? getLastStatus().runner.bundleId : null;

    setStorageUsage(summarizeBundles)({
      dirs,
      activeBundleId: active,
      exportedAt: rec?.exportedAt ?? {},
      // 记录读不出来时不许显示成「未导出」——那是替用户下一个我们没资格下的判断。
      exportRecordsUsable: Boolean(rec?.ok),
    });

    renderStorage();
  } catch (e) {
    el.className = 'card err';
    el.textContent = `统计不出来：${e.message}`;
  }
}

const EXPORT_STATE_TEXT = {
  exported: (at) => `✔ 已导出（${at.slice(0, 16).replace('T', ' ')}）`,
  not_exported: () => '未导出 —— 这是唯一的副本',
  unknown: () => '不确定（本机没有导出记录）',
};

function renderStorage() {
  const el = $('storage');
  el.replaceChildren();

  if (getStorageUsage().length === 0) {
    el.className = 'muted';
    el.textContent = '存储里没有档案。';
    $('storage-actions').replaceChildren();
    return;
  }

  el.className = '';
  el.append(
    table(
      ['档案', { text: '体积', num: true }, { text: '文件', num: true }, '状态', '导出', ''],
      getStorageUsage().map((u) => [
        u.bundleId,
        { text: bytes(u.bytes), num: true },
        { text: String(u.files), num: true },
        u.active ? '正在抓' : (u.hasManifest ? '已完成' : '未收尾'),
        {
          text: EXPORT_STATE_TEXT[u.exportState](u.exportedAt ?? ''),
          muted: u.exportState === 'exported',
        },
        '',
      ]),
    ),
  );

  // 给每行补删除按钮
  const rows = el.querySelectorAll('tr');
  getStorageUsage().forEach((u, i) => {
    const cell = rows[i + 1]?.lastElementChild;
    if (!cell) return;
    const b = document.createElement('button');
    b.className = 'act';
    b.textContent = '删除';
    b.disabled = !u.deletable;
    b.title = u.blockedReason ?? '';
    b.onclick = () => deleteBundle(u.bundleId);
    cell.replaceChildren(b);
    // 灰掉的按钮看起来像 bug，所以把原因也写出来。
    if (!u.deletable && u.blockedReason) {
      const why = document.createElement('span');
      why.className = 'muted';
      why.className = why.className ? `${why.className} small` : 'small';
      why.textContent = u.blockedReason;
      cell.append(why);
    }
  });

  const acts = $('storage-actions');
  acts.replaceChildren();
  const all = document.createElement('button');
  all.className = 'act';
  all.textContent = `清空全部（${getStorageUsage().length} 份 · ${bytes(totalBytes(getStorageUsage()))}）`;
  all.onclick = deleteAll;
  const note = document.createElement('span');
  note.className = 'muted';
  note.className = note.className ? `${note.className} small` : 'small';
  note.textContent = hasUnexported(getStorageUsage())
    ? '有档案没导出过 —— 清空之后不可能找回来'
    : '所有档案都导出过了';
  acts.append(all, note);
}

/** @param {string} bundleId */
/**
 * 删一份档案。
 *
 * `report` 让调用方决定把结果写到哪儿：存储页写自己的结果区，档案页写自己的——
 * 否则从档案页删完之后，成功/失败的消息会出现在一个用户看不见的标签页里。
 *
 * @param {string} bundleId
 * @param {object} [opts]
 * @param {(cls: string, text: string) => void} [opts.report]
 * @returns {Promise<boolean>} 是否真的删掉了
 */
async function deleteBundle(bundleId, { report = setStorageResult } = {}) {
  // 存储页可能还没打开过，`getStorageUsage()` 是空的——而确认框要说出「多大、导出过
  // 没有」，那些都在里面。先读一次。
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
  // 存储变了：作废缓存，并且如果当前选中的那份就是被删的那个，取消选中。
  // 不取消的话，下一次读取会去开一个不存在的目录然后报「读不出来」，
  // 而真实情况只是它被删了。
  invalidateBundles(getStorageUsage().filter((x) => x.bundleId !== u.bundleId).map((x) => x.bundleId));
  await loadStorage();
  await refreshOpenTab();
  return true;
}

// 档案页的「删除这一份」。
//
// 放在这里是因为**这里才有上下文**：你刚看过它有多少条、多大、导出过没有。
// 存储页那份是批量视角，两个都要——而删档案本来就不该只能在调试页里做。

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

  invalidateBundles(blocked.map((x) => x.bundleId));
  if (failed.length) setStorageResult('err', `有 ${failed.length} 份删不掉：${failed.join('；')}`);
  else setStorageResult('good', `已清空 ${deletable.length} 份档案`);
  await loadStorage();
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
 * 于是模块级变量天然是新的。拆成十个模块之后这个等号不再成立——壳可以重新跑，
 * 而各页的模块实例还在，上一次的 `preflightShown` 之类会跟着留下来。
 *
 * 所以现在由 `panel.js` 的启动段显式调用。生产环境里它每次都作用在全新的状态上，
 * 是个空操作；而测试里同一个进程要反复开面板，靠的就是它。
 */
export function resetStorage() {
  setStorageUsage([]);
}
