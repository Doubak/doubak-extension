# 权限拒绝修复的回归核对（2026-11-11）

关联 [issue #34](https://github.com/Doubak/doubak-extension/issues/34)。
基于报告人的脱敏影评响应，核对 `b9a61e7` 的行为修复及本次恢复边界修正。

## 本次补测发现并修复

- 权限恢复后，成功响应已经提交，但 checkpoint 尚未更新就崩溃：原实现不重抓成功页，
  却仍保留旧的 `access_denied` 缺口。现在仅以同路线、同 URL 的最新成功响应消除该缺口，
  原始失败捕获仍保留。新增测试在修复前失败、修复后通过。
- denied 响应已提交，但旧 checkpoint 仍记 pending、尝试次数 0：恢复时保留失败且至少
  记 1 次尝试，避免显示“抓不下来，但尝试过 0 次”。

## 行为覆盖

`test/permission-denied.test.js` 共 22 项，覆盖：

- 本人／公开视角的 HTTP 200 和 403 权限页；正文引用、脚本与注释防误报。
- 真实抓取链路中的普通 403、429、418、风控域与验证码仍停机、降速；不继续其他影评，
  也不能通过“带缺口收尾”绕过风控。
- 权限页显示操作者切换时仍停止整场任务；有序分页不能跳过失败页。
- 普通冷恢复、捕获提交后但 checkpoint 前崩溃、条目尚未进入旧 checkpoint 的情况。
- 旧版 blocked 断点继续一次后按新规则判断；原始旧捕获不改写。
- 显式重试及重试排队后的冷恢复；成功后的崩溃恢复消除旧缺口。
- 真实 writer 产出的 bundle 导出再导入逐文件字节相同；denied 正文不会被内容解析器
  读取，正常影评确实产出记录，网站和 NeoDB 输出与不含该错误页的基线一致。

解析器 `test/denied.test.js` 另外验证 bundle/1.4 的历史正文与 bundle/1.5 的 denied
混合输入：两种输入顺序都保留原记录与修订，不清空正文、不产生删除。

## 验证结果

- 完整扩展套件：2280 项，2279 通过，0 失败，1 项既有 Node 24.18.0 的
  `DecompressionStream` 行为差异跳过；没有为本修复新增跳过。
- LCOV 对比修复前 `9608048`：`src/` 中可测改动行 **69/69**；
  `isReviewPermissionDenied` 分支 **16/16**。这是本修复的覆盖率，不是整个项目 100%。
- 解析器 denied／未来格式／原始回复快照兼容检查：7 项通过。
- 导入适配器完整套件：56 项通过；规范 conformance 使用 JSON Schema 层检查。
- 在独立临时副本中分别移除成功后的缺口修复、关闭 denied 的崩溃恢复，两次突变均被
  对应测试捕获；未修改工作目录中的生产代码来运行突变。

完整覆盖率复现命令（Node 24；可选 schema 检查需要 Python 的 jsonschema / referencing）：

```sh
node --test --test-concurrency=2 --experimental-test-coverage \
  --test-coverage-exclude='test/**' \
  --test-reporter=lcov --test-reporter-destination=/tmp/doubak-regression.lcov \
  --test-reporter=spec --test-reporter-destination=/tmp/doubak-regression.log \
  'test/**/*.test.js'
```

本轮为自动化与离线验证，不代替发布前的 Chrome / Firefox 实机检查。
新读者继续接受旧档案；旧校验器仍会拒绝新增的 denied 取值，不能宣称旧工具完全支持
bundle/1.5。已发布的 v1.6.0 不含此行为修复。
