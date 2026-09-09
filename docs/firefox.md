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
- **导出的 zip：写出端做完了。** `ZipWriter`（上游 `doubak-export-adapters/src/zip.js`，
  流式、大成员走「存储 + 数据描述符」）与 `src/bundle/zip-sink.js`。判据是一条不变量，
  有测试钉住：**同一份档案，写进目录与写进 zip，解开之后逐个文件字节相同**。
  解压一律用系统 `unzip`，不用我们自己的读回器。
- **导入时认得出没解压的 zip**，扩展与命令行两处都说得出下一步。

## 还没量的

- **后台事件页能不能扛住几小时的抓取。** 这是最贵的一个，探针答不了，要真跑一次
  ——而且需要一个**登录着豆瓣**的 Firefox 配置，所以它得由档案主人来跑：
  `node tools/package.mjs --firefox` 出包，`about:debugging` 里「临时载入附加组件」
  选包里的 `manifest.json`，然后从调试页的「最近 7 天的广播」开始。
  答「否」的话，退路是把抓取放进面板标签页（标签页开着就活着，而整套架构本来就是
  每页写检查点、可恢复的）。
- 140 ~ 154 之间 `chrome.*` 的 promise 行为（见第 8 条）。

## zip 写好之后怎么交出去：量过了，走 OPFS

两条候选——直接攒成 `Blob` 再 `createObjectURL`，还是先流式写进 OPFS 再 `getFile()`。
造 240 MB 假数据，**两条路跑在同一个 Firefox 实例里**，外面按 0.2 秒采 RSS：

| 阶段 | RSS |
|---|---|
| 攒 Blob 之前 | 1568 MB |
| 攒完 240 MB 的 Blob | 1798 MB（**+230 MB**） |
| 松手、等一会儿 | 1666 MB |
| 流式写 240 MB 进 OPFS 并交出 `File` | 1708 MB（**+40 MB**） |

**Blob 把整份都拿在内存里（+230 MB ≈ 全部），OPFS 那条只多了约 40 MB。** 差不多六倍，
而且 Blob 那一份**不能靠 GC 省掉**：下载要用的 object URL 必须一直活着，它引用的
blob 就一直在。619 MB 的真实档案照这个比例就是把整份塞进内存——正是这个项目从第一天
起写着不许做的事。

所以**先写进 OPFS 再交出去**。这偏离了「导出直接写进用户选的文件夹，绝不在 OPFS 里
中转」那条规矩，而那条规矩的理由是 `createWritable()` 的原子替换——**Firefox 上没有它**，
所以偏离是有理由的，代价是导出期间需要约 2 倍空闲空间，要写进界面。

第一次量是分两次跑的，两次的空闲基线差了 300 MB——**比要量的信号还大**。那种数字
不能拿来做决定，所以重做成同一个实例里的一次运行。记在这儿，免得下次又那么量。

## AMO 的两件事

- **扩展 id：`doubak@doubak.com`，定下来了，永远不能再改。** 查过 AMO 的公开接口，
  没有已上架的 Doubak（搜索 46 条无一是它，按 slug 直查全 404），所以这是一次自由的
  选择——而且是**唯一一次**：这个字符串就是 AMO 眼里「这是同一个扩展」的全部依据，
  换掉它不会报错，AMO 会另建一条上架记录，现有评价与用户都不在新的那一份上。

  「像邮箱」只是格式（校验器认的两个模式：花括号 UUID，或
  `^[a-zA-Z0-9-._]*@[a-zA-Z0-9-._]+$`；实测 `doubak.com` 这种没有 `@` 的直接判错）。
  **没有任何东西会往这儿发信。**

  选它而不选那个真信箱，判据是两者**寿命不一样**：id 永远不能改、且进每一份装机包的
  manifest（世界可读）；信箱随时能换、只在 AMO 表单里。把真地址写进 id，等于给每一份
  分发出去的包附上一个可抓的地址，而 id 从来不用来联系任何人——**别让一个字符串同时
  当标识符和信箱**。

- **联系邮箱：`admin@doubak.com`**。manifest 里没有放它的地方，填在 AMO 的提交表单里。

## 界面那一侧接上了（2026-09-09）

三个写入点（整条链、单份档案、导出页的派生产物）原来各自写着「没有
`showDirectoryPicker` 就报错，请用 Chrome 或 Edge」——**一句正确的拒绝，指向一条
修不好的路**：档案就在这个浏览器里。与 #12 是同一个形状。

现在只在 `src/ui/panel/destination.js` 里判一次，两种目的地一个契约
（`sinkFor` / `writerFor` / `finish` / `abort`）：

| | Chrome / Edge | Firefox |
|---|---|---|
| 目的地 | 用户选的文件夹 | 一个 zip，先流式写进 OPFS 再 `<a download>` |
| 单份档案 | `doubak-bundle-<编号>/` | `doubak-archive-<编号>.zip` → 解开是同名文件夹 |
| 整条链 | 每份一个子目录 | `doubak-archive-<编号>-整条链.zip` → 解开每份一个子目录 |
| 派生产物 | `doubak-neodb/` 等 | `doubak-neodb.zip` → 解开是同名文件夹 |
| 能不能校验 | ✅ 回读目的地，逐个对摘要 | ❌ **写出去就读不回来** |
| 能不能续导 | ✅ 目标目录就是进度 | ❌ 中断了要整个重来 |

后两行是真的退化，所以**结果卡片有第三支话术**，不复用「尚未收尾所以只核对了
字节数」——那句话的原因是「没有 manifest」，说错原因会把人送去修一个不存在的问题。

两条代价都写在**按下去之前**：确认框里说「会打包成一个 zip」「需要大约两倍空闲
空间」，导出页按钮上方也有一段。

### 中转文件在下一次导出开始时才删

`<a download>` 点下去之后，没有任何事件告诉我们浏览器读完了没有。此时删掉 OPFS
里那份，下载会**静默截断**。所以清理挪到下一次导出的开头，代价照说：上一次的中转
文件会一直占着空间，直到下一次导出。仅剩的窗口是「上一份还在下载时又点了一次导出」。

### 量到的（Firefox 155，真机，**跑的是打好的那个包**）

| 问题 | 结果 |
|---|---|
| OPFS 的 `createWritable()` 在窗口里能用吗 | ✅ 能，64 MB 分 64 块写用 **278 ms**（≈230 MB/s） |
| `getFile()` → `createObjectURL` | ✅ 拿到 `File`，`href` 确实是 `blob:` |
| `removeEntry(..., {recursive:true})` | ✅ |
| `canPickDirectory()` | ✅ `false`，走 zip 那条 |
| 整条路：导一份档案 → `finish()` → 点下载 | ✅ 3 个文件、0 problems、`verified: false`、说明是「目的地读不回来，无法校验」 |
| 真的点了 `<a download>` 吗 | ✅ 文件名 `doubak-archive-<编号>.zip` |
| 第二次导出的**开头**清掉上一份了吗 | ✅ |

产出的那个 zip 传回 Node，用**系统的 `unzip`** 验（判据不能是我们自己的读回器）：

```
unzip -t                    No errors detected
解开之后                     doubak-bundle-<编号>/{data-000001.warc.gz,index.ndjson,manifest.json} + 先看这个.txt
段文件                       200000 字节，与写进去的逐字节相同
权限                        -rw-r--r--
中文名                       先看这个.txt（没乱码）
```

### 顺手量出来的两个 zip 缺陷（都在上游 `doubak-export-adapters`）

写这一步的端到端测试时（解开 zip 与目录导出逐字节比对）发现的，**两个都会影响
Chrome 那条路已经在用的 NeoDB 导出包**：

1. **中央目录的「version made by」高字节是 0（MS-DOS/FAT）**，于是 Debian 的
   Info-ZIP `unzip 6.00`（Debian / Ubuntu 上 `unzip` 的默认实现）把中文文件名当
   CP437 转一遍：`怎么导入.md` → 乱码。**通用标志位第 11 位已经写着 UTF-8，它不看。**
   只改这一个字节就好了。
2. 改成 Unix 主机之后，**外部属性的高 16 位成了权限位**，而原来写的是 0
   ——解出来的文件是 `----------`，读不了。写 `0o100644`。

第二个尤其值得记：`unzip -t`、`unzip -p`、`unzip -l` **三条判据一条都接不住它**，
因为前两个不落盘、第三个只读中央目录。要真的解到磁盘上再打开一次才看得见。

### 导入也接上了（同一天）

Firefox 上「导入档案…」走 `<input type="file" webkitdirectory multiple>`：每个
`File` 带 `webkitRelativePath`，**整棵树一次拿全，连走都不用走**。读取仍然是
`file.slice(...)`，内存是平的（真实档案单个段文件到 256 MiB）。

**判据只有一份**：哪个目录算一份档案、往下找几层、认出没解压的 zip、那句「先解压」
——全在 `importer.js` 里，两条路共用。分家的症状是最难查的那种：同一个文件夹，
一个浏览器导入 3 份、另一个导入 2 份，**两边都不报错**。所以测试不是各测各的，
而是同一份语料喂给两条路逐项对结论（`test/importer.test.js` 的
「走目录与整棵树：两条路的结论必须一样」）。

那组测试的第一版**一条都不可能失败**：File 列表是在 `scanForBundles` 走目录的过程中
顺手攒出来的，而它走到一半就会停（认出档案不再往下、超深度不再往下），于是那些
文件根本不会进列表。突变验出来：把「找到就不往下」和深度上限整条删掉，全绿。
改成两边各自从语料生成之后，两条突变各红一条。**判据不能来自被测的那条路。**

### 已知的代价：超过 4 GB 要等写完才报错

`ZipWriter.finish()` 才知道总偏移量，所以 4 GB 的上限是在写完之后才拦的（拦是对的
——悄悄写出一个坏 zip 最糟）。真实档案 619 MB，离得还远，先记在这儿。

## 怎么复现

探针不在仓库里（它要一条 `http://127.0.0.1:8731/*` 的临时权限来回报结果，不该进
manifest）。做法：把仓库拷进一个构建目录，`manifest.json` 换成 Firefox 形状
（`background.scripts` + 去掉 `offscreen` 权限 + `browser_specific_settings.gecko`），
后台脚本换成探针，`npx web-ext run --arg=--headless`，探针把 JSON POST 回一个本地端口。
