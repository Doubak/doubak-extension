/**
 * 导出：把档案从 OPFS 拷到用户自己选的文件夹。
 *
 * **续传不需要进度文件**——目标目录本身就是进度。理由见 bundle/exporter.js。
 */

import { exportBundle, subdirectorySink } from '../../bundle/exporter.js';
import { WorkerFileStore } from '../../storage/worker-file-store.js';
import { bundleDirName } from '../../core/ids.js';
import {
  $, send, bytes, table, countAlreadyExported, getOpfsWorker, noteExported,
} from './shared.js';
import { refreshOpenTab } from './overview.js';
import { reader, currentBundleId } from './archive.js';

/**
 * 导出整条链：每份档案各占一个子目录。
 *
 * ## 为什么必须分子目录
 *
 * 每份档案都有 `manifest.json` 与 `README.txt`。平铺到同一个目录里，后一份会
 * 覆盖前一份——这不是理论问题：真实使用中用户的下载目录里就只剩了最后一次导出的
 * manifest，早先几份的全被盖掉了，以至于事后想核对哪份档案接在哪份后面都做不到。
 *
 * 目录名与 OPFS 里一致（`doubak-bundle-<id>`），搬回来时不用改名。
 *
 * ## 为什么值得单独一个按钮
 *
 * 增量之后，**一份档案不再是一份完整的备份**——它只含新增的部分。要把「我的豆瓣」
 * 整个搬走，需要的是整条链。让用户自己一份份导，早晚会漏掉一份，而漏掉哪一份是
 * 事后看不出来的。
 */

/** 整条链导出的结果：逐份说清楚，别汇总成一句「成功」。 */
function renderChainExportResult(el, done) {
  const failed = done.filter((d) => d.error || d.result?.problems.length);
  el.className = `card tone-${failed.length ? 'error' : 'ok'}`;
  el.replaceChildren();

  const b = document.createElement('b');
  b.textContent = failed.length
    ? `${done.length} 份中有 ${failed.length} 份没能干净导出`
    : `${done.length} 份档案已全部导出并校验通过`;
  el.append(b);

  const total = done.reduce((n, d) => n + (d.result?.bytes ?? 0), 0);
  el.append(document.createTextNode(`共 ${bytes(total)}，每份各占一个子目录。`));

  for (const d of done) {
    const line = document.createElement('div');
    line.className = 'cap-sub';
    line.textContent = d.error
      ? `${d.bundleId}：失败 —— ${d.error}`
      : `${d.bundleId}：${bytes(d.result.bytes)}`
        + (d.result.problems.length ? `，${d.result.problems.length} 处校验不通过` : '，校验通过');
    el.append(line);
  }
}


/** @param {object} r */
function showExportResult(r, folder) {
  const el = $('export-result');
  el.replaceChildren();
  const b = document.createElement('b');

  if (r.problems.length) {
    el.className = 'card tone-error';
    b.textContent = `导出有问题：${r.problems.length} 个文件没对上`;
    el.append(b, document.createTextNode(
      r.problems.map((p) => `${p.name}（${p.reason}）`).join('；')
      + '。这一份不能当作备份使用——原档案仍在扩展内，请另选位置重新导出。',
    ));
    return;
  }

  el.className = 'card tone-ok';
  // **报的是目的地现在一共有多少**，不是这一趟搬了多少。续导时后者可能是 0，
  // 而「已导出并校验：4 个文件，0 B」会让人以为什么都没发生。
  const totalBytes = r.bytes + (r.skippedBytes ?? 0);
  const resumed = r.skipped
    ? `其中 ${r.skipped} 个是上次已经导好的，本次补了 ${bytes(r.bytes)}。`
    : '';

  if (r.verified) {
    // 只有这一句能说「已校验」：回读了目的地、逐个对上了 manifest 里的摘要。
    b.textContent = `已导出并校验：${r.files.length} 个文件，${bytes(totalBytes)}`;
    el.append(b, document.createTextNode(
      `已写入子文件夹 ${folder}/。${resumed}每个文件都从该文件夹重新读取并核对过，`
      + '字节数与 manifest 中声明的 SHA-256 全部一致。此时可以安全地删除扩展内的那一份。',
    ));
  } else {
    // 只验了字节数就别说「已校验」——那正是这个项目一直在躲的假安心。
    b.textContent = `已导出：${r.files.length} 个文件，${bytes(totalBytes)}（仅核对了字节数）`;
    el.append(b, document.createTextNode(
      `已写入子文件夹 ${folder}/。${resumed}本次抓取尚未收尾，没有 manifest，`
      + '因此只核对了每个文件的字节数，没有摘要可比对。抓取完成后重新导出一次才能做完整校验。',
    ));
  }

  // **在这儿指一下路。** 导完之后「接下来干什么」是必然会冒出来的问题，而在此之前
  // 面板里唯一提到下游的地方是帮助页那张仓库链接表——那是一排代码仓库，不是一句
  // 「你可以这么做」。用户走到这一步，手上有一个文件夹和一个疑问。
  //
  // 只放一句话加一个跳转，不在这里铺开步骤：这一页已经很满了（导入、导出、校验、
  // 删除、用量、捕获检查器…），而那些内容属于帮助页。
  const next = document.createElement('p');
  next.className = 'small muted';
  next.append(document.createTextNode('档案已经在你手里了。想把它解析成结构化数据、'
    + '再生成一个可搜索的存档站点，见帮助页的'));
  const a = document.createElement('a');
  a.href = '#';
  a.textContent = '「导出之后：把档案变成能读的东西」';
  a.addEventListener('click', (e) => {
    e.preventDefault();
    // **点一下帮助那个按钮，而不是自己复制一遍切换逻辑。** 那段逻辑还负责
    // `renderAbout()` 之类的按需加载；另写一份迟早会与它分叉，而分叉的样子是
    // 「从这儿跳过去的帮助页，和自己点过去的不一样」。
    $('tabs').querySelector('button[data-tab="help"]')?.click();
    $('downstream')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  next.append(a, document.createTextNode('。这两步都在你自己的机器上跑，同样不联网。'));
  el.append(next);
}

/** 绑事件。**由 panel.js 显式调用**，不靠 import 的副作用——那种绑定顺序看不出来。 */
export function initExport() {
  $('export-chain').addEventListener('click', async () => {
    const el = $('export-result');
    if (!currentBundleId) return;

    if (typeof window.showDirectoryPicker !== 'function') {
      el.className = 'card tone-error';
      el.textContent = '这个浏览器不支持选择文件夹（File System Access API）。请使用 Chrome 或 Edge。';
      return;
    }

    const r = await send({ type: 'chain', bundleId: currentBundleId });
    const chain = r?.ok ? (r.chain?.bundles ?? []) : [];
    if (chain.length === 0) {
      el.className = 'card tone-error';
      el.textContent = '读不出这条链。';
      return;
    }

    /** @type {FileSystemDirectoryHandle} */
    let parent;
    try {
      parent = await window.showDirectoryPicker({ mode: 'readwrite', id: 'doubak-export' });
    } catch {
      return; // 用户取消
    }

    const ids = chain.map((b) => b.bundleId);
    if (!confirm(
      `将导出 ${ids.length} 份档案（整条链）：\n\n${ids.join('\n')}\n\n`
      + '每份各占一个子目录 doubak-bundle-<编号>。已存在的同名文件会被覆盖。',
    )) return;

    /** @type {Array<{bundleId: string, result: object | null, error: string | null}>} */
    const done = [];
    for (const [i, id] of ids.entries()) {
      const store = new WorkerFileStore({ worker: getOpfsWorker(), dir: bundleDirName(id) });
      try {
        const sink = await subdirectorySink(parent, bundleDirName(id));
        const res = await exportBundle({
          store, sink, overwrite: true,
          onProgress: (p) => {
            el.className = 'card tone-busy';
            const pct = p.total ? Math.round((p.done / p.total) * 100) : 100;
            el.textContent =
              `（${i + 1}/${ids.length}）${id}　`
              + `${p.phase === 'copy' ? '正在复制' : '正在校验'} ${p.file} ${pct}%`;
          },
        });
        done.push({ bundleId: id, result: res, error: null });
        // 只在**校验通过**时记「已导出」——没验过就说导出了，等于给一个我们没资格
        // 给的保证（删除确认框会据此决定说得多重）。
        if (res.problems.length === 0) await noteExported(id);
      } catch (e) {
        // **一份失败不中断其余的。** 用户要的是尽可能多地搬走，而不是在第三份上
        // 停下、前两份还留在原地不知道成没成。
        done.push({ bundleId: id, result: null, error: e.message });
      }
    }

    renderChainExportResult(el, done);
    // `noteExported` 已经失效过缓存了，这里只要重画。
    await refreshOpenTab();
  });

  $('export').addEventListener('click', async () => {
    const el = $('export-result');
    const bundleId = currentBundleId;
    if (!bundleId) return;

    if (typeof window.showDirectoryPicker !== 'function') {
      el.className = 'card tone-error';
      el.textContent = '这个浏览器不支持选择文件夹（File System Access API）。请用 Chrome 或 Edge。';
      return;
    }

    /** @type {FileSystemDirectoryHandle} */
    let dir;
    try {
      dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'doubak-export' });
    } catch {
      return; // 用户取消了，什么都不用说
    }

    const store = new WorkerFileStore({ worker: getOpfsWorker(), dir: bundleDirName(bundleId) });

    // **也建一个子目录**，与「导出整条链」一致。
    //
    // 平铺的话，每次导出的 `manifest.json` 与 `README.txt` 都会覆盖上一次的——
    // 用户往同一个下载目录里导过几份之后，只剩最后一次那一份的 manifest，早先的
    // 全没了，而档案编号只在文件名里、manifest 里的编号已经对不上号。
    //
    // 顺带解决一个噪音：目的地非空检查原来对着**整个下载目录**做，于是几乎每次
    // 都要弹一次「已经有 N 个文件，确认覆盖吗」——而那时并没有任何东西真的会被
    // 覆盖。现在检查的是这一份自己的子目录，弹出来就意味着**真的**要覆盖同一份
    // 档案的上一次导出。
    const folder = bundleDirName(bundleId);
    const sink = await subdirectorySink(dir, folder);
    const run = (opts) => exportBundle({
      store, sink, ...opts,
      onProgress: (p) => {
        el.className = 'card tone-busy';
        const pct = p.total ? Math.round((p.done / p.total) * 100) : 100;
        // 这里的百分比是**字节数**，不是「抓了多少」——分母是本地文件的真实
        // 大小，可信；豆瓣的计数不可信，两者不是一回事。
        el.textContent =
          `${p.phase === 'copy' ? '正在复制' : '正在校验'} ${p.file}` +
          `（${p.fileIndex + 1}/${p.files}）${pct}%`;
      },
    });

    try {
      let r;
      try {
        r = await run({});
      } catch (e) {
        if (e.code !== 'destination_not_empty') throw e;

        // 走到这里说明 `${folder}/` 里已经有东西。因为目的地是**这份档案自己的
        // 子目录**，所以那几乎一定是它上一次（可能被打断的）导出。
        //
        // 不再只问「要不要覆盖」——先去看清楚已经导好了几个，然后把**将要发生
        // 什么**原原本本说出来。「已经有 12 个文件，覆盖吗」和「12 个已经导好、
        // 还差 8 个，续导只补这 8 个」是完全不同的两句话，而后者才是实情。
        el.className = 'card tone-busy';
        el.textContent = '正在检查上次导到哪儿了…';
        const done = await countAlreadyExported({ store, sink });

        const msg = done.ok === 0
          ? `文件夹 ${folder} 里有 ${done.total} 个文件，但没有一个能对上这份档案。\n\n`
            + '继续会覆盖同名文件，且没有回收站。确定吗？'
          : `上次导出到一半：${done.ok} 个文件已经完整（${bytes(done.okBytes)}），还差 ${done.missing} 个。\n\n`
            + '继续只会补齐缺的那些，已经完整的不动。确定吗？';
        if (!confirm(msg)) {
          el.className = 'card tone-idle';
          el.textContent = '已取消，什么都没写。';
          return;
        }
        // 续导隐含覆盖：校验不通过的照样重写。
        r = await run({ resume: true });
      }
      showExportResult(r, folder);
      // 记一笔「导出过了」。派生状态，丢了不影响档案本身——只影响删除确认框说得多重。
      // 只在**校验通过**时记：没验过就说「已导出」，等于给了一个我们没资格给的保证。
      if (r.problems.length === 0) {
        // **导完这一份要让界面跟上。** 原来这里只记了一笔就完了，于是那行
        // 「⚠ 其中 N 份没有导出记录，浏览器里这一份可能是唯一的副本」还停在原处
        // ——用户刚把它导出去，界面却仍然说它可能是唯一的副本。整条链的导出一直
        // 是刷新的，单份的没刷，两条路走了不同的做法。
        await noteExported(bundleId);
        await refreshOpenTab();
      }
    } catch (e) {
      el.className = 'card tone-error';
      el.textContent = `导出失败：${e.message}`;
    }
  });

  $('verify').addEventListener('click', async () => {
    if (!reader) return;
    const el = $('verify-result');
    el.className = 'card tone-idle';
    el.textContent = '正在逐条取出并解压…';

    try {
      const v = await reader.verify();
      if (v.problems.length === 0) {
        el.className = 'card tone-ok';
        el.replaceChildren();
        const b = document.createElement('b');
        b.textContent = `${v.checked} 条全部读得通`;
        el.append(b, document.createTextNode(
          '索引里的每一条都能按偏移量从段文件里取出来并解压。这份档案是自洽的。',
        ));
      } else {
        el.className = 'card tone-error';
        el.textContent =
          `${v.problems.length} / ${v.checked} 条读不出来：` +
          v.problems.slice(0, 5).map((p) => `${p.captureId}（${p.error}）`).join('；');
      }
    } catch (e) {
      el.className = 'card tone-error';
      el.textContent = `验证失败：${e.message}`;
    }
  });
}
