# 账号头像：实现与兼容性核对

核对日期：2026-10-17。范围为各仓库 main；未提升扩展版本或上传商店安装包。
依据：[头像设计](account-avatar-and-site-branding.md)。

## 设计覆盖

| 设计范围 | 实现与证据 | 结论 |
| --- | --- | --- |
| §2.1 目标归属 | parser `extract-profile.js` 只取主页身份块，交叉核对 UID；排除导航、签名、脚本及访客；本人、A 登录代抓 B、匿名抓 B 的真实抓取编排测试 | 已实现 |
| §2.2 资源路线 | `asset.account_avatar` / `asset.image.account_avatar` / `assets-*`，直接父主页 capture；跳过目录、封面不禁用头像；匿名凭据、no-store、禁止 ck 与重定向 | 已实现 |
| §2.2 更新与恢复 | 每个新 bundle 重新派生；内部去重键包含父 capture；冷热恢复不重复已成功资源；断点落后时从已归档主页补队列，不重抓主页 | 已实现，有网络重试、challenge 暂停、失败后重载及显式重试测试 |
| §2.3 失败隔离 | 404、无效图片记独立非分页缺口，保留失败响应；成功重试清掉缺口；不撤销其他分页路线水位线 | 已实现，沿用既有非分页收尾策略 |
| §3 规范 | canonical/1.3 第九文件 `profile.ndjson`；schema、UID 等式、摘要键集、示例、conformance、CI；bundle 仍为 1.4，intent 开放扩展 | 已实现；旧八文件验证通过 |
| §4 解析合并 | parser/0.16.0；同 URL 保留新 observation，未知缺失用 omitted_fields，明确默认头像用 null；跨时区按时间先后、同时间按 capture ID 排序 | 已实现，正反输入顺序测试一致 |
| §4 资源选择 | 共享 `avatar.js` 匹配 UID、bundle、主页、父 capture、URL、route / intent / surface / verdict；核对 payload SHA-256；新资源缺失时不跨父回退 | 已实现，缺资源、错误归属、损坏字节与同 URL 换字节测试 |
| §5 通用导出 | 内容地址原图和 `site-profile.json`；CLI / OPFS 各读 WARC，纯逻辑逐字节 vendor；对同一合成 bundle 比较 canonical、全部 Markdown、原图与 sidecar | 已实现，跨宿主测试纳入 extension CI |
| §5 Hugo | 离线 PNG favicon 32、touch 180、页眉 96（显示 40）；透明补边、不放大小图、GIF 首帧；旧输入及坏图保留文字站名 | 已实现，锁定 Hugo 实际构建及独立 PNG 像素断言；CI 必须安装已校验的 Hugo |
| §5 路径与可访问性 | Chromium 检查根目录、子路径、file URL 的首页和深层页；40px / alt 空串、单 h1、本地资源；390px 明色和 1280px 暗色预览 | 已验证，六组页面无资源失败、外部请求或横向溢出 |
| §6 下游与文档 | export-adapters 读取可选 profile，profile-only 不制造评分；Help、README、官网及公开账号设计的状态链接同步 | 已实现；第三方导入器同步既有账号异常页判定 |

## 两项实现约定

- 浏览器 manual 重定向不暴露 Location，而 follow 无法逐跳拦截。因此头像使用
  `redirect: error`，拒绝所有跳转。其他抓取路线仍沿用已有跳转策略。
- 两个导出宿主共享摘要、MIME、容器与尺寸检查（5 MiB、每边 4096、16M 像素），
  完整像素解码统一在 Hugo 进行。`site-profile.json` 的 `status: ok` 只表示字节检查通过；
  Markdown-only 主题仍需解码。Hugo 解码失败会警告并省略头像 / 图标标签。
  此划分避免引入 npm 图像库或依赖浏览器专属解码器；不是宣称文件头检查等于完整解码。

Hugo 对调色板 PNG 保留原色表，透明补边需显式使用透明背景的 PNG process；
像素测试覆盖了该回归。派生文件保留 Hugo 的变换摘要，避免增量构建复用旧转换结果。
有头像时隐藏默认绿色装饰标记，页眉只显示一个头像与文字站名。

## 本地验证

- specs：bundle conformance（含 jsonschema）、profile schema / CLI 兼容测试、昵称测试、
  校验器输出回归和 schema 自检通过。新合成头像 bundle 通过 bundle 与九类 canonical 验证。
- parser：profile / conformance / 相册 / 小组专项通过；完整测试 319 项，318 通过、0 失败，
  1 项因本机缺少指定的历史大档案而跳过。
- extension：完整测试 2,120 项，2,119 通过、0 失败、1 项因 Node 24.18 尚未实现多余 gzip 输入拒绝而跳过；头像专项含实际 WARC
  写入、离线读取及跨宿主字节比对，全部通过。
- generator：完整测试 279 项通过，含实际 Hugo；头像导出释放段缓存的损坏回归通过。
- export-adapters：228 项通过；import-adapters：55 项通过。
- 官网 `tools/check-links.py` 通过；生成器 front matter 冒烟与 vendor 新鲜度一并核对。

在 `/tmp/doubak-avatar-audit/` 重解析并构建用户现有样本，没有覆盖源档案或 sample 网站：

| 样本 | 逐字节验证 | 解析与构建 |
| --- | --- | --- |
| 本人 `20261015T222343Z-e4e7da` | 51 条捕获、2 段，全部匹配 | 155 标记、20 广播、1 profile；九类 schema 与 Hugo 通过 |
| 公开账号 `20261014T205507Z-a18169` | 565 条捕获、2 段，全部匹配 | 448 标记、461 广播、1 profile；九类 schema 与 Hugo 通过 |

这两份旧 bundle 都有主页头像 URL、没有头像资源，因此 sidecar 为 `missing`，页面保留
文字站名。本人增量样本单独输入时保留既有 17 条缺祖先水位线告警；第三方样本无解析告警。
带标题广播与既有内容继续正常解析；历史失败 capture 的 verdict 保持不变。

本轮没有使用真实登录会话在线抓头像。生产者行为由注入 HTTP 响应的真实 runner / writer
链路覆盖；未把离线样本回归扩大为对豆瓣所有头像样式或全部页面类型的线上验证。
简介、地点、加入日期及统一 CLI `--account` 不属于此次头像设计交付，仍保留在原设计待办。
