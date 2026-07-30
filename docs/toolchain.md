# 工具链

> 首批代码落地时定下的选型与理由。改动此处需要说明为什么。

## 结论：**零依赖、零构建步骤的原生 ES 模块**

| 项 | 选择 |
|---|---|
| 语言 | JavaScript（ES2022+），类型靠 JSDoc 注解 |
| 模块 | 原生 ESM。MV3 的 service worker 支持 `"type": "module"` |
| 构建 | **没有**。仓库里的源码就是浏览器里跑的东西 |
| 测试 | `node --test`（Node 内置，无需安装任何东西） |
| 运行时依赖 | **零** |
| 开发依赖 | 一个，**可选**：`warcio`，只用于独立验证（见下文） |

```sh
npm test          # 零安装即可跑；未装 warcio 则跳过互操作测试并显示原因
npm install       # 装上 warcio，多一层独立验证
npm run test:watch
```

需要 Node ≥ 20（用到内置测试运行器与 Web Streams）。开发时用的是 v24 LTS。

## 为什么不用打包器和 TypeScript

**1. 这个项目的卖点就是「十年后还打得开」。**

档案格式那边已经因为这个理由把 protobuf 换成了 JSON——「一段 protobuf 载荷没有 `.proto` 就是一堆不透明的字节，NDJSON 用 `jq` 永远读得动」。同样的道理适用于代码本身：一个能被直接阅读、不经任何转译的扩展，比一个需要还原构建环境才能理解的扩展更符合这个项目的立场。

**2. 这个扩展碰用户的登录会话。**

每一个 npm 依赖都是供应链攻击面。对一个要求用户「把你的豆瓣会话交给我」的工具来说，「所有代码都在这个仓库里，你可以全部读完」是一个实打实的安全属性，不是洁癖。

**3. 我们本来就不需要库。**

| 原本以为要库的地方 | 其实是原生 API |
|---|---|
| gzip 压缩 | `CompressionStream('gzip')` |
| SHA-256 | `crypto.subtle.digest` |
| UUID | `crypto.randomUUID()` |
| WARC 记录 | 就是文本头 + 载荷，几十行代码 |

WARC 写入原本被列为最大的技术未知数（担心 MV3 禁用 `unsafe-eval` 会让现成的库用不了）。实测下来根本不需要库——**风险消失了，顺带把依赖也消掉了**。

## 为什么不用 warcio 而是自己写 WARC

这是个该认真回答的问题，毕竟 `warcio` 出自 webrecorder——正是 pywb 与 ReplayWeb.page 的作者，也就是我们最需要兼容的那批工具。

实际看了一下它的依赖：**1042 KB，8 个运行时依赖**，其中包括

| 依赖 | 它提供什么 | 我们已有的原生替代 |
|---|---|---|
| `pako` | JS 实现的 zlib | `CompressionStream('gzip')` |
| `hash-wasm` | WASM 哈希 | `crypto.subtle.digest` |
| `uuid-random` | UUID | `crypto.randomUUID()` |
| `yargs` | **命令行参数解析** | 库里根本不该有这个 |

这些大多是**在这些 Web API 普及之前**写的替代实现。而我们要用的只是「写 warcinfo 和 response 两种记录」这一小块，两百行出头，已经写完并测过。

决定性的一条是**成本结构**：没有构建步骤的情况下，扩展没法直接 import 一个 npm 包。用 warcio 就意味着要引入打包器，也就等于推翻上面整个选型——为一件我们已经做完的事付出全套复杂度。

叠加上「这个扩展碰用户登录会话」这条，1 MB、8 个传递依赖的攻击面换两百行代码，不划算。

### 但拿它来做**独立验证**非常划算

`warcio` 作为**可选的开发依赖**存在，只在测试里用（`test/warc-interop.test.js`）：拿 webrecorder 自己的解析器去读我们写出来的字节。

自己写的测试只能证明「写入器和我们的理解一致」；只有让一个独立实现把字节读回来，才谈得上证明「pywb 与 ReplayWeb.page 能打开」这个承诺。这和摘要测试里用 Python 独立算期望值是同一个道理——**测试的价值在于它的独立性**。

没装也没关系：那几个测试会显示原因并跳过，`npm test` 依然零安装可跑。它不进运行时，不影响发布产物。

**4. 类型安全没有丢太多。**

关键的类型约束来自 `doubak-data-specs` 的 JSON Schema，那是跨仓库、跨语言的约束，TypeScript 复述一遍并不能替代它。真正的保障是**拿规范的参考校验器去校验产出的 bundle**（见下文的跨仓库测试）。

## 如果将来要加构建步骤

不排斥，但需要有具体理由，比如：

- 要支持 Firefox，且两边的 MV3 差异大到必须条件编译
- 打包体积成为问题
- 团队规模变大到需要 TypeScript 的强制约束

到那时再加，成本不高；现在加则是提前付出一笔不必要的复杂度。

## 目录结构

```
src/
├── core/       纯逻辑，不碰任何浏览器专有 API，可直接在 Node 里测
├── storage/    存储抽象：内存（测试）+ OPFS + IndexedDB + Worker RPC 客户端
│   ├── opfs-worker.js      只读入口（面板用）
│   └── opfs-rw-worker.js   读写入口（offscreen 用，唯一能写 OPFS 的地方）
├── bundle/     bundle 写入器/读取器/导出器：段轮转、落盘顺序、崩溃恢复
├── crawl/      抓取：frontier、分类器、路线、节奏、会话、编排
├── offscreen/  抓取真正跑的地方（见下）
├── ui/         popup 与完整面板
└── background.js   service worker 入口 —— **只调度，不碰数据**
test/           与 src 平行，node --test 自动发现 *.test.js
selftest/       浏览器里才能跑的那部分（OPFS、IndexedDB、RPC 契约）
```

**`src/core/` 里的东西一律不许 import 浏览器专有 API。** 这条纪律是为了让最需要正确性的
那部分逻辑（标识符、时间、摘要、WARC 字节）能在 Node 里被彻底测试，而不必启动浏览器。

### 三个执行上下文，边界由测试守着

MV3 把代码劈成了几个能力不同的上下文，而**「哪个上下文能做什么」是这个项目踩坑最多的
一类知识**（详见 `docs/permissions.md` 的对照表）：

| | service worker | offscreen document | 专用 Worker | 窗口 |
|---|---|---|---|---|
| `chrome.alarms`（心跳） | ✓ | ✗ | ✗ | ✗ |
| `chrome.storage` | ✓ | **✗** | ✗ | ✓ |
| IndexedDB（标准 API） | ✓ | ✓ | ✓ | ✓ |
| `createSyncAccessHandle()`（OPFS 原地写） | **✗** | **✗** | **✓** | **✗** |
| `showDirectoryPicker()` | ✗ | ✗ | ✗ | ✓ |
| 带 cookie 的 `fetch` | ✓ | ✓ | ✗ | ✓ |

于是分工是被逼出来的、而不是选出来的：抓取跑在 **offscreen**（它能 fetch，也能起专用
Worker 落盘），service worker 只**拿着闹钟**（唯一能跨浏览器重启存活的东西），导出在
**窗口**（只有它有文件选择器）。

`test/execution-context.test.js` 用源码约束守着这些边界——因为 Node 里**根本没有「执行
上下文」这个概念**，这类错误单元测试永远抓不到，只会在装进浏览器时炸，而且报错常常与
真实原因毫无关系。

## 与 `doubak-data-specs` 的关系：**不 import，也不做 submodule**

本仓库**不引入**规范仓库——既不作为源码依赖，也不作为 git submodule。

因为两者之间是**「符合」关系，不是「复用代码」关系**：

- **运行时不需要。** 扩展的职责是**产出**符合规范的 bundle，不是校验 bundle。校验是消费者和校验器的事。要在运行时校验，就得引入一个 JSON Schema 校验器——为一件由代码正确性保证的事再加一层依赖。
- **这个依赖由 `spec_version` 字符串表达。** 扩展在 manifest 里写下 `"spec_version": "bundle/1.0"`，声明自己按哪一版写。这正是「显式版本化的跨仓库依赖」应有的样子。
- **但常量不手抄。** 段前缀、verdict 取值这些从规范的 schema **生成**（见下节）。「反正是冻结的，抄一份也没事」这个想法经不起推敲：封闭词表加一个取值属于小版本变更，是被允许的，而手抄的那一份不会跟着变。

### 词表从 schema 生成，不手抄

扩展在**写入时**校验，用的是手写的 JS 判断——浏览器里没有 JSON Schema
校验器，也不该为此引入一个（Ajv 默认走代码生成，MV3 的 CSP 正好禁掉这条路；
预编译模式则要引入构建步骤）。

于是同一套规则有了两处编码：规范仓库的 schema，和扩展里的判断。两处编码
必然漂移，最可能的形态是**规范新增一个 verdict 取值，而扩展继续把它当非法
值拒掉**，且没有任何东西提醒你。

项目的既定原则是「从 schema 生成代码，绝不反过来」。落实方式：

```sh
node tools/generate-spec-constants.mjs          # 生成 src/core/spec-constants.js
node tools/generate-spec-constants.mjs --check  # 只比对
```

生成的文件**提交进仓库**，所以跑扩展和跑测试都不需要规范仓库在场——零构建
步骤的前提不变。`test/spec-constants.test.js` 会在规范仓库可见时重新生成并
比对，产物过期就失败。忘记重新生成会让测试红，而不是悄悄漂移。

### 为什么不做 submodule（复审后仍然不做）

首次判断时只有一个触点（一致性测试）。现在有三个：词表生成器、新鲜度测试、
一致性测试。触点变多之后重新审了一遍，结论不变，而且理由更硬了：

**这两个仓库是同一个人并行开发、共同演进的。** submodule 会把扩展钉在某个
规范提交上，并且在有人手动 bump 之前保持沉默——那是对付「外部的、慢速变化的
依赖」时想要的性质。这里恰恰相反：规范一改，我们希望**立刻**被告知。

现在的做法正好给出这个信号：改规范里的词表，下一次 `npm test` 就红。钉住的
submodule 反而会把这个信号压掉。

其余理由照旧：运行时完全不需要规范仓库；生成物已提交，单独 clone 扩展仓库
也能跑通全部功能与测试；submodule 让每个 clone 都付出代价，而收益只落在测试上。
CI 想跑齐这些检查，把两个仓库并排检出即可，三行的事。

**真正缺的是溯源**——「这份常量照着哪一版 schema 生成的」。这个用不着
submodule：生成物里带一个 `SPEC_SOURCE_DIGEST`，是实际读取的那几份 schema
的内容哈希。

刻意**不用**规范仓库的 git commit 当溯源标记：那样规范仓库任何一次提交
（改文档、加测试用例）都会让生成物「过期」，新鲜度测试沦为噪音，很快就没人
当回事。只对影响生成结果的字节取摘要，信号才有意义。有测试守着这一点。

### 参考校验器为什么留在 Python，不改写成 JS

因为**跨语言正是它的价值所在**。

一致性测试目前的含义是：「我们用 JS 写出的字节，被一份独立编写的 Python
校验器认可」。把校验器改写成 JS 并让扩展直接 import，它就退化成「我们的 JS
读我们的 JS」——共享同一套误解，也就测不出误解。

这和 WARC 那边的判断是同一条原则：不用 warcio 来**写**，但用它来**验**。
测试的价值来自独立性。

另外，规范不应该因为第一个生产者是 JS 就变得以 JS 为中心。解析器、站点生成器、
第三方实现可能用任何语言；参考实现是 Python，本身就在示范这个格式不绑定生产者
的语言。

代价是扩展最有价值的那个测试需要 `python3`。这个代价可以接受：python3 在开发机
和 CI 上几乎总是有的，没有时测试会带原因跳过。

### JSON Schema 这一层由规范仓库的 CI 跑（缺口已补）

`validate.py` 的 schema 校验需要 `jsonschema` 与 `referencing`，未安装时它会跳过并只跑
结构性检查。曾经有一段时间**没有任何自动化流程装它**，也就是说六份 `.schema.json` 谁都
没执行过——「产出通过规范校验器」那句话当时的准确含义只是「通过了结构性检查那一层」。

现在 `doubak-data-specs` 的 CI（`.github/workflows/validate.yml`）会先
`pip install jsonschema referencing` 再跑 `validate.py --tests`，schema 层每次 push 都
执行。本地跑不装那两个包仍然会跳过，所以**本地全绿不等于 schema 层通过**——那一层的
权威结论在 CI。

### 一致性测试怎么找到规范仓库

`bundle/v1/validate.py` 是规范的参考校验器。写入器的最终验收标准是：

> 用写入器产出一个 bundle，用规范仓库的校验器校验，必须通过。

这比任何单元测试都更能说明「我们真的写对了格式」。测试按以下顺序定位规范仓库：

1. 环境变量 `DOUBAK_SPECS_DIR`
2. 同级目录 `../doubak-data-specs`（两个仓库并排检出是默认的开发布局）

找不到就**显示原因并跳过**，不静默变绿。

将来若要在 CI 里强制这项检查，比起加 submodule，更简单的做法是让 CI 把两个仓库都检出——submodule 会给每个 clone 都添上麻烦，而收益只落在一个测试上。

## 界面脚本怎么测

`src/ui/*.js` 需要 DOM，而 Node 里没有。曾经的做法是只跑 `node --check`——也就是
**只验语法**。代价很快就来了：两个用户可见的故障都出在这里，两个都语法完全正确
（一个是替换代码时连带删掉了一个函数只留下引用，一个是两块界面抢同一个容器）。

现在有一个极简的假 DOM（`test/helpers/fake-dom.js`）：装好 `document` / `chrome`
等全局，真的把界面脚本 `import` 进来，让第一次 `refresh()` 跑完，再检查它写进了
该写的地方。

**刻意不引入 jsdom。** 一是零依赖的约束（浏览器扩展的每个依赖都是供应链面），
二是完整的 DOM 会给出一个假的确信——真正只有浏览器能验的东西（布局、CSP、
执行上下文的 API 可用性）在任何 DOM 模拟里都验不出来，那些交给
`selftest/` 与真机。

这个假 DOM 只回答一个问题：**这段脚本在一个有 DOM 的地方跑得起来吗。**
所以 `querySelectorAll` 只认界面代码实际用到的那几种形状——多认一种就多一处
「测试里能过、浏览器里不行」。

## 共享契约文件不许 import 任何东西

`test/helpers/file-store-contract.js` 与 `kv-store-contract.js` 同时被两边引用：
Node 的 `node:test`，以及**浏览器里的 `selftest/`**。所以它们必须自带断言，
一个 `import` 都不能有。

代价出现过一次：往 kv 契约里加了 `import assert from 'node:assert/strict'`，
于是整个自检 Worker 加载失败。而模块 Worker 加载失败时 `ErrorEvent` 上**什么信息
都没有**——页面只显示「Worker 出错：undefined」，没有文件名、没有行号、没有原因。
Node 那侧当然全绿（那里 `node:assert` 能用），所以只能在源码层面拦：
`test/no-node-builtins.test.js` 扫 `src/` 全部，以及 `selftest/` 的**传递依赖**
（关键——违规文件在 `test/helpers/` 下，只扫 `selftest/` 目录扫不到）。

顺带把那句报错也修了：现在拿不到细节时会直说「模块加载就失败了」并指向 DevTools
Console。**一条报不出原因的错误信息比没有错误信息更浪费时间**——它让人以为自己已经
知道了些什么。

## 相关文档

- `docs/ui.md` —— 界面设计与文案原则
- `docs/permissions.md` —— 权限审计：声明了什么、刻意不要什么、途中丢失怎么办
