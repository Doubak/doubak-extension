# 解析器抽取器的字节副本

**这个目录里的 `.js` 一个字都不要改。** 它们是
[`doubak-data-parser`](https://github.com/Doubak/doubak-data-parser) 的 `src/`
下同名文件的**逐字节拷贝**，只在开头多一行醒目的抬头。

要改就去解析器那个仓库改，然后回来跑一遍同步：

```sh
node tools/sync-extractors.mjs           # 同步（要求 ../doubak-data-parser 在场）
node tools/sync-extractors.mjs --check   # 只比对，不写
```

`--check` 由 `test/vendor-extractors.test.js` 与 CI 调用，**漂了就红**。CI 会把
解析器仓库一起检出，并显式确认那个检查真的跑了——本地缺仓库时它是「带原因跳过」，
而跳过在 CI 里等于没测。

| 文件 | 来自 | 抽什么 |
|---|---|---|
| `html-entities.js` | `src/html-entities.js` | HTML 实体解码，下面四个都依赖它 |
| `extract.js` | `src/extract.js` | 标记列表（书 / 影视 / 音乐 / 游戏 / 舞台剧） |
| `extract-broadcast.js` | `src/extract-broadcast.js` | 广播 |
| `extract-longform.js` | `src/extract-longform.js` | 日记 / 影评书评正文 |
| `extract-doulist.js` | `src/extract-doulist.js` | 豆列与豆列条目 |

用它们的只有一处：`src/ui/panel/content.js`（档案页的「查看内容」）。

## 为什么是抄，不是 import

八个仓库各自独立，扩展打包时只带 `tools/package.mjs` 白名单里的文件；跨仓库的
`import` 在装好的扩展里根本不存在。而这个项目又**刻意没有构建步骤**，也就不能靠
打包器把它们拉进来。

所以走既定的那条路——与 `tools/generate-spec-constants.mjs` 一模一样：**产物提交进
仓库**（跑扩展、跑测试都不需要解析器在场，零构建步骤的前提不变），新鲜度由脚本守着。

同一个理由下还有一处先例：`src/ui/assets/README.md`，那是 `doubak-website` 的标识
的字节副本。

## 为什么是抄，不是重写一份

在扩展里另写一份浅一点的，结果是**能力更弱、而且会漂**——两份实现对同一段 HTML
得出不同结论，只是早晚的事。

这不是假想。`&#34;` 曾经明晃晃地印在 sample.doubak.com 上：当时有**四份**各自演化的
HTML 实体解码表，其中一份干脆没有。合成一份之后，未解码的实体从 196 个降到 1 个，
而那 1 个是对的。

这些文件里的选择器**每一个都是对着真实字节量出来的**，注释里记着量的是什么：广播附
图的三种写法、`#info` 的两种引号、`又名` 必须按 ` / `（带空格）而不是裸 `/` 切分。
那些注释跟着代码一起搬了过来——它们比代码更难重建。

## 加一个文件之前

**先确认它一个 node 内建都不碰。** 名单里每个文件都只 `import './html-entities.js'`，
这是它们能跑在浏览器里的前提，也由 `test/no-node-builtins.test.js` 兜着。解析器里碰
`node:fs` 的那些（`bundle-source.js`）**不搬**：扩展读的是 OPFS，那一层本来就该各写
各的。

名单在 `tools/sync-extractors.mjs` 的 `FILES` 里，而**名单与目录两头都要对齐**：
只查目录的话，名单里加一项却忘了同步，测试照样绿。
