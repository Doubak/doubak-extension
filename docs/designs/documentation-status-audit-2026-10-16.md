# 文档与产品说明核对（2026-10-16）

本次以当前 main 的实际实现为准，核对 extension 中英文 README、Help、官网首页、使用指南与隐私页，
以及 specs / parser / site-generator / export-adapters / import-adapters README。
历史开发日志与设计中的实测数字保留其日期语境，不把旧实验数据全部替换成新数字。
本记录只说明上述文档审查范围，不宣称全部历史文档或完整公开账号设计均已实现。

## 修正结果

| 主题 | 当前证据与文案调整 |
| --- | --- |
| 目标与操作者 | `target-account.js`、`runner.js`：本人 / 登录代抓 / 匿名公开；官网不再说仅支持本人的数据 |
| 多账号界面 | `panel.html` 及 coverage / archive / formats 模块：按 UID 筛选与单账号派生导出；Help 补操作路径 |
| 恢复与增量 | `runner.js`、`loop.js`、`overview.js`：原目标 / 操作者约束、基准缺失会全量；不能保证每次仅抓新增或所有停止原因都可直接继续 |
| 失败记录 | capture 是追加历史；成功重试不删除旧错误，重解析不改原 verdict；分页失败不可按现状收尾，非分页按既有策略处理 |
| 浏览器 | runtime 的 host-page / host-offscreen、ZIP 输出与 Firefox manifest：英文 README 移除 Chromium-only，说明专用 Firefox 包及 ZIP 导出 |
| 扩展导出 | `pipeline/targets.js`：导出 Markdown + 本地图，由 CLI 站点生成器构建 HTML；英文 README 不再把扩展输出直接叫作已构建 HTML |
| 站名与广播标题 | `pages.js`、parser 的 broadcast 提取器：昵称站名及 topic 独立标题已实现，补 Help 与官网 |
| 资源跳过 | `loop.js`：现有附图 / 封面复用成功 URL；删除「所有图片 URL 永远不变」的普遍性保证，并更新原先强制该错误措辞的 Help 测试 |
| 发布 | generator `bin/deploy.js`：构建并写入目录、`--dry-run` 输出清单，Git 提交 / 推送另行执行；不承诺自动全文隐私审查或完全清除第三方片段 |
| 原始内容 | parser 归属过滤不等于 WARC 匿名化；官网 / 隐私页改为以所选目标账号为边界，不把周边社交内容说成完全不会出现在 HTML |
| 实测覆盖 | 本人新 bundle 与第三方公开 bundle 均已有离线链路核对；官网 / Help 不再说只验证一个账号，仍注明页面类型覆盖有限 |
| 使用指南 | 说明公开目标输入与单账号导出；删除「扩展卸载不影响内部档案」的错误保证，区分磁盘已导出文件和浏览器内部副本 |
| 隐私页操作 | 删除扩展数据的入口是「档案」，不再指向旧「存储」标签 |
| 原生导入 | extension README 移除「拦截跨账号归档」：允许混合账号分组导入，重复 / 冲突 / 残缺校验仍有效 |
| CLI 边界 | parser 默认拒绝混合账号，仍有历史 `--ignore-warnings`；尚无统一 `--account`，不能与扩展单账号选择混为一谈 |
| 头像 | 仅交付[专项设计](account-avatar-and-site-branding.md)；README / 官网 / Help 都标待实现，未新增 schema、运行时代码或下载请求 |

## 头像设计的规范结论

Bundle 的 `intent` 是开放词表，计划新增 `asset.image.account_avatar` 可以沿用现有格式；
不是每增加一条图片路线都要修改 manifest 或升级 bundle 版本。
Canonical 则计划新增带来源与修订的 `profile.ndjson`，需要 schema、验证器与摄取文档联动。
实际实现前当前仍是八类记录，消费者不能提前被文档要求读取一个不存在的第九文件。

设计明确处理目标与导航头像隔离、同 URL 换图、默认头像与未知缺失、冷 / 热恢复、
头像资源失败与分页连续性分离、跨账号 / 跨观测资源匹配、离线派生图标及旧档案降级。
原公开账号设计 §7.1.6 的无来源扁平示例由专项设计替代；其他尚未交付的条款继续以
[实现覆盖矩阵](public-and-third-party-account-archive-review.md)为准。

## 验证与限制

- Help 相关既有回归：`node --test test/ui.test.js test/ui-formats-tab.test.js`，181 通过、0 失败。
- 官网 `python3 tools/check-links.py .`：协议、canonical 与发布版本一致性检查通过。
- Chromium 本地预览官网、使用指南、隐私页、Help，390 / 1280 px：无横向溢出、无缺图、无失效页内锚点。
  官网与 Help 截图已目视检查。Help 以静态 HTML 展示，JS 运行时身份栏由既有 UI 测试覆盖；
  此次未执行浏览器内真实抓取。
- 新设计与修改过的 Markdown 本地链接检查、各仓库 `git diff --check`。
- 本轮没有修改 / 重建 `doubak-site-generator-sample`，也没有修改用户原始 bundle。
- 样本验证沿用本轮之前的记录：第三方样本见 `public-viewer-context-audit.md`；
  本人新 bundle `20261015T222343Z-e4e7da` 为 51 条正常捕获、20 条广播，
  与八份祖先合并得到 3,447 条广播、无解析告警。这是离线核对，不扩展为所有页面类型都通过。

发布说明应区分仓库 main 与商店安装包：本次只是 main 的文档 / Help 校准，
没有提升扩展版本、上传商店或发布新的扩展包。
