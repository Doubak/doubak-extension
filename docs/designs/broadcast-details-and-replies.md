# 广播详情与回复首屏快照（issue #26）

状态：首版已实现（main，尚未发布新扩展版本）。调查日期：2026-10-28；方案整理：2026-10-29；实施：2026-10-30。
需求：[extension issue #26](https://github.com/Doubak/doubak-extension/issues/26)。
最终范围：**方案 B 的轻量版本——本人账号可选的回复首屏原始快照**。
本文取代此前的完整讨论归档提案；此前讨论日志、回复 Canonical 和站点讨论页的论证保留在 Git 历史中，不是本轮实施要求。

## 1. 决策与第三方内容边界

首版增加默认关闭的“保存广播回复首屏”抓取选项。仅当目标 UID 等于当前登录 UID、
运行视角为 self，且用户明确开启时，才从本人广播的根回复按钮正数派生详情和首屏 API 任务。
每个根只请求一个逻辑首屏，不翻页、不展开楼中楼，不跟随回复者、引用广播或其他讨论。
既有有限失败重试另计，受同一个节流与会话守卫控制；“一个首屏”不是忽略风控继续重试的许可。

**档案目标、当前操作者和发言作者是三种身份。**备份他人账号时，该账号仍是档案目标，
但其回复采集不在本轮范围内。首版按下表执行：

| 内容 | 首版行为 |
| --- | --- |
| 自己发布的广播正文 | 沿用现有归档规则，不要求开启回复快照 |
| 别人在自己广播下的回复 | 仅 self 且明确开启时，保存接口首屏原始响应；不算作本人的创作 |
| 明确选择备份的他人账号所发布的内容 | 保持已有第三方账号抓取范围，仅保存当前访问视角可见的内容 |
| 他人账号广播下的其他人回复，包括操作者自己写的回复 | 首版不新增详情或评论 API 请求；不能因为其中有操作者发言而扩大采集范围 |
| 自己转发广播中的原作者、原讨论 | 只按自己的根卡片判断；引用来源不入队 |
| 自己在他人主帖下的回复 | 仍是本人 UGC，但没有可靠枚举入口；本轮不新增该能力 |

第三方账号下的回复、小组主帖回复、日记/长评留言仍不新增采集。
这是首版产品范围与维护成本的选择，不声称它们在内容性质上与本人广播下回复不同。
本轮只对“自己的广播周围的一份对话证据”做有限例外，不恢复关注关系等社交网络抓取。

原始 WARC 可能已经包含导航、引用、第三方资料及登录视角内容；
“不新增采集第三方账号回复”不等于保证原始页面完全没有第三方字节。
这些快照只进入原始档案，**不进入回复 Canonical、静态站点、搜索索引或外部平台导出**。
原始 WARC 也不能被描述成经过公开过滤的站点产物。

省略号不触发抓取、不作为截断判断；显式 `（全文）` 链接沿用已有处理。
topic 继续待调研，douc.cc 不新增权限或解析路线。首版不引入 `discussion-state.ndjson`、
`broadcast_replies.ndjson`、`detail_revisions` 或“包含讨论”展示开关。
这些能力如需恢复，要重新提出需求与设计，不能以“未来兼容”为由现在预留一整套实现。

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

## 4. 抓取开关、模式与账号视角

### 4.1 开关先于路线和模式生效

沿用 [`target-account.js`](../../src/crawl/target-account.js) 的身份取证与
[`run-context.js`](../../src/crawl/run-context.js) 的断点约束。
只有 `visibility=self`、`operatorMode=authenticated` 且 operator UID 等于 target UID，才能开启快照。
用户输入自己的 UID 或主页链接并不改变这个判据；未登录访问自己的主页仍为 public/anonymous。

| 访问方式 | 回复快照资格 | 原有抓取行为 |
| --- | --- | --- |
| 登录 A 抓 A | 默认关闭；用户可开启 | 三种模式仍按原定义处理广播、标记、长文等 |
| 登录 A 抓 B | 不支持，开关禁用且有效值为 false | 保持 B 的现有 public 抓取范围，不新增回复派生 |
| 匿名抓 B，包括匿名查看自己的主页 | 不支持，开关禁用且有效值为 false | 保持当前匿名可见范围，不尝试借登录态抓回复 |

UI 禁用不是唯一防线：runner 构造路线前校验选项，public 请求携带启用标志时拒绝该不兼容请求，
不能静默越界；历史 backlog、手动重试入口与恢复也执行相同约束。
开关关闭时，不排本功能的详情/API/旧候选补抓；已有快照保留，不删除，也不触发刷新。
只关闭当前任务的新采集，不改变已有广播正文归档和原始 bundle 导出。

### 4.2 三种模式（仅 self 且开关开启）

已核对 [`crawl-modes.js`](../../src/crawl/crawl-modes.js) 和
[`offscreen.js`](../../src/offscreen/offscreen.js)。保留现有模式语义，不设置统一的 30 天自动刷新周期。

| 行为 | 增量 incremental | 增量＋可变内容 refresh-editable | 全量 full |
| --- | --- | --- | --- |
| 广播列表 | 使用现有时间下界闭区间枚举 | 与普通增量相同 | 无历史下界，从头枚举当前可见范围 |
| 新发现有回复的本人根 | HTML 详情与 API 首屏独立入队 | 同左 | 同左，不用跨 bundle 成功缓存 |
| 历史候选没有成功首屏 | 从同账号 self 的旧列表离线补算并补抓 | 同左 | 只处理本轮重新发现的候选 |
| 已成功首屏 | 跳过，即使已知计数变化也不主动刷新；不承诺发现回复编辑 | 所有已知合格首屏重新请求，包括列表水位线以下候选 | 本轮重新发现的候选重新请求 |
| 已成功 HTML，首屏需要补抓或刷新 | 只请求首屏；HTML 缺失/失败才单独补抓 | 同左，不把不可变详情列入可变内容重抓 | 本轮重新保存 HTML 与首屏，保持新基准自足 |
| 曾有回复、现在计数为 0 | 不抹掉原快照；未成功的历史候选仍可补抓 | 刷新已知首屏，保留实际空结果及历史字节 | 保存本轮列表的 0；不单独触发新的回复快照 |
| 已存首屏内显示还有后续页或楼中楼 | 不补分页 | 只刷新首屏，不扩展范围 | 仍只请求首屏 |
| 省略号或仅有引用来源回复 | 不触发 | 不触发 | 不触发 |

HTML 和首屏分别记录是否成功，不能互相代替。首屏“成功”仅指本次预定响应已保存且分类器识别，
不表示整条讨论完整。若接口首屏包含内嵌 replies 预览，也只原样保存，不派生楼中楼任务。

普通增量的机会是首次捕获和补失败，刷新模式才重新观察已成功首屏。
历史候选只能来自同目标 UID/已核验域名、self 的合格档案；不拿 public 捕获授予 self 的已成功资格。
无合格列表基准时沿用现有显式退回无下界流程；历史候选补算与挑 floor 分开，避免遗漏旧失败。
显式 full 不借旧字节或注入本轮未发现的旧根；旧记录仍保留在原档案中，不据缺席推断删除。

### 4.3 候选、API 与网络边界

纯函数抽取本人根 sid、实际 status 详情 href、经验证的回复计数与父 capture。
只接受 owner UID 匹配的根回复按钮正数，排除引用、删除按钮、作品简介和“更多转发”。
计数缺失为 unknown，不能当 0，也不猜测有回复。候选有 topic 链接时保留列表证据并报告待支持，
不能将 data-aid 当成 status sid 或根据 403 页面编写 parser。

拟议路线：

| route / intent | 数据面 | 本轮请求范围 |
| --- | --- | --- |
| broadcast.item | html | 已验证的 status 独立详情页，首次捕获或补失败；沿用已有 intent |
| broadcast.comments_snapshot | api | 已验证 status sid 对应的评论首屏，固定 start=0、count=20；不跟随 next 或 replies |

第二个名称利用开放 intent 词表明确“首屏快照”语义；实现时在 specs 词表和摄取说明中登记，
不能复用一个暗示全量枚举的名称却不说明限制。这里只承诺接口当时返回的首屏，不保证其排序固定、
返回 20 条或包含某个指定朋友的发言。数量少也不推断完整，接口端的隐藏/折叠规则仍可能影响结果。

对已验证 status profile，端点为 `https://m.douban.com/rexxar/api/v2/status/<sid>/comments`。
列表可直接作为 HTML/API 两个任务的父捕获，API 不依赖本轮先取得详情；实际请求仍通过现有串行闸门。
首次保存 HTML 提供独立单页证据，不承诺原站脚本在离线回放中能自动加载评论。
API 错误或版本变化保留响应并报告失败，不自动改为遍历其他接口或反复抓 HTML 来探测。

评论路线显式 `withCk:false`；loop 尊重路线配置，如 `route.withCk ?? (route.surface === 'api')`，
不能用 `||` 覆盖 false。首屏 GET 不读取或拼入 ck，构造 URL 只允许已验证参数。
self 请求沿用该账号本机会话，withCk=false 不等于匿名。
现有 `withCkToken()` 对空值已有保护，不会生成 ck=undefined；修改针对的是不必要的默认令牌策略。
其他 API 的行为保持兼容，不全局关闭其 ck。

HTML 与 API 独立成功不意味着可绕过风控；任何会话失效、挑战、限流都按现有全局规则暂停。
不新增短链权限，不抓回复者头像/附件/主页，也不执行配置里的评论、删除或点赞写接口。

2026-10-30 用 1,118 张已归档的成功广播列表补核了候选提取：51 个唯一 status 根符合条件；
另见 3 个作品讨论入口、1 个日记入口及 1 个 topic 入口。日记/作品讨论的回应计数属于其
链接目标，不授予广播 sid 回复抓取资格，属于范围外而非缺口；topic 仍报告待支持。
此次核对只读取本地 WARC，没有重新向豆瓣请求页面。

### 4.4 原始存储、恢复与范围说明

首屏是单个派生叶子任务，使用现有 WARC、index、parent_capture_id、verdict 与 route gap 机制。
**不新增讨论状态文件，也不把回复树分页恢复引入 bundle 格式。**
API JSON 中的作者、text、replies 预览、计数与隐藏提示都按原始响应保存，不复制成新的评论实体。
index 的 intent 明确其首屏性质，实际 URL 保留 start/count，item_count 仅在有结构依据时记录。
一次首屏成功永远不能被解释为“该根所有回复已保存”。

开关是任务范围的一部分：在现有 crawl_scope 扩展中记录是否启用，并在 run context/checkpoint 中固化。
已登记扩展字段 `broadcast_reply_snapshot: true|false`，旧档案缺失表示未声明该能力，不表示零回复。
字段含义、开放词表新值和兼容校验需先补 specs 文档/用例，不预设某个 bundle 版本号，
也不能声称“完全不用改规范”。本方案无需新增 manifest 文件声明或讨论恢复 schema。

写入顺序保持响应 WARC → index → 既有任务状态/checkpoint，无候选预写日志。
从已存列表捕获或已声明的历史来源重算候选，用成功捕获集合消除已完成项；HTML/API 独立去重。
将“父列表已落盘、派生任务未 checkpoint”的窗口纳入现有 replay/backlog；不能因列表水位线已推进而永久漏掉首屏。
父来源 bundle 缺失时报告来源缺口，不把无法重算的范围描述成没有候选。
已被 index 确认的损坏继续报错，不为新路线增加另一套截断权威。

广播列表自身的 advanced 按原规则判断。详情/API 叶子没有全局时间下界，不用评论发表时间构造 floor；
其路线汇总保持 bounded、advanced=false，缺失败响应或预算未执行项要在现有 gap/范围说明中可见。
这里报告的是“计划首屏是否捕获”，不是“讨论是否连续枚举”。
若现有 gap 字段不足以表达一个停止原因，先在 specs 的既有扩展机制中明确语义，不能悄悄藏进运行数据库。

有预算/取消/风控时可以停止，但不能报“全部快照完成”。已收尾 manifest 和源捕获支持离线范围说明；
未收尾档案只报告已确认的响应与未知范围，不编造从未落盘的精确停止原因。
原始导出仍携带捕获字节，现有 importer/exporter/recovery 无需新增 discussion-state 专用处理。
这不是零工程量：新路线仍须通过捕获校验、恢复、范围说明与跨版本测试。

### 4.5 开关与断点的用户体验

抓取设置提供“保存广播回复首屏”，不是导出页的“包含讨论”。初次显示默认关闭。
仅 self 可以操作；切换目标或访问视角时清除选择，不继承 A 的勾选到 B。
同一面板会话、同一 self 目标内切换三种模式可保留显式选择；重开面板恢复默认关闭。
后台再次校验资格，不能只依靠控件 disabled。

运行开始时冻结模式、开关、目标、视角和操作者。恢复旧任务不读取当前面板选择，
升级前未启用的旧断点不插入新路线。self 掉登录或换号时暂停，不能退化为 public 继续抓首屏。
修改原任务的范围要结束原任务后新建；普通恢复不重复已完成的首屏。

界面展示“首屏快照已保存 N / 失败 M”，同时注明“不翻页、不展开楼中楼、不加入生成站点”。
public 显示“首版仅支持本人账号”，这不是说第三方主页已抓完或没有回复。
具体控件与导出边界同步于 [docs/ui.md](../ui.md)。

## 5. Canonical、公开展示与未来工作

### 5.1 广播正文仍走原有规范化路径

HTML 详情如需摄取，使用专用抽取函数处理 pubtime、动作、评分和根身份，归一到广播既有 revisions。
等值字段只增加 observation，缺字段不清空已有值；不同展示面的差异不自动当成用户编辑。
来源关系无法证明时保留原始响应并报告冲突，不按文本长度猜全文，不移植作品页短评。
该项是对本人广播正文的解析增强，不需要新增评论实体或 detail_revisions。

### 5.2 第三方回复只保留原始证据

首屏 JSON 不生成 broadcast_replies.ndjson；顶层 comments 与内嵌 replies 都不进入 Canonical 的个人事件流。
首屏原样保留作者信息不代表内容属于档案主人，parser 也不能将其 text 合并进广播正文、标记短评或动作。
现有结构化数据导出、NeoDB、Letterboxd、Goodreads 保持原范围，不宣称其中已经包含回复快照。

生成器不新增讨论页、讨论开关或搜索内容。若以后显示原页回应数，只能是有来源依据的纯文本，
不产生不存在的本地讨论链接，也不回退到豆瓣 API 或在线页面作为“查看已归档回复”的入口。
原始 bundle 与生成站点是两种产物：前者可能包含第三方和登录视角内容，不能当作已过滤的公开站点直接发布。

完整分页、楼中楼、评论 Canonical、版本归并、站点讨论展示，以及第三方账号下的回复采集均暂缓。
“以后可以重解析已经保存的 JSON”不意味着现在能恢复没有抓到的后续页，也不是未来一定实现的承诺。

## 6. 各仓库的改动

| 仓库 | 首版改动与不变边界 |
| --- | --- |
| **doubak-data-specs** | 登记首屏 intent、crawl_scope 开关及捕获/缺口语义，验证旧格式兼容；不新增讨论状态文件、回复实体或平行 revisions |
| **doubak-extension** | self-only 默认关闭开关、后台资格检查、两个独立派生叶子、按模式跳过/刷新、历史补抓/replay、withCk=false、范围报告；README/DESIGN/UI 文案与 vendor 同步 |
| **doubak-data-parser** | 对首屏捕获保留可追溯范围报告，不输出回复 Canonical；如摄取 HTML 详情则归一到现有广播；未知 intent 兼容测试 |
| **doubak-site-generator** | 不新增讨论呈现或参数；检查原始回复不进入正文、搜索或旁路 JSON；如消费详情增强字段则保持原来源语义 |
| **doubak-import-adapters** | 原始 bundle/未知 intent 保留；旧源缺少首屏不制造零回复观测；不新增网络采集或回复模型 |
| **doubak-export-adapters** | 不增加回复映射，验证新增原始捕获不会污染既有外部格式输出 |
| **doubak-site-generator-sample** | 无需为回复快照重新生成或发布；只有独立的广播正文解析改进才触发相关重建 |
| **doubak-website** | 功能实现后说明默认关闭、self-only、首屏范围、模式差异与仅在原始档案保存；不宣传完整讨论备份 |
| **doubak-data-enricher** | 无代码改动，不承担回复采集或跨来源补写 |

实现时同步修订 CLAUDE.md 的旧范围说明：允许用户选择保存本人广播下的首屏对话证据，
不把它描述为全面恢复社交外围，也不提前把未实现功能写成现状。
首版已按规范、抓取核心、面板与运行范围、解析隔离及回归测试分步提交。
HTML 详情目前仅保留原始证据，不增强 Canonical；解析器通过 `stats.rawOnlyCaptures`
报告两种捕获的编号、intent、verdict 与首屏/HTML 范围。
回复 JSON 没有可信导航栏，不对用户正文运行 HTML 会话检测；登录 Cookie 变化会暂停
已开启此功能的任务，恢复仍执行原账号握手。API 错误响应沿用全局暂停机制。

## 7. 验收要求

### 7.1 三种模式 × 三种视角

| 用例 | 预期 |
| --- | --- |
| 增量 × self A | 开关关则无新路线；开启后抓新候选、补未成功首屏，跳过已成功 HTML/API |
| 刷新 × self A | 开关开启后直接刷新所有已知合格首屏；不重抓成功 HTML、不翻页 |
| 全量 × self A | 开关开启后从本轮列表发现候选，新抓 HTML 与一个首屏，不借旧字节 |
| 增量 × 登录 A 抓 B | 仅原有 public 增量；无首屏 API 或本功能新增详情请求 |
| 刷新 × 登录 A 抓 B | 仅刷新原有范围；不给 B 的讨论建候选，即使本地已有别人导入的快照 |
| 全量 × 登录 A 抓 B | 仅当前原有 public 范围，不因 full 扩大到回复 |
| 增量 × 匿名 B | 无回复快照，不能复用 self 勾选或成功缓存 |
| 刷新 × 匿名 B | 无回复快照，不尝试登录升级以取得回复 |
| 全量 × 匿名 B | 无回复快照，匿名访问自己的主页也不能绕过 self-only 条件 |

### 7.2 关键回归与交付检查

- 身份：输入自己 UID 正确得到 self；配置 user/author 不同不误归属；public 注入启用参数被拒绝。
- 范围：本人根 1 回复、引用内 155 回复时只派生本人根；省略号、未知计数、topic、短链不扩大请求集合。
- 首屏：接口显示还有后续页或内嵌 replies，也只保存该响应；无 next、楼中楼、作者主页或附件请求。
- 模式：普通增量已成功首屏不因计数变化自动刷新；刷新模式只刷新 API；full 新捕获两者；开关关闭不补旧任务。
- 传输：新路线显式 false 不被默认覆盖，不调用 getCk、不拼 ck；旧 API 策略保持；错误与风控沿用既有处理。
- 恢复：列表已提交/子任务未 checkpoint、首屏 index 已写/checkpoint 未写、预算中止、旧任务升级，均无静默永久漏抓或范围漂移。
- 离线：移走运行缓存后仍能读取原始首屏和已持久化缺口；缺历史来源则报告依赖缺口；未收尾精确原因未知不编造。
- 归属与导出：第三方姓名/正文仅在原始响应，不进入个人 Canonical、生成页、搜索或外部平台导出；不开启公开讨论入口。
- UI：默认关闭；A→B 清除勾选并禁用；B→A 不自动开启；同 self 目标切模式保留选择；恢复用原任务参数。
- 兼容：新原始 intent/范围字段可被保留；旧 bundle 不被认为含首屏；不新增 discussion-state 文件或回复 schema。

使用实测结构的脱敏 fixture，核对实际请求集合与输出字段，不只测试配置字符串。
相关仓库运行相应单测和回归、specs 一致性检查、vendor 同步检查，Chrome/Firefox 各验证开启、关闭与恢复。
已落地的自动化验证见 `test/broadcast-snapshots.test.js`、
`test/broadcast-snapshot-runner.test.js`、`test/public-crawl.test.js`、
`test/multi-account-ui.test.js` 与 parser 的 `test/broadcast-raw-snapshots.test.js`。
包括实际请求集合、WARC 导入/导出逐字节往返、页面/搜索/平台输出不变，以及列表/首屏
已提交而 checkpoint 落后的崩溃窗口。Firefox 无头工具已检查面板布局。
这些测试使用脱敏结构与模拟传输，不能替代真实登录会话的接口兼容性验证。

2026-10-30 验证记录：扩展完整套件 2,209 通过、0 失败、1 跳过（Node 24.18 的
DecompressionStream 行为差异）；parser 321 通过、0 失败、1 跳过（缺少既有相册/小组样本）。
Bundle validator 含 JSON Schema 层与新增 scope 契约用例均通过。
针对本功能的测试中 `broadcast-snapshots.js` 行覆盖率 100%、分支覆盖率 90.91%，
`snapshot-session-change.js` 行与分支均 100%；这是指定模块口径，不是全项目覆盖率。
两个浏览器的安装包均已在本地成功生成，没有增加 host permissions。

## 8. 尚未解决的证据与交付边界

已验证 status 详情、一个评论首屏、作者隔离与 pubtime 版式。topic 正常页面未取得，继续待调研。
首屏之外的分页和楼中楼不再是首版实施前置条件，也不能据本次单条回复样本宣称所有接口形态均支持。
仍需浏览器实测 self 会话下首屏可访问性、分类器漂移、实际节流与崩溃恢复。

本轮更新 specs、extension、parser 及共享 vendor、文档和开发日志。没有新增回复模型，
没有重建或发布样张站点，没有发布扩展版本，也没有关闭或评论 issue。
真实登录会话的 Chrome/Firefox 抓取验证仍作为发布前人工检查，不在自动化测试通过后宣称已完成。


### 2026-10-30 实测修正：回复 API 缺少 Referer

用户报告 51 个 `broadcast.comments_snapshot` 全部 `unclassified: unexpected_status`。
旧导出不含这些失败响应，不能据此确认全部 HTTP 状态；但从其中一个相同 URL
（status `2181605815`，`start=0&count=20`）进行了无 Cookie、无 ck 的单变量复现：

| 请求 Referer | HTTP | 响应 |
| --- | --- | --- |
| 无 | 400 | JSON `code: 1287`、`msg: invalid_request_1284` |
| 对应桌面 status 详情页 | 200 | `start: 0, count: 20, total: 1` |
| `https://www.douban.com/` | 200 | 同形状首屏 JSON |

三次均无重定向。故这个可复现故障是缺请求头，不是曾修过的移动版重定向。
`item.referer` 仅生成内部 `X-Override-Referer`，旧 DNR 规则只匹配 doubanio 图片，
没有把回复请求的标记转成真实 Referer。这是此前模拟传输测试遗漏的浏览器边界。

修正：复用现有权限，新增独立的 DNR 会话规则，固定站点级 Referer，删除内部标记头；
只匹配 status comments 接口、`xmlhttprequest`、`tabIds: [-1]`。安装与更新时先删后加，
不影响用户标签页，不增加抓取范围、ck、分页或自动重试。继续保留现有节流。
分类失败仍记录 `unexpected_status`，但失败列表同时显示 HTTP 状态与有限的 API
机器错误码；响应原文照常保存在 WARC。非分页失败文案不再把回复接口称作作品页。

更新扩展并重新加载后，在当前任务选择「继续，并重试」；仅「继续」不重置失败条目。
已经收尾的任务可用开启同一选项的新增量补抓，成功的 HTML/API 仍跳过。
本次在线探测是无登录 HTTP 对照，不替代 Chrome/Firefox 实际扩展会话验证。

修正后验证：扩展完整套件 2,212 通过、0 失败、1 个既有跳过；覆盖 DNR 的域名/路径/
标签页边界、规则重装、HTTP 400 错误经 checkpoint 与 WARC 保留、无自动重试。
Chrome/Firefox 本地解包目录已重新生成。
