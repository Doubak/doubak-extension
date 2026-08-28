/**
 * 完整面板（docs/ui.md 的 U2/U4/U5）。
 *
 * **这是唯一的界面。** 曾经还有一个 popup 负责「瞄一眼」，但它一失焦就关，
 * 恰好与「盯着一个跑几小时的任务」相反，日志、覆盖率、档案预览也一个都放不下。
 * 拆掉了——点工具栏图标直接开这一页（docs/ui.md §1.1）。
 *
 * ## 三条约束
 *
 * **① 只读状态、只发命令。** 抓取状态全在 service worker 那边，这里每次都
 * 重新读，绝不自己改。
 *
 * **② 进度不用百分比。** 豆瓣的计数不可信，拿它当分母会给出一个看起来特别
 * 可信的假数字。有时间边界的路线显示「已回溯到某日」。
 *
 * **③ 预览只读档案，不建缓存。** 档案本身就是真相；再存一份派生状态就会有
 * 两个可能不一致的来源。
 *
 * ## 这一页由哪些模块拼起来
 *
 * 一个文件 3034 行的时候，「改导出会不会碰到抓取状态」这种问题只能靠通读回答。
 * 现在一个标签页一个模块，依赖是单向的：
 *
 *     shared ← archive ← coverage ← overview ← { export, storage, log, debug, debug-toggle } ← import
 *
 * 「导出」页（`formats.js`）只 import `shared`，与 `archive` 平级——它读的是整个
 * 档案库，不依赖「当前选中哪一份」。
 *
 * `shared.js` 谁也不 import；`archive.js` 只 import 它。**这条方向一破，拆分就白做**
 * ——那时它只是摊成十个文件的 panel.js。`test/ui-modules.test.js` 守着这条，也守着
 * 「用到的名字必须真的 import 进来」：那类错只在浏览器里炸，`node --check` 看不出来。
 *
 * ## 事件绑定由这里显式调用，不靠 import 的副作用
 *
 * 副作用绑定的先后顺序藏在 import 顺序里，既看不出来也不好改。下面每一行都写着
 * 它在做什么，顺序与拆分之前逐条对应。
 */

import { $, resetShared } from './panel/shared.js';
import { renderAbout } from './panel/help.js';
import { refresh, resetOverview } from './panel/overview.js';
import { loadArchive, resetArchive, initCapturesToggle } from './panel/archive.js';
import { loadCoverage } from './panel/coverage.js';
import { loadLog, initLog, resetLog } from './panel/log.js';
import { loadDebug, resetDebug } from './panel/debug.js';
import { loadStorage, initStorage, resetStorage } from './panel/storage.js';
import { initExport } from './panel/export.js';
import { initFormats, resetFormats } from './panel/formats.js';
import { initImport, resetImport } from './panel/import.js';
import { initDebugToggle } from './panel/debug-toggle.js';

// ── 标签页切换 ───────────────────────────────────────────────

$('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  for (const b of $('tabs').querySelectorAll('button')) {
    const on = b === btn;
    b.setAttribute('aria-selected', String(on));
    $(`tab-${b.dataset.tab}`).hidden = !on;
  }
  // 档案页现在也管整批（占用、导入、清空）。**存储不再是一个标签页**：它列的
  // 是同一批档案，只换了几列，而两份清单意味着两处要各自记得失效，用户还要在两页
  // 之间对「刚才看的是哪一份」。
  if (btn.dataset.tab === 'archive') { loadArchive(); loadStorage(); }
  if (btn.dataset.tab === 'debug') loadDebug();
  // 覆盖率原来**没有自己的加载**——它只是 `openBundle()` 的副作用，所以第一次直接点
  // 进来是空白的（要先去过档案页才有东西）。空白看起来像「正在加载」，而它其实什么
  // 都不会发生。
  if (btn.dataset.tab === 'coverage') loadCoverage();
  if (btn.dataset.tab === 'log') loadLog();
  // 帮助页是静态的，只有「关于」那一块要填（版本号从 manifest 读）。
  if (btn.dataset.tab === 'help') renderAbout();
});

// ── 启动 ────────────────────────────────────────────────────

// 各页的视图状态清回「刚打开面板」的样子。**拆分之前这是隐式的**——整个面板就是
// 一个模块，模块被加载 = 面板被打开。拆开之后这个等号不再成立，所以写出来。
// **底座先清。** 它也有模块级状态（共用的 OPFS Worker、目录扫描缓存），而各页的
// reset 清不到那里 —— 漏掉它的后果是第二次打开面板拿到上一次那个 Worker。
resetShared();
resetOverview();
resetArchive();
resetLog();
resetDebug();
resetStorage();
resetImport();
resetFormats();

initExport();
initFormats();
initImport();
initStorage();
initCapturesToggle();
initLog();
initDebugToggle();

// 概览是唯一**会自己动**的一页：每两秒重读一次状态。
// 页面藏起来时不读——面板经常一开就是几小时，没必要在后台空转。
refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, 2000);
