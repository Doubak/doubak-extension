# 账号头像归档与个人站点图标

状态：已在 main 实现，2026-10-17；不代表商店安装包已更新。验收结果见 [实现核对](account-avatar-implementation-review.md)。
适用仓库：data-specs → data-parser / extension → site-generator；export-adapters 只需兼容新增记录。

承接[公开与多账号归档设计](public-and-third-party-account-archive.md) §7.1.6、§7.3：
本设计细化头像链路，并替代 §7.1.6 中没有修订与来源证据的扁平 profile 示例。
简介、所在地、加入日期等完整个人资料留待后续，不能为完成 favicon 而猜测这些字段。

## 1. 目标与当前缺口

目标是将**所选归档账号**的头像存为原始资源，离线生成其个人站点的页眉 logo 和 favicon。
本人、登录者代抓、匿名公开抓取使用同一条链路；头像属于目标 UID，不能来自浏览器登录操作者。
`sample.doubak.com` 是这一能力的使用者，不在生成器里硬编码样张账号。
`doubak.com` 的产品标识和扩展图标继续使用豆备品牌。

当前代码证据：

- `crawl/profile-identity.js`、`target-account.js` 已从目标身份块读取头像 URL 中的 UID / 主页链接，
  但这只是身份取证，没有下载头像。
- `crawl/routes.js` 和 `loop.js` 已有作品封面、用户附图、小组图标，没有账号头像路线。
- parser 尚无 `extract-profile.js`、`profile.ndjson`；站名目前读取各记录的 `account.nickname`。
- site-generator `image-index.js` 按 URL 建索引，无法安全表达同 URL 的头像换图与跨账号隔离。
- Hugo `baseof.html` 只有文字站名，没有个人 favicon / 页眉头像。

完成标准：删掉派生文件、断网后，仅凭 canonical 与 bundle 就能重建头像和站点；
没有头像的旧档案仍正常生成，不联网补图、不显示坏图。

## 2. 抓取与身份边界

### 2.1 只从已验证的主页读取

正式 `profile.overview` 响应须为 `ok`，且主页身份与任务目标 UID 一致。
复用目标身份块定位，读取其中头像节点的实际 `src`；不得扫描整个 HTML 的第一个 `/icon/`。
导航头像、访客、好友、广播作者、签名正文或脚本中的图片均不能成为账号头像。
头像文件名如含数字 UID，必须与目标一致；缺失 / 冲突不以登录导航作兜底。
需要同时有其他身份依据才能接受不带 UID 的默认头像。

只接受实际页面给出的 HTTPS 豆瓣图片地址，协议相对地址按 HTTPS 解析；
使用现有图片域白名单，拒绝外站、非 HTTPS、凭据 URL、data/blob URL。
实现选择拒绝所有头像重定向（fetch `redirect: error`）：浏览器的 manual 重定向不暴露
Location，follow 又无法逐跳拦截；拒绝跳转比只检查最终 URL 更能守住域边界。
不把 `/u…` 猜成 `/up…`，不穷举大图地址。原始页面和请求 URL 如实保留。
已确认的默认占位头像不下载；结构不认识属于未知，不等于用户删除了头像。

预览「查看账号」只负责身份检查，不额外下载头像。必须先将正式主页落盘，
再把头像请求入队，避免生成没有来源的资源。

### 2.2 新路线

| 项目 | 约定 |
| --- | --- |
| route_key | `asset.account_avatar` |
| intent | 新开放词表值 `asset.image.account_avatar` |
| surface | 已有 `asset` |
| 段 | `assets-*`，不随可丢弃的作品 `catalog-*` 清理 |
| parent_capture_id | 直接指向本次已保存、身份匹配的 `profile.overview` capture |
| 归属 | manifest / checkpoint 的目标 UID；不建立独立的操作者资源 |
| 调度 | 一次主页观测最多派生一个头像任务（网络重试沿用原策略）；普通图片队列、全局节奏与暂停机制 |

每个新 bundle 都重新请求主页里当前的头像，即使 URL 在旧 bundle 中已成功抓过；
头像 URL 可能复用，**不能套用「同 URL 图片永不改变」的跳过规则**。
设置 `cache: no-store`，不发条件请求，避免 304 无字节。图片请求不带登录凭据，
继续使用必要的现有 Referer 机制；不开新权限、不增加网络域。
`skip_catalog` 和作品封面选项不影响头像。第一版随主页默认抓取，不新增让用户猜含义的开关。

冷 / 热恢复保留父 capture、队列状态及目标身份；同一 bundle 已完成的头像不重复抓。
仅在头像失败或此前尚未入队时补齐，不能因恢复时的当前 Cookie 重新归属。
入队与 checkpoint 恢复需覆盖「主页已落盘、子任务还未持久化」的崩溃窗口，利用原主页恢复待办。

### 2.3 失败不是主页缺失

沿用已有资源判定和网络重试规则；验证码 / 风控暂停，不立即重试。
头像 404、损坏、未知 MIME 或尺寸超限如实保存响应与失败原因，不能伪装成功。
已成功的主页解析继续有效；资源失败不影响广播等分页路线的水位线。
用独立资源路线记录缺口，不声称已下载全部头像；允许按现有非分页失败策略收尾。
恢复后成功捕获可以补齐缺口，历史失败 capture 仍保留。

## 3. Spec 变更

### 3.1 Bundle：沿用格式，补词表与语义

不在 `manifest.account` 增加头像路径 / base64 / 当前头像快照：它们会复制可变资料，
还无法表达来源与历史。同样不把头像字段复制到七类账号记录里。

需要修改：

- `bundle/v1/vocabularies/intent.json`：记录 `asset.image.account_avatar` 的语义与所有权。
- `bundle/v1/SPEC.md`：补主页 → 头像的 parent 关系、assets 段、同 URL 可变、错误保留范例。
- bundle conformance：有效头像资源、跨账号父关系错误的 producer 测试、旧 bundle 仍可读。
  只靠索引结构不能验证 HTML 中的 UID；该项由抓取器 / parser 验证，不能夸称 schema 能证明归属。

`intent` 是开放词表，新增值本身**不要求 bundle 小版本升级**；`surface`、索引字段与
manifest 必填字段均不变。当前通用 schema 可以装下这些数据，只需新增示例与语义测试。
同步 extension 的生成常量；如实现阶段发现必须改封闭词表或必填结构，再单独评估版本。

### 3.2 Canonical：新增第九类 `profile.ndjson`

使用现有版本化记录模式，不采用单个无来源的 JSON：

- 新 `canonical/v1/profile.schema.json`；主键为数字 UID，`identity_layer: upstream_id`，
  `upstream_id === account.user_id`。`url` 为有证据的目标主页。
- `revisions` 沿用 `parser_version`、首次 / 末次观测、`fields`、字段 `digests`、`observations`。
- 第一版 `fields` 只有 `username`、`nickname`、`avatar_url`（字段类型为 string 或 null，
  不使用空串代替缺失）；昵称等只从身份块读取。顶层 `account` 继续符合现有通用身份约定。
- `observations` 指向原主页 capture，通过 bundle ID 回指原 crawl_scope，并带 `omitted_fields` 证据。
  资源二进制不进 canonical；头像字节的身份由 bundle 的 capture ID 与 payload digest 表达。
- URL 相同但字节变化不伪造一次 `avatar_url` 字段编辑；同一修订保留新的主页观测，
  下游按最新观测对应的头像 capture 选择字节。
- 无头像节点、未知结构、挑战页或缺失主页不得产生删除。字段缺失沿用 omitted-field 语义；
  只有确认了默认头像标志的正常身份块才写 `avatar_url: null`，表示该次明确观测到默认头像。
  后续未知观测不把这个明确状态反转。公开观测无缺失推断权限，profile 不生成删除事件。

同步 `canonical/FIELDS.md`、`IDENTITY.md`、`INGESTION.md`、v1 README、验证器文件分派、
示例与 conformance。按现有格式演进规则使用实现时下一个可用的 `canonical/1.x` 小版本，
同时递增 parser 版本；不要把新记录误称为现有八文件契约的一部分。
缺少 `profile.ndjson` 的旧输出仍合法；新 parser 输出该文件（可为空）。
旧消费者可忽略它，但不得把「已读八类」当成「已支持全部新资料」。

## 4. Parser、历史合并与资源选择

新增纯 `extract-profile.js`，由 `parse()` 摄取成功且目标身份验证通过的主页；
CLI 和 extension 通过 vendor 使用同一实现。真实旧主页也能重解析得到头像 URL，
但未抓过的头像字节不会凭空恢复。导出不得上网弥补。

profile 与其他记录一样按观测时间排序、同版本字段摘要合并；同时间用 capture ID
作确定性 tie-break，不依赖目录顺序。用户名变化不改变 UID 主键；昵称与头像属于同一账号。
如果 profile 与其他 canonical 记录 UID 不同，整个站点生成在写入前拒绝；只有 profile
而没有标记 / 广播的账号也应能生成有名称的空内容主页。

在共享 `avatar.js` 提供独立的账号头像解析接口，而非两个宿主各自猜 URL：

1. 选出 profile 最近一次有明确头像字段证据的观测。缺失新证据可保留上一观测，
   但时间仍标为旧的观测时间；明确默认头像则显示文字，不退回旧自定义头像。
2. 沿该主页 capture 的 parent 边找 `asset.account_avatar`，检查目标 UID、URL、成功 verdict。
   只按 URL 相同、目录先后或当前登录账号都不足以匹配。
3. 同一父观测有重试时，选最新可读成功 capture；原图须通过摘要、MIME、容器与尺寸校验；
   完整像素解码由 Hugo 统一完成，解码失败时只保留文字站名。Markdown-only sidecar 的
   `ok` 表示上述字节检查通过，不能冒充已完成完整像素解码。
4. 最新明确头像 URL 缺图时降级文字并报告 missing / unreadable，不静默把更旧头像称为当前头像。
   第一版不跨父观测回退字节，即使 URL 一样；宁可明确缺图，也不遮蔽同 URL 换图。

结果为宿主可读取的 `{ host, row }` 与诊断信息。Node 和 OPFS 各负责读写字节，
身份、选择与输出命名规则共用纯函数。`assets/profile/<uid>/<payload-digest>.<ext>`
作为导出的本地内容地址，不用 URL basename，避免账号间 / 同 URL 换图互相覆盖。

## 5. Markdown、favicon 与页眉

Markdown 导出把经过验证的原图放入 `static/assets/profile/...`，另输出稳定的
`site-profile.json`（版本、UID、昵称、本地 avatar 路径、观测时间、缺图状态）。
该 sidecar 是通用主题接入契约，不包含远程 fallback URL，不要求浏览器 fetch 它。
Node CLI 和 extension ZIP / 文件夹输出须逐字节一致；不是往每篇 Markdown 重复插头像。

Hugo 构建阶段从本地原图生成方形 PNG 图标：32×32 favicon、180×180 touch icon，
页眉使用 96×96 派生图、显示 40–48 CSS px。等比缩放居中留透明边，不裁掉原图内容；
不放大低分辨率图。可接受输入限定为 JPEG / PNG / GIF / WebP，GIF 取首帧，
拒绝 SVG / HTML。原图 WARC 字节始终不改。

Hugo 负责离线派生转换；Markdown-only 输出保留原图及 sidecar，由消费主题决定转换方式。
实现前验证项目锁定的 Hugo 对上述格式的解码与动画首帧行为，超出支持范围报告降级，
不为此引入 npm 图像库或浏览器 / Node 两套重采样实现。设置 5 MiB 字节、4096×4096
像素与 16M 总像素上限；校验在转换前执行，防止小压缩文件触发大内存解码。

页面使用本地图标 `<link rel="icon" type="image/png">` 和 touch icon；没有图就不输出
这些标签，维持文字站名。所有路径经同一相对路径规则处理，适用于 `file://`、域名根与
GitHub Pages 子路径，不能硬编码 `/favicon.ico` 指向别的站点根目录。
页眉头像和站名共用首页链接，图片 `alt=""`，避免屏幕阅读器重复读账号名；保留原有 h1。
名称仍沿用 `--site-title` → 昵称 → username → UID 的规则；让 `resolveSiteTitle`
读取同一目标 profile，并保留旧 canonical 从 account 元数据取名的回退路径。

sample 只在用户安排重新生成时应用此能力；设计 / 验证过程在临时目录构建，
不覆盖当前 sample 网站。生成器不提供发布前全文隐私审查；可见性筛选和 `deploy --dry-run`
也不能替用户判断头像是否适合公开。

## 6. 实施顺序与验收

| 阶段 | 产出与必要验证 |
| --- | --- |
| 1 specs | profile schema / 语义 / 验证器 / 兼容样例；缺字段和 null 区别，旧八文件仍可验证 |
| 2 parser | 新文件、CLI / 内存 parse 输出、canonical loader；打乱输入顺序结果一致，昵称与 URL 有来源 |
| 3 extension | 主页派生头像、资源失败、冷热恢复、崩溃窗口；跳过作品详情仍抓头像；重试不复制父任务 |
| 4 generator | 共享资源选择、两个宿主 sidecar 一致、Hugo favicon / 页眉；无头像和坏图降级 |
| 5 docs / vendor | 同步 parser / generator vendor，所有「八文件」说明及 Help；导出适配器忽略 profile、不把它编成评分记录 |

必须覆盖以下实际行为，不能只有 selector 的单元测试：

- A 登录抓 B：导航头像 A、访客 C、目标 B 同页，只抓 B；匿名和本人得到同一归属。
- 默认头像、丢失节点、异常主页、UID 冲突、脚本中的假头像、不允许的重定向。
- 新 URL 换图、同 URL 换字节、重复时间、乱序 bundle、最新字节损坏；无跨 UID 回退。
- 全量 / 增量 / 冷热恢复 / 资源网络失败 / 验证码暂停；错误保留而分页水位线不被图片阻塞。
- 只有 profile、旧 bundle 有 HTML 无头像字节、旧 canonical 无 profile、缺失祖先 bundle。
- WARC 校验、九类 schema、Node / 浏览器 canonical 与 Markdown 一致。
- 临时 Hugo 构建后用浏览器检查首页 / 深层页 / 子路径 / file URL 的图标和页眉；
  所有资源本地存在，离线零外部请求，明暗主题与窄屏可读，没有重复 h1 / 无障碍名字。
- 真实本人和第三方 bundle 的匿名化最小夹具：不提交原始 Cookie、访问令牌或私人页面。

实现与测试覆盖逐项记录在 [实现核对](account-avatar-implementation-review.md)。
README / 官网 / Help 区分 main 与已发布安装包，旧主页 HTML 仍不等于已归档头像字节。
