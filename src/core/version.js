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
 * `ui/panel.js` 的「关于」早就是这么做的，注释也早就写着为什么。这个模块只是把那条
 * 规则挪到写档案的路径上——那才是它真正要紧的地方。
 *
 * @returns {string} 形如 `0.9.0`
 */
export function extensionVersion() {
  const v = globalThis.chrome?.runtime?.getManifest?.()?.version;
  if (!v) {
    throw new Error(
      '拿不到 manifest.json 里的版本号。不能凭空编一个写进档案——'
      + '档案里的 producer.version 是要用来追溯的。',
    );
  }
  return v;
}
