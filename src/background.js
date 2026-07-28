/**
 * MV3 service worker 入口。
 *
 * 目前只是个占位：真正的抓取编排要等 frontier 与抓取引擎落地。
 * 现阶段的开发重心是 bundle 写入器（src/bundle/），它可以完全在 Node 里测，
 * 不需要装载扩展。
 */

// TODO(debug): 开发期日志，发布前删掉整块
const DEBUG = true;

/** @param {...unknown} args */
export function debugLog(...args) {
  if (DEBUG) console.log('[doubak]', ...args);
}

debugLog('service worker 已启动', new Date().toISOString());

// service worker 被杀掉后重新拉起时也会走到这里；一切状态都必须从
// IndexedDB / OPFS 恢复，内存里不留唯一副本（见 DESIGN.md F-10b）。
