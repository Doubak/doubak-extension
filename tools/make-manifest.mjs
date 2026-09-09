/**
 * 从 `manifest.json` 推出 Firefox 那一份。
 *
 * ## 为什么是「推」，不是「各写一份」
 *
 * 两份手写的 manifest 一定会漂，而**漂的方向是固定的**：Chrome 那份加了个新权限、
 * 新资源，Firefox 那份忘了跟。症状是装得上、某个功能悄悄不工作——这个仓库为
 * 「同一条规则在两个地方各写一遍」付过好几次学费（sync-vendor、删掉再重标、
 * buildMarkdown 少了私密过滤）。
 *
 * 所以只有**一份手写的**（`manifest.json`，Chrome 的，也是开发时直接载入仓库用的
 * 那份），Firefox 那份由这里算出来。`manifest.firefox.json` 提交进仓库是为了能
 * 在 git 上看见差异，而 `test/manifest-firefox.test.js` 钉住它必须等于这个变换的
 * 结果——**手改它会红**。
 *
 * ## 三处差异，每一处都有理由
 *
 * | 键 | 为什么 |
 * |---|---|
 * | `background` | Firefox **没有** `background.service_worker`（BCD: firefox = NO）。它的 MV3 后台是事件**页**，用 `scripts` + `type: "module"`（后者要 112+） |
 * | `permissions` | 去掉 `offscreen`：Firefox 没有这个 API，而事件页本来就能直接起专用 Worker（实测，见 docs/firefox.md） |
 * | `browser_specific_settings.gecko` | AMO 要 id；`strict_min_version` 见下 |
 *
 * ## 版本下限 140，而决定它的不是我们用的 API
 *
 * 我们真正用到的东西下限都很低：OPFS 111、`background.type` 112、DNR 那四项 113。
 * 把线抬到 140 的是两条**别的**：
 *
 * - `data_collection_permissions` 要 **140**，而 `web-ext lint` 说它「对所有新的
 *   Firefox 扩展都是必需的」。这个扩展的答案恰好是 `{"required": ["none"]}`——
 *   凭据与数据一个字节都不离开设备，而 Firefox 现在正好有一个正式字段能声明它。
 * - `runtime.getContexts` 要 **127**（`src/ui/notify.js` 在用），被 140 顺带覆盖。
 *
 * 用法：`node tools/make-manifest.mjs`（写文件）或 `--check`（只核对，CI 用）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Firefox 那份的落点。**不要手改它**，改 `manifest.json` 然后重跑这个脚本。 */
export const FIREFOX_MANIFEST = 'manifest.firefox.json';

/** 事件页的入口。与 Chrome 的 service worker 是同一个文件。 */
export const FIREFOX_BACKGROUND = { scripts: ['src/background.js'], type: 'module' };

/**
 * 开发用的 id。**它不是也不该像一个真的 AMO id。**
 *
 * 与 `manifest.firefox.json` 里提交的那一份一致，测试钉住——哪天有人把真 id
 * 提交进仓库，那条会红。真 id 不进版本库：上传时从环境变量给。
 */
export const DEV_GECKO_ID = 'doubak-dev@localhost';

/**
 * AMO 上的扩展 id。**默认没有，而且不许在这里编一个。**
 *
 * 这个扩展在 AMO 上已经有 id 了（归档主人持有）。而 id 一旦写错，后果不是报错：
 * **AMO 会把它当成一个新的扩展**，于是现有那条上架记录、评价与用户全都不在这一份上，
 * 而已经装了的人也收不到更新。这是那种「看起来成功了」的失败。
 *
 * 一度想「不知道就不写」，但 **MV3 下 Firefox 要求必须有 id**（`web-ext lint` 直接
 * 报 `ADDON_ID_REQUIRED` 错误，量过）。所以退而求其次：默认写一个**一眼就不是
 * AMO id** 的开发用值，而真正上传时必须显式给。
 *
 * `doubak-dev@localhost` 这个值是刻意挑的——它不像一个真的扩展 id，误传上去会很
 * 显眼，而不是安安静静地建出一条新的上架记录。`tools/package.mjs --firefox` 带着
 * 这个值时**拒绝出包**，除非显式 `--dev`。
 */
export const GECKO_ID = process.env.DOUBAK_GECKO_ID || DEV_GECKO_ID;

/**
 * AMO 那边留的联系邮箱：`admin@doubak.com`。
 *
 * manifest 里**没有**放它的地方——它填在 AMO 的提交表单里，记在这儿只是免得下次去翻。
 */
export const AMO_CONTACT = 'admin@doubak.com';

/** 见文件开头：决定它的是 data_collection_permissions（140），不是我们用的 API。 */
export const STRICT_MIN_VERSION = '140.0';

/**
 * Chrome 的 manifest → Firefox 的 manifest。**纯函数**，测试直接调它。
 *
 * @param {object} chrome
 * @returns {object}
 */
export function toFirefox(chrome) {
  const m = structuredClone(chrome);
  m.background = { ...FIREFOX_BACKGROUND };
  m.permissions = (chrome.permissions ?? []).filter((p) => p !== 'offscreen');
  m.browser_specific_settings = {
    gecko: {
      // 见 `GECKO_ID`：不知道就不写，绝不编一个。
      ...(GECKO_ID ? { id: GECKO_ID } : {}),
      strict_min_version: STRICT_MIN_VERSION,
      // 这个扩展什么都不收集——凭据与数据一个字节都不离开设备。这不是一句宣传语，
      // 它是整个项目的判据（「服务器关掉也必须能产出完整档案」），而 Firefox 现在
      // 有一个正式字段可以把它声明出来。
      data_collection_permissions: { required: ['none'] },
    },
  };
  return m;
}

/**
 * 仓库里那两份文件此刻的样子。
 *
 * **只有当这个文件是被直接跑起来时才动手。** 第一版是顶层就写文件，于是
 * `test/manifest-firefox.test.js` 一 import 它就把 `manifest.firefox.json`
 * 重新生成了一遍——**那条「Chrome 加了个权限、Firefox 没跟上」的测试因此永远绿**，
 * 它在检查之前先把被检查的东西修好了。突变验出来的。
 *
 * 这就是这个仓库记过的那类「一个不可能失败的检查」，只是这次的成因是副作用。
 */
function run() {
  const chromeManifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf-8'));
  const want = `${JSON.stringify(toFirefox(chromeManifest), null, 2)}\n`;

  if (process.argv.includes('--check')) {
    let have = '';
    try { have = readFileSync(join(ROOT, FIREFOX_MANIFEST), 'utf-8'); } catch { /* 下面报 */ }
    if (have !== want) {
      console.error(
        `${FIREFOX_MANIFEST} 与 manifest.json 对不上。`
        + '跑 `node tools/make-manifest.mjs` 重新生成——不要手改那个文件。',
      );
      process.exit(1);
    }
    console.log(`${FIREFOX_MANIFEST} 是最新的`);
  } else {
    writeFileSync(join(ROOT, FIREFOX_MANIFEST), want, 'utf-8');
    console.log(`写好了 ${FIREFOX_MANIFEST}（背景=事件页，去掉 offscreen 权限，最低 Firefox ${STRICT_MIN_VERSION}）`);
  }
}

// 被 import 时什么都不做——见 `run()` 上面那段。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
