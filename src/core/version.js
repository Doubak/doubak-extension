/**
 * 扩展的版本号，**只有一个来源：`manifest.json`**。
 *
 * 这个数字不只是给人看的。它会被写进每份 bundle 的 `producer.version`，也会被写进
 * 每个段的 WARC `software:` 头——而 bundle 是不可逆的那一步的产物，写进去就是永久的。
 * 它存在的唯一目的是回答「这份档案是哪份代码抓的」，所以一个跟真实版本对不上的
 * 版本号比没有更糟：它看起来像证据，实际上是噪音。
 *
 * 这里曾经写死过 `'0.0.1'`（`crawl/runner.js` 与 `bundle/bundle-writer.js` 各一份），
 * 于是 manifest 涨到 0.9.0 之后，八份已经导出的档案仍然一律自称 0.0.1——已经发生过的
 * 那部分追不回来了。所以现在这里宁可抛错，也不编一个版本号出来。
 *
 * ## 为什么读文件，而不是 `chrome.runtime.getManifest()`
 *
 * 因为**这个函数是在 offscreen document 里被调用的**，而那里没有 `getManifest()`。
 *
 * 第一版就是 `chrome.runtime.getManifest().version`。在面板里试是好的（面板是普通
 * 扩展页面，扩展 API 全都有），装上之后一按「开始抓取」就抛「拿不到 manifest.json
 * 里的版本号」——因为真正写档案的那条路径跑在 offscreen 里，而 offscreen document
 * **只暴露 `chrome.runtime` 的消息 API**（Chrome 官方原话：“only the chrome.runtime
 * messaging APIs are exposed to the offscreen document”）。`getManifest` 不在其中。
 *
 * `offscreen.js` 开头那张「这里能用哪些 chrome API」的表早就写着这条规则，只是没有
 * 任何东西**执行**它——所以现在有了 `test/offscreen-contract.test.js`，它顺着
 * offscreen 的 import 图检查每个 `chrome.*` 调用点。
 *
 * 退回去读 `manifest.json` 这个文件本身，反而比问 chrome 更贴合「只有一个来源」：
 * 那就是同一个文件。而 `fetch` 一个扩展自己的资源在三个上下文里都成立，不需要任何
 * 扩展 API，也不需要 `web_accessible_resources`（那是给别的源用的）。
 *
 * @returns {Promise<string>} 形如 `0.9.0`
 */
export async function extensionVersion() {
  // getURL 在 offscreen 里是可用的（`offscreen.js` 那张表里已经实测标了 ✓，
  // 存档 Worker 就是这么起来的）。真没有的话，退到相对扩展根的绝对路径——
  // 三个上下文的 origin 都是 `chrome-extension://<id>`。
  const url = globalThis.chrome?.runtime?.getURL?.('manifest.json') ?? '/manifest.json';

  /** @type {unknown} */
  let manifest;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (e) {
    throw new Error(
      `读不到 manifest.json（${url}）：${e?.message ?? e}。`
      + '不能凭空编一个版本号写进档案——档案里的 producer.version 是要用来追溯的。',
    );
  }

  const v = /** @type {{version?: unknown}} */ (manifest)?.version;
  if (typeof v !== 'string' || !v) {
    throw new Error(
      '拿不到 manifest.json 里的版本号。不能凭空编一个写进档案——'
      + '档案里的 producer.version 是要用来追溯的。',
    );
  }
  return v;
}
