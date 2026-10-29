# 广播详情与回复归档（issue #26）

状态：设计提案，尚未实现。调查日期：2026-10-28；方案整理：2026-10-29。
需求：[extension issue #26](https://github.com/Doubak/doubak-extension/issues/26)。
范围：广播列表发现、详情 HTML、回复与楼中楼响应的归档，以及下游离线解析和呈现。
本文中的新路线、字段和界面均为拟议设计，不代表当前版本已经支持。

## 1. 审查后的范围决定

**仅在目标本人广播的根回复按钮明确显示有回复时，派生详情抓取。**
省略号不触发抓取，不触发永久历史重抓，也不作为 `text_truncated` 的判断依据。
`（全文）` 的结构化链接继续沿用既有语义；本设计不增加其抓取路线。
`book/2053249` 的详情仍显示省略文本，是本次观察事实，不推断其服务端如何存储，也不保证未来能够补全。

本提案明确修订了项目 2026-07-28 排除他人回复的范围决定：按 issue #26 和本轮需求，
新增**目标本人广播下直接关联的讨论归档**。不是将回复重新定义成“本人创作”，也不是默认展开社交网络。
边界由以下规则共同限定，而非仅用“有界”二字保证数量小：

- 根必须是本轮目标账号发布的广播；转发的根附言属于目标，引用来源不因此入队。
- 保存根下的回复和有证据的楼中楼；不跟随作者主页、关注关系、引用的其他广播或外部讨论。
- 同根的楼中楼分页需取得成功样本才实现；没有协议证据时保存已有响应并明确标记缺口。
- 广播列表与本人正文保留现有最高优先级，回复队列排在本人正文之后，不阻塞列表水位线。
- 大型讨论可以暂停或限额，但中断状态必须进入导出的 bundle，不能宣称完整。
- 第三方回复默认不进入公开站点；作者身份、可见视角与发布选择独立记录。

小组主帖下回复在所有权分类上也是讨论上下文，不再声称它与广播回复存在本质差异。
**本轮仅实现广播讨论这一已提出的需求；小组回复仍不支持，原因是分阶段范围与尚未调研的协议。**
目标本人在他人主帖下的回复仍属于本人 UGC，但没有可靠枚举入口；暂不支持不表示其价值低于他人回复。
实施前应同步更新 CLAUDE.md 与 README 的范围说明，保留旧决策的日期，避免两套原则并存。

初版仅实现已有正常样本的 status 详情及顶层回复路径。topic 标为待调研，不能依据 403 页面设计 DOM
选择器、评论 API 或 canonical 实体映射；`douc.cc` 只保留本次调研事实，不新增权限或自动解析路线。
广播保持一个 `revisions` 数组，列表与详情由 parser 归一化，不引入 `detail_revisions`。

## 2. 调研基线与代码入口

已检查工作区 `CLAUDE.md`、相关仓库 README、issue 正文、广播抓取/解析代码及真实档案。
根目录没有 README，各仓库的 README 分别说明职责。

| 仓库 | 调研基线 HEAD | 当前与本问题有关的行为 |
| --- | --- | --- |
| data-specs | `11b3075` | intent 已有 `broadcast.item`，但不等于抓取器已实现；广播 schema 没有回复模型 |
| data-parser | `f7130cc` | 只把 `broadcast.timeline` 交给广播抽取器；按 sid 归并列表观测 |
| site-generator | `ba27569` | 广播月页、作品时间线使用 canonical 广播；无回复展示 |
| extension | `d1e6fc1` | 有广播列表与附图派生，没有广播详情/回复路线 |
| import-adapters | `3b463d5` | 历史档案转 bundle；不能恢复原来未抓过的回复 |
| export-adapters | `9982bc3` | 消费 canonical；回复不能混进标记短评或第三方导入记录 |
| website | `358ffe4` | 相关开发日志解释了“列表有回应数、详情尚未抓”的缺口 |
| site-generator-sample | `f39df0352` | 用于未来端到端验收；本轮不重新生成或发布 |
| data-enricher | `b6576a7` | 目前是规划仓库；本问题不需要联网补全器 |

关键代码与规范：

- [`routes.js`](../../src/crawl/routes.js)、[`classifier.js`](../../src/crawl/classifier.js)：
  `broadcast.timeline` 是有水位线的 bounded 列表路线，不能证明历史广播全部存在或不存在。
- [`loop.js`](../../src/crawl/loop.js)：现有 `_enqueueLongformItems`、`_enqueueStatusPhotos`
  可参考派生与父 capture 关联方式，但没有广播详情派生。
- [`backlog.js`](../../src/crawl/backlog.js)、[`offscreen.js`](../../src/offscreen/offscreen.js)：
  已有从旧广播 HTML 补算附图的机制，应扩展这一模式，避免增量水位线永久漏掉旧回复。
- [`replay.js`](../../src/crawl/replay.js)：`derivesWork()` 目前靠 pagination / interest 前缀判断，
  新增无列表分页的详情派生路线也需要纳入崩溃恢复。
- [parser `extract-broadcast.js`](https://github.com/Doubak/doubak-data-parser/blob/f7130cc/src/extract-broadcast.js)：
  `topicHeading()` 已验证 `data-aid` 与 topic 链接一致；`fullTextUrl()` 只认结构化 `（全文）` 链接。
- [parser `parse.js`](https://github.com/Doubak/doubak-data-parser/blob/f7130cc/src/parse.js)：
  `upsertBroadcast()` 把 `Boolean(fullTextUrl)` 写成 `text_truncated`，不是省略号检测。
- [bundle intent 词表](https://github.com/Doubak/doubak-data-specs/blob/11b3075/bundle/v1/vocabularies/intent.json)：
  已有 `broadcast.item` 和 `redirect.shortlink`，开放词表增加路线名本身不要求 bundle 大版本升级。

## 3. 已取得的证据

### 3.1 本地档案与 issue 中的两个例子

扫描 `/home/mewx/downloads/exports` 的 35 份 bundle：1120 条 `broadcast.timeline` 索引记录，
其中 1118 条 verdict 为 ok；未发现 `broadcast.item` 捕获。按 owner UID `82160871` 过滤，
列表抽取器识别出 3475 个不同 sid；每个 sid 取观测时间最新的已存列表卡片后：

| 观察项 | 数量 | 含义 |
| --- | ---: | --- |
| 根卡片回复按钮 `data-count > 0` | 52 | 自动补抓候选，包含 1 条 topic 动态；尚非请求数或已保存回复数 |
| topic 动态 | 6 | sid 与 topic ID 是不同身份轴 |
| 文本末尾为 `...` 或 `…` | 43 | 仅说明样本形态，不触发抓取或截断标记 |
| 显式 `（全文）` 链接 | 2 | 沿用已有语义，与省略号不同 |

计数方法：用 parser `openAll()` 读各 bundle 索引，只读取 ok 的广播 HTML，
`extractBroadcasts(html, ownerUid)` 识别本人 sid；在对应 wrapper 内找回复按钮的独立
`btn-action-reply` class token，并验证 href 对应本条 sid 或已验证 topic ID，再读 `data-count`。
同 sid 按 `observed_at` 比较，不能用文件遍历顺序代替时间。
这些数字仅代表这批档案中最后一次看到的状态，不能断言目前线上仍有相同数量的回复。

**2053249：**列表广播 sid 为 `1317888615`，最早证据
`20221225T181500Z-98e6c6#000028`，较新证据
`20260903T232811Z-b3c2b6#000178`。列表正文以 `参考作...` 结束，回复数 0。
2026-10-28 匿名 GET [广播详情](https://www.douban.com/people/mewcatcher/status/1317888615/)
返回 200，正文仍以同样的省略文本结束。作品详情里的完整短评不能证明这条历史广播有可恢复的全文。
因此它应成为“**0 回复、不因省略号入队**”的回归样本；不能把作品页短评嫁接为广播全文。

**2181605815：**[注销好友的开发日志](https://doubak.com/log/2026-10-16-when-a-friend-deletes-account.html)
所述转发，列表证据之一是 `20260731T043423Z-d40c1d#000142`。
本人根广播的回复按钮是 `data-count="1"`；同一片段内还存在引用来源的 `155回应`。
抽取器必须同时核对根身份与链接，不能把引用里的 155 当成本条回复数，也不能顺手排队引用来源。

### 3.2 status 详情与实际回复接口

2026-10-28 无 Cookie 的少量只读请求：

| 来源 | 结果 | 能证明的事情 |
| --- | --- | --- |
| [用户提供的 status 页面](https://www.douban.com/people/82160871/status/9933613312/) | 200，21991 字节 | 根 `data-sid=9933613312`、`data-uid=82160871`；时间在 `.pubtime` |
| [旧转发详情](https://www.douban.com/people/mewcatcher/status/2181605815/) | 200，26923 字节 | 正文保留转发附言；回复容器本身为空 |
| [对应回复 API](https://m.douban.com/rexxar/api/v2/status/2181605815/comments?start=0&count=20) | 200 JSON，1116 字节 | `total=1, num=1, start=0, count=20`，实际含 1 条回复 |

详情中的实际结构（只摘录用于识别的部分）：

```html
<div class="new-status status-wrapper   from-detail " data-sid="9933613312" data-uid="82160871">
<div class="pubtime">2026-10-26 08:35:34 <span class="pub-loc"></span></div>
<div id="comments" class="comment-list"></div>
```

`_COMMENTS_CONFIG` 声明 `service: 'status'`、`start: 0`、`count: 20`，以及：

```text
FRODO_API_PREFIX = https://m.douban.com/rexxar
comments   = /api/v2/status/:topic_id/comments
getReplies = /api/v2/status/comment/:comment_id/replies
target.id  = 当前 status sid
```

这里模板变量名叫 `topic_id`，**不表示它是 `/topic/` URL 的数字**。
同一配置还包含添加、删除、点赞等接口；归档只选择已验证的读取接口，绝不执行整个配置或脚本。
回复 JSON 实测包含 `id`、`author`、`text`、`create_time`、`parent_comment_id`、`ref_comment`、
`replies`、`total_replies`、`is_deleted`、`is_folded`、`is_censoring` 等。
本例回复 ID 为 `251854261`，`create_time` 为 `2018-06-28 20:33:52`，楼中楼数组为空。
这证明顶层回复可取得，**尚未验证多页及非空楼中楼的网络行为**。

### 3.3 用户下载的 HTML

已读本地 `Downloads/芃芃的广播.html`（26082 字节）。根 sid `9935443329`，
作者 UID `162998492`，`data-target-type=book`，动作“读过”，3 星。
`_COMMENTS_CONFIG.author` 是作者，`_COMMENTS_CONFIG.user` 则为登录操作者 UID `82160871`。
回复容器同样为空；“保存网页”得到这份 HTML 并不代表已经保存了网页上后来加载的回复。
原文件含登录视角资料，不复制到仓库；实现测试应使用保留结构的脱敏 fixture。

直接把两个详情 HTML 输入现有**列表**抽取器，实测分别得到：

```text
9933613312: postedAt=null, action="想看 2026-10-26 08:35:34", status=null
9935443329: postedAt=null, action="读过 2026-10-26 15:47:06", status=null, rating=3
```

因此不能只增加 intent 分支后复用原抽取器：详情的动作、发布时间、标题、根容器边界要专门解析。
登录者与作者分离也必须贯穿抓取目标核对、canonical 和回复展示。

### 3.4 topic、短链与其他入口

- 用户给的 [topic 503888148](https://www.douban.com/topic/503888148/) 和
  [topic 503786901](https://www.douban.com/topic/503786901/) 在本次匿名请求中均返回 403，
  未取得正常正文，未继续尝试绕过。**不能据此说它们已删除或不支持。**
- 旧列表已有实证：`20261026T003756Z-bfadec#000007` 中，sid `9871051745`
  对应 `data-aid=502623668`，标题、时间与回复按钮均指向 `/topic/502623668/`，回复数 2。
  topic 回复按钮有 `btn-action-reply` / `data-count`，却没有普通广播的
  `data-action-type="showComments"`；后者不能作为通用必要条件。
- 用户提供的 [短链](https://douc.cc/1yY1iJE) 本次实测返回 **302**，Location 为
  `https://www.douban.com/topic/503732386/?_spm_id=MTYyOTk4NDky`。
  这是一个新的 topic ID，不能与下载文件中的 status `9935443329` 当成同一条记录。
- 现有列表还提供 `data-status-url`、`.created_at` 内链接；topic 提供标题链接。
  回复按钮优先，以上作为身份验证后的替代入口。只保存页内存在的链接，不依据类别猜详情 URL。

`_spm_id`、`_i`、`_dtcc` 是这些分享链接中出现的参数。原始 href 保留在 WARC；
调度去重可剥离已确认的跟踪参数和 fragment，但必须保留 `tab`、分页位置及未来未知的语义参数。
同一作者的数字 UID / 用户名形式仅在已有主页身份或详情证据确认后合并。

短链实现还有两处现成缺口：[`manifest.json`](../../manifest.json) 未声明 `douc.cc` host 权限；
[`transport.js`](../../src/crawl/transport.js) 虽有短链主机表，真实浏览器 fetch 用
`redirect: 'follow'`，通常只能取得起点与终点。Node 中拿到 302，不代表浏览器能读取逐跳响应。
不能把测试替身的 manual redirect 能力当成已实现的 WARC 跳转保真度。

## 4. 抓取模式、账号视角与持久化

### 4.1 现有代码的模式契约

已核对 [`crawl-modes.js`](../../src/crawl/crawl-modes.js)、
[`offscreen.js`](../../src/offscreen/offscreen.js) 的 `incrementalOptions()` / `handleOp('start')`、
[`chain.js`](../../src/crawl/chain.js) 的 `sameAccount()`，以及
[`run-context.js`](../../src/crawl/run-context.js)、[`target-account.js`](../../src/crawl/target-account.js)。
当前三种模式是 `incremental`、`refresh-editable`、`full`；账号视角是独立维度，不是第四种模式。

普通增量使用列表水位线和已捕获跳过名单；增量＋可变内容保留列表水位线，但直接重抓所有已知可变内容；
全量不使用旧水位线或跨 bundle 跳过名单。**撤销先前设计统一的 30 天刷新周期**，由模式直接决定行为。
广播主文本的不可变假设与回复的可变性分开处理，不能以回复会变为由重抓全部历史广播列表。

### 4.2 三种模式的行为矩阵

以下均以当前目标、视角、操作者及启用路线范围为前提。一个讨论的“已完成”必须包含成功分页终点，
不能仅凭某个 URL 有过 200 响应；`has_replies` 来自经根身份核对的回复数量。

| 行为 | 增量 `incremental` | 增量＋可变内容 `refresh-editable` | 全量 `full` |
| --- | --- | --- | --- |
| 广播列表 | 按现有时间下界闭区间枚举 | 与增量相同 | 从头枚举至当前视角的可见终点，无历史 floor |
| 新发现有回复的根 | 详情＋已支持的回复分页 | 同左 | 同左，不跨 bundle 跳过 |
| 旧候选尚未保存详情/回复或上次有缺口 | 从旧列表 WARC 补算，补未完成讨论 | 补抓并刷新该讨论 | 由本轮列表重新发现、重新抓取 |
| 已完成、回复计数未变的旧讨论 | 跳过；不承诺发现同数编辑 | 所有已知讨论直接刷新，包括水位线以下的讨论 | 本轮重新发现的讨论全部重新抓取 |
| 本轮列表发现回复计数变化 | 刷新该讨论；减少不代表删除 | 刷新 | 本轮重新抓取 |
| 旧候选现在显示 0 回复 | 曾未完成则补抓；已完成则在观察到数量变化时刷新 | 保留已知身份，重新观察，不删除旧回复 | 保存本轮 0 的观察；仅此不会触发新详情任务 |
| 省略号，无回复证据 | 不抓 | 不抓 | 不抓 |
| 根详情已保存，回复需刷新 | 可重读详情以取得本次配置/访问状态，再走回复分页 | 同左 | 本轮取得新详情，不能用旧响应充当新捕获 |
| 已有资源字节 | 沿用既有资源跳过规则 | 同左 | 选择范围内需要的资源重新捕获，遵守已有不抓回复附件的边界 |
| 历史根未出现在本轮列表 | 可依据同视角旧候选补尚未完成的讨论 | 可直接刷新同视角已知讨论 | 不注入旧候选冒充本轮发现；旧记录仍在原 bundle 中 |

“增量＋可变内容”须直接排队所有已知讨论，不能只取消 URL 跳过后等待它们在新列表页出现。
回复计数不变但正文编辑、删一条再加一条，只有刷新模式或全量中被重新访问的讨论可能发现。
普通增量的新补抓功能是填补既有缺口，不是无限轮询全部旧讨论。

全量是一份**当前可见范围**的新基准，不是过去所有内容的复活：本轮不再出现的旧根不因此被判删除，
新基准也不从旧 bundle 借字节补齐。仅用本轮 bundle 应能解析本轮已取得内容；合并旧 bundle 则保留历史。
即使全量列表走到底，广播与讨论的缺席也不授予删除推断权。public 的 absence authority 始终为 none。

没有合格基准时，两个增量模式按现有机制明确退回无下界枚举；UI 显示实际行为与原因。
历史讨论候选扫描须与 `pickFloors()` 解耦：列表没有合格 floor，不代表同视角历史失败候选不存在。
显式选择 full 时禁用历史补抓注入；增量退回无下界时仍可补同视角已知缺口，并保留跨 bundle 来源。
后者不是“显式全量自足档案”，不能用同一个 UI 标签掩盖其来源依赖。

### 4.3 本人、登录访问他人、匿名访问的行为矩阵

以 `inspectTarget()` 的实际身份取证为准：目标 UID 等于登录 UID 才是 self。
输入自己的数字 UID 或主页链接不会变成第三方抓取；未登录访问自己的公开主页仍属于 public/anonymous。

| 场景 | 目标与操作者 | 可抓范围与凭据 | 可复用的历史 |
| --- | --- | --- | --- |
| 登录 A 抓 A | target=A，self，operator=A | 本人当前可访问的根与讨论，沿用本机会话；可能含私密内容 | 同目标 UID/域名、self 的合格历史 |
| 登录 A 抓 B | target=B，public，operator=A | A 当前能看到的 B 的根与讨论；不冒充 B，不把导航或配置 user 当成作者 | 同 B UID/域名、public、authenticated、operator=A |
| 未登录抓 B（也可能是本人公开主页） | target=B，public，anonymous | 匿名可见内容；请求明确 omit 凭据且不用 ck | 同 B UID/域名、public、anonymous |

`public` 是抓取视角，不是“捕获到的每句话都可公开发布”的保证；登录 A 能看到的好友回复可能匿名不可见。
`_COMMENTS_CONFIG.author`、根 data-uid 指示内容作者，配置 `user` 指示操作者；回复各自有作者。
备份 B 时，A 在 B 根下的回复可以作为该讨论的上下文保存，但不能因此把根归给 A。

三种模式与以上三种视角做笛卡尔组合，执行同一调度矩阵。差异在于可见内容、历史资格与会话守卫，
不是“抓别人就默认全量”或“抓自己就能看到所有回复”。公开模式现有的目录默认关闭、owner-only 路线排除
保持不变；回复接口属于 data，不照搬作品目录的匿名请求策略，登录访问 B 时仍绑定操作者 A 的会话。
匿名会话若后来登录，暂停并要求按原视角继续或新建任务，不能把两种可见集合拼成一次完整枚举。

水位线、候选、成功缓存、未完成分页与覆盖证据统一使用视角隔离键：
`(target UID, 已核验域名, visibility, operator mode, public operator UID)`。
同 B 的 self、A 登录访问、C 登录访问、匿名访问不能互相授予“已抓完”、下界或免请求资格。
旧 public 档案缺 operator UID 时不授予这类资格；不为兼容把它猜成当前操作者。
同 UID 改域名沿用现有重新建基准规则，不能只按 URL 文本替换续旧断点。

### 4.4 发现与已支持的接口边界

新增纯函数 `extractBroadcastDetailCandidates(html, ownerUid)`，在线派生与历史扫描共用。
返回根 sid、实际 href、回复计数、父 capture 和身份取证，不把登录者资料当成 owner。
仅接受根按钮明确的正数；缺失计数为 unknown，记录诊断，不猜 0 或自动排队。
普通按钮的 `btn-action-reply` 要按 class token 匹配并核对其 href，排除删除按钮、嵌套引用和作品卡片。

当前可以设计的实现路线为：

| route / intent | surface | 派生来源与验证 |
| --- | --- | --- |
| `broadcast.item`（status profile） | html | 根回复链接；核对根 sid、作者 UID、详情框架及配置 target |
| `broadcast.comments` | api | 正常详情的已验证读取配置；保存顶层 JSON 分页与终点证据 |
| `broadcast.comment_replies`（暂缓启用） | api | 需非空楼中楼及分页样本验证后，才允许从实际回复 ID 派生 |

只解析配置中的受限数据字面量，不执行脚本或任意 URL；只访问已有样本支持的读取端点。
`create_comment/delete_comment/react` 等写接口绝不入队。令牌只使用既有会话路径，不记入日志或 fixture。
空动态回复容器不代表 0；API 返回 200 HTML 登录页、JSON 错误或异常空页不是成功结果。
计数只作观察与缺口提示，不能证明全部抓完；分页需要真实 next/offset 协议、终点与防停滞判断。
当前首屏 `start=0,count=20` 不足以证明多页、楼中楼的终止方式，取得样本是启用这些路径的前置条件。

发现 `/topic/:id/` 链接时保留原始列表证据，并将该能力列入 `UNRESOLVED_ROUTES` / 范围报告。
已有 `data-sid` 与 `data-aid` 的关联可以如实保留，但**不生成臆测的详情 profile、评论路径或 topic 回复 schema**。
在正常样本确认它是目标的个人内容、作者和 API 资源身份后，再用独立设计增补启用。
403 只说明本次访问受阻，不证明它是多人广场、已删除或永远不支持。

### 4.5 短链不进入本次实现

本次已取得的列表样本提供回复按钮、`data-status-url`、时间或 topic 标题的直达链接。
用户给出的分享短链是调研输入，不足以证明爬虫需要增加短链访问能力；不推广为“所有网页永远没有短链”。
本轮不新增 `douc.cc` host 权限、不新增 `redirect.shortlink` 调度、不改变现有 redirect 保真度约定。
若未来卡片只有短链且无可验证直达入口，保留链接并报告不支持，不自动申请新权限或拼造最终地址。

新增必需 host 权限可能导致 Chrome 更新后停用扩展，等待用户授权；是否升级权限由新旧授权能力比较决定，
不能把所有 manifest 字符串变更都说成一定停用。参见
[Chromium 权限升级机制](https://chromium.googlesource.com/chromium/src/+/main/extensions/docs/permissions.md)。
此处需求可用已有权限内的直达链接满足，不承担这项新增发布成本。

### 4.6 讨论覆盖必须随 bundle 保存

回复树不使用一个全局时间水位线。新设计增加**bundle 级讨论枚举日志**，暂名 `discussion-state.ndjson`，
作为规范化的抓取元数据随 bundle 导出，而不是 canonical，也不是只有本机可读的队列缓存。
文件名与 schema 在 specs 中定稿后再实现；引入新必需语义需 bump bundle minor，并更新 validator/导入导出清单。

每个讨论任务至少记录：本轮 task ID、父候选 capture、根 sid/实际 status 资源 ID、完整视角隔离键、
requested/effective mode、计划范围、已捕获分页 capture ID、请求游标、已见回复 ID、待展开楼中楼、
终点证据、已知缺口和 stop reason。状态包括 not_requested、partial、complete_visible、unavailable、unknown；
只有真实结构终点与连续分页证据能给出 complete_visible，且仅针对本轮视角和已支持范围。
未支持的楼中楼、隐藏/折叠回复、用户限额、解析失败分别记录，不能统一抹成 0。

写入顺序是响应 WARC → index → 讨论枚举日志 → checkpoint；候选任务在首次请求前也须落盘。
run-store/frontier 是可重建的运行缓存。用户取消、预算中止、风控和部分导出时，这个日志也必须进入 bundle；
最终 manifest 含摘要及文件引用，未收尾 bundle 则直接读取已有日志，不能等到成功 finalize 才知道缺口。
崩溃若只有 response/index 而未写讨论状态，可从 capture 重建已抓页面；缺少明确终点时只能得到 unknown/partial。
若仅凭原始页面就能重算候选，日志与重算结果应交叉核验，不凭日志声称保存了不存在的字节。

不设置未经运行成本验证的固定“200 请求后视为完成”。用户设置的 maxCaptures/时间预算是停止条件，
触及时暂停或产出部分档案，并记下尚未处理的讨论与原因；停止不会抹掉已保存内容。
单个讨论可能很大，分页队列需轮转以免饿死其他候选；已有全局节流、退避、取消与人工风控恢复规则继续生效。

`crawl_state` 与新讨论状态的职责明确分开：

- `broadcast.timeline` 只证明列表枚举；列表连续走完可按原规则 advanced=true，即使讨论尚有缺口。
- 详情与回复路线无全局时间下界，high_water_time/floor_time 为 null，advanced=false，不参与 pickFloors；
  enumeration 保守为 bounded，未获得路线级连续性证据时 contiguous=false；实际逐根终点由讨论日志表达。
  路线汇总不能把 null floor 解释为遍历了所有人的所有讨论。specs 要同步修订“完整性只由 crawl_state 表达”的旧说明，
  不能新增日志后继续让旧校验器把回复树误当线性列表。
- 新讨论日志逐根证明分页连续性；`advanced=false` 不要求下次把已完成讨论全部再抓，因为讨论补抓读取该日志，
  不是复用线性列表的 floor 逻辑。
- manifest 的 bundle/讨论汇总必须显示缺口；“列表完整”不能写成“全部回复完整”。
- 计数下降、任意视角未出现、一次 404 都不证明回复删除。只有该回复明确的上游墓碑才记录删除状态。

校验器要同时检查日志引用的 capture 存在、视角一致、终点与 missing 页不矛盾。
把 bundle 导到另一台机器、删除 OPFS 运行缓存后，离线 parser 必须仍能区分已抓、未抓、未知与被限额中断。
这修复的是抓取元数据的持久化约定，并不把 canonical 或运行缓存提升为原始内容证据。

### 4.7 恢复、升级和用户可见表现

任务开始时固化 requested/effective mode、目标 UID/域名、视角、操作者、路线开关、预算和策略版本。
这些字段随 bundle 任务元数据与 checkpoint 保存；不要仅靠面板当前选项或只在运行数据库里存 mode。
恢复必须沿用原值，切换模式/目标/操作者只能结束原任务后新建；相同任务正常恢复不重复已完成页。
崩溃窗口的派生 replay 允许受控重复，但不能永久漏掉子任务，且不能重用过期分页游标假装连续：
需要重新锚定时，从已验证的根入口重走该未完成讨论并去重，不必重抓全部广播列表。

self 掉登录、public 登录操作者退出/换号、匿名任务中途变登录、目标身份变化都暂停，不能悄悄降级继续。
正常回复关闭/不可见是内容可见性问题；账号会话失效是整轮视角问题，不能一概当作“回复已删除”。
旧断点没有新路线配置时，按旧范围恢复；新一轮才启用讨论补抓，证据不足的旧断点拒绝猜测身份。

面板分别展示“广播列表”“待抓详情”“讨论分页”，并标明本轮模式、目标与访问者。
普通增量说明“不刷新已完成讨论”，刷新模式说明“重新检查所有已知讨论”，全量说明“重建当前可见范围”。
范围报告区分：本模式跳过、用户未启用、未支持、访问不可见、失败及预算中止；不能用一个“0”概括。
公开视角的日志和范围报告写“由 A 登录访问 B 时看到”或“匿名访问”，不把其称为 B 本人的完整备份。

## 5. canonical 与离线呈现

### 5.1 一个实体只有一条修订流，归一化由 parser 完成

不新增 `detail_revisions`。同一广播仍只有 `revisions`，每条 observation 指向原始 capture。
详情使用独立抽取函数处理 `.pubtime`、动作、评分与根容器，再映射到既有字段；
不是把详情 HTML 直接塞给列表抽取器。既有 surface 区分 HTML/API，列表与详情同属 HTML 时，
可在 observation 增加来源角色（如 source_intent），以明确该捕获为哪些字段提供证据。

parser 的摄取规则必须写入 specs 并以同一 parser_version 测试：

| 证据关系 | 归一化行为 |
| --- | --- |
| 列表/详情字段等值 | 同一修订追加 observation，不新增正文版本 |
| 详情补充更精确时间或原先缺失字段 | 按观察时间形成一次证据补充，保留字段出处；不把抓取时间当发表/编辑时间 |
| 已有结构证据确认列表为摘要，详情提供相同资源的完整正文 | 由 parser 采用完整正文，保留之前摘要修订与来源；标记为证据补全而非用户编辑 |
| 后续列表再次出现已知摘要 | 不覆盖已证实的完整字段；记录该捕获未提供完整字段证据，保留摘要在 WARC 中 |
| 两份可靠完整正文确有差异 | 单一 revisions 中保留观察变化，编辑时间未知；不能只因为“广播通常不可编辑”丢弃实际证据 |
| 身份、完整性或两份内容关系无法确认 | 不猜较长文本胜出，不静默覆盖；保留响应并输出结构化冲突诊断，维持此前可验证的字段值 |

“更长”和“省略号结尾”均不足以构成摘要→全文关系的证明；旧 `text_truncated=false`
只表示旧解析器未识别显式全文链接，也不是全文保证。文本与 text_parts 必须作为一组归一化，
时间不得降精度；未展示字段沿用 omitted/unknown 语义，不能清空已有评分或动作。
冲突诊断须引用双方 capture，离线重跑仍能重现，不把未经采纳的值冒充当前字段的新证据。

生成器消费 parser 给出的规范化字段和版本性质，只负责排版与是否展开历史，不再比较两套源数组选正文。
同一 canonical 用于扩展、CLI、外部导出应得到一致内容。作品页短评始终是独立证据，不参与补写广播。

### 5.2 回复是独立记录

新增可选输出 `broadcast_replies.ndjson`，不把整个回复数组加入广播正文的 digest。
拟议记录结构：

```text
account: 档案归属 UID（不是回复作者）
thread: {kind: status, upstream_id: 已验证的 status 资源 ID}
broadcast_id: 已有证据映射到的列表 sid（未知时不猜）
upstream_id: 上游回复 ID，统一字符串
identity_layer: upstream_id
revisions: [{fields, digests, observations, parser_version, ...}]
fields: {author, text, text_parts, posted_at, parent_reply_id,
         referenced_reply, visibility, deletion_state, ...}
```

回复主键为 `(account UID, thread kind, thread ID, reply ID)`；当前只定义已实测的 status，topic 待取得证据后扩展。
根记录缺失时仍可保存有证据的回复，不伪造空广播。无法取得稳定回复 ID 时保存原始响应和解析诊断，
不按正文 hash 合并不同作者的同文回复。作者注销后的占位状态与原先作者资料都保留观测。

每次 observation 保留对应 bundle/capture 的 visibility、operator mode 和 operator UID，或提供可离线解析的
等价来源索引；不能只在临时运行日志里存视角。多个视角看到同一回复可以归为一个实体，但字段证据和缺口
仍按视角保存。后来的匿名响应缺字段，不会清空更早 self 证据；反过来也不能把 self 值挂到匿名 observation 上。
生成公开输出时按实际字段来源与可见性筛选，单独一个 record.account 或“最近一次 public 捕获”不足以授予发布资格。

计数与覆盖结果从 bundle 讨论日志派生为独立的解析报告，不加入广播或回复正文的 digest，
不让计数变化变成用户正文修订。原始回复 API 与讨论日志共同支持该报告，运行数据库不参与离线解析。
`is_deleted` 等明确的上游墓碑可以记录；一次列表未出现、计数下降、页面不可见都不能推断删除。
回复间的先后以有精度的上游时间和稳定 ID 排序；抓取时间只用来排列同一回复的观测版本。

新 schema、摘要覆盖校验器与 forward-compat 用例必须一起更新；沿用单一 revisions 的摘要校验。
canonical 使用下一个可用 minor 版本，实施时核对届时主分支，不能在设计中占用固定版本号。
WARC 必须足以离线重建上述记录，导出期间不访问豆瓣、不运行页面脚本。

### 5.3 生成站点与导出范围

新增回复显示开关，默认公开站点不输出第三方回复；显式选择包含讨论时，生成本地讨论页，
由广播月页和作品时间线链接进去。讨论页按回复时间展示作者、正文、父子关系及真实版本变化。
不把回复混到作品标记历史，也不让每个作品页面重复打印整段讨论。

“包含讨论”与现有 `--include-private` 是两个独立选择；包含讨论不能解除私密内容过滤。
讨论不可见、缺页或无作者的边界由 capture 视角和内容可见性共同约束，不能把操作者可见推成公开。
页面只在讨论确有缺口时提示“本次只保存部分回复”，不在所有普通广播上加免责声明或爬虫时间戳。
搜索索引、JSON 输出、预览和图片处理必须应用相同过滤，防止页面隐藏了回复但搜索仍泄露全文。

第一版保存回复 API 自带的作者/引用资料，但不额外抓回复者头像、主页、引用广播或附件 URL。
回复图片的原始地址保留在数据中；未归档字节时不在离线站点嵌入远程图片。
这项边界要在导出说明中写清，后续如扩展回复附件抓取另列路线和验收。
NeoDB、Letterboxd、Goodreads 导出维持既有范围，不把别人的回复当成账号主人的短评或活动。

## 6. 各仓库的改动与落地顺序

| 仓库 | 改动 | 验证与文档 |
| --- | --- | --- |
| **doubak-data-specs** | 定义 bundle 讨论枚举日志、任务范围/模式和与 crawl_state 的分工；定义 status 回复 schema；补充单一 revisions 的来源与字段归一化规则 | bundle minor、schema/validator、文件清单、INGESTION/IDENTITY/FIELDS、前向兼容与离线缺口用例一起更新；不提前定义 topic 回复结构 |
| **doubak-extension** | status 候选/详情/API 派生；按模式构造已知讨论、待补缺口与刷新队列；视角隔离；枚举日志持久化/导出/恢复；topic 范围报告 | 修改 routes/classifier/loop/backlog/runner/replay/run-store 与 offscreen 接缝；同步 crawl-modes 注释、README、DESIGN、docs/ui.md 与多语言文案；不增加 host 权限 |
| **doubak-data-parser** | 专用 status 详情抽取并归一到现有 revisions；status 回复输出；讨论日志与 capture 的离线交叉校验；保留作者/操作者/视角来源 | CLI/portable 输出、版本号、README、真实脱敏 fixtures；输入顺序无关、重复/分叉/混合视角与旧格式兼容 |
| **doubak-site-generator** | 消费统一字段和可选回复记录；可选本地讨论页、版本排版、公开过滤、完整性提示 | 不做列表/详情源裁决；页面、搜索、图片与数据输出统一过滤；无新字段时保持旧行为；说明两个独立发布开关 |
| **doubak-import-adapters** | bundle 导入/回传保留新的讨论日志与任务范围；旧爬虫没有回复时不制造零回复快照 | 原始字节与源时间不变；旧源详情只有正常样本及明确 URL 才映射；未知分类保留，不联网补抓 |
| **doubak-export-adapters** | 接受新增可选回复文件及广播 observation 信息，但不增加第三方平台的回复映射 | 既有 NeoDB/Letterboxd/Goodreads 输出条数与字段不被他人回复污染；README 说明范围 |
| **doubak-site-generator-sample** | 实现后从新版 parser/generator 重建，默认公开过滤；可选讨论演示使用脱敏 fixture | 不手改 HTML；不发布用户下载的原始第三方页面；记录生成版本和开关 |
| **doubak-website** | 实现发布时说明模式差异、本人/访问者视角、讨论范围与缺口；更新开发日志及 FAQ | 原“注销好友”日志保留历史事实并链接新实现；小组回复仍不支持，说明是阶段范围而非所有权不同 |
| **doubak-data-enricher** | 本题无运行时代码改动 | 不负责抓回复、补写广播或从网络判断作者；必要时更新职责说明 |

工作区 `CLAUDE.md` 与 extension README 的旧“社交外围一律排除”说明也应在实现时同步修订，
明确广播讨论是新增范围，小组回复仍未实现。本次设计只记录待调整处，不提前把未实现能力写成现状。

建议逐阶段提交：

1. **契约和证据：**先定义逐讨论枚举日志及单一修订摄取规则，补齐多页和楼中楼 fixture。
   topic 继续 unresolved；取得真实成功证据后独立补充设计，不阻塞已验证 status 路线。
2. **捕获闭环：**status 详情/顶层回复、讨论日志、三模式调度和三视角隔离一起验收；
   未支持分页必须报告 partial。没有完整终点证据的版本不能宣称“回复归档已完整实现”。
3. **离线解释：**parser 与 bundle/schema 校验、import/export 文件清单更新，完成离线重建和兼容测试。
4. **呈现：**generator 的讨论页与发布过滤，外部格式适配器兼容核对。
5. **集成发布：**运行 [`tools/sync-vendor.mjs`](../../tools/sync-vendor.mjs)，不直接改 vendor；
   Chrome/Firefox 演练通过后才更新 sample、website、版本和能力文档。

旧 bundle 不重写，新 parser 对缺少讨论日志的旧档案只能报告 unknown/not_captured，不能认定完整。
开放 intent 新值本身不要求 bundle major 变更；新日志的必需语义、文件完整性和旧读者行为由 specs 明确，
不能因为 JSON 接受附加字段就省略版本与校验升级。消费者的兼容更新先于对外启用新输出。

## 7. 测试与验收

### 7.1 模式 × 视角的九组最小端到端用例

每组都在相同 fixture 上比较**实际请求集合、所用基准、任务状态和导出 bundle**，
不是只断言 UI 选项或配置里的字符串。fixture 包含新根、已完成旧讨论、未完成旧讨论、
水位线以下旧根、同数编辑、0 回复省略文本以及受限页面。

| 用例 | 预期 |
| --- | --- |
| 增量 × self A | 复用 A 的 self floor；抓新讨论、补旧缺口；已完成且未发现变化的旧讨论不请求 |
| 刷新 × self A | 列表仍用 self floor；已知旧讨论即使未在本轮列表出现、回复数未变也请求 |
| 全量 × self A | 不用旧 floor/成功缓存；本轮列表、详情及已支持分页形成当前范围的新捕获 |
| 增量 × 登录 A 抓 B | 只复用 B/public/operator A；不会用 A/self、B/self 或 C 抓 B 的记录跳过请求 |
| 刷新 × 登录 A 抓 B | 只刷新同视角 B 的已知讨论；配置 user=A、author=B 仍正确归属 |
| 全量 × 登录 A 抓 B | 不跨 bundle 跳过，但仍仅 A 当前可见；不可见回复不推断删除 |
| 增量 × 匿名 B | 只用 B/public/anonymous 基准，请求无登录凭据；登录抓到的更多回复不授予完成资格 |
| 刷新 × 匿名 B | 只刷新匿名历史候选；匿名不可见内容保留缺口，不升级身份尝试读取 |
| 全量 × 匿名 B | 当前匿名范围全量；隐私截断、登录墙和未知终点不得写成全部覆盖 |

补充组合：输入自己 UID 自动 self；未登录访问本人主页仍 public；无基准、同 UID 改域名、public 缺 operator
都不能误复用下界；切换操作者/登录状态后无法继续原任务。相同 UID 的 self/public 混合离线解析，
每份字段证据仍须能追到原视角；公开视角的一次空/缺字段不能清空 self 历史，更不能把 self 私密字段漂白成公开。

### 7.2 抽取、恢复和数据语义回归

| 层面 | 场景 | 断言 |
| --- | --- | --- |
| 范围 | 2053249、作者自己写的省略号、显式全文但 0 回复 | 都不因标点或全文链接单独入队；不写 text_truncated=true |
| 范围 | 根 1 回复、引用内 155 回复、更多转发按钮 | 只抓根讨论；无来源广播、作者主页、关注/点赞/收藏请求 |
| topic | 只有列表 data-aid/链接，详情是 403 | 保留列表证据与 unresolved 原因；无猜测 parser/API/schema，无“已删除”判断 |
| 短链 | 用户给出的分享链接、卡片只有未知短链 | 不增加权限、不解析短链；能用验证过的直达链接则用，否则报告缺口 |
| 身份 | 芃芃 HTML author 与 user 不同 | 根归属正确；登录者不成为根作者 |
| 详情 | pubtime、3 星、合法空正文 | 时间与动作分离，评分准确；空正文不等于没有回复 |
| API | 200 登录 HTML、JSON 错误、空动态容器、真实零回复 | 错误/未请求/未知与 0 分开；写接口始终不入队 |
| 分页 | 多页、楼中楼预览、重复游标、跨页移动、折叠回复 | 真正的结构终点才完成；缺样本路径报不支持；去重且有限停止 |
| 增量 | 列表 advanced=true，旧讨论 partial | 下次仍补讨论，列表下界正常推进；不能依赖 route advanced 来发现讨论缺口 |
| 刷新 | 同数编辑、旧根不在增量列表、回复计数减少 | 所有已知讨论排队；变化留存，缺失不当删除 |
| 全量 | 移走全部旧 bundle 后解析本轮 bundle | 已捕获内容与范围报告一致，无历史字节依赖；不声称恢复已消失旧根 |
| 恢复 | WARC/index 已写但枚举日志/checkpoint 未写时崩溃 | 重建捕获和待派生任务；无证据的终点降为 unknown，不永久漏页 |
| 配额 | 限额中止且仍有未请求根，删除所有运行缓存再离线导出/解析 | bundle 可报告相同的 pending 根与 stop reason；不把 200 或其他阈值当完整终点 |
| 会话 | self 掉登录、public 换操作者、匿名转登录 | 暂停且保持原视角；没有新旧会话混合的完成证明 |
| 任务 | 暂停期间改模式/范围，升级旧断点 | 不能修改原任务契约；旧范围可验证才恢复，新路线下一轮启用 |
| canonical | 列表→详情→列表，字段等值或已证明摘要关系 | 单一 revisions，无交替假编辑；文本与 parts 一致，来源可追溯 |
| canonical | 更精确时间、缺失字段、未能判明的正文冲突 | 不降精度、不凭空清空；parser 输出确定结果和冲突诊断，generator 不裁决 |
| 回复 | 正文编辑、明确墓碑、单次不可见、父回复缺失 | 记录变化或 unknown；不虚构删除/父记录 |
| 发布 | 包含讨论/private 开关组合，混合来源 | 页面、搜索、图片和数据导出同样过滤；public capture 不自动等于内容 public |
| 兼容 | 旧 bundle 无讨论日志、旧 canonical、新可选回复文件 | unknown 不伪装完整；旧广播不丢；外部平台导出不增加他人内容 |

自动化 fixture 必须保持真实结构并脱敏；topic、非空楼中楼和多页终点不能用自造数据冒充线上协议证据。
落实各仓库相关单测与完整回归、specs schema/一致性校验、vendor 同步检查。
最终用同一份脱敏 bundle 比较 CLI 与扩展离线输出，Chrome/Firefox 各演练“新抓→中断→恢复→部分导出”。
报告实际请求数、去重回复数、逐讨论缺口和终点证据，不能只报覆盖率或测试总数。
本轮是文档修改，以上为实现验收要求，不表示这些新测试已经实现或运行。

## 8. 尚待验证与交付边界

已验证 status 正常 HTML、一个顶层回复首屏、作者隔离与时间版式；列表 topic 入口和短链落点只作研究证据。
尚需取得：顶层多页、非空楼中楼、旧 HTML 回复形态的成功样本；topic 正常内容与身份/接口证据；
真实浏览器中三种模式和三种视角的接口可访问性与恢复行为。

本文的讨论日志和 reply schema 是拟议契约；必须先通过 specs 审查与离线重建用例再启用抓取。
本轮只更新设计与 README，未修改运行时代码、schema、vendor、CLAUDE.md 或生成站点，也未向 issue 发评论。
