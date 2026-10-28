# 广播详情与回复归档（issue #26）

状态：设计提案，尚未实现。调查日期：2026-10-28。
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
