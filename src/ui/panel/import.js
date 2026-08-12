/**
 * 导入：把用户文件夹里的档案搬回扩展。
 *
 * ## 为什么这一页存在
 *
 * 我们一直在劝用户「导出之后可以安全地删掉扩展里那一份」。那句话只有在**它回得来**
 * 的前提下才诚实——否则下一次增量抓取找不到基准，退回全量：几小时，还要把几千个
 * 作品详情页重抓一遍。换机器、重装浏览器、清过站点数据，都是同一件事。
 *
 * ## 先看清楚，再动一个字节
 *
 * 点完文件夹之后**先扫描、先判断、先把「将要发生什么」整份说出来**，用户确认了才写。
 * 这与导出那边「目的地非空时先去数一数已经导好了几个，再把将要发生什么原原本本说
 * 出来」是同一条规矩：「已经有 12 个文件，覆盖吗」和「12 个已经导好、还差 8 个，
 * 只补这 8 个」是完全不同的两句话，而后者才是实情。
 *
 * ## 覆盖不是靠这里拦住的
 *
 * 这一页会拒绝一批东西（编号对不上、段文件缺失、账号不同、已经有了），但
 * **「绝不覆盖已有档案」不靠这些判断**——那条在 Worker 一侧：导入用的 Worker 只能
 * 新建文件，碰不到任何已经在那儿的字节（storage/opfs-import-worker.js）。
 * 这里的判断是为了**把话说清楚**，不是为了当锁。
 */

import {
  readBundleMeta, planImport, importBundle, scanForBundles, ACTIONS,
} from '../../bundle/importer.js';
import { WorkerFileStore } from '../../storage/worker-file-store.js';
import { bundleDirName } from '../../core/ids.js';
import { shortId } from '../components.js';
import {
  $, bytes, scanBundleDirs, invalidateStorageUsage, getLastStatus,
} from './shared.js';
import { loadArchive } from './archive.js';
import { loadStorage } from './storage.js';
import { refreshOpenTab } from './overview.js';

/**
 * 可写的那个 OPFS Worker。
 *
 * **与面板其余部分共用的那个是两回事**：那个是只读入口（`opfs-worker.js`），
 * 而且必须继续是只读的——看档案、导出没有任何理由能写。这里起的是导入专用入口，
 * 它只能新建文件。
 *
 * @type {Worker | null}
 */
let importWorker = null;
function getImportWorker() {
  if (!importWorker) {
    importWorker = new Worker(chrome.runtime.getURL('src/storage/opfs-import-worker.js'), {
      type: 'module',
    });
  }
  return importWorker;
}

/** 每种处置在界面上叫什么。**「不导」的几种要各自有名字**——合成一句「跳过」等于没说。 */
const ACTION_LABEL = {
  [ACTIONS.IMPORT]: '导入',
  [ACTIONS.RESUME]: '补齐',
  [ACTIONS.PRESENT]: '已经有了',
  [ACTIONS.DUPLICATE]: '重复',
  [ACTIONS.CONFLICT]: '编号撞了',
  [ACTIONS.OTHER_ACCOUNT]: '别的账号',
  [ACTIONS.ACTIVE]: '正在抓',
  [ACTIONS.REFUSE]: '不能导',
};

const WILL_WRITE = new Set([ACTIONS.IMPORT, ACTIONS.RESUME]);

/** @param {string} cls @param {string|Node} body */
function say(cls, body) {
  const el = $('import-result');
  el.className = `card ${cls}`;
  if (typeof body === 'string') el.textContent = body;
  else el.replaceChildren(body);
}

/** OPFS 里已经有什么，按 `planImport` 要的形状。 */
async function readExisting() {
  return (await scanBundleDirs({ force: true })).map((d) => ({
    bundleId: d.bundleId,
    files: d.files,
    accountUserId: d.manifest?.account?.user_id ?? null,
    accountUsername: d.manifest?.account?.username ?? null,
  }));
}

/**
 * 把清单画出来。
 *
 * 每一行都写明**这一份会怎么样、为什么**。灰掉一行不给理由，看起来就像出了 bug——
 * 而这里最常见的两种「不导」（已经有了、别的账号）都是完全正常的结果。
 */
function renderPlan(plan, scan) {
  const box = document.createElement('div');

  const head = document.createElement('b');
  head.textContent = plan.count
    ? `准备导入 ${plan.count} 份档案，共 ${bytes(plan.bytes)}`
    : '没有需要导入的档案';
  box.append(head);

  if (scan.truncated) {
    const t = document.createElement('div');
    t.className = 'cap-sub warn-text';
    t.textContent = `只扫描了前 ${scan.scanned} 个文件夹就停下了 —— 选中的目录太大。`
      + '下面的清单可能不全，请改选更具体的文件夹再来一次。';
    box.append(t);
  }

  for (const item of plan.items) {
    const line = document.createElement('div');
    line.className = WILL_WRITE.has(item.action) ? 'cap-sub' : 'cap-sub muted';
    const id = item.meta.bundleId ? shortId(item.meta.bundleId) : '？';
    line.textContent = `${ACTION_LABEL[item.action]}　${id}　${item.meta.label}`
      + `${item.meta.bytes ? `　${bytes(item.meta.bytes)}` : ''}\n　　${item.detail}`;
    box.append(line);
  }

  // 链断了不拦着导，但要说出**缺的是哪一份**——用户多半还留着它，只是没选进来。
  for (const h of plan.holes) {
    const line = document.createElement('div');
    line.className = 'cap-sub warn-text';
    line.textContent = `${shortId(h.bundleId)} 接在 ${shortId(h.missing)} 后面，`
      + '而那一份不在这里也不在扩展里。这一份照样能导入，'
      + '只是「从今天连续回溯到更早」这句话暂时证明不了 —— 找到那一份再导一次就补上了。';
    box.append(line);
  }

  return box;
}

/** 确认框里那段话。**把不导的那些也列出来**，否则用户以为它们导进去了。 */
function confirmText(plan) {
  const lines = [`导入 ${plan.count} 份档案，共 ${bytes(plan.bytes)}？`, ''];
  for (const i of plan.items.filter((x) => WILL_WRITE.has(x.action))) {
    lines.push(`· ${ACTION_LABEL[i.action]} ${shortId(i.meta.bundleId)}（${bytes(i.meta.bytes)}）`);
  }
  const skipped = plan.items.filter((x) => !WILL_WRITE.has(x.action));
  if (skipped.length) {
    lines.push('', `以下 ${skipped.length} 份不会导入：`);
    for (const i of skipped) {
      lines.push(`· ${ACTION_LABEL[i.action]} ${i.meta.bundleId ? shortId(i.meta.bundleId) : i.meta.label}`);
    }
  }
  lines.push('', '导入只会新建文件，不会改动扩展里已有的任何档案。');
  return lines.join('\n');
}

/**
 * 空间够不够。
 *
 * 查不了就**不拦**——`preflightStorage` 返回 null 表示浏览器不肯说，而不是「不够」。
 * 拿「不知道」当「不够」，等于替用户取消了他要做的事。
 */
async function checkRoom(needBytes) {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  if (!est?.quota) return null;
  const available = Math.max(0, est.quota - (est.usage ?? 0));
  return available >= needBytes ? null
    : `可用空间大约只有 ${bytes(available)}，而这次要写入 ${bytes(needBytes)}。`
      + '先在这一页删掉一些已经导出过的档案，或者分批导入。';
}

/** 真的搬。逐份来：一份失败不该让其余的也不导。 */
async function runImport(plan, byLabel) {
  const worker = getImportWorker();
  /** @type {Array<{id: string, ok: boolean, note: string}>} */
  const done = [];
  const todo = plan.items.filter((i) => WILL_WRITE.has(i.action));

  for (const [n, item] of todo.entries()) {
    const id = item.meta.bundleId;
    const dir = bundleDirName(id);
    const dest = new WorkerFileStore({ worker, dir, readOnly: false });
    let fresh = false;

    try {
      // 认领只为了一件事：失败时能不能整份回滚。**不是写权限的开关**——那条规矩
      // 是「只能新建文件」，由 Worker 逐个文件执行。
      fresh = (await dest.claimForImport())?.fresh ?? false;

      const r = await importBundle({
        source: byLabel.get(item.meta.label),
        dest,
        resume: item.action === ACTIONS.RESUME,
        onProgress: (p) => {
          const pct = p.total ? Math.round((p.done / p.total) * 100) : 100;
          say('run', `（${n + 1}/${todo.length}）${shortId(id)}　`
            + `${p.phase === 'copy' ? '正在复制' : '正在校验'} ${p.file} ${pct}%`);
        },
      });

      if (r.problems.length) {
        // 校验没过 = 这一份不能当档案用。**回滚**，而不是留一份看起来正常的坏档案
        // 在列表里——那正是这个项目最不能出的错。只有从零建起来的目录才回滚得掉；
        // 续传失败时旧文件不属于这次导入，只能如实说。
        if (fresh) await WorkerFileStore.destroy(worker, dir).catch(() => {});
        done.push({
          id,
          ok: false,
          note: `${r.problems.length} 个文件没对上（${r.problems[0].reason}）。`
            + (fresh ? '已经写进去的部分已撤销。' : '扩展里原有的文件没有被动过。'),
        });
        continue;
      }

      done.push({
        id,
        ok: true,
        note: r.verified
          ? `${r.files.length} 个文件，${bytes(r.bytes + (r.skippedBytes ?? 0))}，摘要全部核对通过`
          : `${r.files.length} 个文件，${bytes(r.bytes + (r.skippedBytes ?? 0))}（没有 manifest，只核对了字节数）`,
      });
    } catch (e) {
      if (fresh) await WorkerFileStore.destroy(worker, dir).catch(() => {});
      done.push({ id, ok: false, note: e.message });
    }
  }
  return done;
}

/**
 * 逐份说清楚，别汇总成一句「成功」。
 *
 * **没导的那些也要留在屏幕上。** 第一版把结果整块换掉了清单，于是「这几份为什么
 * 没导」随着清单一起消失——用户看到的是「1 份档案已导入」，而他明明选了三份。
 * 那正是他此刻最想知道的事。
 */
function renderResult(done, plan) {
  const failed = done.filter((d) => !d.ok);
  const box = document.createElement('div');
  const b = document.createElement('b');
  b.textContent = failed.length
    ? `${done.length} 份中有 ${failed.length} 份没能导入`
    : `${done.length} 份档案已导入并校验通过`;
  box.append(b);
  for (const d of done) {
    const line = document.createElement('div');
    line.className = d.ok ? 'cap-sub' : 'cap-sub warn-text';
    line.textContent = `${shortId(d.id)}：${d.note}`;
    box.append(line);
  }

  const skipped = plan.items.filter((i) => !WILL_WRITE.has(i.action));
  if (skipped.length) {
    const head = document.createElement('div');
    head.className = 'cap-sub';
    head.textContent = `另外 ${skipped.length} 份没有导入：`;
    box.append(head);
    for (const i of skipped) {
      const line = document.createElement('div');
      line.className = 'cap-sub muted';
      const id = i.meta.bundleId ? shortId(i.meta.bundleId) : i.meta.label;
      line.textContent = `${ACTION_LABEL[i.action]}　${id}　${i.detail}`;
      box.append(line);
    }
  }
  say(failed.length ? 'err' : 'good', box);
}

export function initImport() {
  $('import').addEventListener('click', async () => {
    if (typeof window.showDirectoryPicker !== 'function') {
      say('err', '这个浏览器不支持选择文件夹（File System Access API）。请使用 Chrome 或 Edge。');
      return;
    }

    /** @type {FileSystemDirectoryHandle} */
    let root;
    try {
      // 只要读权限。导入不往用户的文件夹里写任何东西，也就不该要那个权限——
      // 权限提示上写着「查看和修改」还是「查看」，用户是看得见的。
      root = await window.showDirectoryPicker({ mode: 'read', id: 'doubak-export' });
    } catch {
      return; // 用户取消
    }

    say('idle', '正在查看这个文件夹里有什么…');
    let scan;
    try {
      scan = await scanForBundles(root);
    } catch (e) {
      say('err', `读不了这个文件夹：${e.message}`);
      return;
    }
    if (scan.found.length === 0) {
      say('err', `${root.name} 里（连同下面几层）没有找到档案。`
        + '导出时每份档案会放进一个 doubak-bundle-… 文件夹，选中它，或者选中它的上一级。');
      return;
    }

    // 逐个读元数据。**这一步不读段文件内容**，只看文件名与字节数，所以八份档案
    // 也就是几十毫秒。
    const byLabel = new Map(scan.found.map((f) => [f.label, f.source]));
    const candidates = [];
    for (const f of scan.found) candidates.push(await readBundleMeta(f.source, f.label));

    const activeBundleId = getLastStatus()?.runner?.bundleId
      ?? getLastStatus()?.checkpoint?.bundle_id ?? null;
    let plan = planImport({
      candidates, existing: await readExisting(), activeBundleId,
    });

    // 「别的账号」是**唯一一种用户可以推翻的拒绝**：他可能真的有两个豆瓣号。
    // 但要问一次，而且要说清代价——解析器会拒绝混了两个账号的目录。
    const others = plan.items.filter((i) => i.action === ACTIONS.OTHER_ACCOUNT);
    if (others.length) {
      $('import-result').replaceChildren(renderPlan(plan, scan));
      $('import-result').className = 'card warn';
      const ok = confirm(
        `有 ${others.length} 份档案属于另一个豆瓣账号。\n\n`
        + '默认不导入：两个账号的档案混在一起之后，解析器会拒绝整个目录，'
        + '而合过之后是拆不开的。\n\n如果这确实是你自己的另一个账号，可以照导。\n\n'
        + '导入它们吗？（点取消则只导入本账号的那些）',
      );
      if (ok) {
        plan = planImport({
          candidates, existing: await readExisting(), activeBundleId, allowOtherAccounts: true,
        });
      }
    }

    $('import-result').className = 'card idle';
    $('import-result').replaceChildren(renderPlan(plan, scan));

    if (plan.count === 0) return; // 清单已经说清楚为什么了，不必再弹一个框
    const tooBig = await checkRoom(plan.bytes);
    if (tooBig) {
      say('err', `空间不够：${tooBig}`);
      return;
    }
    if (!confirm(confirmText(plan))) {
      say('idle', '已取消，一个字节都没写。');
      return;
    }

    renderResult(await runImport(plan, byLabel), plan);

    // 存储变了：两处缓存都作废，然后把三处显示重画。
    invalidateStorageUsage();
    await loadStorage();
    await loadArchive();
    await refreshOpenTab();
  });
}

/** 见 storage.js 里同名函数的说明。 */
export function resetImport() {
  importWorker = null;
}
