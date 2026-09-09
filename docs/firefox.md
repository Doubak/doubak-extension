# Firefox 支持：第 0 步的实测

跟踪 issue：[`Doubak/doubak-extension#11`](https://github.com/Doubak/doubak-extension/issues/11)。

这一页记的是**量出来的东西**，不是计划。计划在别处；这里每一行都有一个明确的是/否，
以及它是怎么得到的。凡是没量过的，写「没量过」，不写「应该可以」。

测量环境：Firefox **155.0.1**（`/usr/bin/firefox`，headless），`npx web-ext run` 临时载入，
一个只有探针的后台事件页（`background.scripts`）。对照组是 Chrome 152 上的自检页。

## 结论先写：#11 上那句判断，指的是错的那一半

> 「Firefox 系的浏览器数据存储的接口不太一样，导致没有办法很容易的移植过去」

**档案存储那一侧一行都不用改**——OPFS 连同 `createSyncAccessHandle()` 在从后台事件页
起的专用 Worker 里完全可用，共享的 FileStore 契约 20 条全过。真正没有的是
**File System Access**（`showDirectoryPicker`），也就是**把字节交到用户磁盘上**那一步。

**Firefox 能抓、能存，交不出一个文件夹。**

## 量到的（2026-09-09）

| # | 问题 | 结果 |
|---|---|---|
| 1 | 后台事件页有 DOM 吗 | ✅ `document` / `window` / `Worker` 都在。`chrome.offscreen` 不存在（预期），`runtime.getContexts` 有（155 ≥ 127） |
| 2 | 事件页起的专用 Worker 里 `createSyncAccessHandle()` 能用吗 | ✅ **能**，写入→读回逐字节相符 |
| 3 | 共享的 FileStore 契约在 Gecko 的 OPFS 上过不过 | ✅ **20/20**，与 Node 跑 `MemoryFileStore`、Chrome 跑 `OpfsFileStore` 的是同一组断言 |
| 4 | Referer 那条 DNR 会话规则装得上吗 | ✅ 装上了，而且是**从浏览器读回来确认的**（`getSessionRules()` 里有 id 1），不是「没报错」 |
| 5 | 桌面版 UA 那条规则呢 | ✅ 行为正确：**什么都不做**（「桌面浏览器，不需要改」）——桌面 Firefox 本来就拿得到桌面版 |
| 6 | `alarms` 的最小周期 | ✅ `periodInMinutes: 0.5` **原样收下并读回 0.5**，没有被夹到 1 分钟。`HEARTBEAT_PERIOD_MINUTES` 不用改 |
| 7 | `extensionVersion()`（`fetch('manifest.json')`）在事件页里 | ✅ 读到 `1.3.6` |
| 8 | `chrome.*` 到底返不返回 promise | ✅ **`browser.*` 与 `chrome.*` 都返回 thenable**（见下，这条改掉了原计划） |
| 9 | 吞吐 | 64 MB / 2224 ms ≈ **28.8 MB/s**，Chrome 152 上同一段代码是 43.2 MB/s。约三分之二，不是障碍 |

### 第 8 条把计划里的第 1 步取消了

原计划有一整步「把 70 处 `chrome.*` 收敛到一个 `browser ?? chrome` 的适配层」，理由是
**「Firefox 的 `chrome.*` 是回调式的，而我们全程 `await`，`await` 一个返回 undefined 的
回调式函数会立刻拿到 undefined」**。

**在 Firefox 155 上量下来，这个前提是假的**：`chrome.alarms.getAll()` 返回的就是一个
thenable。所以那一步**不做**——70 处机械改动，理由却站不住。

留一句限定：这是在 **155** 上量的，而我们打算把 `strict_min_version` 定在 140（见下），
中间那些版本没量过。真出问题时症状会很响（规则没装上、闹钟没建上），到那时再说，
不预先为一个没观察到的问题改 70 个地方。

## `web-ext lint`：0 错误，3 警告，每一条都对得上已知的工作

把 `strict_min_version` 从 113 提到 **140** 之后，10 条警告降到 3 条：

| 警告 | 说明 |
|---|---|
| `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` | 安卓要 142 才有 `data_collection_permissions`。我们不做安卓，这一条留到提交 AMO 时按「要不要投放安卓」决定 |
| `UNSUPPORTED_API` × 2（`src/offscreen/host.js:31,34`） | `offscreen.createDocument` / `offscreen.Reason`。宿主接缝做完、Firefox 那个包不再带这个文件之后自然消失 |

### 版本下限是 140，而决定它的不是我们用的 API

我们真正用到的东西下限都很低：OPFS 111、`background.type` 112、DNR 那四项 113。
把线抬到 140 的是**两条别的**：

- `browser_specific_settings.gecko.data_collection_permissions` 要 **140**。而
  `web-ext lint` 说它「对所有新的 Firefox 扩展都是必需的」——这个扩展的答案恰好是
  **`{"required": ["none"]}`**：凭据与数据一个字节都不离开设备，Firefox 现在正好有一个
  正式字段可以声明它。
- `runtime.getContexts` 要 **127**（`src/ui/notify.js` 在用），被 140 顺带覆盖了。

## 已经做完的

- **抓取宿主的接缝**（`src/runtime/host.js`）。按能力挑：`offscreen.createDocument`
  有就走 offscreen document，没有就直接在后台事件页里跑。在真 Firefox 上验过整条缝，
  `status` 那一条把 `CrawlRunner` 整个构造在了事件页里——整条抓取链真的在那边跑起来了。
- **两份 manifest，一个来源**（`tools/make-manifest.mjs`）。`manifest.firefox.json`
  是算出来的，手改会红。`node tools/package.mjs --firefox` 出 Firefox 那个包。
- **`web-ext lint`：0 错误、1 警告**（从 10 → 3 → 1）。剩下那条是
  `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`——我们不投放安卓，提交 AMO 时
  按「要不要投放」处理，不是缺陷。
- 打好的 Firefox 包（去掉了 `host-offscreen.js` 与 `offscreen.html`）在 Firefox 里
  载入并跑通了整条缝——**验的是发出去的那份，不是仓库**。

## 还没量的

- **后台事件页能不能扛住几小时的抓取。** 这是最贵的一个，探针答不了，要真跑一次
  ——而且需要一个**登录着豆瓣**的 Firefox 配置，所以它得由档案主人来跑：
  `node tools/package.mjs --firefox` 出包，`about:debugging` 里「临时载入附加组件」
  选包里的 `manifest.json`，然后从调试页的「最近 7 天的广播」开始。
  答「否」的话，退路是把抓取放进面板标签页（标签页开着就活着，而整套架构本来就是
  每页写检查点、可恢复的）。
- `getFile()` 拿到的 `File` 交给 `URL.createObjectURL()` 会不会把整个文件读进内存
  （真实段有 159 MB）。这决定导出的 zip 能不能流式产出。
- 140 ~ 154 之间 `chrome.*` 的 promise 行为（见第 8 条）。

## 怎么复现

探针不在仓库里（它要一条 `http://127.0.0.1:8731/*` 的临时权限来回报结果，不该进
manifest）。做法：把仓库拷进一个构建目录，`manifest.json` 换成 Firefox 形状
（`background.scripts` + 去掉 `offscreen` 权限 + `browser_specific_settings.gecko`），
后台脚本换成探针，`npx web-ext run --arg=--headless`，探针把 JSON POST 回一个本地端口。
