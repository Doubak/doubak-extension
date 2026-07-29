# doubak-extension
豆备 (Doubak) 的浏览器插件，整个项目的所有功能都可以在这个插件里找到入口。

它在**你自己的浏览器、用你自己的 IP 和节奏**抓取豆瓣，把页面原样存成标准 WARC 档案。登录凭据和会话 cookie 不离开你的设备。验收标准是：**把服务器关掉，插件依然能产出一份完整可用的本地档案。**

> 开发中，尚不可用。

## 文档

- **[DESIGN.md](DESIGN.md)** —— 功能规划、抓取边界模型、三份实测附录
- **[docs/toolchain.md](docs/toolchain.md)** —— 工具链选型与理由
- **[docs/ui.md](docs/ui.md)** —— 界面设计：说什么话、怎么显示进度才不撒谎
- 档案格式定义在另一个仓库：[`doubak-data-specs`](https://github.com/Doubak/doubak-data-specs)

## 开发

零依赖、零构建步骤。仓库里的源码就是浏览器里跑的东西。

```sh
npm test          # 跑测试（用 Node 内置的测试运行器，不需要 npm install）
```

需要 Node ≥ 20。

### 装载到浏览器

Chrome / Edge：`chrome://extensions` → 打开开发者模式 → 加载已解压的扩展程序 → 选本仓库根目录。

### 浏览器自检

有些东西 Node 里测不到：OPFS、持久化存储许可、配额。装载扩展后打开

```
chrome-extension://<扩展ID>/selftest/index.html
```

点「开始自检」，它会在真实浏览器里跑 FileStore 契约（与 Node 里跑在内存实现上的是同一组断言）、
完整的 bundle 写入、崩溃恢复，并报告持久化存储许可与配额。

### 界面

点工具栏图标是 popup（状态、开始/暂停），里面的「完整面板」按钮会开一个标签页：
概览、覆盖率对账、**档案预览**（顺着索引把记录从段文件里取出来解压）、日志。

## 现状

| 模块 | 状态 |
|---|---|
| 脚手架、工具链 | ✅ |
| 基础类型（标识符 / 时间 / url_key / 摘要 / WARC） | ✅ |
| bundle 写入器（段轮转 / index / manifest） | ✅ 产出已通过规范校验器 |
| 崩溃恢复 | ✅ 真实 OPFS 上验证过 |
| OPFS 存储后端 | ✅ 与内存实现共用一份契约测试 |
| 会话守卫、分类器、路线注册表、frontier | ✅ |
| 抓取引擎（取页、节奏、超时、重试分流） | ✅ |
| 抓取主循环（frontier→取页→判定→写档案） | ✅ |
| 生命周期自恢复（心跳、崩溃哨兵） | ✅ |
| 持久化（IndexedDB）与后台接线 | ⬜ 未开始 |
| 编排（开始/分批/恢复/收尾） | ✅ |
| 最小 popup（U1） | ✅ |
| 完整面板：概览 / 覆盖率 / 档案预览 / 日志 | ✅ |
| bundle 读取器与「验一验」 | ✅ |
| 存储页、导出（File System Access） | ⬜ 未开始 |

测试：`npm test`（零安装即可跑）。装了可选开发依赖后会额外用
webrecorder 的 warcio 独立验证 WARC 输出；同级目录有 `doubak-data-specs`
时会额外跑跨仓库一致性检查。
