# 上游三个仓库的字节副本

**这些目录里的 `.js` 一个字都不要改。** 它们是另外三个仓库 `src/` 下同名文件的
**逐字节拷贝**，只在开头多了四行醒目的抬头。

要改就去那个仓库改，然后回来跑一遍同步：

```sh
node tools/sync-vendor.mjs           # 同步（要求三个仓库并排在 ../ 下）
node tools/sync-vendor.mjs --check   # 只比对，不写
```

`--check` 由 `test/vendor.test.js` 与 CI 调用，**漂了就红**。CI 会把三个仓库一起
检出，本地缺仓库时是「带原因跳过」——而跳过在 CI 里等于没测，所以脚本在 `CI`
环境变量下把「找不到仓库」当失败处理。

| 目录 | 来自 | 装什么 |
|---|---|---|
| `parser/` | `doubak-data-parser` | HTML → 记录，以及 bundle → canonical 的全部逻辑（11 个文件） |
| `export-adapters/` | `doubak-export-adapters` | canonical → NeoDB 的 NDJSON 归档、zip 格式、《怎么导入》（6 个） |
| `site-generator/` | `doubak-site-generator` | canonical → 投影 → Markdown 与搜索索引（4 个） |

用它们的地方：`src/ui/panel/content.js`（档案页的「查看内容」）与
`src/pipeline/`（导出页的三种产出）。

## 为什么是抄，不是 import

八个仓库各自独立，扩展打包时只带 `tools/package.mjs` 白名单里的文件；跨仓库的
`import` 在装好的扩展里根本不存在。而这个项目又**刻意没有构建步骤**，也就不能靠
打包器把它们拉进来。

所以走既定的那条路——与 `tools/generate-spec-constants.mjs` 一模一样：**产物提交
进仓库**（跑扩展、跑测试都不需要上游在场，零构建步骤的前提不变），新鲜度由脚本
守着。

同一个理由下还有一处先例：`src/ui/assets/README.md`，那是 `doubak-website` 的标识
的字节副本。

## 为什么不是 git submodule

有个具体的理由，不只是风格：`git clone` 不加 `--recursive` 会留下一个**存在但是
空的**目录。`package.mjs` 的 `collect()` 只在路径不存在时才抛，空目录它照收不误
——于是打包成功，装出来的扩展里没有解析器，而且一声不响。白名单当初就是为了避开
这种「静静少了东西」的失败，不能从后门把它放回来。

submodule 也拿不走一个仓库的**一部分**：`bundle-source.js` 会跟着进来，然后还是
要在打包名单里排除它。

## 为什么是抄，不是重写一份

在扩展里另写一份浅的，结果是**能力更弱、而且会漂**——两份实现对同一段输入得出不同
结论，只是早晚的事。

这不是假想。`&#34;` 曾经明晃晃地印在 sample.doubak.com 上：当时有**四份**各自演化
的 HTML 实体解码表，其中一份干脆没有。合并成一份之后，未解码的实体从 196 个降到
1 个，而那 1 个是对的。

摘要那一份更要命。`digest.js` / `sha256.js` 两边只要差一个字节，同一份档案解析两次
就会得出不同的修订——而 canonical **只比较同一 `parser_version` 的修订**，于是所有
记录同时看起来被编辑过，且不报任何错。`test/vendor.test.js` 因此拿 `node:crypto`
再对拍一次。

## 只搬纯函数

名单里每个文件都不碰任何 node 内建——这是它们能跑在浏览器里的前提，由
`test/no-node-builtins.test.js` 兜着；上游那三个仓库各自也有一条 `portable.test.js`
守着同一条线，所以「加了个 import 忘了通知扩展」在那边就会红。

碰 `node:fs` 的那些**不搬**：`bundle-source.js`（解析器）、`canonical.js`（导出
适配器）、`generate.js`（站点生成器）读的都是文件系统，而扩展读的是 OPFS。
**「字节从哪儿来」本来就该各写各的，「字节怎么解释」只能有一份。** 扩展这一侧的
对应物在 `src/pipeline/opfs-bundle-source.js`。

## 目录结构照抄，不拉平

`export-adapters/targets/neodb-ndjson.js` 里写的是
`import { csv } from '../csv.js'`。拉平到一个目录就得改那行 import，而**改了就不再
是同一份**，逐字节比对也就失去意义。
