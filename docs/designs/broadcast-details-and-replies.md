# 广播详情与回复归档（issue #26）

状态：设计提案，尚未实现。调查日期：2026-10-28；方案整理：2026-10-29。
需求：[extension issue #26](https://github.com/Doubak/doubak-extension/issues/26)。
范围：广播列表发现、详情 HTML、回复与楼中楼响应的归档，以及下游离线解析和呈现。
本文中的新路线、字段和界面均为拟议设计，不代表当前版本已经支持。

## 1. 本轮决定

**有回复的广播需要抓详情，并保存实际承载回复的响应。仅保存详情 HTML 不足以完成回复备份。**

按本轮用户反馈，**正文以 `...`、`…` 等省略号结尾，不再作为详情抓取条件**，
包括旧档案补抓。实测 `book/2053249` 对应广播的详情仍是同一段省略文本，不能承诺补全。
因回复而取得的详情正文可以留存，但不拿作品页短评补写广播，也不凭省略号断言正文被截断。
既有 `（全文）` 链接继续按现有 `full_text_url` / 长文关联处理，本设计不增加对这类链接的泛化爬取。

自动发现以**目标账号本人广播卡片的回复按钮及数量**为依据，支持实际链接所指向的
`/people/:uid-or-name/status/:sid/`、`/topic/:topic_id/`，以及 `douc.cc` 跳转。
不按“文字动态一定是 topic、标记动态一定是 status”来拼 URL；这只是当前样本的常见形态。
不递归抓转发来源的整条讨论，不抓点赞、收藏、转发者列表，不访问回复者的主页。

捕获目标讨论中的第三方回复，属于本轮明确增加的归档范围；回复作者必须独立记录，
不能变成档案主人的发言。原始归档与公开站点的发布范围分开处理。

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
| 文本末尾为 `...` 或 `…` | 43 | 仅说明样本形态；**不触发抓取** |
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
因此它应成为“**不因省略号入队**”的回归样本。

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

## 4. 抓取方案

### 4.1 发现、身份与路线

新增纯函数 `extractBroadcastDetailCandidates(html, ownerUid)`，在线派生和旧档案扫描共用。
返回根 sid、已验证的 topic ID（如有）、详情 href、回复计数和来源信息。
切片必须以根卡片为边界，并验证按钮属于该根；不能仅在 wrapper 后半段搜索任意 `回应`。

自动入队条件是**根卡片已确认的回复数大于 0**。缺失计数为 unknown，不能转成 0；
若识别到回复按钮但计数结构未知，记录诊断以便更新解析器，不静默声称已覆盖。
`...`、显式全文链接、转发来源有回复、点赞数、收藏数均不能单独触发本路线。
保留手动指定某条已验证广播进行补抓的扩展点，不能由此扩展成任意 URL 爬虫。

拟议路线如下，均属于 `data`，保存用户讨论证据，不能进入可丢弃的 `catalog-*`：

| route / intent | surface | 派生关系 | 成功的最低条件 |
| --- | --- | --- | --- |
| `broadcast.item` | html | 本人广播列表 → 详情 | 根身份与候选吻合，识别正常详情框架及作者 |
| `broadcast.comments` | api，旧版可为 html | 详情 → 顶层回复分页 | 符合已验证响应结构，父资源确定，分页状态可读 |
| `broadcast.comment_replies` | api | 顶层回复 → 楼中楼分页 | 父回复 ID 确定，响应结构与分页协议已实测 |
| `redirect.shortlink` | html / 实际响应类型 | 候选短链 → 已验证详情落点 | 只记录实际可见的响应与解析结果，不伪造中间跳转 |

`broadcast.item` 内分 status 和 topic 两种 profile，不为相同业务拆出两份广播记录。
status 以根 `data-sid`、作者 UID、URL 和配置 target 交叉核验。
topic 以候选 `data-aid`、详情资源 ID、作者及页面实际配置核验；sid → topic 的映射必须由列表
或详情证据支持，不能拿 topic ID 冒充 sid，也不能从 status 的模板变量名推断 topic API。
根身份冲突、未知版式或跳到首页不能判 ok；403、登录页、风控页按现有规则保存响应并处理。

对用户下载样本这样的第三方页面，公开归档目标为 `162998492` 时才属于其本人广播。
登录操作者 `82160871` 不改变内容所有权。备份 `82160871` 时，不因该文件包含登录者信息而吸收它。

### 4.2 回复分页与完整性

新 status 页面已证明需要读取 `_COMMENTS_CONFIG` 并请求 JSON；旧 HTML 若直接包含回复，
应按经实测的旧版结构抽取并跟随实际分页链接。空 `#comments` 加动态配置表示“尚未请求”，不是“无回复”。

配置抽取仅解析受限的数据字面量，禁止 `eval`、执行远程脚本或任意配置 URL。
读取 API 限定为已验证的 Douban 主机与路径，父资源 ID 必须匹配；只做 GET。
`allowComment`、`create_comment`、`delete_comment`、`react` 不在归档路线内。
沿用目标账号、操作者、self/public 视角、节流与会话守卫；不要为新接口另建一套不受控 fetch。
`route.surface === 'api'` 目前会启用现有 `withCk` 路径，实施前需确认该读接口是否需要它，
不能因为别的 API 需要令牌而机械复制；日志、fixture 和文档均不得带会话令牌。

顶层响应保存 `start/count/num/total/all_total`、可见性提示及所见回复 ID 集合。
多页协议以正常浏览器实测为准：当前只确认首屏 `start=0,count=20`，不能假定所有 profile 都按 20 递增。
如果实际协议采用 offset，按协议的分页步长前进，不能按跨页去重后的条数计算 offset。
若采用 next URL / cursor，保存并验证它；无论哪种方式，都检测重复游标、重复页与无进展。

楼中楼 `replies` 可能只是预览；比较 `total_replies` 与已见 ID，存在未展开内容时调用已验证的
`getReplies` 读取路线。只有单条 `ref_comment` 的引用文本，不等于保存了整个父讨论。
根评论、内嵌预览、楼中楼分页按同一回复 ID 去重；保留 parent ID 与引用关系，允许父回复缺失。

完整性按**每个讨论、每次读取视角**记录：`not_requested`、`partial`、`complete_visible`、
`unavailable` 或 `unknown`（拟议词表）。其中：

- `complete_visible` 仅表示此次请求走到了已验证的可见分页终点，并完成所见楼中楼；
  不声称所有用户、所有历史回复都已抓到。
- `hidden_nonfriend_comments`、折叠/审核提示等必须保留；不能用 `all_total` 强推当前可见数。
- 回复在分页过程中新增或删除，可能造成重复、移动和计数不一致；去重后仍有缺口应报 partial，
  不循环重抓直到数字凑齐，也不因计数下降而删除旧回复。
- API 返回 HTML 登录页、JSON 错误、异常空页、请求失败、预算耗尽，都不能写成“0 条回复”。
- 详情正文抓取成功与回复抓取成功分别统计；详情 200 不能让整个讨论显示已完成。

### 4.3 历史补抓、刷新与恢复

启动时从**同 UID、同视角及符合现有操作者隔离规则**的已存 ok 列表捕获离线重算候选。
不请求旧列表页，不重设广播水位线。每个 sid 保留最新可读卡片，也保留“曾经回复数大于 0”的证据：
后来计数变成 0 不能抹掉尚未补抓过的候选。调研中的 52 是最新状态的规模估算，实际历史并集可能更大。
派生 capture 的 `parent_capture_id` 可以指向旧 bundle；跨 bundle 父证据丢失时，明确报告来源缺口。

“已成功抓过 URL”不能永久阻止回复刷新，因为同样的回复数也可能发生编辑或一增一删。
第一版建议采用以下可调整策略，并在任务开始时固化为本轮配置：

1. 优先补抓从未成功读取、曾中断或有新列表证据显示回复数变化的讨论。
2. 本轮新看到的有回复广播检查最近成功快照；超过 30 天则刷新。历史已知候选也按同样规则到期轮转，
   因此水位线以下讨论无需靠列表再次出现才能刷新；用户可显式刷新全部已知讨论。
3. 第一版默认每轮最多 200 个详情/回复数据请求，未知与失败重试也计入预算；队列按未完成优先、
   上次成功时间从旧到新稳定排序。预算只是运行上限，未处理项持久化并标为 partial，下轮继续。
4. 单次运行内按讨论身份、视角和分页位置去重；跨运行的刷新有独立任务身份，不受静态资源
   `capturedAssets` 的永久去重约束。不能把“存在任何一次成功页”当成“本次讨论完整”。

30 天和 200 请求是设计起点，需按浏览器实测调整；这不是“实时同步回复”的承诺。
一个以前计数为 0 的旧广播，如果此后从未再出现在已抓列表里，其新增回复仍不可发现。
应在抓取范围说明里交代这种增量边界；需要时由用户发起全量列表发现，不能暗中无限回扫。

将详情、回复、楼中楼纳入 frontier、checkpoint、run-store 和 replay；升级恢复旧任务时沿用旧任务
范围，不把新功能偷偷插入旧断点，新一轮再启动补抓。保存 WARC/index 后才推进派生状态；
在“页面已落盘、子任务还未 checkpoint”窗口崩溃，也必须能恢复派生，不能漏掉回复页。
新增路线按不可替代数据优先级调度，沿用全局请求闸门、暂停、取消、退避与限流处理。

### 4.4 短链与权限的实现边界

能从同卡片取得验证过的直达详情链接时直接用它；只有短链时才解析 `douc.cc`。
新增精确的 `https://douc.cc/*` host 权限并更新权限说明、权限丢失处理及 Firefox manifest 生成测试。
`m.douban.com` 已在现有 `*.douban.com` 权限范围内。

初版采用现有浏览器 `follow` 传输：保存原请求 URL、实际最终 URL、最终响应和父候选关系，
明确标注只观察到端点。`redirect.shortlink` 的规范描述需同步说明：逐跳响应可读时保存真实响应，
不可读时不能伪造 302 WARC，也不能宣称已保存完整跳转链。以返回的正文身份验证最终资源，
建立短链 → 资源别名；不把最终 HTML 误标成短链自身的正文。解析器须能消费这类详情落点。

目前 follow 只能事后核对最终 URL，不能声称逐跳都经过请求闸门或域名检查。
不为仅保存端点默认增加 `webRequest` 权限；若实施决定要求逐跳头部，需单独完成 Chrome / Firefox
观察能力与最小权限测试。即使 `onBeforeRedirect` 能看到跳转头，也不等于拿到了 3xx 正文。
未知落点、循环、网络失败、权限不足或风控保留缺口，不转为成功详情，不反复自动解析。

## 5. canonical 与离线呈现

### 5.1 详情不能制造广播“编辑历史”

建议在 `broadcasts.ndjson` 的同一 sid 记录下增加可选的 `detail_revisions`，
采用现有 `fields/digests/observations` 骨架，并在字段中记录 `resource: {kind,id}`、
标题、正文、文本分段、作者、发布时间、可见性和正文完整性证据。
同 sid 的列表 `revisions` 与详情 `detail_revisions` **分开归并**；列表摘要 → 详情 → 列表摘要
不能因此制造三次用户修改。详情内真实变化保留，但叫“详情观测版本”，没有上游编辑时间就不编造编辑事件。

省略号本身不改变 `text_truncated`，也不证明完整。详情为全文、仍截断或未知，必须有页面证据；
本例 1317888615 可如实保留与列表相同的文本。列表的 `full_text_url` 继续指向原有内容来源，
不强制改为 status 详情 URL。`posted_at` 取上游时间；`observed_at` 取捕获时间，不能互相回填。
旧数据的 `text_truncated=false` 只表示现有抽取器没识别出显式全文链接，不可升级解释为“正文已确认完整”。
详情未展示的列表字段使用既有 omitted/unknown 语义，不能以 null 清掉列表评分或动作。

站点默认仍展示一条广播事件。若详情有可验证的更完整正文，使用详情并保留对应 provenance；
更晚的列表摘要不能覆盖它。列表和详情实质冲突时保留两份可展开的来源观测，不按“文本更长”武断选择，
也不移植原页短评。旧 canonical 缺少 `detail_revisions` 时沿用原有显示。
完整性和来源选择应由 generator 的共享投影完成，月页与作品时间线使用同一结果。

### 5.2 回复是独立记录

新增可选输出 `broadcast_replies.ndjson`，不把整个回复数组加入广播正文的 digest。
拟议记录结构：

```text
account: 档案归属 UID（不是回复作者）
thread: {kind: status|topic, upstream_id: 上游讨论资源 ID}
broadcast_id: 已有证据映射到的列表 sid（未知时不猜）
upstream_id: 上游回复 ID，统一字符串
identity_layer: upstream_id
revisions: [{fields, digests, observations, parser_version, ...}]
fields: {author, text, text_parts, posted_at, parent_reply_id,
         referenced_reply, visibility, deletion_state, ...}
```

回复主键为 `(account UID, thread kind, thread ID, reply ID)`；不要假定 topic 与 status 回复 ID 全局共用空间。
根记录缺失时仍可保存有证据的回复，不伪造空广播。无法取得稳定回复 ID 时保存原始响应和解析诊断，
不按正文 hash 合并不同作者的同文回复。作者注销后的占位状态与原先作者资料都保留观测。

增量的点赞数、计数、抓取状态放到单独的讨论观测集合（建议顶层 `interaction_observations`），
含 capture 引用、计数、已见回复 ID 和本次覆盖范围，不让计数变化变成用户正文修订。
`is_deleted` 等明确的上游墓碑可以记录；一次列表未出现、计数下降、页面不可见都不能推断删除。
回复间的先后以有精度的上游时间和稳定 ID 排序；抓取时间只用来排列同一回复的观测版本。

新 schema、摘要覆盖校验器与 forward-compat 用例必须一起更新；明确 `detail_revisions` 同样需要摘要校验。
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

## 6. 各仓库的具体改动与落地顺序

| 仓库 | 必需改动 | 验证与文档 |
| --- | --- | --- |
| **doubak-data-specs** | 明确 `broadcast.item` 双页面形态；补充 replies intents、讨论身份与可见覆盖语义；新增回复 schema 和可选详情/讨论观测字段；澄清短链端点与逐跳捕获区别 | 更新 `canonical/IDENTITY.md`、`FIELDS.md`、`INGESTION.md`、schema/validator、bundle 词表与短链说明；补一致性/前向兼容用例 |
| **doubak-extension** | 新增候选纯函数和双 profile；详情/API/分页派生；历史 backlog、到期刷新、任务预算、恢复；短链权限和别名；讨论级覆盖报告；导出开关 | 改 `routes/classifier/loop/backlog/runner/replay/run-store` 及 offscreen 接缝；更新 `README`、`DESIGN.md`、`docs/ui.md`、`docs/permissions.md`、中英文界面文案；正常生成 Firefox manifest |
| **doubak-data-parser** | 专用详情抽取；status/topic/API dispatch；作者与操作者分离；sid ↔ thread 映射；详情、回复与覆盖观测独立归并；支持短链 final_url 落点 | 更新 `parse.js`、portable/CLI 输出与输出清单、schema 版本；脱敏真实 fixture、乱序/重复/分叉重建；README 描述新可选文件及第三方内容边界 |
| **doubak-site-generator** | loader 接受缺省或新增回复文件；统一广播正文投影；可选本地讨论页、回复层级与版本；发布过滤；稳定本地链接与搜索 | 月页、作品页共用选择逻辑；无新字段时旧输出不变；README/CLI/Markdown 导出参数说明；不回退成联网读取 |
| **doubak-import-adapters** | 既有列表导入无须新增网络请求；若旧源确有详情/回复文件，只有识别实际 URL 与来源后才映射新 intent；否则继续保留原始内容 | 检查未知分类保留、捕获时间和原字节；文档明确旧档案无回复并不代表当时没有回复；不制造零回复快照 |
| **doubak-export-adapters** | 不增加回复的外部平台映射；验证新 canonical 可选字段/文件不会被误认成标记或破坏旧导出 | 新旧 fixture 的既有导出数量与字段一致；如 loader 拒绝未知可选文件则修兼容，README 写明回复未导出 |
| **doubak-site-generator-sample** | 实现验收后用新版 parser + generator 重建，默认仍用公开过滤；用脱敏 fixture 展示可选讨论样例 | 不手改生成 HTML；README 标明生成版本与范围；不直接发布本次下载的第三方页面或回复数据 |
| **doubak-website** | 实现发布时写开发日志，解释回复为何需要 API、详情仍可能省略、增量发现边界和公开导出选择 | 更新日志索引/首页入口、功能与 FAQ；旧注销好友日志保留当时事实，追加“后续实现”链接；本次不宣称功能已发布 |
| **doubak-data-enricher** | 本功能无运行时代码改动；不承担抓回复、网络回填正文或归属推断 | 如职责说明涉及本题，注明由 extension 捕获、parser 离线解析，避免重复实现 |

建议按以下阶段提交，每阶段独立可审查：

1. **证据与契约：**补齐 topic 正常页、顶层多页、非空楼中楼、旧 HTML 回复版式的脱敏样本；
   落地 specs 与兼容用例。没有样本的 profile 明确报 unsupported/unknown，不用猜测选择器上线。
2. **原始捕获闭环：**extension 实现候选 → 详情 → 回复/楼中楼 → WARC；先验证预算、断点和补抓。
   短链与 topic 可以分提交，但缺失的入口必须可见地报告，不能把部分完成称为 issue 全部解决。
3. **离线解释：**parser 增加详情、回复模型和输出；旧 bundle 重解析不得丢已有广播。
4. **可选阅读：**generator 增加讨论页与过滤，export/import 做兼容核对。
5. **集成与发布：**通过 [`tools/sync-vendor.mjs`](../../tools/sync-vendor.mjs) 同步共享源码，
   不直接修改 `src/vendor/`；扩展 UI 接入，完成 Chrome/Firefox 演练，再更新 sample、website 和版本文档。

仅增加开放 intent 不必修改旧 bundle 字节；若新增持久化调度/覆盖字段，按实际兼容需求选择 bundle
minor 或内部 checkpoint 版本。旧档案、新 parser 的组合必须可用；旧 parser 至少仍能处理既有列表，
不把新 route 的零输出当成“用户没有回复”。新 canonical 的消费者升级顺序先于对外启用新输出。

## 7. 测试与验收

实现时优先增加以下行为测试，而非只断言源码里出现了路线名：

| 层面 | 场景 | 必须成立的断言 |
| --- | --- | --- |
| 候选 | 2053249 的 0 回复、省略正文；显式全文但 0 回复 | 不排详情任务；不把省略号改成已证实截断 |
| 候选 | 普通广播有回复、topic 无 showComments 属性 | 均从所属卡片的实际 href 入队，准确区分 sid 和 topic ID |
| 候选 | 本人转发 1 回复，引用内另有 155 回复 | 只抓本人根讨论；引用来源与删除按钮不触发派生 |
| 身份 | 芃芃页面中作者与登录者不同；账号改用户名 | 按 UID 核对目标；别名有证据才合并；不能摄取操作者为作者 |
| 详情 | `.pubtime`、评分与空正文；两个 URL profile | 日期和动作分别解析；3 星不变；合法空正文可成功，但不据此推断零回复 |
| API | 空容器 + 动态配置、200 HTML 登录页、JSON 错误 | 未请求/失败与真正空数组严格区分；不执行配置中的写接口 |
| 分页 | 多页、首屏嵌入 replies 预览、非空楼中楼 | 完成真实分页；回复去重；没有截断预览冒充全部 |
| 分页 | 回复移动/删除、重复页、循环 cursor、隐藏或折叠回复 | 有限停止，覆盖范围如实；不依据数量下降制造删除 |
| 短链 | 给定 douc.cc 样本、带跟踪参数、身份不符/未知落点 | 保存请求与落点证据；验证后去重；不能伪造逐跳响应 |
| 增量 | 旧水位线以下 1 回复候选，已有部分详情捕获 | 从本地 WARC 补算；不重抓旧列表；不能因详情已抓而跳过回复 |
| 刷新 | 回复数不变但内容变化；旧候选最新计数为 0 | 到期/手动刷新能保留变化；历史正数候选不会直接被抹掉 |
| 恢复 | 各父响应落盘后、子任务 checkpoint 前崩溃 | 恢复无永久缺页；重复捕获不重复生成逻辑回复 |
| 运行边界 | 预算耗尽、取消、掉登录、换目标/操作者、旧任务升级恢复 | pending 不丢；partial 不伪装 complete；身份与原任务范围不漂移 |
| canonical | 列表→详情→列表、乱序文件、重复/分叉 bundle | 相同逻辑输出；不制造交替正文修订；每个字段都有正确出处 |
| canonical | 回复编辑、明确墓碑、单次不可见、父回复缺失 | 保存变化或 unknown；无凭空删除，无伪造父记录 |
| 生成器 | 旧 canonical；新讨论开关关/开；private 开关组合 | 旧行为兼容；仅显式开启才展示讨论；搜索、图片、链接同样受过滤 |
| 导入/导出 | 旧导入数据缺回复；新 canonical 含第三方回复 | 不新增伪零观测，不污染既有外部平台导出 |

自动化测试 fixture 应保留本次发现的真实结构，但替换姓名、正文、操作者资料及会话字段；
普通省略号与实际省略样本都要覆盖。topic/多页/楼中楼在取得正常响应后再制作测试，
不能用自造 fixture 宣称其线上协议已验证。

各仓库运行对应单测与完整回归；specs 运行 schema 自检和一致性用例；vendor 同步检查不可省略。
最终用同一份脱敏 bundle 比较 CLI 与扩展离线导出结果，并在 Chrome、Firefox 各演练一次
“新抓取 → 部分分页 → 暂停/恢复 → 导出”，包括权限丢失与短链真实浏览器行为。
验收数据应列出请求数、讨论数、回复去重数、partial 原因和正常终点，不能只报测试总数或行覆盖率。

## 8. 尚待验证与本轮交付

当前可确定 status 的详情、首屏回复 GET、作者隔离和时间版式；可确定列表内 topic 的另一种入口，
以及用户给定短链的 302 落点。以下不应在实施时被默认为已解决：

- topic 正常详情及其 API/分页配置：本次两个在线示例返回 403，下载样本是 status。
- 顶层回复多页、非空楼中楼、折叠/受限回复和旧版 HTML 回复的真实终点语义。
- Chrome/Firefox 扩展上下文中的接口权限、实际 Referer、短链端点保真度与恢复行为。
- 拟议刷新预算在不同账号上的运行成本，以及默认公开过滤与讨论开关的界面措辞。

本轮完成的是调研与设计、README 入口及分阶段提交。
未改抓取行为、canonical schema、生成器或 vendor；未向 issue 发评论，未发布站点。
