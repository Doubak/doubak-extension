# 真实归档全流程验证与多账号/边际行为审计报告（2026-10-17）

> 审计执行范围：`doubak-extension`（含修复后的爬虫）、`doubak-data-parser`、`doubak-export-adapters`、`doubak-site-generator`。  
> 测试数据源：`~/downloads/exports/`（本人全量历史归档）与 `~/downloads/exports_3rd/`（第三方公开轻量归档）。

---

## 1. 测试数据源现状

| 数据集 | 账号 UID | 昵称 | 归档模式 | Bundle 数量 | 捕获记录数 | WARC 总体积 | 涵盖媒介与特性 |
|---|---|---|---|---|---|---|---|
| `exports/` | `82160871` | MewX | 私人/本人全量归档（`skip_catalog: false`） | 34 份（含 6 处分叉/重复链） | 30,911 条 | ~852 MB | 书、影、音、游、相册、日记（含豆瓣私密与用户私密）、长文、豆列、小组话题/加入、头像 |
| `exports_3rd/` | `154611037` | 三岐闻 | 第三方公开轻量归档（`skip_catalog: true`） | 3 份（a18169、5f9326、8fe1a5） | 1,167 条 | ~27 MB | 书、影、舞台剧（《妈妈咪呀》）、广播、日记、豆列、加入小组、目标用户头像 |

---

## 2. 完整流水线（Flow）端到端测试

### 2.1 Flow A：本人全量归档（`exports/`）

1. **解析（`doubak-data-parser`）**
   - **命令**：`node bin/parse.js /home/mewx/downloads/exports <out_dir>`
   - **结果**：
     - 完整性校验：67 个 WARC 段文件（852 MB）、30,911 条捕获逐字节校验 **全部对得上**（耗时 ~10.3s）。
     - 去重机制生效：检测到 `20260801T005010Z-3eef52` 在根目录与 `20260806/` 子目录下重复存在，自动去重只读一份。
     - 拓扑分析：识别出 6 个历史起点与分叉，平滑合并所有观测。
     - Canonical 产出：
       - 标记 2,992 条（修订 3,157 次）、作品 2,992 个
       - 广播 3,470 条（修订 3,926 次）、长文 6 篇、豆列 6 份
       - 相册 1 个、小组话题 3 篇、加入小组 34 个
       - 账号资料表（`profile.ndjson`）：成功归一化提取 UID `82160871`、昵称 `MewX`、头像 `up82160871-12.jpg`。
     - 容错统计：跳过 2,270 条登录重定向与 25 条 soft404，另有 2 条无法识别的捕获因同 URL 在其他 bundle 有成功记录，未影响数据完整性。

2. **导出（`doubak-export-adapters`）**
   - **命令**：`node bin/export.js <canonical_dir> <out_dir>`
   - **结果**：
     - **NeoDB NDJSON**：导出 2,986 条标记（电影 1,480、电视剧 656、游戏 614、图书 146、音乐 85、舞台剧 5）；还原广播状态历史 2,577 条；精确识别 1 篇豆瓣锁闭私密日记（按公开还原）与 1 篇用户自定义私密日记（按 `visibility: 2` 仅提及者私密导出）；生成 `neodb-needs-check.csv` 与 `neodb-doulist-needs-check.csv`。
     - **Letterboxd CSV**：导出 961 部看过、514 部想看，跳过 656 部电视剧与 855 项非影视内容；标记 35 部无 IMDb 条目。
     - **Goodreads CSV**：导出 146 本图书（读过 45、在读 18、想读 83），跳过 2,845 项非图书。
     - 生成操作引导：`怎么导入.md`。

3. **站点生成（`doubak-site-generator`）**
   - **命令**：`node bin/generate.js <canonical_dir> <bundle_dir> <out_dir>`
   - **结果**：
     - 成功生成 **3,182 个静态页面**（标记 2,991、长文 5、广播 3,469 条归入 155 个月份归档、相册 1、小组 3 话题/34 加入）。
     - **图片离线化**：从 WARC 段中解压并写入 **3,132 张本地图片**（包含 `covers/`、`uploads/`）。
     - **头像提取**：成功从捕获段提取用户头像，落盘至 `static/assets/profile/82160871/7ea273ac...jpg`。
     - **站点标题**：自动解析账号与 profile，生成站点标题为 `MewX的豆瓣存档`。
     - **搜索索引**：构建 5,286 条客户端搜索索引条目（gzip 后 473 KB）。

---

### 2.2 Flow B：第三方公开轻量归档（`exports_3rd/`）

1. **解析（`doubak-data-parser`）**
   - **命令**：`node bin/parse.js /home/mewx/downloads/exports_3rd <out_dir>`
   - **结果**：
     - 完整性校验：7 个段（27 MB）、1,167 条捕获全部通过。
     - Canonical 产出：
       - 标记 448 条、作品 448 个、广播 461 条（修订 494 次）
       - 长文 2 篇、豆列 2 份、加入小组 4 个、相册 0 个
       - 账号资料表（`profile.ndjson`）：成功归一化提取 UID `154611037`、昵称 `三岐闻`、头像 `up154611037-2.jpg`。
       - 舞台剧条目：正确解析《妈妈咪呀》（ID `10944605`），`cover_url` 提取为 `https://img9.doubanio.com/pview/drama_subject_poster/small/public/8972fded86c3674.jpg`，`cover_url_key` 格式标准。

2. **导出（`doubak-export-adapters`）**
   - **结果**：
     - **NeoDB NDJSON**：导出 448 条标记（电影 417、图书 30、舞台剧 1）。由于轻量模式跳过了详情页抓取，导出器正确报警 `417 条没读到详情页，分不出电影还是剧集，按电影处理`，优雅降级。
     - **Letterboxd CSV**：因无法区分电影与剧集，Letterboxd 严格执行防错策略，未将未知影视项输出为电影，全部记录至 check 清单，避免污染目标账号。
     - **Goodreads CSV**：导出 30 本图书，记录无 ISBN 清单。

3. **站点生成（`doubak-site-generator`）**
   - **结果**：
     - 生成 **528 个静态页面**，图片提取 451 张。
     - **站点标题**：自动解析为 `三岐闻的豆瓣存档`。
     - **头像提取**：成功从目标头像捕获中还原并写入 `static/assets/profile/154611037/`。
     - **舞台剧封面优雅降级**：因现有包抓取于封面修复之前，WARC 中尚无该图，站点生成器将《妈妈咪呀》页面的 `douban_cover` 渲染为 `null`，保持纯文本卡片，控制台与生成流程 **零崩溃、零报错中断**。

---

## 3. 多账号碰撞与防护测试

### 3.1 Parser 的 Fail-Fast 阻断与 `--ignore-warnings`
* **测试用例**：将 `bin/parse.js` 目标指向同时包含 `exports/` 与 `exports_3rd/` 的父目录。
* **现象**：
  ```text
  ✖ 这个目录（含子目录）里混着 2 个账号的档案（154611037、82160871）。
    一起解析会把它们合进同一份 canonical，而且事后分不开。
    请分开放，或者确认它们真的属于同一个人之后加 --ignore-warnings。
  ```
* **退出码**：`1`（阻断，未写出任何 canonical 文件）。
* **容差测试**：追加 `--ignore-warnings` 后，解析器允许合并生成 canonical，但在日志与产出告警中明确打出 `multiple_accounts: 1` 警告。

### 3.2 Site Generator 的多账号铁律防御
* **测试用例**：将混入了上述两个账号的 `canonical_mixed` 输入 `bin/generate.js`。
* **现象**：
  ```text
  Error: 输入中有多个账号（154611037、82160871）。请按账号分开生成站点。
      at resolveSiteTitle (...)
  ```
* **退出码**：`1`。
* **显式标题绕过测试**：即使显式传入 `--site-title="合集存档"`，站点生成器依然在标题计算阶段优先执行 UID 唯一性校验，**强制拒绝混合生成**。

### 3.3 Export Adapters 的行为与 CLI 现状
* **测试用例**：将混入了两个账号的 `canonical_mixed` 输入 `bin/export.js`。
* **现象**：导出器正常运行并以首个记录的账号为主体，未设置阻断。
* **`--account` 参数现状**：
  - 各 CLI 工具（`bin/parse.js`、`bin/export.js`）遇到 `--account <uid>` 会以 Exit Code `2` 提示不认识该开关；
  - `bin/generate.js` 内部将 `--account` 暂存为未启用 flag，但依然被多账号校验拦截；
  - **结论**：当前生态的多账号隔离遵循**前置目录隔离**原则（扩展导出时按 UID 分目录存放），CLI 层面的统一 `--account` 过滤选择器仍属待演进特性。

---

## 4. 关键边际与容错测试（Edge Cases）

| 测试场景 | 测试输入条件 | 预期行为 | 实际运行结果 | 状态 |
|---|---|---|---|---|
| **单包全量 vs 增量链** | 仅解析 3rd 单个全量包 vs 解析 3 个增量包链 | 基础条目数一致，增量链包含更多广播/标记修订历史 | 单包广播修订 461 次；增量链广播修订 494 次（保留了 33 次时间线演变） | ✅ 符合预期 |
| **纯内容无主题导出** | `bin/generate.js --no-theme` | 不复制 Hugo 骨架，仅生成 `content/` 与 `static/` | 成功剥离 Hugo 模板，输出仅含资产与页面，无 `hugo.toml` | ✅ 符合预期 |
| **无原始 bundle 纯 Markdown 生成** | `bin/generate.js <canonical> /nonexistent` | 缺失图片时提示降级，页面保留原始 doubanio 外部 URL，不崩溃 | 提示 `当前头像没有对应的已归档图片，站点将保留文字站名`，成功生成 528 页，耗时 164ms | ✅ 符合预期 |
| **空 Canonical 输入** | `bin/generate.js <empty_dir>` | 生成仅含基础框架的空站点，不抛异常 | 成功生成 3 个基础页面，站名回退为 `我的豆瓣存档` | ✅ 符合预期 |
| **空 Canonical 导出** | `bin/export.js <empty_dir>` | 阻断并提醒并非合法 Canonical | 抛出错误 `看着不像 canonical 目录（所有已知 NDJSON 都没有记录）`，Exit Code 1 | ✅ 符合预期 |
| **非法 CLI 选项** | 传入拼写错误如 `--no-themee` 或 `--target=unknown` | 阻断并列出所有合法选项列表 | 明确提示 `不认识这些开关` 并打印能用的选项列表，Exit Code 2 | ✅ 符合预期 |

---

## 5. 推荐的修改方案（Proposals for Multi-Account & Edge Resilience）

针对本次全流程审计暴露出的「CLI 多账号防御不一致」以及「指定账号过滤缺失」两大痛点，提出以下四阶段递进式演进方案：

### 5.1 阶段一：补齐 Export Adapters 的 Fail-Fast 阻断机制（即时防线）

- **现状问题**：`doubak-export-adapters` 盲目读取 Canonical 目录，若用户在 `parse.js` 中使用了 `--ignore-warnings` 生成了混合 UID 的 Canonical 数据，导出器会在毫无感知的情况下导出首个命中账号的数据，或将多个账号的书影音混合写入同一个 CSV/NDJSON，污染目标第三方平台（NeoDB/Letterboxd/Goodreads）。
- **修改方案**：
  在 `doubak-export-adapters/src/canonical.js` 的 `loadCanonical(dir)` 中，加载记录时统一收集 `record.account?.user_id`：
  ```javascript
  const uniqueUids = new Set();
  for (const mark of records.marks) {
    if (mark.account?.user_id) uniqueUids.add(String(mark.account.user_id));
  }
  if (uniqueUids.size > 1 && !options.account) {
    console.error(`✖ 输入的 canonical 目录中包含多个账号的数据（${Array.from(uniqueUids).join('、')}）。`);
    console.error('  直接导出可能导致第三方平台（NeoDB/Letterboxd/Goodreads）数据交叉污染。');
    console.error('  请使用 --account <uid> 指定账号，或先按账号分别生成 canonical。');
    process.exit(1);
  }
  ```
- **收益**：与 `parse.js` 和 `generate.js` 统一防御门槛，全链路阻断混合污染。

### 5.2 阶段二：统一三端 CLI 的 `--account <uid>` 过滤开关（解耦目录强隔离）

- **现状问题**：目前用户必须严格在文件系统层面物理分开归档包目录，一旦归档包混放在同一父目录下，CLI 工具缺乏按账号过滤解析/导出/生成的能力（均报不认识 `--account` 开关或阻断）。
- **修改方案**：
  1. **`doubak-data-parser`（`bin/parse.js`）**：
     - 在 CLI 参数解析器中增加 `--account <uid>` 与 `--account=<uid>`。
     - 在执行拓扑分析与 `parse()` 前，过滤扫描到的 `bundleDirs`：
       ```javascript
       if (targetAccount) {
         bundles = bundles.filter(b => String(b.manifest.account?.user_id) === String(targetAccount));
         if (bundles.length === 0) {
           console.error(`✖ 未在输入目录中找到账号 ${targetAccount} 的归档包。已发现账号：${foundUids.join('、')}`);
           process.exit(1);
         }
       }
       ```
     - 此时仅留目标账号的 bundle 序列，自然解除多账号碰撞报错。
  2. **`doubak-export-adapters`（`bin/export.js`）**：
     - 支持 `--account <uid>` 选项；
     - 在 `loadCanonical` 读取各 NDJSON 时，只保留 `record.account?.user_id === targetAccount` 的记录；若不存在该账号则友好报错退出。
  3. **`doubak-site-generator`（`bin/generate.js`）**：
     - 将已存在的 `--account` 选项接入核心逻辑；
     - 在读取 Canonical 数据后、调用 `resolveSiteTitle` 和构建静态文件前，先对内存中的数据集执行过滤：
       ```javascript
       if (options.account) {
         canonical = filterCanonicalByAccount(canonical, options.account);
       }
       ```
     - 生成站点仅包含该账号的内容与对应头像，彻底解决混合 Canonical 生成站点的死锁问题。

### 5.3 阶段三：支持全自动批量分治输出（`--all-accounts`）

- **场景**：离线冷备份脚本或家庭/多账号自动化流水线。
- **修改方案**：
  - 允许在三个工具中传入 `--all-accounts`；
  - 工具检测到多账号时不报错退出，而是按 UID 分流，自动将产出写到子目录：
    - Parser、Export Adapters、Site Generator：均为 `<out_dir>/<uid>/`，不额外添加 `canonical/`、`exports/` 或 `site/` 层。
  - 单账号及显式 `--account <uid>` 直接使用指定输出目录，不自动追加 UID；单个输入数据集只有一个账号时，`--all-accounts` 也保留原目录布局。
  - 彻底将用户从手动写 Shell 循环处理多账号的工作中解放出来。

### 5.4 阶段四：爬虫封面模式的防御性泛化

- **现状经验**：本次发现并修复的早期舞台剧封面，因使用了豆瓣独立的 `pview/drama_subject_poster` 路径而被原本仅识别 `view/(subject|photo)` 的扩展正则漏抓。
- **推荐方案**：
  - 在 `doubak-extension/src/crawl/loop.js` 中，将封面识别正则由枚举式扩展为安全白名单前缀匹配：
    ```javascript
    // 匹配 img*.doubanio.com 下所有合法海报与封面资源路径
    /(?:img\d*\.doubanio\.com\/(?:view\/(?:subject|photo)|pview\/[a-z_]+|[blsp]pic)\/[^"'\s\)]+)/i
    ```
  - 针对豆瓣未来可能出现的其他媒介专属前缀（如音乐海报、播客封面等）形成长效免疫。

---

## 6. 结论

1. **舞台剧封面修复验证完备**：爬虫端新增路径规则（`pview/drama_subject_poster`）已补全单元测试，下游解析器与站点生成器对现有缺失包与未来完整包均有完善的兼容与优雅降级机制。
2. **端到端流水线稳健**：两份真实数据在解析、导出（NeoDB/Letterboxd/Goodreads）以及静态站点生成上全部畅通。
3. **多账号边界保护严格**：数据解析器与静态站点生成器均严格落实了 Fail-Fast 保护铁律，有效防止用户意外混淆多个账号的数据。
4. **演进路径清晰明确**：通过补齐 Export Adapters 的 Fail-Fast 与推进统一 `--account` 过滤参数，能够彻底打通多账号场景下的全自动化归档体验。

---

## 7. 改造落地与真实数据验证结果（2026-10-17 实施完成）

### 7.1 实现与改动汇总

1. **Stage 1 (Fail-Fast 对齐)**：
   - `doubak-export-adapters`（`src/canonical.js`、`bin/export.js`）：加入多账号识别，发现多 UID 且未显式指定过滤时，退出码 `1` 阻断，杜绝污染第三方平台。
2. **Stage 2 (统一 `--account <uid>`)**：
   - `doubak-data-parser`：`filterSourcesByAccount` 沿 `previous_bundle_id` 与 `floor_from_bundle_id` 自动溯源保留链条中的无清单祖先包；
   - `doubak-export-adapters`：`filterCanonicalByAccount` 纯内存过滤 records 并安全导出；
   - `doubak-site-generator`：按 UID 过滤 records、头像与原始图片索引。
3. **Stage 3 (`--all-accounts` 批量分流与全链路子目录感知)**：
   - `doubak-site-generator`：`indexImages` 升级为 `walk(dir)` 深度递归，带 `realpathSync` 环路保护、忽略 `.git`/`node_modules`、命中 `index-*.ndjson` 止步不读内部 WARC 段；
   - `doubak-export-adapters` & `doubak-site-generator`：引入 `findCanonicalDirs` 自动探查子目录中的 canonical 存档；
   - 三大 CLI 统一支持 `--all-accounts` 自动向 `<out_dir>/<uid>/` 分治产出。
4. **测试覆盖**：
   - 全项目 2,123 个单元测试全部通过（2,122 pass, 1 skipped, 0 fail）。

### 7.2 真实混合归档（`exports/` + `exports_3rd/`）端到端大考实测

| 测试环节与场景 | 执行命令 | 实测指标与运行结果 | 状态 |
|---|---|---|---|
| **Parser 混合阻断** | `parse.js <mixedDir> <out>` | 扫描 74 个段（879 MB）、32,078 条捕获；精准拦截混合账号 `154611037` 与 `82160871`；退出码 `1`，零磁盘写入。 | ✅ PASS |
| **Parser 单账号隔离** | `parse.js ... --account 154611037` | 仅提取三岐闻 3 份档案（439ms），产出标记 448 条、广播 461 条、长文 2 篇、豆列 2 份、小组 4 个，零串号。 | ✅ PASS |
| **Parser 深度子目录隔离** | `parse.js ... --account 82160871` | 穿透 `20260806/` 嵌套子目录，合并 34 份档案（19s），产出标记 2,992 条、广播 3,470 条、长文 6 篇、相册 1 个、小组 34 个。 | ✅ PASS |
| **Parser 批量分流** | `parse.js ... --all-accounts` | 识别两账号，自动分流解析至 `canonical_all/82160871/` 与 `canonical_all/154611037/`。 | ✅ PASS |
| **Export 混合阻断** | `export.js <mixedCanonical> <out>` | `findCanonicalDirs` 发现多个子目录，退出码 `1` 阻断并提示防污染。 | ✅ PASS |
| **Export 单账号导出** | `export.js ... --account 154611037` | 锁定三岐闻子目录，成功导出 NeoDB（标记 448、历史 385）、Letterboxd（417 未知进 check）与 Goodreads（30 本）。 | ✅ PASS |
| **Export 批量分流** | `export.js ... --all-accounts` | 分流导出至 `exports/82160871/` 与 `exports/154611037/`，各自含完整平台导入包。 | ✅ PASS |
| **Site Gen 混合阻断** | `generate.js <mixed> <bundles> <out>` | 识别多子目录与混合 UID，退出码 `1` 阻断拒绝混合生成。 | ✅ PASS |
| **Site Gen 单账号+深度图片** | `generate.js ... --account 82160871` | 递归检索出 `20260806/` 全部图片，生成 3,182 页、提取 covers 2,964 张与 uploads 168 张，站名头像无误。 | ✅ PASS |
| **Site Gen 批量分流** | `generate.js ... --all-accounts` | 批量构建，在 `site_all/82160871/` 与 `site_all/154611037/` 生成两个主题完整、头像独立的静态站点。 | ✅ PASS |
| **Flat 混合数据容灾** | 单目录手工合并的混合 NDJSON 文件测试 | 记录级过滤依然 100% 生效，无数据穿透。 | ✅ PASS |


