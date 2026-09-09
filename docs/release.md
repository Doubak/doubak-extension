# 发一个版本

发布这件事本身是三条命令。这份文档存在，是因为**围着它的那些约束**散落在
`package.yml`、`tools/package.mjs` 与 `test/version.test.js` 的注释里——每一条都有理由，
而理由不写在一处，下一次发版就得靠重新读一遍 CI 去拼。

## 步骤

```sh
# 1. 改版本号：两个文件，一起改
#    manifest.json 是权威的（Chrome 和应用商店认它），package.json 跟着它走
vim manifest.json package.json

# 2. 重新生成 Firefox 那份 manifest —— 它是**算出来的**，版本号也从上面那份来
node tools/make-manifest.mjs

npm test                       # 比对那两个数字，也比对 manifest.firefox.json 是不是最新的

git commit -am "release: 1.2.0"
git push origin main           # 先让 main 上那次跑绿了再打标签（理由见下）

git tag -a v1.2.0 -m "v1.2.0"
git push origin v1.2.0         # ← 这一下触发发布
```

标签必须是 `v` 加 manifest 里的版本号。对不上 CI 会停，而不是发一个自称 `v1.2.0`
而里面写着 `1.1.0` 的包出去。

### 还有一步在另一个仓库

`doubak-website` 的首页在**三处**写死着版本号：首屏徽标、仓库表格，以及
结构化数据里的 `softwareVersion`（给搜索引擎和答题机器人读的那一段）。**发完要跟一次**：

```sh
cd ../doubak-website
sed -i 's/1\.2\.0/1\.3\.0/g' index.html
python3 tools/check-links.py .        # 三处对不上就是红的，并会指出是哪一处
git commit -am "站点：版本号跟到 v1.3.0" && git push
```

第三处是 2026-09-02 加的，加的时候顺手把检查也写了——原来靠一句注释提醒「两处要一起
改」，而这一处恰恰是最不会有人去看的那一处：页面照常渲染，只有机器读到的版本停在上一版。

下载按钮不用管——它指的是 `/releases/latest`，自己会跟（那也正是它这么写的理由）。
「安装到 Chrome」那个按钮也不用管，它指向商店；但**商店里的包要你自己去传**（见下）。

这一步没有任何东西会提醒你：CI 在两个仓库里各跑各的，站点上写着旧版本号照样一路
绿灯。跨仓库的步骤就是这样丢的，所以写在这儿。

## 版本号为什么值得这么小心

它不只是给人看的。`extensionVersion()` 读到的数字会被写进**每一份 bundle 的
`producer.version`**，以及**每个段的 WARC `software:` 头**——而写 bundle 是整条流水线
里唯一不可逆的一步。一个跟真实代码对不上的版本号比没有更糟：它看起来像证据。

这里已经出过一次事。`crawl/runner.js` 与 `bundle/bundle-writer.js` 各写死过一份
`'0.0.1'`，于是 manifest 涨到 0.9.0 之后，**八份已经导出的档案仍然一律自称 0.0.1**——
已经发生的那部分追不回来了。所以现在：

- `src/` 里**不许出现任何形如 `x.y.z` 的字符串字面量**（有测试扫，注释除外）；
- 拿不到版本号时 `extensionVersion()` 抛错，不编一个；
- `BundleWriter` 缺 `producer` 就抛，没有默认值兜底。

第一条是后加的。原来那条只查「有没有写死*当前*版本」，而真正发生的是**写死了一个
过期版本**——按那条判据反倒全都合规。

## CI 做什么

一个工作流（`.github/workflows/package.yml`），两种触发：

| | 推 `main` | 推 `v*` 标签 |
|---|---|---|
| `manifest.firefox.json` 是不是算出来的那份 | ✅ 在打包**之前** | ✅ 同左 |
| 打 zip ×2（Chrome / Edge + AMO） | ✅ | ✅ |
| 摊成可加载目录 ×2 → 两个构建产物 | ✅ | ✅ |
| `web-ext lint`（对着打好的 Firefox 包） | ✅ | ✅ |
| 文件清单 ×2 + 两者的 diff，写进运行摘要 | ✅ | ✅ |
| 标签与 manifest 比对 | — | ✅ 在打包**之前** |
| 建 release、挂**两个** zip | — | ✅ |

**两个商店，两个包，同一份文件名单。** 差别只有 `tools/package.mjs` 的 `TARGETS`
表里那三格（用哪份 manifest、文件名后缀、去掉哪两个在 Firefox 上永远走不到的文件），
CI 里一个文件名都不重复——在 CI 里重写一份名单，漂移的方向是「shipped `test/`」，
而那里面有真实账号的用户名与 uid。

`web-ext lint` 验的是**打好的那个包**，不是仓库：仓库根上放的是 Chrome 那份
manifest，而发出去的不是它（实测对仓库根 lint 是 2 errors，对包是 0）。版本钉成
`web-ext@10`——不钉的话每次 CI 都取一份当天的最新，校验工具漂了，红绿就不再说明
代码变了。

**zip 每次推送都打，哪怕没人下载它。** 它是打包脚本那几项检查（不许带 `test/`、
manifest 引用到的文件必须都在包里、版本号格式）的执行入口。只在发版当天才第一次跑的
东西，就会在最不该出问题的那天第一次出问题。

**先让 main 绿了再打标签**，同理：标签跑失败要收拾的是标签和半个 release，而 main 上
那次跑失败只需要再推一个提交。

### 两种下载途径不一样，别搞混

| | 谁能下 | 装法 |
|---|---|---|
| Actions 产物 `-unpacked` | **必须登录 GitHub**（实测：匿名调下载接口是 401） | Chrome / Edge：解压出来就是可加载的目录 |
| Actions 产物 `-firefox-unpacked` | 同上 | Firefox：解压后选目录里的 `manifest.json` |
| Release 附件 `doubak-<版本>.zip` | 任何人，链接永久（实测 200） | Chrome / Edge，解压之后「加载已解压」 |
| Release 附件 `doubak-<版本>-firefox.zip` | 同上 | Firefox，解压之后「临时载入附加组件…」 |

**两个包别装错。** 两份 manifest 不一样（`background.service_worker` ↔
`background.scripts`），装错了是直接加载失败，而失败信息不会提到是拿错了包。
release 正文第一句就是这个。

所以**面向用户的地方一律指向 Releases**。构建产物是给开发期用的——想试 main 上还没
发版的改动，才走那条。

Release 附件是**原样上传**，不会被再压一层；而 `upload-artifact` 一定会把上传的东西
压成 zip（`compression-level: 0` 也只是不 deflate，外面仍然是个 zip）。这里曾经把 zip
本身也当产物传上去，下下来是 zip 套 zip，而那份东西没有任何消费者。

### 两边都要先解压

release 上那两份都是**商店的提交格式**，收件人是商店，不是浏览器：

- Chrome / Edge：`chrome://extensions` 的「加载已解压的扩展程序」收的是**目录**，
  不收 zip；
- Firefox：`about:debugging#/runtime/this-firefox` 的「临时载入附加组件…」，选解压
  出来那个目录里的 `manifest.json`。

「临时载入」是字面意思：**关掉浏览器就没了**。但 OPFS 里的档案还在，下次载入还能接着
增量抓——这一句要说，否则用户会以为重启一次就白抓了。上架 AMO 之前只有这一条路。

release 正文分两段写这个，因为这是所有人会先踩的一步。

## 发完核对

```sh
gh release download v1.2.0 -R Doubak/doubak-extension -D /tmp/rel
node tools/package.mjs && node tools/package.mjs --firefox   # 本地各打一份
sha256sum /tmp/rel/doubak-1.2.0*.zip dist/doubak-1.2.0*.zip
```

**两对哈希都要一一对上**，别只核 Chrome 那个——两个包是同一条 CI 打出来的，而
「只核了其中一个」与「两个都核了」在输出上长得一模一样。zip 里的时间戳是刻意清零的，
所以同一份代码打出来的包逐字节相同——这条让「release 页上挂的，就是我本地打出来的
那个」变成可验证的，而不是只能相信。

v1.0.0 实测：`b7f257cd9b12bc3710f5ee57594ba34c018557d914c6d6b3558289c7694d5552`，
89 个文件，顶层只有 `LICENSE` / `icons` / `manifest.json` / `selftest` / `src`。

## 发错了怎么办

```sh
gh release delete v1.2.0 --yes
git push origin :refs/tags/v1.2.0
git tag -d v1.2.0
```

`gh release create` 撞上已存在的 release 会直接失败，所以重发之前这两样都得先清掉。

但要清楚**能撤的只是分发**：如果那个版本已经有人装上并且跑过一次抓取，它的版本号
就已经写进那些人的 WARC 里了，那部分撤不掉。

## 上传商店

两个商店，各传各的，而且**都不会跟着 GitHub 的 release 自己走**。

### Chrome 应用商店

已上架：<https://chromewebstore.google.com/detail/hilmaopahndgbiolohgefnbeedobpafe>

Release 上那份 `doubak-<版本>.zip` 就是提交用的，不需要另外打。**上架之后每次发版都要再传一次**
——商店里的版本不会跟着 GitHub 的 release 自己走，而站点上的「安装到 Chrome」指向
的是商店。忘了传的后果是：站点说 v1.0.3，用户装到的是 v1.0.2，而两边都没有任何
东西会提醒你。

表单里每个权限都要写「为什么需要」，可直接粘贴的答案在 [`store-listing.md`](store-listing.md)——改权限的时候，那份、
[`permissions.md`](permissions.md) 和 `manifest.json` 是一起改的。

### AMO（Firefox）

**还没上架**（`Doubak/doubak-extension#11`）。传的是 `doubak-<版本>-firefox.zip`。

提交时要用的那几样——扩展 id（**永远不能改**，理由写在那儿）、联系邮箱、
`strict_min_version` 为什么是 140、`web-ext lint` 剩下的那条警告是什么
——都在 [`firefox.md`](firefox.md) 的「AMO 的两件事」。**这儿一个字都不抄**：
一份说明出现在两处就会分叉，而分叉的方向是「其中一处还写着旧的 id」，
那正好是那个字符串唯一不能出错的地方。有测试守着这一条，而它抓到的第一个违规者
就是这一段的初稿——写着「别抄」，同时把 id 抄了过来。

CI 每次推送都跑一遍 `web-ext lint`，所以提交那天不该再撞上格式问题；真撞上了，
先看是不是 `strict_min_version` 或者安卓那条（我们不投放安卓）。

### 两个商店共用的：标题和简短说明改不了后台

它们取自 `manifest.json`，而那两格指向
[`_locales/<语言>/messages.json`](../_locales)。所以「改一下商店文案」和「发一个版本」
是同一件事：改字 → 重新打包 → 重新提交审核。改完跑一遍 `npm test`
（[`test/locales.test.js`](../test/locales.test.js) 会核长度上限、各语言的键集，
以及 `_locales` 还在不在打包白名单里——漏了它 Chrome 会整个拒绝加载）。
