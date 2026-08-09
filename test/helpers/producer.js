/**
 * 测试里写档案用的 `producer`。
 *
 * 真实的版本号只有一个来源——`manifest.json`（见 `src/core/version.js`）——而 node:test
 * 里没有 `chrome`，读不到 manifest。所以测试必须自己传一个。
 *
 * 版本号刻意写成一眼假的 `0.0.0-test`：`BundleWriter` 以前默认成 `'0.0.1'`，一个看起来
 * 像真版本号的值，于是没人注意到它跟 manifest 早就对不上了。假值不会有这个问题。
 */
export const TEST_PRODUCER = { name: 'doubak-extension', version: '0.0.0-test' };

/** `CrawlRunner` 只要版本号，不要整个 producer。 */
export const TEST_PRODUCER_VERSION = TEST_PRODUCER.version;
