# 豆瓣客户端算力证明（PoW）逆向、凭据隔离防线与全链路实测审计

> 日期：2026-10-18  
> 关联 PR：[#30](https://github.com/Doubak/doubak-extension/pull/30) · 关联 Issue：[#29](https://github.com/Doubak/doubak-extension/issues/29) · 关联分支：`perf/cdn-pacing-multiplier`  
> 测试归档源：`~/downloads/exports_3rd/doubak-bundle-20261017T225057Z-0566fa`（目标用户：三岐闻，UID `154611037`，全量含作品详情与封面）

---

## 一、 背景与现象：神秘的「载入中...」

在公开抓取模式下开启「作品详情页」（`interest.item`）后，遇到冷门或受控条目（如番剧《相反的你和我》`37134598`，动画《辉夜大小姐》`30241099`），抓取引擎频繁停顿在 `paused · challenge`。

下载拦截响应（`downloads/豆瓣.html` 与 `downloads/豆瓣2.html`，落在 `https://sec.douban.com/c?r=...`）审查发现：
- 页面无字符验证码、无滑块拼图，标题为「载入中...」，页面中央仅有一个纯 CSS 动画；
- 源码包含 `<form id="sec" action="/c" method="POST">`，带隐藏字段 `tok` 与 `cha`；
- 内嵌执行脚本声明 `var difficulty = 1;`（或 2），并包含针对 `sha512` 哈希的计算循环。

---

## 二、 逆向机理：客户端工作量证明（Proof-of-Work）

豆瓣安全中心对高频或特定条目下发的并非传统图形验证，而是标准的 **Proof-of-Work（算力证明）** 挑战：

1. **挑战参数**：服务端给出字符串 `cha`（挑战值）、`tok`（令牌）与整数 `difficulty`；
2. **试凑目标**：客户端在本地循环试凑字符串 `sol`（solution），使得将 `cha + sol` 进行 **SHA-512** 哈希后，前导连续零字节（`0x00`）数量达到 `difficulty`；
   - 难度 1：前导 1 个零字节（8 位零比特），数学期望约为 256 次哈希运算（真机约数毫秒）；
   - 难度 2：前导 2 个零字节（16 位零比特），数学期望约为 65,536 次哈希运算；
3. **换取凭证**：客户端通过 `POST /c` 提交 `sol`、`tok`、`cha`、`red`（回退目标）；
4. **颁发全站通行证**：服务端校验无误后，返回 302 重定向回到目标页面，并附带通行 Cookie：
   ```http
   Set-Cookie: dbsawcv1=...; path=/; domain=.douban.com; max-age=...
   ```

---

## 三、 四大架构暗坑与防护实现

### 1. W3C Fetch 规范的 `credentials: 'omit'` 凭据陷阱
- **困境**：公开目录抓取初始按 `credentials: 'omit'` 发起，以防携带操作者个人数据。然而 W3C Fetch 规范强制规定：`'omit'` 会**丢弃一切响应中的 Set-Cookie**，且在发请求时禁带任何 Cookie。导致自动算完 PoW 提交后，浏览器直接忽略了豆瓣发来的通行证 `dbsawcv1`，重试原请求时再度被 302 拦截，陷入死锁。
- **方案**：`Transport.fetch` 侦测到 PoW 挑战时，提交 `POST /c` 与后续放行重试**强制升级为 `credentials: 'include'`**，确保通行证有效沉淀与携带。

### 2. CORS 跨域预检与 OPTIONS 403 封杀
- **困境**：向 `sec.douban.com/c` 发起跨域 POST 时，若携带非简单请求头（如 `X-Override-Referer`），浏览器会强制触发 `OPTIONS /c` 预检，而豆瓣 WAF 对 `OPTIONS` 直接返回 403 Forbidden。
- **方案**：提交表单严格净化为标准 `application/x-www-form-urlencoded`，杜绝任何预检触发。

### 3. 操作者导航条与会话守卫沙盒解耦
- **困境**：携带 Cookie 拿回作品详情后，页面顶部出现当前登录操作者的个人导航条，`SessionGuard.verify()` 误报 `operator_switched`。
- **安全论证**：
  - 作品详情解析器（`extractSubjectDetail`）严格限定在 `<div id="info">` 区域内，仅提取导演、编剧、主演、类型、语言、首播、集数、又名、IMDb 等客观元数据，**绝不摄取评论区或打分框**；
  - 目标用户真正的评分、短评与收藏时间，**100% 只来自目标用户主页列表（`interest.list.*`）**；
  - 因此标记 `powSolved = true` 放行客观目录页，未标 `powSolved` 的请求继续严禁登录态混入。

### 4. IndexedDB 并发写入覆盖
- **困境**：停机时连续抛出 `capture`、`awaiting_human`、`stopped`、`paused` 四事件，无 await 的异步写入导致并发读取旧数据并相互覆盖，刷新面板后最关键的 `capture · challenge` 丢失。
- **方案**：在 `event-log.js` 内部建立基于 Promise 链的微任务写队列（`appendQueue.then(...)`），彻底保证持久化事件严格串行落盘。

---

## 四、 CDN 1/3 延迟倍率设计

针对影视全量归档中大量封面图片（`*.doubanio.com`）的处理：
- 静态图片 CDN 属于边缘对象存储分发，无 Python 动态业务逻辑及 WAF/PoW 风控；
- 在 [`RequestGate.run`](file:///home/mewx/codes/doubak/doubak-extension/src/crawl/pacing.js#L277) 中支持 `delayMultiplier: 1/3`，自动缩短等待间隔至 1/3（自抓模式从 1000ms 降至 ~333ms，公开模式降至 ~1000ms）；
- 保持严格单通道串行排队（并发恒为 1）；切回主站 HTML 页面时倍率自动恢复为 1，从上一发结束算起等满全额基础间隔，绝不冲击主站。

---

## 五、 真实全量归档（`0566fa`）端到端大考实测数据

使用包含详情页的真实全量归档包 `doubak-bundle-20261017T225057Z-0566fa`（目标用户：三岐闻，UID `154611037`）执行全链路检验：

### 1. 抓取与完整性表现
- **段与记录**：3 个段（26 MB WARC）、1,019 条捕获全部逐字节校验通过；
- **PoW 实战成效**：全量 457 条详情页中，**417 条成功通过 PoW 算力证明自动通关**；前期留下的 9 条受阻记录在断点恢复后全部收口收敛；
- **数据纯净度**：Canonical 全表唯一存在的 UID 仅有目标账号 `154611037`，操作者评价零泄漏。

### 2. 下游工具链验证对比

| 环节 / 工具 | 此前无详情页（轻量模式）表现 | 本次具备完整详情页表现 | 提升价值 |
|---|---|---|---|
| **`doubak-data-parser`** | 产生 448 条基础标记，缺少详情客观字段 | 448 作品补齐演职员表、首播集数、又名、IMDb 等 | 档案信息量完整度质的飞跃 |
| **`doubak-export-adapters` (NeoDB)** | 告警「417 条分不出电影还是剧集，按电影处理」 | 精准识别分类：**电影 259 · 剧集 158 · 图书 30 · 舞台剧 1** | 彻底根除降级猜测与类型污染 |
| **`doubak-export-adapters` (Letterboxd)** | 严格防错，将未知影视全部推入 check 清单 | 精准导出 **259 部电影**，严格剔除 158 部剧集 | 符合 Letterboxd 只收电影的规范 |
| **`doubak-site-generator`** | 仅文字卡片，无法展示剧集季数与 IMDb | 生成 **528 静态页面 + 452 张本地海报**，演职员与广播动态完美呼应 | 完全达成单机离线豆瓣还原目标 |
