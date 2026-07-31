/**
 * 存储用量的汇总与「能不能删」的判断。
 *
 * 设计：DESIGN.md F-08d、F-08g
 *
 * ## 为什么单独一个纯函数模块
 *
 * 删档案是**不可逆**的，而且删掉的东西没有回收站——OPFS 里那份可能是用户唯一的
 * 副本。所以「哪些能删、删之前该说什么」这套判断必须能在 Node 里完整测到，
 * 不能混在只能靠肉眼看的界面代码里。
 *
 * ## 三条规则
 *
 * **① 正在抓的那份绝不许删。** 删了它，写入器下一次 append 就会往一个不存在的
 * 目录里写，而抓取正跑在几小时的中途。
 *
 * **② 没导出过的要显眼地标出来。** OPFS 里的档案不属于用户（卸载扩展、清站点
 * 数据都会抹掉它），所以「没导出」等于「这是唯一的副本」。
 *
 * **③ 不知道就说不知道。** 导出记录是我们自己记的，只在这台浏览器里。换过机器、
 * 清过数据、或者用别的方式导出过，我们都看不见。这种情况必须说「不确定」，
 * 而不是显示成「未导出」——后者是在替用户下一个我们没资格下的判断。
 */

/** 导出记录在 KV 里的键前缀。派生状态，丢了不影响档案本身。 */
export const EXPORTED_KEY_PREFIX = 'doubak.exported.';

/** @param {string} bundleId */
export function exportedKey(bundleId) {
  return `${EXPORTED_KEY_PREFIX}${bundleId}`;
}

/**
 * @typedef {object} BundleUsage
 * @property {string} bundleId
 * @property {string} dir
 * @property {number} bytes        目录里所有文件之和
 * @property {number} files
 * @property {boolean} hasManifest 收尾了才有
 * @property {boolean} active      正在抓的就是这一份
 * @property {string | null} exportedAt
 * @property {'exported' | 'not_exported' | 'unknown'} exportState
 * @property {boolean} deletable
 * @property {string | null} blockedReason  不能删的原因，给人看
 */

/**
 * 把一组目录清单汇总成界面要显示的东西。
 *
 * @param {object} opts
 * @param {Array<{bundleId: string, dir: string, files: Array<{name: string, bytes: number}>}>} opts.dirs
 * @param {string | null} [opts.activeBundleId]  正在抓的那份
 * @param {Record<string, string>} [opts.exportedAt]  bundleId → ISO 时间
 * @param {boolean} [opts.exportRecordsUsable]  导出记录这套机制在这台机器上可不可信
 * @returns {BundleUsage[]}
 */
export function summarizeBundles({
  dirs,
  activeBundleId = null,
  exportedAt = {},
  exportRecordsUsable = true,
}) {
  return dirs
    .map((d) => {
      const bytes = d.files.reduce((n, f) => n + (f.bytes ?? 0), 0);
      const active = d.bundleId === activeBundleId;
      const at = exportedAt[d.bundleId] ?? null;

      /** @type {'exported' | 'not_exported' | 'unknown'} */
      let exportState;
      if (at) exportState = 'exported';
      else if (!exportRecordsUsable) exportState = 'unknown';
      else exportState = 'not_exported';

      return {
        bundleId: d.bundleId,
        dir: d.dir,
        bytes,
        files: d.files.length,
        hasManifest: d.files.some((f) => f.name === 'manifest.json'),
        active,
        exportedAt: at,
        exportState,
        deletable: !active,
        // 说清楚为什么不能删，而不是只把按钮灰掉——灰掉的按钮看起来像 bug。
        // **不能只说「先暂停」**：暂停之后它依旧删不掉——档案还在写、指针还指着
        // 它。真正能放开它的是「中止」（收尾成 aborted 并放开指针）或者跑到结束。
        blockedReason: active
          ? '这份正在抓。要删的话先在概览页「中止这次抓取」（已抓到的都会留下），或者等它跑完'
          : null,
      };
    })
    // 新的在前。bundle_id 以时间戳打头，所以倒序即最新在前。
    .sort((a, b) => (a.bundleId < b.bundleId ? 1 : -1));
}

/**
 * 删除前的最后一道判断。
 *
 * 刻意与界面分开：界面上那个确认对话框是给人看的，这个是给代码守的。**两者都要
 * 有**——用户可能点得很快，而消息也可能是从别处发来的。
 *
 * @param {BundleUsage[]} usage
 * @param {string} bundleId
 * @returns {{ok: true, target: BundleUsage} | {ok: false, error: string}}
 */
export function checkDeletable(usage, bundleId) {
  const target = usage.find((u) => u.bundleId === bundleId);
  if (!target) return { ok: false, error: `没有这份档案：${bundleId}` };
  if (!target.deletable) return { ok: false, error: target.blockedReason ?? '这份档案现在不能删' };
  return { ok: true, target };
}

/** @param {BundleUsage[]} usage */
export function totalBytes(usage) {
  return usage.reduce((n, u) => n + u.bytes, 0);
}

/**
 * 有没有「唯一副本」要被删掉。
 *
 * 用来决定确认对话框说得多重。`unknown` 也算——不确定的时候要按最坏情况警告，
 * 而不是按最好情况放行。
 *
 * @param {BundleUsage[]} usage
 */
export function hasUnexported(usage) {
  return usage.some((u) => u.exportState !== 'exported');
}
