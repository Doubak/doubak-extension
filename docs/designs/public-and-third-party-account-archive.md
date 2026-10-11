# 设计方案：未登录账号与他人公开账号归档支持（Issue #19 & Issue #2）

> **状态**：设计草案（Design Proposal）  
> **关联 Issue**：
> - [Doubak/doubak-extension#19](https://github.com/Doubak/doubak-extension/issues/19)：依然需要支持备份未登录的账号，例如自己账号被封禁
> - [Doubak/doubak-extension#2](https://github.com/Doubak/doubak-extension/issues/2)：请求加入备份他人账号的功能  
> **设计目标**：在保持豆备现有架构纯度、规范兼容性、单归档单账号约束以及防假编辑不变性的前提下，以通用、优雅且完全向后兼容的方式支持公开数据归档。

---

## 1. 背景与核心问题抽象

### 1.1 两个 Issue 的诉求与现实场景

1. **Issue #19（账号被封禁/无法登录时的数据挽救）**：
   - **场景**：用户的豆瓣账号因社区审查被封禁（或因海外手机号失效导致无法通过短信验证登录），用户本人已无法在浏览器中建立该账号的登录会话（`session`）。
   - **诉求**：该账号在豆瓣上的个人主页、公开标记（看过/想看/在看）、长文（日记/书评/影评）、广播与自建豆列等公开页面依然可被外界访问。用户迫切需要将这些残留的多年心血导出留存。
2. **Issue #2（备份关注的他人账号 / 囤积防销号）**：
   - **场景**：用户关注了一批高质量书影音创作者、学者或朋友，担心对方因炸号、自我注销或不可抗力导致内容瞬间蒸发。
   - **诉求**：希望在本地完整备份他人账号的公开内容（标记、短评、自建豆列、长文、广播及附图等）。

### 1.2 核心机制的底层统一性

从豆瓣服务端协议与 Web 前端渲染视角来看，**「备份自己被封禁的账号」与「备份他人的账号」在技术底层是完全等价的**：
- **访问权限同一**：二者都**没有目标账号的登录凭据（Cookie/Session）**，能够读取的仅限于豆瓣向外界暴露的**公开表面（Public Surface）**。
- **不可访问内容同一**：私密标记（仅自己可见）、私密广播、私密日记、未公开豆列、账号设置与私信，在两种场景下均无法从豆瓣页面获取。
- **爬取目标同一**：请求的目标 URL 结构完全一致（均以目标用户标识 `people/<target>/` 展开）。

因此，**系统不应为二者设计两套平行的机制，而应当将其抽象为同一个底层能力：公开数据归档（Public Surface Archiving）**。

---

## 2. 现状约束与系统不变量

任何新特性的引入，绝不能破坏豆备在过去数月测量与验证中确立的硬性不变量。设计必须正面回答以下六项核心约束：

### 约束 1：单 bundle 归属单一账号（`manifest.account.user_id`）
- **不变量**：每个 bundle 必须明确且唯一归属于一个豆瓣账号，数字 `user_id` 是稳定主键。
- **约束推论**：即便用户使用小号（账号 B）登录浏览器去抓取目标用户 A，产出的 bundle 归属主键**必须是 A，绝对不能记成 B**。否则解析器与导出适配器（如 NeoDB）会把 A 的几千条标记说成是 B 的记录，产生灾难性的数据污染。

### 约束 2：公开视图与完整视图的严格区隔（防假编辑与假删除）
- **规范要求**（`canonical/INGESTION.md` §2.2）：未登录看到的是公开视图，私密条目不在其中，且标签（tags）在匿名访问下可能被豆瓣整批剥离。
- **致命陷阱**：若一份公开归档没有明确标明其公开性质，被当成 `enumeration: full` 摄取并与该账号早年的完整自归档合并，解析器的连续性证明（`absenceAuthority`）会误认为「该账号删除了全部私密标记与全部标签」，**凭空捏造数万条假编辑和假删除**。
- **约束推论**：公开归档的元数据必须自声明其观测范围（`crawl_scope: public`），并在权限推导中严格限制其删除推断权。

### 约束 3：会话守卫（`SessionGuard`）与账号防串设计
- **现状设计**（`DESIGN.md` F-01 & `session.js`）：`SessionGuard.verify()` 每页比对全局导航栏的数字 ID，发现不一致或退出登录即判 `account_switched` / `session_expired` 并整场停机。
- **冲突点**：
  - 若在**未登录状态**抓取：每页均是 `nav-login`，分类器会判 `verdict: 'login'`，守卫会抛 `session_expired`。
  - 若以**小号 B 登录状态**抓取目标 A：全局导航栏的 `_GLOBAL_NAV.USER_ID` 是 B，而目标是 A，守卫会判 `account_switched` 并停机。
- **约束推论**：必须将「操作者会话（Operator Session）」与「归档目标主体（Target Account）」在架构上解耦。

### 约束 4：分类器（`classifier.js`）判定契约
- **现状设计**：`classifier.js` 步骤 6 检测到导航栏无登录态时，将响应判为 `verdict: 'login'`；而在 `loop.js` 与 `frontier.js` 中，`verdict: 'login'` 会触发整场停机；在解析器中 `login` 捕获被视作不可信数据不予摄取。
- **约束推论**：在公开抓取模式下，导航栏出现 `nav-login` 是**正常且预期之内的**，必须将其正确识别为 `verdict: 'ok'`，同时依然保留对真正的登录拦截页（HTTP 302 重定向到 `passport/login` 或带有 `<title>登录豆瓣</title>`）的拦截能力。

### 约束 5：反爬、配额与设备端信任边界
- **现状设计**：所有抓取在用户浏览器本地运行，共享用户会话与 IP。未登录状态下，豆瓣对 IP 的请求频率限制极其苛刻（极易遭遇 403 阻断或验证码）；若使用小号 B 抓取 A，高频请求存在连累小号 B 的风险。
- **约束推论**：系统必须对抓取节奏（`Pacer`）进行差异化控制，并向用户提供清晰的风险告知与条目轻量化抓取选项（如跳过作品详情页）。

### 约束 6：全工具链兼容与下游零侵入
- **约束推论**：新方案产出的 bundle 必须能无缝通过 `doubak-data-specs` 的 `validate.py` 校验，无缝被 `doubak-data-parser`、`doubak-export-adapters`（NeoDB/Markdown）所摄取，不得破坏既有 23 个 vendor 文件的零依赖单向同步契约。

### 约束 7：URL Slug 易变性与数字 UID 唯一恒定性（更名、抢注与所有权转移铁律）
- **客观事实**：豆瓣个人主页的 URL 路径形如 `douban.com/people/<slug>/`。其中 `slug`（个性域名/用户名）在豆瓣账号设置中**允许用户自由修改**；修改或注销后，原 `slug` 会被释放，甚至可能在数月或数年后被第三方重新注册占用。与之相对，**数字 `user_id`（UID）由豆瓣服务端按注册顺序自增生成，终身唯一恒定，注销后绝不回收复用**。
- **致命陷阱**：
  1. **备份他人时输入自己账号**：用户在“备份其他公开账号”输入框中粘贴了自己的主页链接。若系统盲目按公开视图抓取，会导致私密内容和标签静默丢失，造成假安心。
  2. **Slug 更名（同 UID，异 Slug）**：同一个用户改了 slug，豆瓣所有列表页的 URL 均随之改变。若直接接着旧档案进行增量抓取，跨 bundle 的 `url_key` 无法对齐，破坏版本链与去重机制（见 `bundle/SPEC.md` §5.5.1b）。
  3. **Slug 被他人抢注（异 UID，同 Slug）**：过去某个 slug 属于 A（UID: 10001），如今属于 B（UID: 99999）。若系统按 slug 匹配历史归档，就会把 B 的数据当成 A 的续抓，产生灾难性的跨账号串号污染。
- **约束推论**：
  - 系统识别、分组、链条比对与存储隔离，**100% 以数字 `user_id` 为唯一不变量主键**，绝对不把 slug 当主键。
  - 在 Preflight 探测阶段，必须对「输入自己账号」「同 UID 改名」「异 UID 抢注碰撞」三种场景进行确定性裁决与主动交互拦截。

### 约束 8：多账号原生感知与全工具链单用户安全边界（Multi-Account as a First-Class Citizen）
- **系统级基本假设**：在公开归档引入后，“单一存储目录下可能同时存在多个账号的归档”成为系统的常态，而非边缘特例。**所有生态工具（扩展 UI、解析器、导出器、站点生成器、导入器）必须在底层将多账号支持作为一等公民对待**。
- **核心安全边界**：
  1. **采集与导入（宽松汇聚）**：导入器支持**批量无差别导入**任意多个账号的历史 bundle，由系统根据 `manifest.account.user_id` 自动聚类分组，无需用户预先人工按账号分拣。
  2. **解析、导出与建站（严格单用户隔离与预检）**：下游消费端工具（Canonical 解析、NeoDB/CSV 导出、Hugo 站点生成）的数据语义均绑定在特定主体身份上。**严禁在无显式声明的情况下将多个账号的数据混入同一个导出文件或同一个站点中**。
  3. **Fail-Fast 预检铁律**：所有 CLI 工具（`parser`、`export-adapters`、`site-generator`）在运行时必须预检输入源的用户唯一性。若发现数据源包含多个 `user_id`，且用户未显式通过 `--account <uid>` 指定目标，工具**必须立即报错终止**并列出所有检测到的账号，绝对不得静默合并或猜一个账号。

---

## 3. 三种架构备选方案对比

围绕上述约束，我们推演并对比三种不同的实现路线：

| 维度 | 方案 A：分层会话与目标主体解耦模型（推荐） | 方案 B：平行外挂式公开爬虫引擎 | 方案 C：仅提供外部工具导入适配器 |
|---|---|---|---|
| **核心思路** | 在现有 runner / session / loop 体系中引入 `target` 与 `operator` 角色解耦，将公开模式作为合法模式纳管 | 单独写一个独立的公开抓取脚本/模块，完全绕过 `SessionGuard` 和现有主循环 | 扩展内不增加抓取能力，要求用户用外部 Python/Go 脚本抓取 HTML，再通过导入适配器进 bundle |
| **代码复用度** | **高**（复用 95% 现有代码：loop, frontier, pacing, WARC writer, OPFS, recovery） | **低**（两套爬取驱动，重复实现落盘、重试、节奏控制与 WARC 组装） | **极低**（扩展完全不承担责任，逻辑在外部） |
| **长期维护成本** | **低**：统一管道，单一实现，所有既有 bugfix（如分段恢复、退避重试）自动受惠 | **极高**：两套实现必然随豆瓣改版而发生行为漂移（违背 CLAUDE.md 核心军规） | **中**：维护成本转移给第三方爬虫 |
| **规范兼容性** | **完全兼容**：符合 `bundle/1.4` 与 `canonical/1.1`，通过 manifest 声明公开作用域 | **存疑**：外挂逻辑容易生成不合规的索引与状态证明 | **兼容**：走 `doubak-import-adapters` 管道 |
| **用户体验** | **极致原生**：扩展面板内直接输入目标，一键抓取并导出 NeoDB / Markdown | **分裂**：面板中出现两套不同交互与进度的界面 | **极差**：普通用户无法自行搭建 Python/Node 命令行环境 |
| **对既有自归档影响** | **零回归风险**：默认模式完全维持现状，通过严格测试套件锁定 | **零回归风险**：物理隔离，但代码膨胀 | **零影响** |

### 方案选型结论
**选定方案 A（分层会话与目标主体解耦模型）**。它完全符合本仓库「字节从哪来各写各的，字节是什么意思只能有一份实现」的架构信条，杜绝两套爬虫并存带来的静默分叉。

### 3.1 三种方案对 Specs 规范体系（doubak-data-specs）改动要求的系统对比

深入 `doubak-data-specs` 规范（覆盖 `bundle/v1/` 容器层和 `canonical/v1/` 数据模型层），对比三个方案对各规范文件的具体改动需求：

| 规范文件 / 模块 | 方案 A：分层会话与目标解耦（推荐） | 方案 B：平行外挂式公开爬虫 | 方案 C：外部导入适配器 |
|---|---|---|---|
| **`bundle/v1/manifest.schema.json`** | **向前兼容**：利用现有 `additionalProperties: true` 增设 `crawl_scope`；可选递增至 `bundle/1.5` 固化字段定义。 | **分裂**：若伪造 bundle 则难以满足完备性字段；若输出自定义 dump 则必须另写独立 schema。 | **无需改动**：复用 `bundle/1.3` 的 `capture_fidelity: "decoded_body+synthesized_headers"`。 |
| **`bundle/v1/SPEC.md`** | **增补修订**：<br>1. §5.1 说明 `crawl_scope` 语义；<br>2. §5.5.1b 增加基准链不变量：**公开归档不得作为自归档的增量基准（防水位线虚高与私密遗漏）**；<br>3. §6.3 澄清公开抓取下合法公开响应为 `verdict: ok` 而非 `login`。 | **规范崩塌**：无法遵循 §6.5 强制要求（零载荷检测）、§7.1 连续性证明与 §8.1 严格落盘顺序。或需在 specs 中新增《公开 Dump 规范》。 | **完全就绪**：规范在 §6.4.1 已为外部导入准备好完整语义声明与 `notes` 说明。 |
| **`bundle/v1/validate.py`** | **零改动**！产出的 bundle 天然满足 WARC 切片、哈希校验、capture_id 格式、`claimed_source` 追溯与 `crawl_state` 不变量。 | **被迫削弱校验**：由于缺少浏览器上下文的精确抓取凭据，极易在 `claimed_source` 或段计数上失败，迫使校验器放宽限制。 | **零改动**：只要导入器按规范构建 WARC、NDJSON 与 manifest，校验器 100% 通过。 |
| **`canonical/INGESTION.md`** | **核心升级（必须）**：<br>1. §2.2 澄清 `verdict: ok` 与公开视图边界；<br>2. **§3 权限降级规则（关键防线）**：公开归档的 `absence_authority` 必须设为 `none`（或仅限公开域 `whole_public_route`），**坚决禁止对私密条目推导假删除**；<br>3. 匿名模式下缺失的 tags 标为 omitted，不得推导清空 tags。 | **不可用或同上**：若不进 canonical 则丢失下游生态；若进 canonical 则依然面临与方案 A 相同的假删除陷阱。 | **核心升级（同方案 A）**：导入的公开数据并入 canonical 库时，面临完全一样的假删除风险，必须统一遵循 §3 的降级规则。 |
| **`canonical/IDENTITY.md`** | **零改动**：公开页面同样携带 `data-cid`（书影音）或 `/j/ilmen/thing/`（游戏），完全对齐第 1 层 `upstream_id` 或第 2 层退化键。 | **无影响** | **零改动**：同样对齐身份分层模型。 |
| **`canonical/FIELDS.md`** | **零改动**：规范已确立「任何来自页面的字段都不得设为必填」，公开数据缺失私密字段与 tags 完全合法。 | **无影响** | **零改动** |
| **`canonical/v1/*.schema.json`** | **零改动**：现有的 `absence_authority: ["whole_route", "above_floor", "none"]` 完全够用，公开归档直接映射到 `none`。 | **无影响** | **零改动** |

---


## 4. 推荐方案详细技术设计

### 4.1 架构分层模型：目标主体（Target）与操作会话（Operator）解耦

```
                           ┌───────────────────────────────────────────────┐
                           │                 用户发起抓取                  │
                           └───────────────────────┬───────────────────────┘
                                                   │
                                   ┌───────────────┴───────────────┐
                                   ▼                               ▼
                     【模式 1：本人完整自归档】       【模式 2：公开数据归档（#19 / #2）】
                     （Current / Self Mode）          （Public Surface Mode）
                                   │                               │
        ┌──────────────────────────┴────────┐                      │
        │ 目标 = 当前登录账号               │                      ├───────────────────────────────┐
        │ 作用域 = full (含私密条目)         │                      ▼                               ▼
        │ 操作会话 = 本人登录态             │         【子场景 2A：小号登录执行】     【子场景 2B：纯未登录执行】
        └───────────────────────────────────┘         · 目标 = 账号 A                 · 目标 = 账号 A
                                                      · 作用域 = public               · 作用域 = public
                                                      · 操作会话 = 小号 B             · 操作会话 = anonymous
                                                      · 优势：配额高、有标签          · 优势：零关联、免小号
                                                      · 风险：小号被风控              · 风险：限流严、无标签
```

每个抓取任务显式维护两个独立的上下文对象：
1. **`targetAccount`（归档目标主体）**：
   - `userId`: 目标账号的数字 ID（稳定主键）。
   - `username`: 目标账号的自定义域名/用户名（用于构造 URL）。
   - `displayName`: 目标账号的昵称（用于界面呈现与 manifest）。
   - `scope`: `'self'` 或 `'public'`。
2. **`operatorSession`（执行操作者会话）**：
   - `mode`: `'authenticated'`（已登录小号/当前账号）或 `'anonymous'`（未登录访客）。
   - `operatorUserId`: 若已登录，为当前操作者的数字 ID（用于会话漂移检测）。

---

### 4.2 目标账号定位与数字 ID 确定（Preflight 协议）

在本人自归档中，数字 ID 可通过全局导航栏的 `_GLOBAL_NAV.USER_ID` 100% 提取。而在公开抓取模式下，目标账号的数字 ID 获取机制需进行分层设计：

#### 4.2.1 用户输入形式归一化
用户在面板输入框中可提供以下三种形式之一：
- 完整主页 URL：`https://www.douban.com/people/mewcatcher/`
- 自定义域名/用户名：`mewcatcher`
- 纯数字 ID：`82160871`

系统统一解析出初始的 `slug`（即 URL 中的 people 路径段）。

#### 4.2.2 公开探测与数字 ID 提取策略（严格优先级）
向 `https://www.douban.com/people/<slug>/` 发起一次探测请求：
1. **若 `slug` 本身即为纯数字**：`userId = slug`，直接完成。
2. **若 `slug` 为自定义字母/下划线**，按以下**经过实测校准的提取顺序**解析页面正文（绝不猜测）：
   - **优先级 1（RSS Feed 链接）**：
     ```html
     <link rel="alternate" type="application/atom+xml" href="https://www.douban.com/feed/people/<uid>/interests" />
     ```
     豆瓣个人主页的 RSS 链接路径中，必定使用数字 `user_id`。
   - **优先级 2（用户个人自建广播容器）**：
     主页下方用户个人广播列表中的条目属性：
     ```html
     <div class="status-item" data-uid="<uid>">
     ```
     在个人主页（非作品详情页）上，广播列表的作者容器数字 ID 为本人。
   - **优先级 3（用户头像 URL 特征）**：
     ```html
     /icon/u<uid>-<version>.jpg 或 /icon/up<uid>-<version>.jpg
     ```
     在主页顶部 `#db-usr-profile .pic img` 容器内提取（限定在用户信息区块，严防作品海报干扰）。
3. **若主页完全提取不到数字 ID**：
   - 探测 `https://movie.douban.com/people/<slug>/` 或 `https://www.douban.com/people/<slug>/statuses` 作为补充。
   - 若仍提取不到（例如豆瓣极早期仅有用户名的特殊僵尸账号），则以 `slug` 作为临时键，并如实记入 `manifest.notes` 与 warnings。

#### 4.2.3 异常账号状态裁决：主动注销（Disabled）与封禁锁定（Banned）

在抓取第三方公开账号或未登录账号时，上游豆瓣账号可能处于非正常活跃状态。根据实测真实抓取取证，异常状态存在两种截然不同的机制形态：**主动注销（Disabled / 硬下线）** 与 **违规封禁（Banned / 锁定）**。两者在 HTTP 表现、页面结构、子路由可访问性以及系统判定逻辑上存在本质差异，Preflight 探测协议必须精确识别并作出差异化确定性处置：

```
                              【Preflight 主页探测】
                          GET www.douban.com/people/<id>/
                                         │
         ┌───────────────────────────────┴───────────────────────────────┐
         ▼                                                               ▼
【分支 A：主动注销墓碑】                                          【分支 B：封禁违规锁定】
HTTP 200, .mn 命中注销模式                                        HTTP 200 / 302 / 提示违反指导原则
（例：235807474，含注销时间戳）                                    （主页社交与广播被屏蔽）
         │                                                               │
         ▼                                                               ▼
[ 提取注销时间戳 ]                                                【触发二级探测】
子路由验证：电影/书同样硬注销                                      GET movie.douban.com/people/<id>/collect
         │                                                               │
         ▼                                               ┌───────────────┴───────────────┐
[ 判定：tombstone_deleted ]                              ▼                               ▼
全站已无任何数据，直接终止                                【二级正常：软封禁】            【二级亦锁：全站硬锁定】
杜绝生成空包，向用户呈报注销事实                           .grid-view 正常可读             同样阻断或返回违规
                                                         │                               │
                                                         ▼                               ▼
                                               [ 判定：banned_soft ]           [ 判定：banned_hard ]
                                               降级抓取：排除主页与广播         全站公开不可读，终止抓取
                                               尽最大努力归档书影音数据         提示本人登录态抢救（#19）
```

##### 4.2.3.1 边缘场景一：主动注销账号（Disabled Accounts，实测例 `235807474`）

###### 1. 上游真实页面特征与取证
通过对真实已注销账号 [`https://www.douban.com/people/235807474/`](https://www.douban.com/people/235807474/) 进行实测取证，上游返回特征如下：
- **HTTP 状态码**：返回 **HTTP 200 OK**（**严正注意：上游并非返回 404 或 410**！若仅靠 HTTP 状态码判定，传统爬虫会误认为页面请求成功）。
- **页面标题**：`<title>该用户已经主动注销账号</title>` 或 `<title>豆瓣</title>`。
- **DOM 结构**：主页正常的用户资料（`#db-usr-profile`）、广播流、豆列等全部被移除，核心内容区替换为简洁的墓碑容器：
  ```html
  <div id="wrapper">
    <div id="content">
      <h1>该用户已经主动注销账号</h1>
      <div class="grid-16-8 clearfix">
        <div class="article">
          <div class="infobox">
            <div class="bd">
              <div class="mn">
                该用户已经主动注销账号。<br/>
                注销时间：2026-05-20 05:17:39<br/>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  ```
- **子路由联动效应**：实测请求该用户的看电影列表 `https://movie.douban.com/people/235807474/collect`、读书列表 `https://book.douban.com/people/235807474/collect`，上游**均返回完全相同的 HTTP 200 与注销墓碑提示**。这意味着账号注销在豆瓣底层属于全站级的硬下线，没有任何公开子路由可逃脱。

###### 2. 判定契约与正规表达式
Preflight 探测器与 `classifier.js` 固化如下判定模式：
```javascript
const TOMBSTONE_RE = /该用户已经主动注销账号|该用户已被注销|用户已注销/;
const CANCELLATION_TIME_RE = /注销时间：\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/;
```
当 HTML 命中 `TOMBSTONE_RE` 时：
1. 立即停止任何后续探测请求；
2. 提取注销时间戳（如 `2026-05-20 05:17:39`）；
3. 判定结果裁决为 `account_disabled_tombstone`。

###### 3. 为什么严禁启动抓取（防空包与假清空铁律）
- **致命隐患**：如果系统将该页面当作普通空白页面放行，爬虫会认为该用户的标记、广播、日记数量均为 0，并生成一份 `status: complete` 的全量空 bundle。
- 当这份空 bundle 流入 `doubak-data-parser` 时，若未对连续性权限进行绝缘，将导致下游判定“用户清空了所有标记”，制造毁灭性的假删除。
- **正规处置**：**坚决不启动抓取，坚决不向 OPFS 或磁盘写入任何 bundle 容器**。Preflight 探测卡片显示置灰墓碑状态，并给出确定性文案：
  > <b>该账号已于 2026-05-20 05:17:39 主动注销</b><br>
  > 豆瓣已下线该用户全站的所有公开页面（主页、书影音、日记等均返回注销墓碑）。上游数据源已清空，浏览器无法抓取到公开数据。若您此前曾备份过该账号，可前往「导入」查看历史存档。

---

##### 4.2.3.2 边缘场景二：违规封禁与锁定账号（Banned / Locked Accounts）

###### 1. 上游特征：软封禁（Soft Ban）与全站硬锁定（Hard Ban）
当账号因违反《豆瓣社区指导原则》遭到平台处置时，页面会出现：
- `该账号因违反《豆瓣社区指导原则》被锁定`
- `该账号已被停用` 或 `提示：该账号已锁定`
- 或被 302 重定向至 `/accounts/suspended` 提示页面。

然而，封禁状态与注销存在一个**关键技术差异**：**社交封禁 ≠ 标记数据硬删除**。在很多情况下：
- 用户主页（`www.douban.com/people/<id>/`）被锁定，动态广播被隐藏；
- 但其公开书影音标记列表（如 `movie.douban.com/people/<id>/collect`）在特定封禁阶段（如软封禁、禁言、主页屏蔽）**依然可以通过直接 URL 公开访问**！

###### 2. 二级探测协议（Secondary Probe Protocol）
Preflight 探测器在主页捕获到封禁/锁定提示时，**不立即宣告失败，而是自动触发二级验证**：
1. **主页模式匹配（暂定启发式规则）**：
   ```javascript
   // 启发式暂定正则：覆盖常见违规封锁、停用与锁定提示
   const BANNED_RE = /因违反《豆瓣社区指导原则》被锁定|该账号已被停用|该账号已被锁定|该用户已被封禁|提示：该账号已停用/;
   ```
2. **触发二级探测**：发送单次轻量探测请求至 `https://movie.douban.com/people/<target>/collect`。
3. **分支判定**：
   - **分支 1（软封禁/部分标记可读）：`banned_soft_partial_available`**
     - 看电影列表返回 HTTP 200，且包含 `.grid-view` 或 `.item` 列表结构。
     - 结论：书影音标记依然向公网开放！
     - 策略：**允许用户继续抓取，但自动对抓取路线实施动态降级（Dynamic Route Pruning）**：
       - 自动勾选并只抓取 `interest.*`（影视、读书、音乐、游戏、舞台剧）；
       - 自动剔除 `user.profile`、`broadcast`、`note`（已知被锁定屏蔽的路线，避免徒增 403 阻断）。
     - 界面反馈文案：
       > <b>账号主页已被锁定，但部分书影音标记公开可读</b><br>
       > 豆瓣已锁定该用户的社交主页与广播，但公开的电影/读书标记依然可读。豆备将尽最大努力抓取所有尚可访问的公开标记数据。
   - **分支 2（全站硬锁定）：`banned_hard_locked`**
     - 二级探测同样返回违规锁定提示或 403 / 302 重定向。
     - 结论：上游公开通道已被全站掐断。
     - 策略：终止抓取，不生成空包。
     - 界面反馈文案：
       > <b>该账号已被豆瓣全站锁定</b><br>
       > 豆瓣已限制该账号的所有公开访问，未登录或他人身份下无法读取数据。若这是您自己的账号，请参阅下文【本人被封账号登录态自归档】。

###### 3. 规则暂定性说明与诊断日志协议（Diagnostic Logging Protocol）
> [!NOTE]
> **关于封禁关键字与模式的暂定性说明（Tentative Heuristic）**：
> 相比主动注销账号（拥有可复现的真实样本 `235807474` 及固化的 `.infobox .bd .mn` 结构），违规封禁账号属于动态风控场景，目前尚未固化完整的脱敏 DOM Fixture。上述 `BANNED_RE` 系基于豆瓣官方规则文案与历史特征的**启发式经验设计（Heuristic Rule）**。
>
> **诊断日志协议（Diagnostic Logging Protocol）**：
> 为确保未来能够精准核实、校准封禁页面特征，探测器与分类器在遇到非 200、非标准结构或疑似违规提示时，**绝不静默吞掉异常，必须在控制台打出诊断日志**：
> ```javascript
> console.warn('[Preflight:Diagnostic]', {
>   url: probeUrl,
>   httpStatus: response.status,
>   pageTitle: document.title,
>   bodySnippet: html.slice(0, 500).replace(/\s+/g, ' '),
>   matchedHeuristic: BANNED_RE.test(html),
>   unmatchedSuspicious: response.status !== 200 && !TOMBSTONE_RE.test(html),
> });
> ```
> 未来一旦获取到真实被封账号样本，将第一时间录入 `test/fixtures/` 回归套件，把启发式规则升级为精确的 DOM 契约。

---

##### 4.2.3.3 本人被封禁账号的抢救性自归档（Issue #19）

[Issue #19](https://github.com/Doubak/doubak-extension/issues/19) 提出的核心痛点是：用户自己的账号被豆瓣封禁（停用/禁言/转为只读），用户希望抢救性备份自己多年的书影音与日记数据。

与第三方公开抓取相比，本人登录态在遭遇封禁时拥有关键特权与处置优势：
1. **登录会话特权（Cookie Session Privileges）**：
   - 即便账号被封禁，用户在浏览器中可能依然保留有未过期的 `dbcl2` 登录态 Cookie。
   - 在登录态下，豆瓣服务端对本人访问的限制往往宽于外部匿名访客（例如本人仍可浏览自己的私密日记、全部标记列表、个人设置导出页等）。
2. **Preflight 身份判定与引导**：
   - 探测器探测到该账号处于锁定状态，但同时检测到当前浏览器的 `operator.userId === target.userId`。
   - 系统立刻识别为：**Issue #19 本人封禁抢救模式（Rescue Self-Archive）**。
   - 界面弹出专属引导卡片：
     > <b>检测到当前处于封号抢救场景（Issue #19）</b><br>
     > 您的账号当前处于受限/锁定状态。系统将自动启用【本人抢救性归档】模式，携带您当前的登录凭证尝试读取所有受限页面，并启用高容错抓取引擎（单条路线遇到硬性封锁时不中断全局）。
3. **抓取引擎的高容错抢救参数配置**：
   - `failure_tolerance: "lenient"`：单条路由遇到平台封锁页面时，将其记为 `verdict: "blocked"`，继续执行其他可用路由，绝不中途崩溃中断。
   - `manifest.crawl_scope.rescue_mode: true`：在 manifest 中显式打标，告知下游解析器这是一次针对封禁账号的抢救性归档，数据可能存在平台单侧屏蔽造成的缺口。

---

##### 4.2.3.4 异常状态判定规则与决策状态机汇总

| 探测场景 | 主页返回特征 | 二级探测返回 | 最终裁决状态 | 是否允许抓取 | 路线裁剪策略 | Manifest 打标 |
|---|---|---|---|---|---|---|
| **正常活跃账号** | HTTP 200, `#db-usr-profile` 正常 | （无需触发） | `ok` | 是 | 抓取全部已配置路线 | `scope: public` |
| **主动注销账号**（例 235807474） | HTTP 200, `.mn` 命中注销墓碑 | （无需触发） | `account_disabled_tombstone` | **否**（终止） | 不生成包 | 无 |
| **软封禁账号** | HTTP 200, 命中违反原则/锁定 | HTTP 200, `.grid-view` 存在 | `banned_soft_partial_available` | **是**（降级） | 仅保留 `interest.*`，裁剪主页与广播 | `scope: public, partial_banned: true` |
| **全站硬锁定账号**（他人） | HTTP 200/302, 命中违反原则 | 同样封锁 / 403 | `banned_hard_locked` | **否**（终止） | 不生成包 | 无 |
| **全站硬锁定账号**（本人 #19） | 命中违反原则，但 `operator==target` | 尝试本人 Cookie 访问 | `rescue_self_archive` | **是**（抢救） | 尝试所有路线，遇阻记录并跳过 | `scope: self, rescue_mode: true` |
| **IP 访问受限** | HTTP 403 / 验证码挑战 | （无需触发） | `rate_limited` | **否**（暂停） | 等待冷却或切换代理 | 无 |

---

#### 4.2.4 账号身份冲突、同账号复用与 Slug 漂移裁决机制

豆瓣生态中，用户可以随时在账号设置中更改其个性域名（`slug`），且注销或改名后旧域名可能被第三方抢注；同时，用户在输入框中完全可能填写自己当前登录账号的网址。系统通过数字 UID（终生唯一且不可变）与 Slug 的双重核验矩阵，进行严格的确定性裁决：

```
                                  【Preflight 探测结果】
                                (targetUid, targetSlug)
                                           │
             ┌─────────────────────────────┼─────────────────────────────┐
             ▼                             ▼                             ▼
   【场景 1：输入自己账号】        【场景 2：异 UID 抢注碰撞】     【场景 3：同 UID 更名】
 targetUid == operatorUid      targetSlug == histSlug        targetUid == histUid
                               && targetUid != histUid       && targetSlug != histSlug
             │                             │                             │
             ▼                             ▼                             ▼
    [ 自动无缝继续 ]               [ 域名归属变更警示 ]           [ 强制新全量基准 ]
 自动合流为本人完整自归档        绝对作为全新账号隔离建档       重打基准，防止 url_key 断裂
 完整备份私密数据与标签          绝不合并或串入他人历史链条     历史档案按 UID 并集归并
```

##### 4.2.4.1 输入自己账号的无缝合流（Self-Account Seamless Continuation）
- **判定条件**：探测到的目标数字 ID `target.userId` 与当前浏览器已登录会话的 `operator.userId` 完全相等。
- **用户体验优化**：
  - 过去方案如果弹窗拦截或报错，会让用户感到困惑和受阻。
  - **新设计策略**：**静默合流，体验无缝**。
    - 当用户在输入框中粘贴了自己的主页、个性域名或数字 ID 时，系统自动识别出“这是当前登录用户本人”；
    - 状态栏直接更新为正面确认状态：“✔ 已识别为当前登录账号（mewcatcher），将自动启用【本人完整自归档】（完整备份私密日记、私密标记与完整标签）”；
    - 主操作按钮保持为「开始抓取」，流程无缝衔接，杜绝了多余的阻断交互，同时确保数据不会被降级为缺乏私密内容的公开视图。

##### 4.2.4.2 异 UID 抢注碰撞（Slug Reassignment / Hijacking）
- **场景**：
  - 用户 A 曾使用个性域名 `douban.com/people/cat/`（数字 UID: `10001`），本地曾备份过该账号。
  - 后来用户 A 改名或注销，空出来的域名 `cat` 被用户 B（数字 UID: `99999`）重新注册占用。
  - 亦或者是用户以前输入过别人的旧网址，后来自己注册占用了该网址。
- **判定条件**：
  `target.username === historical.username` 但 `target.userId !== historical.userId`。
- **致命陷阱**：若按 URL slug 寻找历史基准 bundle，系统会错误地把用户 B 的公开内容当成用户 A 的增量，引发灾难性的跨账号串号污染（违背 `SPEC.md` §5.5.1b 与 `INGESTION.md` §6）。
- **处理策略**：
  1. **主键铁律**：基准链寻找首要且唯一的主键是数字 `user_id`。数字 ID 不一致，**绝对判定为无基准，必须从零开始建立全新归档**。
  2. **OPFS 目录物理隔离**：目录名为 `doubak-bundle-<bundle_id>`（纯时间戳与随机十六进制），天然不会互相覆盖。
  3. **UI 预警机制**：在 Preflight 确认卡片中醒目标注：“注意：检测到域名归属发生变更。本地已有历史档案属于旧用户（UID: 10001），当前探测到的账号为新用户（UID: 99999）。当前抓取将作为【全新账号】独立存储，绝不会与旧账号数据合并。”

##### 4.2.4.3 同 UID 更名（Slug Drift by Same User）
- **场景**：
  用户数字 ID 恒为 `10001`。2024 年备份时域名为 `old_slug`，2026 年抓取时域名变为了 `new_slug`。
- **判定条件**：
  `target.userId === historical.userId` 但 `target.username !== historical.username`。
- **规范处理（依据 `bundle/v1/SPEC.md` §5.5.1b）**：
  - 豆瓣所有列表路由均内嵌用户名（如 `people/<slug>/collect`）。改名后，新抓取的每一条原始 URL 和 `url_key` 均已发生改变。若强行增量接着抓，新旧 `url_key` 无法去重，同一页面的版本历史也无法拼接。
  - **规范铁律**：改名后**不得接着进行增量抓取**，必须重新打一份**全量基准（`floor_time: null`）**。
- **处理策略**：
  - 界面提示用户：“检测到该账号个性域名由 old_slug 变更为 new_slug。数字 ID 保持一致，确认属于同一账号。本次抓取将作为新的全量基准进行。”
  - 抓取完成后，在 OPFS 和导出时依然归属于同一个 `account.user_id: "10001"`。导出 Canonical 时，解析器依据 `INGESTION.md` §5.2 的分叉规则自动合并两个时期的观测记录，数据完整保留无遗漏。

##### 4.2.4.4 输入纯数字 ID 时的自动 Slug 解析与规范化
- 用户直接输入纯数字 ID（如 `82160871`）时：
  - 探测器请求 `https://www.douban.com/people/82160871/`。
  - 豆瓣服务端对于已设置个性域名的数字 ID 请求，会发起 HTTP 302 重定向至 `https://www.douban.com/people/<current_slug>/`。
  - 探测器跟随重定向并解析最终 URL，同时提取并锁定当前的 `username: current_slug` 与 `user_id: 82160871`。
  - 如果账号未设置个性域名，豆瓣页面直接以纯数字渲染，此时 `username` 记为 `null`，以纯数字 `user_id` 展开后续路由构造。

---

### 4.3 会话守卫（`SessionGuard`）重构

将 `src/crawl/session.js` 中的 `SessionGuard` 升级为支持双重身份核对：

```javascript
export class SessionGuard {
  /**
   * @param {object} opts
   * @param {'self' | 'public'} opts.crawlScope
   * @param {AccountHints} opts.targetAccount
   * @param {'authenticated' | 'anonymous'} opts.operatorMode
   * @param {string | null} [opts.operatorUserId]
   */
  constructor({ crawlScope, targetAccount, operatorMode, operatorUserId = null }) {
    this._crawlScope = crawlScope;
    this._target = targetAccount;
    this._operatorMode = operatorMode;
    this._operatorUserId = operatorUserId;
  }

  /**
   * 每页执行廉价复核
   * @param {string} html 响应正文
   * @param {string} url 当前请求 URL
   */
  verify(html, url) {
    // 1. 目标一致性复核：确保当前抓取的页面没有因为错误重定向跳到其他用户主页
    if (this._target.username && isUserScopedUrl(url)) {
      assertUrlBelongsToUser(url, this._target.username);
    }

    // 2. 本人完整自归档模式：完全保持原有的严格守卫行为
    if (this._crawlScope === 'self') {
      const state = detectLoginState(html);
      if (state === 'logged_out') {
        throw new SessionError('session_expired', '会话已失效（检测到未登录状态）');
      }
      if (state === 'logged_in') {
        const hints = extractAccountHints(html);
        const mismatch = describeMismatch(this._target, hints, { fields: ['userId'] });
        if (mismatch) {
          throw new SessionError('account_switched', `账号发生了变化（${mismatch}）`);
        }
      }
      return;
    }

    // 3. 公开数据归档模式（Public Mode）：
    // 若操作会话为「已登录小号」，则防止小号中途退出或串号（保护操作会话的稳定性）
    if (this._operatorMode === 'authenticated') {
      const state = detectLoginState(html);
      if (state === 'logged_out') {
        throw new SessionError('operator_session_lost', '作为抓取发起者的小号登录已失效，抓取安全停止。');
      }
      if (state === 'logged_in' && this._operatorUserId) {
        const hints = extractAccountHints(html);
        if (hints.userId && hints.userId !== this._operatorUserId) {
          throw new SessionError('operator_switched', '作为抓取发起者的小号发生了切换，抓取安全停止。');
        }
      }
    }
    // 纯未登录访客模式下：无需复核登录态，只需由分类器把关页面内容质量
  }
}
```

---

### 4.4 分类器（`classifier.js`）判定逻辑调整

修改 `classifier.js` 步骤 6 的登录态判定，使之感知 `route.isPublicMode` 或全局上下文：

```javascript
  // ── 6. 导航栏登录状态判定
  const userNav = route.userNav ?? DEFAULT_USER_NAV;
  const loggedIn = userNav.test(bodyText);

  if (!loggedIn) {
    // 如果是在公开数据归档模式下：
    if (context.isPublicMode) {
      // 只要页面具备合法的数据容器（如 grid-view, stream-items, article 等），
      // 导航栏的未登录状态即属于合法现状，判定为通过。
      reasons.push('公开归档模式：导航栏处于公开/未登录状态，确认为合法的公开视图');
    } else {
      // 本人自归档模式：导航栏掉登录意味着拿到了缺失私密条目的残缺视图，坚决阻断
      const explicit = LOGIN_LINK.test(bodyText) ? '（导航栏出现登录入口）' : '';
      reasons.push(
        `导航栏中没有登录状态${explicit}——页面即使有内容也只是公开视图，不代表这个账号`,
      );
      return { verdict: 'login', reasons, itemCount };
    }
  } else {
    reasons.push('导航栏中存在登录状态');
  }
```

**关键安全保护**：即使在公开模式下，若豆瓣返回真正的认证重定向（URL 漂移至 `passport/login`、正文包含 `<title>登录豆瓣</title>` 或风控拦截码），分类器依然在第 1、第 2 步就会将其精确判定为 `login` 或 `blocked`，不会错误放行。

---

### 4.5 路线注册与抓取范围边界（Routes & Scope）

#### 4.5.1 路线支持矩阵

| 路线类别 | 路由 Key | 公开归档是否支持 | 差异与边界约束 |
|---|---|:---:|---|
| **个人概览** | `profile.overview` | ✅ | 归档昵称、头像、简介、常居地、加入时间等公开信息。 |
| **分类入口** | `profile.category_entry.*` | ✅ | 读取各分类公开统计数字作为 coverage 证据。 |
| **标记列表** | `interest.*` (5类×3态) | ✅ | 仅包含公开标记。私密标记（仅自己可见）由豆瓣直接过滤。 |
| **用户广播** | `broadcast.timeline` | ✅ | 仅包含公开广播；`extractBroadcasts` 依靠目标 `user_id` 过滤他人转发。 |
| **长文日记** | `note.list` / `note.item` | ✅ | 仅包含作者设为公开的日记正文。 |
| **长文书影评** | `review.list` / `review.item` | ✅ | 仅包含公开发布的评论。 |
| **自建豆列** | `doulist.list` (`doulists/all`) | ✅ | 仅包含公开豆列及其评语。 |
| **自传图片** | `asset.status_photo`, `asset.longform_embed` | ✅ | 抓取广播与日记中由作者上传的原图。 |
| **作品封面** | `asset.subject_cover` | ✅ (可选) | 抓取作品封面，确保离线渲染可用。 |
| **作品详情页** | `interest.item` (`catalog`) | ⚙️ **默认关闭/可选** | **关键优化**：详见 4.5.2 节。 |
| **私密条目** | 私密标记/私密广播/私密日记 | ❌ | 上游完全不可见，如实记录在范围说明中。 |
| **社交外围** | 关注/粉丝/他人回应/豆邮 | ❌ | 依据 DESIGN.md 既有原则：**永不抓取**。 |

#### 4.5.2 作品详情页（Catalog）的按需抓取策略
在现有自归档中，作品详情页（`interest.item`）占整场请求量的 **90.3%**（例如 2950 部电影对应近 3000 次额外请求）。
- **对于本人自归档**：为了支撑「数十年后离线完整建站」，作品的导演、演员、别名必须抓取。
- **对于公开备份他人账号 / 封禁账号**：
  - 用户通常核心关注的是**该用户自己的标记评分、短评、日记与广播**。
  - 在无登录态或小号态下盲目爬取数千张作品详情页，**极易耗尽风控预算导致 IP 或小号受限**。
  - **设计策略**：在公开抓取模式下，新增开关 **「仅归档用户原创内容与标记列表（推荐）」**（默认开启）：
    - 开启时：抓取全部标记列表、广播、日记、豆列与封面图，**跳过作品详情页**。抓取请求数直接从 4000+ 次暴降至 300 次左右，极大提升备份成功率并保护网络环境。
    - 关闭时：完整抓取作品详情页，维持与自归档同等完整度。

---

### 4.6 规范与元数据定义（Data Specs Compatibility）

公开归档生成的 bundle 必须与 `doubak-data-specs` 规范（`bundle/1.4`）100% 兼容。

#### 4.6.1 `manifest.json` 元数据扩展
利用 JSON Schema 允许的 `additionalProperties: true`，在 `manifest.json` 中增设明确的 `crawl_scope` 描述对象：

```json
{
  "spec_version": "bundle/1.4",
  "bundle_id": "20261010T120000Z-a1b2c3",
  "previous_bundle_id": null,
  "status": "complete",
  "created_at": "2026-10-10T12:00:00Z",
  "producer": {
    "name": "doubak-extension",
    "version": "1.1.0",
    "user_agent": "Mozilla/5.0 ..."
  },
  "account": {
    "user_id": "82160871",
    "username": "target_user",
    "profile_url": "https://www.douban.com/people/target_user/"
  },
  "crawl_scope": {
    "visibility": "public",
    "operator_mode": "anonymous",
    "skip_catalog": true,
    "issue_reference": "https://github.com/Doubak/doubak-extension/issues/19"
  },
  "notes": "这份档案是在公开数据模式下抓取的（未登录或操作者视角）。仅包含目标账号在豆瓣公开发布的标记、广播、长文与自建豆列，不包含任何私密条目。"
}
```

#### 4.6.2 摄取规则与连续性权限约束（`INGESTION.md` 映射）
在 `crawl_state` 中，各路线的枚举模式处理如下：
- **`enumeration` 设为 `bounded`（或在存在 `crawl_scope.visibility === 'public'` 时约束权限）**：
  在 `authority.js` 中增加判定规则：
  ```javascript
  // 公开归档不具备对「私密记录」的删除解释权
  if (manifest.crawl_scope?.visibility === 'public') {
    // 权限自动降级或仅限公开记录比对，绝不向历史私密条目推导删除
  }
  ```
  这样，即使用户未来找回账号进行了完整的自归档，并与此前的公开抢救归档合并，解析器也不会将「公开归档里没有私密日记」解释为「用户删除了私密日记」。

---

### 4.7 节奏控制与反爬安全策略（Pacing Policy）

| 会话模式 | 基础请求间隔 | 随机抖动（Jitter） | 说明与安全保障 |
|---|---|---|---|
| **本人自归档（基准）** | 1.5s ~ 3.0s | ±20% | 现有生产校准参数。 |
| **小号登录抓取他人** | 2.5s ~ 4.5s | ±25% | 略微放慢，保护小号不触发频控。 |
| **纯未登录匿名抓取** | 4.0s ~ 7.0s | ±30% | 显著放缓，保护本机 IP 免遭豆瓣封锁。 |

- **遇到 `challenge`（验证码）时的行为**：
  - 若已登录小号：提示用户在新标签页中登录该小号完成验证码，验证后点击「继续」。
  - 若纯未登录：提示用户在新标签页打开豆瓣任一页面完成人机验证。

> **注**：完整的界面与交互设计（涵盖抓取、导出、导入、预览与覆盖率）已作为核心议题独立提升至 [**第 6 章：界面与交互全景详细设计**](#6-界面与交互全景详细设计ui--ux-抓取--导出--导入--预览--覆盖率) 进行条款级展开。

---

## 5. 深入 specs：逐文件变动分析与规范演进推演

为了彻底评估新功能对生态的影响，我们对 `doubak-data-specs` 规范仓库中的每一份文件进行条款级（Clause-level）研读与推演。

### 5.1 `bundle/v1/manifest.schema.json` 变动分析

#### 现状规则
在当前规范（`bundle/1.4`）中：
- 顶层声明了 `"additionalProperties": true`（L254）。
- `account` 对象声明了 `user_id` 为必填项，且同样允许 `"additionalProperties": true`（L104）。
- `spec_version` 引用 `common.schema.json#/$defs/spec_version`，匹配 `^bundle/1\.[0-9]+$`。

#### 各方案改动需求
1. **方案 A（分层会话与目标解耦）**：
   - **路径 1（阶段一：即刻兼容实现，零规范修改）**：
     在 `manifest.json` 中直接附带 `crawl_scope` 对象。由于 `additionalProperties: true`，现有的 `manifest.schema.json` **完全无需修改**，现有的 `validate.py`（基于 jsonschema Draft2020-12 校验器）直接判定通过。
   - **路径 2（阶段二：形式化演进，推荐递增至 `bundle/1.5`）**：
     在 `manifest.schema.json` 中显式定义 `crawl_scope` 属性，提升元数据的自解释性：
     ```json
     "crawl_scope": {
       "type": "object",
       "description": "本次抓取的可见性范围与执行模式。未提供时默认为本人完整自归档（self）。",
       "properties": {
         "visibility": {
           "type": "string",
           "enum": ["self", "public"],
           "description": "视图可见性。self=本人完整视图（含私密条目）；public=公开表面视图（不含私密条目）。"
         },
         "operator_mode": {
           "type": "string",
           "enum": ["authenticated", "anonymous"],
           "description": "执行抓取的操作者会话状态。authenticated=已登录小号；anonymous=纯匿名访客。"
         },
         "operator_account": {
           "type": "object",
           "description": "当 operator_mode 为 authenticated 时，记录发起抓取的操作者账号信息，用于审计与防漂移。",
           "properties": {
             "user_id": { "type": "string" },
             "username": { "type": ["string", "null"] }
           },
           "required": ["user_id"]
         },
         "skip_catalog": {
           "type": "boolean",
           "description": "是否跳过作品详情页（catalog-*）。公开抓取建议设为 true，可削减 85%+ 的请求配额。"
         }
       },
       "required": ["visibility", "operator_mode"],
       "additionalProperties": true
     }
     ```
2. **方案 B（平行外挂爬虫）**：
   - 若外挂爬虫试图拼凑 bundle，常因缺少前端精准状态而无法生成完备的 `segments`、`coverage` 或 `crawl_state`，将面临 schema 必填项缺失。
   - 若输出非 bundle 格式（如 custom jsonl/zip），则彻底脱离 `manifest.schema.json`，需在 specs 另立门户建立新 schema。
3. **方案 C（外部导入适配器）**：
   - 无需修改 `manifest.schema.json`。导入生成的 bundle 使用 `bundle/1.3` 起支持的 `capture_fidelity: "decoded_body+synthesized_headers"`，在 `producer.name` 和 `manifest.notes` 声明导入来源即可。

---

### 5.2 `bundle/v1/SPEC.md` 语义变动分析

#### 现状规则
- **§1.1**：“事后能从 WARC 重新算出来的，都是可选的；事后算不出来的，第一版就必须有。”
- **§5.4.3**：“`floor_time` 非 null 的路线，`enumeration` 必须是 `bounded`。”
- **§5.5.1b**：“基准必须是同一个账号、同一个用户名。数字 ID 不同就是别人的档案，不得当基准。”
- **§6.3**：“豆瓣以 HTTP 200 返回封锁页。只看状态码等于完全没有检测。每个响应必须得到一个 verdict。”

#### 各方案改动需求
1. **方案 A（分层会话与目标解耦）**：
   - **§5.1 修订**：新增 `crawl_scope` 的字段规范说明，定义 `visibility` 与 `operator_mode` 的互斥与默认值。
   - **§5.5.1b 基准链不变量重要升级**：
     > **【核心不变量补充】公开归档（`visibility: public`）不得作为本人自归档（`visibility: self`）的增量基准（`floor_from_bundle_id`）。**
     - **技术原理**：公开归档从上游无法读取私密条目。如果用户未来找回账号进行本人自归档，若错误地以公开归档为基准推进了水位线（`high_water_time`），自归档将跳过公开归档覆盖的那段时间，导致**在此期间创建的私密条目被永久漏抓**！
     - **正确拓扑**：公开归档与本人自归档在链上应当作为**同一个账号的两个分叉分支（Forked Chains）**存在。依据 `INGESTION.md` §5.2（“分叉不是矛盾，两条分支只是同一个账号的两批观测”），解析器会自然地将两批观测取并集摄取，既不会漏掉私密条目，也不会污染增量水位线。
   - **§6.3 判定澄清**：
     - 在公开数据归档模式下，合法的公开页面返回的 `verdict` **必须为 `ok`**，绝不能记为 `login`。只有遇到 302 重定向到 `passport/login`、包含 `<title>登录豆瓣</title>` 或验证码阻断时，才记为 `login` 或 `blocked`。
2. **方案 B（平行外挂爬虫）**：
   - 严重破坏 `SPEC.md` §6.5（强制要求空响应必须有 verdict、零长度载荷不得记为 ok）、§7.1（checkpoint 连续性证明）和 §8.1（严格落盘顺序）。
3. **方案 C（外部导入适配器）**：
   - `SPEC.md` §6.4.1 已经完全为外部导入准备好了合规路径，规范文本无需改动。

---

### 5.3 `bundle/v1/validate.py` 校验器兼容性分析

#### 现状规则
`validate.py` 分为两层检查：
1. **结构性检查（Integrity Checks，无依赖）**：
   - 检查 `README.txt` 是否存在并说明规范版本和 WARC 打开方式（L160-172）；
   - 检查各段文件哈希与大小（L179-195）；
   - 检查 index 行数与 SHA256（L197-222）；
   - 检查 `EMPTY_SHA256` 载荷不得为 `verdict=ok`（L253-257）；
   - 检查每个 index 偏移量是否对应合法的 gzip member 与 WARC record id（L263-281）；
   - 检查 `coverage` 中 `claimed_count` 必须有对应的 `claimed_source` 捕获（L334-346）；
   - 检查 `crawl_state`：`advanced=true` 必须蕴含 `contiguous=true ∧ gaps=[] ∧ high_water_time!=null`（L358-372）；`floor_time` 非 null 时必须写 `bounded`（L381-387）。
2. **Schema 校验（Conformance Checks，基于 jsonschema）**。

#### 各方案改动需求
1. **方案 A（分层会话与目标解耦）**：
   - **零修改！直接 100% 通过**！
   - 方案 A 生成的 bundle 是标准的 WARC、标准的 index.ndjson、标准的 manifest.json。
   - 其数字用户 ID 即为目标账号 ID，`claimed_source` 真实存在，WARC 块真实可解压。
   - `validate.py` 运行时退出码恒为 0。
2. **方案 B（平行外挂爬虫）**：
   - 外挂爬虫若未完整实现 WARC gzip member 组装或丢失 `claimed_source`，`validate.py` 会直接以退出码 2（完整性错误）阻断。若想通过，必须削弱 `validate.py` 的校验逻辑。
3. **方案 C（外部导入适配器）**：
   - 只要导入适配器正确构造 WARC 和索引，`validate.py` 零修改通过。

---

### 5.4 `canonical/INGESTION.md` 摄取规则变动分析（核心防线）

这是整个规范体系中**最关键、最需慎重设计**的部分。

#### 核心矛盾：假删除与假编辑陷阱
在 `INGESTION.md` 中：
- **§2.2** 记录了前代真实事故：2023-01 匿名抓取了 105 页电影，条目全部抓到但无标签、无私密条目。若把它当普通内容读入，解析器会推出**四万条假编辑（误判用户删除了所有标签，后来又重新加上）**。
- **§3 缺失推断权限三级定义**：
  - `whole_route`: `enumeration = full ∧ contiguous ∧ gaps = [] ∧ status = complete`
  - `above_floor`: `enumeration = bounded ∧ contiguous ∧ gaps = [] ∧ status = complete ∧ floor_time ≠ null`
  - `none`: 任何缺失都不得解释为删除。
- **§4.2 删除推断**：一条记录在窗口 A 中存在，在窗口 B 中消失，且 B 的权限覆盖 A 的时间位置，则判定该记录被删除。

#### 致命风险推演
假设目标账号曾在 2024 年使用本人登录态抓取过一份完整自归档 A（含 50 条私密日记和标记标签）。
2026 年账号被封，用户使用公开模式（无论是方案 A 还是方案 C）抓取了一份全量公开归档 B：
- 归档 B 从头翻到了尾，`enumeration` 被记为 `full`，无缺口，`status = complete`。
- 若按照现有 `INGESTION.md` §3，归档 B 将被赋予 `whole_route` 权限！
- 当解析器合并 A 与 B 时：发现 A 中的 50 条私密条目在 B 中全都不见了，而 B 拥有 `whole_route` 权限，于是断定：**用户在 2026 年删除了全部 50 条私密内容**！
- 同时，若 B 是纯未登录匿名抓取，所有条目的 tags 全都不见了，解析器会断定：**用户在 2026 年清空了全部标记的标签**！

#### 对 `canonical/INGESTION.md` 的必须修订
为了彻底封死假删除漏洞，必须在 `INGESTION.md` §3 与 §5 增加针对公开归档的约束：

##### 修订策略对比
- **策略 1（最保守、最优雅、零 Schema 变更：公开归档权限恒降为 `none`）——【强烈推荐】**：
  在 `INGESTION.md` §3 中增加一条铁律：
  > **凡来自 `crawl_scope.visibility: "public"` 的 bundle，其 `absence_authority` 恒为 `none`。**
  - **理论依据**：备份他人账号或抢救封禁账号的核心目的在于**抢救已有的内容（增量观测）**，外界根本无从获知目标用户在私密域发生了什么。因此公开归档天然没有资格宣布「没看见的东西被删除了」。
  - **收益**：既有数据模型中的 `absence_authority` 枚举（`whole_route | above_floor | none`）**完全不需要改**！解析器仅需一行代码判断：
    ```javascript
    if (manifest.crawl_scope?.visibility === 'public') {
      routeAuthority = 'none';
    }
    ```
- **策略 2（细粒度权限：引入 `whole_public_route`）**：
  允许公开归档对「明确已知的公开条目」行使删除推断权，但对私密条目降权为 `none`。
  - **代价**：需在 `canonical/v1/common.schema.json` 中扩展枚举，且解析器需跟踪每个条目的历史可见性状态，复杂度大增。
  - **结论**：现阶段采纳**策略 1**最为稳健。

##### 标签（Tags）保护规则补充
在 `INGESTION.md` §5.4 中补充：
> 当观测来自 `crawl_scope.operator_mode: "anonymous"`（匿名访客）时，页面上缺失的标签应当被标记为 `omitted`（未观测），**不得**生成 `fields.tags: null` 或 `[]` 的修订，严禁触发批量假编辑。

---

### 5.5 `canonical/IDENTITY.md` 与 `canonical/FIELDS.md` 变动分析

#### 现状规则
- `IDENTITY.md` §2：身份判定按 `data-cid`（第 1 层）→ 退化键 `(account, medium, subject)`（第 2 层）逐级降级。
- `FIELDS.md` §1：“canonical 不得把任何来自页面的字段设为必填。”

#### 各方案改动需求
- **零改动**！
- 无论是方案 A、B 还是 C：
  - 公开列表页上的条目在 HTML 中同样包含 `data-cid`（电影/图书/音乐/舞台剧）或删除接口（游戏）。条目能够 100% 对齐到既有的 `upstream_id` 或退化键。
  - 公开数据中缺失的私密字段完全符合 `FIELDS.md` 的全字段可选契约。

---

### 5.6 `canonical/v1/*.schema.json` 数据模型变动分析

- **`common.schema.json`**：
  由于采纳策略 1（公开归档映射为 `absence_authority: "none"`），现有的 `absence_authority` 枚举（`["whole_route", "above_floor", "none"]`）完全满足需求，**零改动**。
- **`mark.schema.json`** / **`broadcast.schema.json`** / **`longform.schema.json`**：
  所有条目 schema 的必填字段仅为 `account.user_id`、`medium` 等元信息，数据字段均允许为 null。**零改动**。

---

### 5.7 三种方案对 Specs 规范影响的综合裁决

| 评估维度 | 方案 A：分层会话与目标解耦 | 方案 B：平行外挂式公开爬虫 | 方案 C：外部导入适配器 |
|---|---|---|---|
| **对规范整体架构的破坏性** | **零破坏**（天然融入现有体系） | **极高**（要么另立新规范，要么违背现有硬约束） | **零破坏**（复用导入规范） |
| **`bundle/` 容器层改动** | 仅 `manifest.json` 补充 `crawl_scope`，增补增量基准链说明 | 无法维持 WARC 与连续性证明合规性 | 零改动（复用 `capture_fidelity` 导入机制） |
| **`canonical/` 摄取层改动** | `INGESTION.md` 明确公开归档 `absence_authority = none` 铁律 | 无法进入 canonical，或同方案 A | `INGESTION.md` 同样必须增加权限降级规则 |
| **测试与校验器成本** | `validate.py` 零修改自动通过 | 极高（需定制放宽规则） | 零修改自动通过 |

---

### 5.8 跨仓库演进影响与协同矩阵

| 仓库 / 组件 | 角色与定位 | 改动需求与演进计划 |
|---|---|---|
| **`doubak-data-specs`** | 规范源头定义 | 1. 在 `bundle/v1/SPEC.md` 中增补 `crawl_scope` 与公开链拓扑说明；<br>2. 在 `canonical/INGESTION.md` 中明确公开归档的 `absence_authority = none` 铁律；<br>3. 在 `bundle/v1/manifest.schema.json` 增设可选的 `crawl_scope`（推进至 `bundle/1.5`）。 |
| **`doubak-extension`** | 采集与执行端 | 1. 重构 `SessionGuard` 支持目标与操作者解耦；<br>2. 调整 `classifier.js` 支持公开视图放行；<br>3. 概览页增加多账号输入与轻量化抓取开关；<br>4. 产出符合 `crawl_scope` 的 manifest。 |
| **`doubak-data-parser`** | 规范摄取引擎 | 1. 识别 `manifest.crawl_scope.visibility === 'public'`，自动将其 `absence_authority` 置为 `none`，杜绝假删除；<br>2. 匿名模式下将缺失的 tags 标为 omitted，杜绝假编辑。 |
| **`doubak-export-adapters`** | 下游应用导出 | **零改动**。NeoDB 导入包与 Markdown 导出仅消费 canonical 数据，无需感知数据来源是自归档还是公开归档。 |
| **`doubak-site-generator`** | 离线静态站点 | **零改动**。模板按既有逻辑渲染已有的公开内容。 |

---

## 6. 界面与交互全景详细设计（UI & UX: 抓取 / 导出 / 导入 / 预览 / 覆盖率）

本节依据 [**`docs/ui.md`**](file:///home/mewx/codes/doubak/doubak-extension/docs/ui.md) 确立的交互哲学、系统状态模型与设计系统规范，对「公开数据归档」新特性在管理面板各主视图中的交互行为、状态机、错误反馈与文案设计进行条款级详尽定义。

---

### 6.0 核心设计哲学与界面硬约束（承袭 `docs/ui.md`）

在进入各页面具体设计前，必须重申豆备界面所恪守的五项核心军规：
1. **状态不在内存里**（`ui.md` §0）：界面不是状态的持有者，只是 IndexedDB 与 OPFS 状态的纯视图。面板随时可能关闭，恢复打开后必须能无缝还原真实数据状态。
2. **计数不可信，进度条绝不撒谎**（`ui.md` §4.1）：豆瓣页面的条目计数器随时受到社区审查过滤影响。**严禁用「豆瓣声称的总数」作为抓取进度条的分母**。广播使用「累计中位数回溯到的日期」，标记列表使用「绝对条数 + 当前页码」。
3. **书面语，且不是 Markdown**（`ui.md` §8.5）：面向用户的文本必须是严谨的书面语，且必须是纯文本或语义 HTML（强调使用 `<b>`，**代码中严禁写入 `**粗体**` 等 Markdown 标记**，严防星号直接渲染在界面上）。
4. **统一卡片语气与动作可执行性**（`ui.md` §4.9）：所有提示框严格通过 `statusCard(tone)` 渲染（`idle` / `busy` / `ok` / `warn` / `error`），且每个 `warn` 与 `error` **必须配备明确的下一步可执行动作**。
5. **说人话，不暴露内部术语**（`ui.md` §9）：界面上禁止出现 `frontier`、`verdict`、`bundle` 等工程实现词汇，统一翻译为「队列」「判定」「档案」。

---

### 6.1 抓取（Crawl / Overview）：统一自适应输入与会话动态感知工作流

#### 6.1.1 核心设计理念：单输入框融合两大流程，零割裂感
传统设计常采用突兀的模式切换单选框（如“模式一：本人归档” vs “模式二：他人公开归档”），这不仅增加了用户的认知负担，而且当用户在“模式二”中误输入自己账号时还会引发尴尬的中断。

新方案遵循 [**`docs/ui.md`**](file:///home/mewx/codes/doubak/doubak-extension/docs/ui.md) 的平实质感，将抓取流程**彻底统一为一个自适应输入与状态感知的单一界面**：
1. **自动感知已登录账号**：后台静默读取当前会话，动态在顶部呈现当前登录状态（如“已检测到当前登录账号：mewcatcher”）。
2. **默认留空即自归档**：输入框初始为空。用户不填写任何内容时，默认就是为当前登录账号发起【本人完整自归档】（零学习成本，老用户心智 100% 保持不变）。
3. **输入覆盖目标（Target Override）**：
   - 用户输入内容时，系统将其视为对抓取目标的覆盖设定。
   - **若输入的正是当前登录账号**：系统自动识别并正面确认：“✔ 已匹配当前登录账号”，流程无缝延续为本人自归档，不报错、不弹多余确认框。
   - **若输入的是第三方公开账号**：系统自动触发 Preflight 探测，平滑切换为第三方公开归档流程，并呈现公开归档专属的范围与轻量化选项。
   - **若当前浏览器未登录任何账号**：顶部显示“当前未登录”，若留空则提示登录或输入公开网址；若填写了公开网址则顺畅进入匿名抓取流程。

#### 6.1.2 统一概览页界面布局与状态机

```
┌────────────────────────────────────────────────────────────────────────┐
│  豆瓣账号数据归档                                                        │
│                                                                        │
│  [已登录] 当前登录账号：mewcatcher（数字 ID：12345678）                 │
│                                                                        │
│  目标账号（留空则默认归档当前登录账号）：                                │
│  ┌──────────────────────────────────────────────────────────┐ ┌──────┐ │
│  │ https://www.douban.com/people/... 或留空                 │ │ 探测 │ │
│  └──────────────────────────────────────────────────────────┘ └──────┘ │
│  支持输入目标个人主页网址、自定义域名（slug）或豆瓣纯数字 ID。留空直接自归档。 │
│                                                                        │
│  状态：将为当前登录账号（mewcatcher）发起完整自归档                       │
│  范围：包含全部私密日记、私密标记、广播、豆列与设置（完整凭证保护）        │
│                                                                        │
│  [ 开始抓取 ]                                                           │
└────────────────────────────────────────────────────────────────────────┘
```

##### 状态机分支（Dynamic Workflow States）与反馈：

1. **分支 A：留空状态（默认登录自归档）**
   - 界面呈现：输入框保持为空（带有浅灰色占位符 `留空则完整归档当前登录账号`）。
   - 状态说明：`将为当前登录账号（mewcatcher）发起完整自归档，包含私密内容与完整标签`。
   - 主按钮：`[ 开始抓取 ]`（启用态）。
   - 用户行为：直接点击主按钮即可开始，原有单用户使用路径零破坏。

2. **分支 B：输入本人账号（静默合流，体验无缝）**
   - 触发条件：输入框填入的内容经解析后，其 `target.userId === operator.userId`。
   - 界面呈现：
     ```
     ✔ 已匹配当前登录账号 mewcatcher（数字 ID：12345678）
     状态：自动启用【本人完整自归档】（可完整备份私密日记、私密标记与完整标签）
     ```
   - 主按钮：`[ 开始抓取 ]`。无需弹窗阻断，无需二选一切换。

3. **分支 C：输入第三方公开账号（自动展开 Preflight 选项）**
   - 触发条件：输入框填入的内容指向另一个公开用户。
   - 界面平滑展开探测卡片：
     ```
     ✔ 已识别第三方公开账号：target_user（昵称：豆友A，数字 ID：87654321）
     发起者状态：当前已登录小号 (mewcatcher) 将作为请求发起者（配额充足、可读标签）

     抓取范围选项：
     [✔] 仅归档用户原创内容与标记列表（推荐）
         跳过几千页公共条目详情，请求量减少约 85%，有效防止访问受限。
     [✔] 包含作品封面图（离线渲染所需）

     [ 开始抓取公开数据 ]
     ```
   - 主按钮变为：`[ 开始抓取公开数据 ]`。

4. **分支 D：未登录态访问**
   - 触发条件：浏览器 Cookie 中无有效登录凭证（`operator == null`）。
   - 顶部状态：`未检测到登录账号`。
   - 若留空：主按钮禁用，提示：`请先在浏览器中登录豆瓣账号，或在上方填入需要备份的公开主页网址`。
   - 若填入公开账号：自动开启匿名公开抓取分支。

##### 探测状态机（Preflight States）与反馈文案
1. **输入与提交**：
   - 允许输入 URL（如 `https://www.douban.com/people/target_user/`）、用户名 slug（`target_user`）或纯数字 ID（`12345678`）。
   - 点击 `[ 验证 ]` 时，按钮禁用，状态切为 `busy`：“正在探测账号信息…”
2. **正常成功（Tone: `ok`）**：
   - 显示探测到的头像、昵称、用户名以及提取到的稳定数字 ID（注明提取来源，例如 RSS 链接或主页广播）。
   - 同时清晰说明当前浏览器环境的操作者身份：
     - 若当前已登录账号 B：`“发起者：当前已登录小号 (bot_user) 将作为请求发起者（配额充足、可抓取标签）”`
     - 若未登录（访客模式）：`“发起者：纯未登录匿名访客模式（请求节奏将放缓、页面无标签渲染）”`
3. **异常情况与账号冲突处理（严格遵守 `ui.md` §5）**：
   - **情形 1：软封禁账号（主页停用，但列表可读）**：
     - 卡片（`warn`）：`<b>账号主页已停用</b> 该账号个人主页显示停用，但看电影/看书列表仍可读。豆备将尽力抓取所有可访问的公开列表。`
     - 动作：允许用户继续点击 `[ 开始抓取公开数据 ]`。
   - **情形 2：硬删除账号（404 / 页面不存在）**：
     - 卡片（`error`）：`<b>目标账号不存在</b> 豆瓣提示该用户不存在或已被彻底注销。公开页面均已下线，无法获取数据。`
     - 动作：`[ 重新输入 ]`。主按钮保持禁用。
   - **情形 3：IP 受限（403 / 阻断）**：
     - 卡片（`warn`）：`<b>当前访问受限</b> 豆瓣暂时限制了当前 IP 的匿名访问。建议在浏览器新标签页登录任一豆瓣账号（作为发起者），或稍后再试。`
     - 动作：`[ 打开豆瓣登录 ]` `[ 重新探测 ]`。
   - **情形 4：输入的是当前登录账号自身（`target.userId === operator.userId`）**：
     - 用户在「备份其他公开账号」中输入了当前浏览器登录的账号链接，系统主动拦截并弹出引导卡片，防止误操作丢失私密条目：
     ```
     ┌───────────────────────────────────────────────────────────────┐
     │  ⓘ 提示：你输入的是当前登录的账号自身                           │
     │                                                               │
     │  目标账号：mewcatcher（12345678）与当前浏览器登录的账号一致。        │
     │                                                               │
     │  你通常应当选择【本人完整自归档】：                              │
     │  · 包含私密标记（仅自己可见）、私密日记、广播及完整个人设置。      │
     │  · 支持正常的增量更新与连续性保障。                             │
     │                                                               │
     │  若你依然希望仅备份公开视图（例如测试外界可见效果）：              │
     │  · 将跳过全部私密条目，产出独立的公开视图档案。                    │
     │                                                               │
     │  [ 切换为本人完整自归档（推荐） ]   [ 仍然作为公开视图备份 ]        │
     └───────────────────────────────────────────────────────────────┘
     ```
   - **情形 5：同 UID 更改了个性域名（Slug Drift）**：
     - 探测到的数字 ID 与本地历史归档一致（`target.userId === historical.userId`），但域名发生了变动（如由 `old_slug` 变更为 `new_slug`）：
     ```
     ┌───────────────────────────────────────────────────────────────┐
     │  ⓘ 检测到账号域名已由 old_slug 变更为 new_slug                  │
     │                                                               │
     │  数字 ID（12345678）保持一致，确认归属于同一账号。               │
     │  因豆瓣页面网址随域名变更，本次抓取将作为【新的全量基准】进行，   │
     │  以确保所有新网址被完整归档。旧档案依然完整保留在本地。          │
     │                                                               │
     │  [ 开始新的全量基准抓取 ]                                       │
     └───────────────────────────────────────────────────────────────┘
     ```
   - **情形 6：异 UID 抢注碰撞（Slug Collision / 域名被他人抢注或注销后他人接盘）**：
     - 用户输入的域名与本地某份历史档案一致，但当前探测到的数字 UID 与历史档案不一致（例如他人抢注了该域名，或用户输入了别人注销后自己新占用的域名）：
     ```
     ┌───────────────────────────────────────────────────────────────┐
     │  ⚠ 注意：检测到域名归属发生变更                                 │
     │                                                               │
     │  当前探测到的账号：用户 B（数字 ID：99999）                     │
     │  本地已有历史档案：用户 A（数字 ID：10001，历史域名也是 cat）     │
     │                                                               │
     │  说明：豆瓣域名「cat」已更换主人。当前抓取将作为【全新账号】独立  │
     │  存储与归档，绝对不会与旧账号 A 的历史数据合并或混淆。           │
     │                                                               │
     │  [ 我已知晓，继续抓取新用户 B ]                                 │
     └───────────────────────────────────────────────────────────────┘
     ```
   - **情形 7：输入纯数字 ID（如 `82160871`）的自动重定向与 Slug 绑定**：
     - 探测器请求后自动跟随豆瓣 302 重定向至最新个性域名，并同时在界面反馈中渲染展示：`✔ 已识别：用户 mewcatcher（数字 ID：82160871，已绑定最新个性域名 mewcatcher）`。

#### 6.1.3 运行态实时反馈（Running State）
一旦点击开始，概览页转入运行态。严格遵守 `ui.md` §4.4b 与 §4.4d：
- **状态卡片**：
  ```
  正在抓取公开数据 · 目标 target_user (12345678) · 发起者 小号 bot_user [ 暂停 ] [ 中止 ]
  当前间隔 3.5 秒（公开模式） · 正在抓 movie.douban.com/people/target_user/collect?start=30
  ```
- **路线进度表**：
  - 复用 DOM 行，避免每两秒重画导致的文字抖动与光标丢失；
  - 广播路线显示：“已抓 1,842 条 · 已回溯到 2023-04-12（每页中位数）”；
  - 标记列表显示：“已抓 620 条 · 第 21 页”；
  - 跳过作品详情页时，作品详情行明确显示：“已跳过（轻量化模式）”；
- **暂停与中止控制**：
  - 点击 `[ 暂停 ]`：立即给出即时反馈：`“正在暂停…（当前页面抓取完毕后即会停下，已抓取数据完整保留）”`，不让用户因 22 秒批次延迟而误以为界面卡死。
  - 点击 `[ 中止 ]`：弹出二次确认，说明“中止后将收尾为已中止状态，已抓取数据全部留存可查，此后档案可被安全删除”。

---

### 6.2 覆盖率（Coverage / Chain Reconciliation）：多账号对账与差值事实

覆盖率页（[**`src/ui/panel/coverage.js`**](file:///home/mewx/codes/doubak/doubak-extension/src/ui/panel/coverage.js)）的核心使命是解答「抓到了哪儿、链条完不完整」。

#### 6.2.1 账号选择与视角切换
当本地存储存在多账号归档时，覆盖率页顶部呈现两级控制栏：

```
┌────────────────────────────────────────────────────────────────────────┐
│  对账账号： [ mewcatcher (本人自归档) ]   [ ● target_user (公开归档) ]    │
│  对账视角： [ ● 合起来 (整条链) ]   [ ○ 这一份 (单次抓取) ]               │
└────────────────────────────────────────────────────────────────────────┘
```

#### 6.2.2 链条图拓扑（Chain View）
依据 `SPEC.md` §5.5.1b 与 `ui.md` §8.6，链条箭头始终朝向更早的一份：
```
7a8b9c (公开全量) → [ 起点 ]
```
- **隔离不变量展示**：公开归档与本人自归档在界面上各自形成独立的链条，**绝不串链**。即使用户先有一份自归档，后有一份公开归档，界面也清晰说明两者属于不同的观测分支，避免给用户造成「链条断裂」的假象。

#### 6.2.3 公开归档专属对账事实表（覆盖率说事实，不下判断）

```
┌────────────────────────────────────────────────────────────────────────┐
│  覆盖率对账 · 目标 target_user                                          │
│                                                                        │
│  ⓘ 这是公开数据归档：目标账号设为私密的条目（仅自己可见）不会出现在公开页面上。    │
│    因此「豆瓣声称计数 > 实际抓到」是正常的公开视图差异，不是遗漏。                 │
│    完整性由抓取过程自身的连续性证明保证。                                │
│                                                                        │
│  路线              豆瓣声称   实际抓到   差值   连续性                  │
│  ───────────────────────────────────────────────────────────────       │
│  电影 / 看过         1,157     1,120     −37    ✔ 已验证                │
│  电影 / 想看           627       627       0    ✔ 已验证                │
│  日记                   42        35      −7    ✔ 已验证                │
│  广播                    —     1,842       —    ✔ 已验证                │
│  作品详情页              —         —       —    跳过（轻量化模式）        │
│                                                                        │
│  ⓘ 「电影 / 看过」差值 37 条：该账号存在 37 条仅自己可见的私密标记，公开不可见。 │
│    本次公开抓取从第 1 页至最后一页连续完整，无任何抓取缺口。                 │
└────────────────────────────────────────────────────────────────────────┘
```

- **文案与设计原则**：
  - 差值列**不使用红色，不加叹号**；
  - 明确解释公开视图与私密条目的客观存在，不将私密缺失断言为抓取失败；
  - 完整性结论由「连续性证明」那一列担保：`✔ 已验证` / `有 N 处缺口` / `没走完`。

---

### 6.3 预览与档案（Archive & Preview / Captures / "验一验"）

档案页（[**`src/ui/panel/archive.js`**](file:///home/mewx/codes/doubak/doubak-extension/src/ui/panel/archive.js)）承担用户对归档内容的查看与自验证需求。

#### 6.3.1 档案列表（左栏）多账号分组
遵循 `ui.md` §4.9.2，档案列表固定在左侧自己滚动，右侧为详情。列表项明确标注账号归属与性质：

```
mewcatcher
  2026-08-01 10:50   全量              169 MB · 6,399 条 · 3eef52   已导出
target_user [公开]
  2026-10-11 12:00   公开全量           12 MB · 1,842 条 · 7a8b9c   未导出
```

#### 6.3.2 档案概览卡片（右栏顶部）
选中一份公开归档时，右栏顶部渲染其元数据特征卡片：

```
┌────────────────────────────────────────────────────────────────────────┐
│  档案 20261011T120000Z-7a8b9c                                          │
│                                                                        │
│  目标账号：target_user（数字 ID：12345678）                             │
│  归档性质：公开数据归档（抓取发起者：小号 bot_user）                      │
│  范围说明：跳过作品详情页（轻量化模式）                                   │
│  体积条数：12.4 MB · 1,842 次捕获 · 包含 1,120 条标记、35 篇日记、82 条广播  │
│                                                                        │
│  ⓘ 这份档案是在公开数据模式下抓取的。仅包含目标用户在豆瓣公开发布的内容，      │
│    不包含任何私密标记、私密日记或账号设置。                              │
│                                                                        │
│  [ 验一验 ]  [ 导出这份档案 (WARC) ]  [ 删除这份档案 ]                    │
└────────────────────────────────────────────────────────────────────────┘
```

#### 6.3.3 捕获列表翻看（Captures Inspector）
依据 `ui.md` §10.1，顺着 `index.ndjson` 列出每行捕获（零解压成本）：
- 列出：`电影 / 看过 · 第 3 页` ｜ `20 条 · 2024-05-01 → 2024-05-20` ｜ `体积 42 KB`。
- 判定：在公开归档中，正常的公开视图捕获判定为 `ok`，**正常行不显示任何多余判定文字**，保持视觉平稳；若出现被屏蔽或注销的条目，则标出 `gone` 或 `blocked`。
- 折叠容器：使用原生 `<details>` 单独汇总列出「有 2 条在豆瓣上已被删除（Gone）」以及未能抓取的重试记录。

#### 6.3.4 浏览器内解压校验（"验一验"）
点击 `[ 验一验 ]` 时：
- 纯前端 Worker 顺着 `index.ndjson` 逐行按 `offset`/`length` 取出 gzip member 解压；
- 逐字节核对 HTTP 正文与 `content_sha256`；
- 原生 `<progress>` 进度条显示解压与核验进度；
- 验证完毕后给出权威确定性结论：`✔ 档案内 1,842 条记录解压与哈希全部核对通过。档案自洽无损坏。`

---

### 6.4 导出（Export / Formats）：单账号隔离导出与派生格式适配

导出页（[**`src/ui/panel/formats.js`**](file:///home/mewx/codes/doubak/doubak-extension/src/ui/panel/formats.js)）负责将归档转换为人类可读和下游可用的派生格式。

#### 6.4.1 导出界面的多账号处置契约
导出的核心安全边界在于**绝对禁止跨账号混合导出**：
1. **单个 Bundle 与 Bundle 链条导出**：
   - 导出原始 WARC Bundle 或 Bundle 链属于容器层操作，天然以单 Bundle 或同一 UID 的增量链为单位，不受多账号影响。
2. **派生格式导出（NeoDB NDJSON、CSV、Markdown）**：
   - 若本地 OPFS 中仅存有 1 个账号：静默绑定该账号，直接展示各格式导出卡片，零多余点击；
   - 若本地 OPFS 中存有 >1 个账号（例如既有本人自归档，又有导入或抓取的第三方公开归档）：
     - 页面顶部必须展示显式的单选【账号选择器】；
     - 用户必须明确选择其中一个账号后，下方各个导出选项才被激活；
     - 导出的所有文件名、内部元数据均严格绑定该目标用户的数字 UID（如 `neodb-235807474.zip`），绝不混杂其他账号数据。

```
┌────────────────────────────────────────────────────────────────────────┐
│  选择要导出的账号：                                                     │
│  [ ● mewcatcher（本人自归档，共 14 份档案） ]                            │
│  [ ○ target_user（公开归档，共 2 份档案） ]                              │
└────────────────────────────────────────────────────────────────────────┘
```

#### 6.4.2 三种导出目标在公开归档下的行为定义
1. **Canonical 数据 (`doubak-canonical/`)**：
   - 导出规范化的 marks、broadcasts、longform NDJSON。
   - 界面说明：*“导出的记录已声明缺少删除推断权（absence_authority: none）。这是一份纯粹的公开观测记录，未来若与完整自归档合并，绝不会误判删除。”*
2. **NeoDB 导入包 (`doubak-neodb/`)**：
   - 生成标准的 NeoDB 导入 NDJSON。
   - 界面说明：*“包含目标用户的全部公开评分、短评与标记。私密条目因上游不可见未包含在内。”*
3. **Markdown 离线站点 (`doubak-markdown/`)**：
   - 生成 Hugo / 静态博客源文件。
   - 界面说明：*“目标账号公开发布的日记、书影评、广播与书影音清单均已完整生成。若抓取时跳过了条目详情页，作品详情页面将呈现为基础条目信息，不影响文字内容的完整阅读。”*

---

### 6.5 导入（Import / Scanning & Conflict Resolution）：批量无差别导入与多账号聚类展现

导入页（[**`src/ui/panel/import.js`**](file:///home/mewx/codes/doubak/doubak-extension/src/ui/panel/import.js)）负责将外界存储的 bundle 搬回扩展 OPFS。

#### 6.5.1 批量无差别导入（Batch Multi-Account Import）与自动聚类
在真实的归档流转中，用户往往会将自己多个时期的备份包、以及好友或公共人物的备份包放在同一个文件夹中整体备份。**系统不应强求用户预先手工分拣文件夹**：
- **无门槛选择**：用户直接选择包含多份 Bundle 的根文件夹或多个压缩包。
- **扫描器自动聚类（Auto Grouping by `user_id`）**：
  - `opfs-import-worker.js` 在扫描阶段读取各个 Bundle 的 `manifest.account.user_id` 与 `username`；
  - 自动按账号将档案分组归类，并在导入计划（Plan Import）卡片中清晰呈报：

```
┌────────────────────────────────────────────────────────────────────────┐
│  准备导入 5 份档案，共 62.4 MB（检测到 2 个账号）                       │
│                                                                        │
│  账号 1：mewcatcher（本人自归档 · 3 份档案）                            │
│  　• 全量基准　1a2b3c　24.1 MB                                         │
│  　• 增量档案　2b3c4d　12.0 MB                                         │
│  　• 增量档案　3c4d5e　 8.3 MB                                         │
│                                                                        │
│  账号 2：target_user（公开归档 · 2 份档案）                             │
│  　• 公开全量　7a8b9c　11.2 MB                                         │
│  　• 公开增量　8c9d0e　 6.8 MB                                         │
│                                                                        │
│  ⓘ 以上档案导入后将在扩展内独立归档管理，支持分账号查看对账与导出。       │
│                                                                        │
│  [ 确认批量导入全部 5 份档案 ]   [ 取消 ]                              │
└────────────────────────────────────────────────────────────────────────┘
```
- **原子分桶写入**：点击确认后，工作线程将各档案写入对应的 OPFS 目录分桶（`archives/<user_id>/<bundle_id>`），绝不发生账号间的数据串扰。

#### 6.5.2 导入安全与回滚保障
- **不变量**：导入操作通过专用 `opfs-import-worker.js` 执行，**只允许新建目录，绝对不修改任何已存在文件**。
- **原子性回滚**：导入过程中若出现 gzip 段校验失败或 SHA256 不符，整份新建目录自动销毁回滚，杜绝半成品坏档案留在 OPFS 中。

---

### 6.6 UI 规范与文案铁律对照表

| 界面区域 | 常见错误做法（严禁） | 豆备正确做法（必须执行） | 规范依据 |
|---|---|---|---|
| **抓取进度** | 用豆瓣声称的“共 1,157 部”作为分母显示 45% | 显示“已抓 620 条 · 第 21 页”，广播显示回溯日期 | `ui.md` §4.1 |
| **覆盖率差值** | 差值 -37 显示为醒目红字 ⚠ 并提示“数据丢失” | 正常灰色显示，注明“公开归档不含私密条目，完整性由连续性证明保证” | `ui.md` §4.2 |
| **错误提示** | 提示 `Error: 403 Forbidden` 或 `verdict: blocked` | 状态卡片（`warn`）：`<b>豆瓣暂时限制了访问</b> 抓取已停止，不会自动重试。建议等待 30 分钟。` | `ui.md` §5 |
| **多账号导出** | 将本地所有账号的标记合并打包导出给 NeoDB | 显式要求用户选择具体账号，每个账号各出独立文件 | `formats.js` L31-45 |
| **文本渲染** | 在 JS 模板字符串中书写 `**已识别**` | 纯文本节点或使用 `<b>已识别</b>`，样式统一走 `panel.css` | `ui.md` §8.5 |

---


## 7. 全生态工具链集成规范（Ecosystem Toolchain Integration）

在豆备的整体工程架构中，浏览器扩展（`doubak-extension`）只是数据的采集与容器封装端。采集产出的归档必须能够无缝、安全地流入整个豆备工具链体系：
- [**`doubak-data-specs`**](file:///home/mewx/codes/doubak/doubak-data-specs)：规范源头定义与模式校验；
- [**`doubak-data-parser`**](file:///home/mewx/codes/doubak/doubak-data-parser)：规范摄取引擎，将 bundle 转换为标准化 Canonical 事件日志；
- [**`doubak-export-adapters`**](file:///home/mewx/codes/doubak/doubak-export-adapters)：下游多目标格式导出器（NeoDB、CSV、Markdown）；
- [**`doubak-site-generator`**](file:///home/mewx/codes/doubak/doubak-site-generator)：离线静态站点生成器（Hugo 驱动）；
- [**`doubak-import-adapters`**](file:///home/mewx/codes/doubak/doubak-import-adapters)：外部历史爬虫与异构数据导入适配器。

为了彻底消除隐式依赖与数据串扰，全生态工具链在面对「公开归档」与「多第三方账号」时必须遵循统一的契约。

---

### 7.0 全生态工具链“多用户预检与单账号安全边界”通用契约（Multi-User Pre-Check Contract）

随着多账号归档的常态化，用户的输入目录中可能同时混合存放着本人历史档案以及多个抓取/导入的第三方公开档案。**为了从根本上杜绝跨账号数据混杂、串号以及隐私意外泄露，整个生态的消费端 CLI 工具必须遵循严格的统一预检铁律**：

```
                      【CLI 工具启动（parser / exporter / generator）】
                                             │
                                             ▼
                             【执行多用户预检（Pre-flight Scan）】
                       统计输入源中唯一的 account.user_id 数量
                                             │
                       ┌─────────────────────┴─────────────────────┐
                       ▼                                           ▼
            【检测到仅 1 个账号】                        【检测到 >1 个账号】
                       │                                           │
                       ▼                             ┌─────────────┴─────────────┐
             自动锁定该账号，顺畅执行                 ▼                           ▼
                                            已提供 --account <uid>      未提供 --account 参数
                                                     │                           │
                                                     ▼                           ▼
                                             仅过滤提取该账号数据       【立即以 Exit Code 1 阻断】
                                             继续安全执行               打印错误与所有检测到的账号
                                                                        提示添加 --account 参数
```

#### 1. 预检扫描规范（Scan Protocol）
- **`doubak-data-parser`**：在解析前先扫描输入目录下所有 bundle 的 `manifest.json`，收集所有 `account.user_id`；
- **`doubak-export-adapters`** 与 **`doubak-site-generator`**：在导出或建站前，快速扫描 Canonical 目录中 `marks.ndjson`、`broadcasts.ndjson` 与 `longform.ndjson` 前 1000 行及索引中的 `account.user_id`。

#### 2. 行为准则与阻断文案
- **单账号输入**：若检测到输入数据仅包含单一 `user_id`，工具自动以该账号为上下文继续执行，老用户单账号操作体验保持 100% 零感知；
- **多账号输入未指定参数**：若检测到输入数据包含多个不同 `user_id`，且命令行未指定 `--account` 参数，**工具必须立即以 Exit Code 1 阻断退出**，向 stderr 打印友好、明确的错误信息：
  ```text
  [ERROR] 检测到输入数据包含多个不同账号的数据：
    • 12345678 (mewcatcher)
    • 235807474 (target_user)
  为了防止跨账号数据混杂与隐私泄露，工具严禁在未指定账号的情况下混合处理数据。
  请使用 `--account <user_id>` 显式指定本次操作的目标账号。例如：
    node bin/export.js canonical/ --target neodb-ndjson --account 12345678
  ```
- **多账号输入已指定参数**：若用户显式指定了 `--account <user_id>`，工具仅摄取、导出或渲染与该 `user_id` 匹配的记录，忽略其他账号的数据。

---

### 7.1 `doubak-data-parser`：规范摄取与权限降级

`doubak-data-parser` 是整个系统中最关键的守护层。其核心职责是将不可变的 WARC/Segment 捕获解析为事件日志，并根据连续性证明裁决数据修订与删除。在处理第三方公开归档时，必须落实以下四项铁律：

```
                    【WARC 捕获 / Bundle 输入】
                                 │
                                 ▼
                     读取 manifest.crawl_scope
                                 │
                 ┌───────────────┴───────────────┐
                 ▼                               ▼
    visibility === 'authenticated'     visibility === 'public'
                 │                               │
                 ▼                               ▼
      正常连续性裁决                    【铁律 1：权限彻底降级】
  absenceAuthority 计算                absenceAuthority 恒为 'none'
  支持推断删除与假编辑审计               严禁推断任何未见条目为删除
                 │                               │
                 ▼                               ▼
      正常标签与作品解析                【铁律 2：匿名标签保护】
  tags 依页面如实更新                   若 operator_mode === 'anonymous'
                                        页面缺失 tags 视作 omitted
                                        严禁写入 tags: null 覆盖历史
```

#### 7.1.1 铁律 1：`absence_authority = none` 彻底降级（防假删除）
- **文件定位**：[`src/authority.js`](file:///home/mewx/codes/doubak/doubak-data-parser/src/authority.js#L20-L72)。
- **核心逻辑**：
  ```javascript
  export function absenceAuthority(crawlState, bundleStatus, coverage, crawlScope) {
    // 铁律：公开归档绝对没有资格解释「没看见」！
    if (crawlScope?.visibility === 'public') {
      return 'none';
    }
    // 原有常规逻辑...
  }
  ```
- **技术理由**：公开视图下，上游豆瓣天然过滤了用户的私密标记、私密日记与未公开豆列。如果将公开归档的连续性权限赋予 `whole_route`，解析器在对账时会得出“用户删除了这些私密条目”的荒谬结论，并在 Canonical 中追加假删除事件。将其强行置为 `'none'`，确保公开归档**只记录其确实看到的东西，绝对不下“未见即删除”的断言**。

#### 7.1.2 铁律 2：匿名模式下的标签保护（防假编辑）
- **文件定位**：[`src/extract.js`](file:///home/mewx/codes/doubak/doubak-data-parser/src/extract.js) 与 [`src/parse.js`](file:///home/mewx/codes/doubak/doubak-data-parser/src/parse.js#L713-L757)。
- **核心逻辑**：
  - 实测取证：当 `crawl_scope.operator_mode === 'anonymous'` 时，豆瓣公开标记列表 HTML 中不会输出 `<span class="tags">标签: ...</span>` 节点。
  - **防范灾难**：若解析器将缺失的标签直接提取为 `tags: null` 或 `tags: []`，并据此生成新的 Revision，会导致历史标记的所有标签被一次性抹除（真实历史案例如 2023-01 匿名抓取曾凭空制造 40,000 条假编辑）。
  - **契约调整**：若当前 bundle 声明为匿名公开模式，提取的标记对象标记为 `tags: OMITTED_BY_ANONYMOUS`。在 `upsertMark` 组装 Revision 时，**不将其与已有版本的标签做比对，直接沿用历史已观测到的标签集合**。

#### 7.1.3 铁律 3：公开广播流的作者归属严格过滤（防串入他人广播）
- **文件定位**：[`src/extract-broadcast.js`](file:///home/mewx/codes/doubak/doubak-data-parser/src/extract-broadcast.js)。
- **核心逻辑**：
  - 公开广播时间线（`www.douban.com/people/<id>/statuses`）中包含大量转播（reshares / 转发布告，DOM 中包裹在 `div.status-real-wrapper`）。
  - 在匿名公开抓取时，页面没有当前登录用户的个人标记，广播条目必须显式核验其发布者的 `user_id`：
    - 若条目为原创广播，其发布者必须严格匹配 `manifest.account.user_id`；
    - 若条目为转播，其主体关系必须精确标明 `action: 'reshare'`，而原作者的身份必须独立存放于 `original_author` 中，严禁将原作者的文字直接提取为目标用户的原创言论。

#### 7.1.4 铁律 4：作品目录轻量模式（`skip_catalog`）元数据优雅降级
- **文件定位**：[`src/parse.js`](file:///home/mewx/codes/doubak/doubak-data-parser/src/parse.js#L759-L785)（`upsertSubject`）。
- **核心逻辑**：
  - 在公开轻量归档中，为节省配额与时间，系统跳过了条目详情页（`https://movie.douban.com/subject/<id>/`）的抓取。
  - 此时 `subjects.ndjson` 仅能从标记列表的单行 HTML 提取 `title`、`cover_url`、`cover_url_key` 和 `raw_meta`。
  - 解析器维持规范现有行为：`aliases`、`info`（包含 ISBN、IMDb、导演、主演等）**如实保留为 `null`（表示未观测到），严禁填充为空字典 `{}` 或空数组 `[]`**。同时，`cover_url_key` 确保封面 CDN 域名轮换不触发假作品修订。

#### 7.1.5 多账号 Canonical 存储拓扑（Multi-Account Partitioning）
- 解析器 CLI 工具增加对多账号的支持：
  ```bash
  # 默认在目标账号专属目录下输出 Canonical
  node bin/parse.js input_bundles/ --account 1234567 --out canonical/1234567/
  ```
- 每一条输出记录的顶层对象均带上 `account: { user_id, username }`，确保多账号数据无论在分目录存放还是在单一目录下按行存储时，都具备唯一自解释性。

---

### 7.2 `doubak-export-adapters`：多账号导出隔离与下游目标适配

`doubak-export-adapters` 负责消费 Canonical 数据并向外部格式转化。在支持公开与第三方账号时，必须保障**单账号强隔离**与**字段缺失容灾**：

```
                    【Canonical 数据源】
                             │
                             ▼
                bin/export.js --account <uid>
                             │
       ┌─────────────────────┼─────────────────────┐
       ▼                     ▼                     ▼
【NeoDB NDJSON 导出】   【CSV 格式导出】      【Markdown 笔记导出】
targets/neodb-ndjson.js  targets/*.js           instructions.js
       │                     │                     │
       ▼                     ▼                     ▼
• 绑定目标 account_id   • 单账号独立 CSV       • 多账号分目录归档
• 默认 visibility: 0    • 提示私密项缺失       • 按作品年限归集
• 容忍 catalog 缺失     • Goodreads/Letterboxd • 支持离线静态阅读
```

#### 7.2.1 强制单账号导出隔离（Single-Account Isolation）
- **规范要求**：无论用户本地 OPFS 或目录中积累了多少个账号（本人账号 + 抓取的多个关注者账号），**严禁将不同账号的标记合并打包导出给同一个第三方平台**。
- **命令行契约**：
  ```bash
  # 必须显式声明目标账号，避免混杂导出
  node bin/export.js canonical/ --target neodb-ndjson --account 235807474 --out exports/235807474-neodb.zip
  ```
  若未指定 `--account` 且 Canonical 存在多个 `user_id`，导出工具必须主动阻断并打印可用账号列表供用户选择。

#### 7.2.2 NeoDB NDJSON 适配器（`neodb-ndjson.js`）适配细节
- **文件定位**：[`src/targets/neodb-ndjson.js`](file:///home/mewx/codes/doubak/doubak-export-adapters/src/targets/neodb-ndjson.js)。
- **可见性映射（Visibility Mapping）**：
  - 公开归档生成的所有 `ShelfLog`、`ShelfMember`、`Collection` 与 `Article`，其 `visibility` 明确赋为 `0`（公开）。
- **条目详情缺失容灾（Catalog-Resilient Fallback）**：
  - 遇到跳过详情页抓取的轻量归档时，`subject` 对象缺乏 IMDb 或 ISBN 数据。
  - 适配器依靠 `links` 字段（填入 `https://movie.douban.com/subject/<id>/`）与 `external_resources`，调用 NeoDB 的 URL 匹配通道，不因缺失本地详情页而丢弃该标记。
- **标签导出策略**：
  - 若标记因匿名公开模式缺少标签（`tags` 为 omitted），适配器**坚决不输出 `TagMember`**。NeoDB 导入器在没有看到 `TagMember` 时不会改变目标条目的现有标签，杜绝抹掉用户在 NeoDB 上已有的标签体系。

#### 7.2.3 CSV 适配器（Letterboxd / Goodreads）
- CSV 适配器为每位第三方账号生成专属的 CSV 清单（如 `1234567-letterboxd.csv`）。
- 在导出报告中明确告知用户：“该归档为第三方公开归档，不含未公开标记及私人短评。”

#### 7.2.4 Markdown 导出器
- 为每个账号创建独立目录树：`markdown_export/<user_id>/`。
- 将公开长评、公开日记与影视书影音标记结构化输出为前置 YAML 元数据的 Markdown 文档，适合 Obsidian、Logseq 等本地知识库直接导入。

---

### 7.3 `doubak-site-generator`：多账号静态站点生成与私密旁路防护

`doubak-site-generator` 将 Canonical 数据编译为离线静态 Hugo 站点。当处理第三方公开账号时，核心挑战在于**作者身份切换**与**私密旁路防护**：

```
                    【Canonical 数据输入】
                             │
                             ▼
                bin/generate.js --account <uid>
                             │
                 ┌───────────┴───────────┐
                 ▼                       ▼
      【作者身份注入】               【私密旁路防护】
   • Header: 目标用户昵称          • private.js 严格执行
   • Bio: 目标用户签名            • 抑制私密日记空标签
   • Avatar: 目标用户头像         • 不显示无意义 🔒 占位符
   • 严禁展示操作者身份           • 保障公开站点纯净优雅
```

#### 7.3.1 多账号站点生成拓扑与预检
- **多用户预检铁律**：
  建站命令 `bin/generate.js` 首先执行 7.0 节定义的预检。若输入目录包含多个账号且未指定 `--account`，立即阻断报错，防止将两个用户的标记混在一个网站的首页和时间线上。
- **单账号专属站点（默认模式）**：
  ```bash
  # 针对指定账号生成专属独立站点
  node bin/generate.js --canonical canonical/ --account 1234567 --out site/1234567/
  ```
  若 Canonical 目录内仅有单一账号，则 `--account` 可省略，自动锁定该账号。
- **多账号索引门户（Hub Portal，显式声明）**：
  当用户显式传递 `--all-accounts` 时，站点生成器支持在顶层生成多账号索引 Portal，各账号作为子路径独立存放（如 `/users/1234567/`），保持各账号之间相互隔离。

#### 7.3.2 档案作者身份正确呈现（Profile Attribution）
- **现状机制**：站点生成器的首页大标题、个人头像、个人简介原本默认读取操作者的信息。
- **改进规范**：
  - 站点元数据生成器从输入 Canonical 的 profile 记录或 `manifest.account` 中提取 `nickname`、`avatar`、`bio` 与 `join_date`；
  - 严禁将扩展当前操作者（小号或大号）的个人信息渲染在第三方账号的站点上。

#### 7.3.3 私密数据旁路保护（`private.js` 铁律）
- **文件定位**：[`src/private.js`](file:///home/mewx/codes/doubak/doubak-site-generator/src/private.js)。
- **规则落实**：
  - 公开归档天然不含私密日记（`note`）和私密豆列。
  - 站点模板严禁在页面导航栏中渲染空的“私密条目”分类，更严禁显示无内容的“🔒 已锁”占位图标。
  - 对于因平台锁定而无法抓取的内容，站点保持静默，确保生成的静态网站视觉纯粹、布局自然。

---

### 7.4 `doubak-import-adapters`：第三方公开抓取数据摄取与合规化

`doubak-import-adapters` 负责将第三方历史工具（如 `its-my-data/doubak` 等）产出的离线 HTML 目录转换重构为合规的 Bundle。

```
              【外部第三方爬虫导出的 HTML / 目录】
                               │
                               ▼
                    adapters/external-html.js
                               │
            ┌──────────────────┴──────────────────┐
            ▼                                     ▼
【打标 capture_fidelity】              【打标 crawl_scope】
decoded_body+synthesized_headers       visibility: 'public'
标明头部为合成，正文为真实               operator_mode: 'anonymous'
            │                                     │
            └──────────────────┬──────────────────┘
                               │
                               ▼
                 验证提取的数字 UID 与 Slug
                               │
                               ▼
               产出合规 bundle/v1 标准归档
```

#### 7.4.1 捕获保真度打标（Capture Fidelity）
- **规范依据**：`bundle/v1/SPEC.md` §6.4.1。
- **契约定义**：外部工具采集的公开 HTML 没有原始 HTTP 响应头，`convert.js` 统一打标为：
  ```json
  "capture_fidelity": "decoded_body+synthesized_headers"
  ```
  向全生态声明：正文字节真实，响应头为合成。

#### 7.4.2 范围与操作模式注入（Crawl Scope Injection）
- 导入适配器生成的 `manifest.json` 自动附加：
  ```json
  "crawl_scope": {
    "visibility": "public",
    "operator_mode": "anonymous",
    "catalog_included": true
  }
  ```
  使得下游 `doubak-data-parser` 在读取由老工具转换而来的 Bundle 时，能自动启用 `absence_authority = none` 保护机制，防止老数据污染现有数据库。

---

### 7.5 跨仓库契约校验与自动化流水线（CI & Vendor Sync）

为了确保这套涉及 6 个独立仓库的架构方案平稳落地，必须确立严密的协同演进流水线：

```
               【1. doubak-data-specs】
            制定 crawl_scope 与权限降级规范
                          │
         ┌────────────────┴────────────────┐
         ▼                                 ▼
【2. doubak-data-parser】        【3. 运行 sync-vendor】
落实 absence_authority 契约      镜像同步 classifier / validator
         │                                 │
         └────────────────┬────────────────┘
                          │
                          ▼
              【4. doubak-extension】
         落实 SessionGuard、Preflight 探测、
         UI 多账号展示与轻量抓取
                          │
         ┌────────────────┴────────────────┐
         ▼                                 ▼
【5. doubak-export-adapters】    【6. doubak-site-generator】
单账号分桶导出与 NeoDB 适配        作者身份呈现与私密旁路防护
```

1. **第一优先级：规范合并**：`doubak-data-specs` 优先合并 `manifest.schema.json`、`SPEC.md` 与 `INGESTION.md` 修订案。
2. **第二优先级：同步脚本校验**：
   - 各仓库根目录下均设有 `tools/sync-vendor.mjs`。
   - 运行 `node tools/sync-vendor.mjs --check`，确保核心判定逻辑、ID 校验算法与路由模板在各仓库间完全一致，杜绝任何两端逻辑分歧。
3. **第三优先级：端到端真实验证集**：
   - 建立覆盖以下典型场景的离线 Fixture 验证集：
     1. 正常活跃用户公开主页；
     2. 注销账号墓碑页面（例 `235807474`）；
     3. 软封禁违规锁定账号主页与看电影列表；
     4. 本人封号抢救会话页面（Issue #19）。
   - CI 运行完整解析与导出链，确保 0 报错、0 假删除、0 假编辑。

---

## 8. 实施路线图（Milestones）

### 阶段一：核心爬虫驱动与会话解耦（Engine Layer）
1. 扩展 `SessionGuard`，使其支持 `crawlScope: 'public'` 与 `operatorMode` 分离。
2. 升级 `classifier.js`，增加注销墓碑模式（`TOMBSTONE_RE`）与封禁模式（`BANNED_RE`），在公开模式下允许合法的公开导航栏通过（避免误判为 `login` 停机）。
3. 调整 `runner.js` 与 `offscreen.js`，支持直接接收外部传入的目标 `username` / `userId`，并在公开模式下组装正确的 `targetAccount` manifest。
4. 增加单元测试：验证匿名抓取流程、小号代理抓取流程、串号保护与断点恢复。

### 阶段二：探测器与路线范围定制（Preflight & Routes）
1. 实现公开主页探测解析器 `discoverPublicTarget(slug)`，实现注销墓碑识别（提取注销时间戳）与违规封禁二级探测逻辑。
2. 在 `routes.js` 中增加 `skipCatalog`（轻量化模式）参数支持，使公开抓取可按需跳过条目详情页。
3. 升级 `Pacer`，接入公开模式的动态退避节奏。

### 阶段三：管理面板界面与交互落地（UI Layer）
1. 在概览页（`overview.js`）实现模式切换组件与目标账号探测卡片（包含注销墓碑提示与封禁抢救引导）。
2. 在覆盖率页（`coverage.js`）加入多账号对账切换与公开视图差值说明。
3. 在档案页（`archive.js`）完善多账号分组、捕获列表展示与「验一验」支持。
4. 在导出页（`formats.js`）与导入页（`import.js`）优化多账号独立分桶与权限交互。
5. 补充无头浏览器截图与交互测试（`panel-shot.test.js`、`ui.test.js`）。

### 阶段四：跨仓库工具链适配与端到端真实验证（Ecosystem & Sync）
1. 在 `doubak-data-specs` 中归档 `crawl_scope` 与公开链路不变量说明。
2. 在 `doubak-data-parser` 中固化公开归档 `absence_authority = none` 与匿名标签保护规则。
3. 在 `doubak-export-adapters` 与 `doubak-site-generator` 中落实多账号隔离与目录降级。
4. 执行 `tools/sync-vendor.mjs --check` 校验跨仓库代码一致性。
5. 针对典型真实公开页面（活跃用户、封禁账号、注销账号 `235807474`）进行抽样演练验证。


