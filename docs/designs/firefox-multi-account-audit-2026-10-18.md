# Firefox 多账号与扩展导入导出核对（2026-10-18）

环境：Linux、Firefox 155.0.1、Node 24.18.0。所有改动在 extension 的 main；
样本与 sample 网站未改写。测试浏览器使用 web-ext 创建的独立临时配置，不使用日常浏览器会话。

## 发现与修复

| 问题 | 修复与回归证据 |
|---|---|
| Firefox 包删掉 `host-offscreen.js`，但共享入口已改为静态导入它，后台无法启动 | 两个包均保留此无加载副作用的模块；仅 Chrome 调用其 API。检查所有打包 JS 的相对模块依赖都在包内，并实际安装 Firefox 构建验证后台 `status` 响应 |
| 多账号库选 B 后删除 B，剩下 A 时派生导出会退回 A | 单账号也记录所选 UID；所选账号消失时拒绝导出并要求重新选择 |
| 扫描/选择目录期间重复点击可启动多个派生导出；期间切账号可能改变目标 | 第一次异步等待前锁定任务与 UID；完成、取消、出错都释放 |
| 整链导出等待后台答复时切档案，ZIP 名可能变成另一份的编号 | 点击时固定 bundle ID，用于取链和命名 |
| 档案页与派生页，或两个面板，同时打包会清理彼此的中转目录 | 同面板互斥与跨面板 Web Locks；抢占失败明确报错，不能进入清理步骤。取消、完成、初始化失败释放锁 |
| Firefox 整链 ZIP 未回读，却在标题和每份结果中说“校验通过” | 按实际能力区分已校验、仅核对字节数、ZIP 未回读校验 |
| 整链 ZIP 在写中央目录、交给下载之前已记“导出过” | ZIP 收尾/交付成功之后才写记录；失败不能降低删除提醒 |

单账号输出保持 `doubak-canonical/`、`doubak-neodb/`、`doubak-markdown/` 及同名 ZIP；
多账号库导出追加所选 UID。内部文件名不变。

## Firefox 实测

使用两份已有增量样本：

- 第三方：`20261017T031336Z-5f9326`（UID `154611037`）。
- 本人：`20261017T031652Z-7961d3`（UID `82160871`）。

测试以正式打包脚本的产物为基础，仅在临时副本加入驱动页、启动入口和 localhost
回传权限；运行时代码不替换。文件选择的输入由真实 `File` 对象及其相对路径提供，
未自动操作系统原生文件夹选择窗口。

1. `FileList → scanFileList → planImport → importBundle →` 实际 OPFS Worker：
   一次识别两个账号，两份均摘要校验通过。
2. 导出 UI 多账号未选择时禁用按钮；逐个选择账号后，分别完成 Canonical、NeoDB、
   Markdown 导出，六份 ZIP 均由 Firefox 实际下载。
3. 用独立 ZIP 读取器核对 CRC、目录和内容。Canonical 中所有带账号归属的记录均属于
   所选 UID；subjects 是无账号字段的公共作品记录，未误当成账号记录校验。
4. 两份 Markdown 的 `site-profile.json` 与本地头像路径分别指向对应 UID，均为 160×160 JPEG。
5. 原始档案导出 ZIP，经系统 `unzip` 解开后逐个文件与源样本逐字节一致；重新导入另一组
   OPFS 测试目录，摘要再次通过。浏览器实际下载文件与打包完成时的文件逐字节一致。
6. 模拟扫描结果只有一个账号，实际 UI 输出 `doubak-canonical.zip`，没有 UID 后缀。
7. 使用真实 IndexedDB、OPFS Worker 和 CrawlRunner，网络响应注入固定页面：
   热恢复与重建 runner 的冷恢复均拒绝 A→B 登录切换，索引字节保持不变；切回 A 可恢复，
   最终 manifest 保留 A 的身份。

这是增量样本的兼容性验证，未加入其全部祖先；解析数量不代表完整账号内容数量。
本轮没有使用真实 Cookie 在线抓取，也没有模拟浏览器进程在写入中的强制崩溃。

实测产物：`/tmp/doubak-firefox-results/`（`report.json`、`artifact-checks.json`、六份派生
ZIP、单账号 ZIP、原始档案 ZIP、实际下载及系统解压结果）。

## 自动化与边界

- Node 全量测试：2,134 项，2,133 通过、0 失败、1 项既有环境跳过（Node 24.18 的
  DecompressionStream 尚未拒绝尾随输入）。新增交互回归覆盖：打包依赖、账号消失、重复点击、FileList 混合导入、
  保留既有档案、ZIP 互斥/释放、收尾失败不登记、切换档案时保持原下载名、结果文案。
- 冷/热恢复、公开目标与操作者隔离继续由 `multi-account-resume.test.js`、
  `public-crawl.test.js` 等既有测试覆盖；未改抓取核心。
- `web-ext lint`：0 errors、3 warnings。两条是保留的 Chrome 宿主模块中的 offscreen API，
  Firefox 不会调用；另一条是 Android 最低版本提示。不能为消除静态警告而删掉静态依赖。
- Firefox 140 最低版本与 Android 未在本轮实测；Android 仍不宣称支持在线抓取。
- ZIP 交给下载不等于下载完成或回读校验；请在下载完成后再发起下一份导出。
  现有中转清理仍发生在下一次导出开始，本轮互斥保护覆盖正在打包的任务，不检测下载完成。
