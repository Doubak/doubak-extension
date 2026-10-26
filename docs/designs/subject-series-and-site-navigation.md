# 「同系列作品」归档、修订与站内导航

状态：设计提案，尚未实现。调查日期：2026-10-26。
范围：data-specs、data-parser、site-generator、extension；可涉及 importer 与 export-adapters 的兼容检查。
本次只提交设计，不改变抓取行为、不重新发布 sample 站点。

## 1. 结论与边界

将豆瓣「同系列作品」保存为**某个作品详情页在某次捕获中展示的一份目录快照**，
放在 `subjects.ndjson` 的修订字段里。生成站点在现有作品页中增加系列导航，
优先链接本次确实生成的本地作品页；未归档条目只显示名称与「本档案未收录」。

不建立猜出来的全局系列实体，不合并各季的标记、评分或短评，不改变 `movie/<id>.md`
永久路径。列表出现、增加、减少、重排都属于目录观测变化，不是用户行为。
没有这一字段的旧 canonical 照常生成；新页面没有展示这一栏，也不能清空旧证据。

第一版只解析已捕获的详情页，不递归抓同系列条目、不自动追「全部」链接。
「全部」的响应若不在 WARC 里，离线解析就不可能恢复它。
**列表可能只是预览，也不能假定它等于一个电视剧的所有季。**

## 2. 已检查的事实与尚缺的证据

### 2.1 项目基线

已读根目录 `CLAUDE.md` 以及 extension、data-parser、site-generator 的 README 与相关代码。
工作区根没有 `README.md`；各子仓库的 README 是对应上下文。
项目文档采用中文，canonical 是可重建的观测记录，WARC 才是原始证据；解析、生成均离线。

调查时的 main 基线：

| 仓库 | 提交 | 与本设计有关的当前行为 |
| --- | --- | --- |
| data-specs | `11b3075` | canonical/1.x 接受未知附加字段；subject 使用修订、字段摘要及 observation |
| data-parser | `f7130cc` | parser `0.16.0`，输出 `canonical/1.3`；详情只抽 `info` / `aliases` |
| site-generator | `e814e66` | 作品页由标记投影生成；正文为 Markdown，Hugo 负责 HTML |
| extension | `d20fa8e` | vendor 复用 parser / generator；详情页默认跳过已成功抓取的 URL，可显式重抓 |

代码依据（实施时以对应 main 最新代码重新核对）：

- [parser `extract-subject.js`](https://github.com/Doubak/doubak-data-parser/blob/f7130cc/src/extract-subject.js)：
  `extractSubjectDetail()` 只返回媒介、ID、`info`、`aliases`；没有系列关系抽取。
- [parser `parse.js`](https://github.com/Doubak/doubak-data-parser/blob/f7130cc/src/parse.js)：
  先处理所有 detail，`details.set(medium:id, ...)` 覆盖为一份，随后 `upsertSubject()`
  把它补到列表页产生的记录中。这能补齐当前资料，但**不能保存详情变化的时序**。
  detail 仅在 info 或 aliases 非空时入表；只出现系列栏的页面会被现有条件丢掉。
- [subject schema](https://github.com/Doubak/doubak-data-specs/blob/11b3075/canonical/v1/subject.schema.json)
  与 [摄取规则 §5.4](https://github.com/Doubak/doubak-data-specs/blob/11b3075/canonical/INGESTION.md)：
  字段缺失不是空值；`omitted_fields` 已能表达本次不提供某字段的新证据。
- [generator `projection.js`](https://github.com/Doubak/doubak-site-generator/blob/e814e66/src/projection.js)、
  [ `pages.js`](https://github.com/Doubak/doubak-site-generator/blob/e814e66/src/pages.js)、
  [ `markdown.js`](https://github.com/Doubak/doubak-site-generator/blob/e814e66/src/markdown.js)：
  `project()` 按 `(medium,id)` 关联 subject；`buildPages()` 遍历投影后的 marks 生成作品页。
  **有 subject 记录不等于有对应页面**，不能拿 subject 索引直接判断链接是否有效。
- [`known-captures.js`](../../src/crawl/known-captures.js)、[`runner.js`](../../src/crawl/runner.js)：
  已有 `refreshSubjectUrls` 能直接排队重抓旧详情，不必依赖增量标记列表重新发现它们。
- [`sync-vendor.mjs`](../../tools/sync-vendor.mjs)：共享逻辑必须先在上游仓库实现，再同步；
  不在 OPFS 宿主另写系列解析或导航逻辑。

### 2.2 豆瓣页面证据

2026-10-26 查询到的**搜索索引中的豆瓣页面文本**：

| 页面 | 索引中可见内容 | 能支持的结论 |
| --- | --- | --- |
| [老友记 第四季](https://movie.douban.com/subject/3286536/) | 「同系列作品」「全部 10」，展示第一、二、三、五、六季共五项 | 可见列表不保证包含全部成员，也可能不含当前作品 |
| [碟中谍2](https://movie.douban.com/subject/1298525/) | 同名栏目，「全部 8」 | 这一关系也用于电影系列，不能命名为 `tv_seasons` |
| [美少女战士S](https://movie.douban.com/subject/1465024/) | 「全部 10」，可见条目同时含剧集与剧场版 | 不能从列表位置推断季数或观看顺序 |

这些是搜索引擎缓存的页面文本（结果标示约一年多前抓取），**不是本次取得的实时 HTML**。
直接读取上述豆瓣详情受 429 / `sec.douban.com` 挑战阻挡，未继续重试或绕过。
因此本设计不声称确认了当前 DOM 选择器、`全部` 的 href / 分页方式、总数是否包含当前作品，
也不声称这个功能是最近才上线。

本地只读扫描 `~/downloads/exports`，使用 parser 的 `openAll()` / `payload()`：

- 筛选 `route_key === 'interest.item'`、`verdict === 'ok'`、URL 以
  `https://movie.douban.com/subject/` 开头的捕获，共 **11,398 次**，不是不同作品数。
- 正文包含完整字面量 `同系列作品` 的 **0 次**；这只说明这批捕获没有该字面量，
  不证明豆瓣没有该功能，也不排除实体编码、节点拆分、客户端加载或访客模板差异。
- 放宽为 `同系列|subject[_-]series|franchise` 命中 **11 次**，抽查不同作品的命中
  都在简介或影评中，不能当成系列栏。不能用全页关键词 / 全页作品链接扫描建关系。
- `id='season'` / `id="season"` 命中 **267 次**。例如 2022-12-27 捕获的
  [11232690](https://movie.douban.com/subject/11232690/) 含季数下拉框，option 的值是作品 ID，
  当前项 selected。这是另一个明确的导航结构，但与「同系列作品」的集合语义并不等价。
  第一版不把它偷偷并入同一字段；未来若支持，须作为独立来源 / 关系类型设计。

扫描未改变归档；原始页面、用户内容及 Cookie 不纳入本设计提交。

### 2.3 实施前必须补齐的夹具

从用户正常浏览或既有 bundle 中取得脱敏的栏目片段及其容器边界：短列表、超过预览上限、
电影系列、剧集、无栏目、同页推荐区。核对是否服务端 HTML 已含全表、当前作品是否出现在列表、
`全部` 是否请求新页面或只是展开已有 DOM，以及标题是否被截断。再确定具体 selector。
若必须新增请求，另按 §8 的后续阶段设计；不能为迁就一个假设的 selector 修改抓取器。

## 3. 设计决策

以下章节将细化数据契约、按观测重放、站点体验与跨仓库验收。
本节列出不可被实现细节改变的约束：

1. 一个详情页只为它自己的列表作证；不把 A→B 自动写成 B→A，更不推导 A→B→C 的传递关系。
2. 新的一次可读列表是新快照；不能把所有历史列表取并集当作当前列表。
3. 未抓、未展示、结构不认识与明确空列表分别处理；缺字段不构成删除证据。
4. 来源时间来自真正提供系列证据的 detail capture，不能借用较晚的标记页时间。
5. 本地作品页是否存在，以本次筛选后将输出的页面集合为准。关系不会创建用户标记。
6. 同一批字节在 Node 和扩展导出中产生一致结果；没有网络和 enricher 仍可构建。
