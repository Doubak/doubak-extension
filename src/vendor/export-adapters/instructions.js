/* 【自动同步，请勿手改】来自 doubak-export-adapters 的 src/instructions.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/**
 * 跟产出文件一起写出去的一份说明。
 *
 * 三个平台的上传入口都藏在设置里的不同地方，而且 Letterboxd 是**两次**上传
 * （看过一次、想看一次）——只给一堆 CSV 不说去哪儿传，等于没做完。
 *
 * 说明里带着这一次的真实条数。「导出成功」这四个字什么也没说，
 * 「看过 953 部、想看 509 部、剧集 641 部没导」才说明白了发生过什么。
 */

/**
 * @param {{neodb?: object, neodbCsv?: object, letterboxd?: object, goodreads?: object,
 *          doulists: number, multiRevisionMarks: number, shelfHistory?: boolean}} r
 */
export function instructions(r) {
  const L = [];
  L.push('# 怎么把这些文件导进去');
  L.push('');
  L.push('这几个文件是从档案里现算出来的。**它们不是备份**——备份是 WARC 和 canonical，');
  L.push('删掉这个目录随时能重出一份一模一样的。');
  L.push('');

  if (r.neodb) {
    L.push('## NeoDB');
    L.push('');
    L.push('设置 → 数据 → **导入 NeoDB 备份**，上传 `neodb/neodb-ndjson-import.zip`');
    L.push('（整个 zip，不用解压）。页面会自己认出格式，「检测到的格式」那一行应当显示 **NDJSON**。');
    L.push('');
    L.push('⚠ **不是**名字里带「豆瓣」的那一节。那一节收的是豆伴（Doufen）的 `.xlsx`，');
    L.push('传这个 zip 上去只会被拒。名字对不上是有原因的：豆备产出的本来就是 NeoDB');
    L.push('自己的归档格式，所以走它自己的入口，不需要 NeoDB 那边为豆备加任何东西。');
    L.push('');
    L.push(`这一次带了 **${r.neodb.marks} 条标记**、${r.neodb.ratings} 个评分、`
      + `${r.neodb.comments} 条短评、${r.neodb.tags} 个标签、`
      + `${r.neodb.reviews} 篇书评影评、${r.neodb.notes} 篇笔记、`
      + `${r.neodb.collections} 份豆列、${r.neodb.articles} 篇不挂作品的日记。`);
    L.push('NeoDB 是按 `catalog.ndjson` 里的豆瓣链接找条目的，它库里没有的会自己去豆瓣抓一份，');
    L.push('所以第一次导会慢，而且要挂着。');
    L.push('');
    if (r.shelfHistory) {
      L.push(`✦ 这一份**带着 ${r.neodb.shelfLogs} 条状态历史**，是从广播还原出来的：`);
      L.push('广播是发出去那一刻就冻住的，所以它记着「你哪天把这部片子从想看改成看过」，');
      L.push('还记着**你当时打的星**——豆瓣自己只留最后一次，这段历史在豆瓣上已经看不到了。');
      L.push('');
    } else {
      L.push('⚠ 这一份**没有带状态历史**——是 `--no-shelf-history` 关掉的。去掉那个开关重跑，');
      L.push('  可以从广播里还原出一条带日期的 想看 → 在看 → 看过 时间线，还带着当时打的星。');
      L.push('  **豆瓣自己已经不显示它了**，这份导出不带走，就没有别的地方还有。');
      L.push('');
    }
    L.push('⚠ **NDJSON 这条路上没有可见性选项。** 上传页面检测到 NDJSON 就会把那三个单选框');
    L.push('藏起来，所有记录一律按公开导入。要别的可见性，用 `--visibility=1`（仅关注者）或');
    L.push('`--visibility=2`（仅提及者）重新导出——那个选择写在文件里，不在表单里。');
    L.push('');
    if (r.neodb.noLink) {
      L.push(`⚠ **${r.neodb.noLink} 条没有放进 zip**：这些作品豆瓣已经删掉了，`);
      L.push('档案里连链接都没有，NeoDB 无从定位。它们列在 `neodb/neodb-needs-check.csv` 里，');
      L.push('那个文件**不要上传**——放进去只会固定报几个失败，把真出问题的那条盖住。');
      L.push('');
    }
    if (r.neodb.doulistEntriesDropped) {
      L.push(`⚠ 豆列里有 **${r.neodb.doulistEntriesDropped} 条不是作品条目**`);
      L.push('（别人的影评、小组、人物、照片……），NeoDB 的收藏单只装条目，这些没有去处。');
      L.push('见 `neodb/neodb-doulist-needs-check.csv`。');
      L.push('');
    }
    L.push('还有两样这个包里没有：**图片没有随包搬运**（长文正文里的图还指着豆瓣的图床），');
    L.push('**广播没有变成嘟文**（NeoDB 的导入器里那一段是空的）。两样都还在档案里。');
    L.push('');
  }

  if (r.neodbCsv) {
    L.push('## NeoDB（旧的 CSV 格式）');
    L.push('');
    L.push('设置 → 数据 → **导入 NeoDB 备份**，上传 `neodb_csv/neodb-import.zip`，');
    L.push('「检测到的格式」那一行应当显示 **CSV**。');
    L.push('');
    L.push('CSV 是 NeoDB 为了兼容 NiceDB 和 Doufen 留下的格式，装不下豆列、装不下不挂作品的');
    L.push('日记、装不下状态历史。**除非上面那份 NDJSON 出了问题，否则不用这个。**');
    L.push('它唯一比 NDJSON 强的地方：上传时能选可见性，而且靠 `info` 列里的 `isbn:` 还能');
    L.push('多认出几本豆瓣页面已经没了的书。');
    L.push('');
    L.push(`这一次带了 **${r.neodbCsv.marks} 条标记**、${r.neodbCsv.reviews} 篇书评影评、`
      + `${r.neodbCsv.notes} 篇笔记。`);
    L.push('');
    if (r.doulists) {
      L.push(`⚠ **${r.doulists} 份豆列没有导出。** CSV 导入里没有「收藏单」这一档。`);
      L.push('');
    }
    if (r.neodbCsv.unattachedLongform) {
      L.push(`⚠ **${r.neodbCsv.unattachedLongform} 篇日记没有导出**，因为它们不挂在任何作品上，`);
      L.push('而 NeoDB 的笔记必须挂一个条目。（NDJSON 那一份里它们是 Article，导得进去。）');
      L.push('');
    }
  }

  if (r.letterboxd) {
    L.push('## Letterboxd');
    L.push('');
    L.push('**要传两次**，两个入口不一样：');
    L.push('');
    L.push(`1. 看过的 ${r.letterboxd.watched} 部 —— Settings → Import & Export → Import your data，`);
    L.push('   上传 `letterboxd/letterboxd-watched.csv`。它会一部一部让你确认匹配结果。');
    L.push(`2. 想看的 ${r.letterboxd.watchlist} 部 —— 到 Watchlist 页面，用那里的导入，`);
    L.push('   上传 `letterboxd/letterboxd-watchlist.csv`。');
    L.push('');
    L.push('两个分开是有意的：混在一起的话，想看的片子会变成「看过但没写日期」，');
    L.push('那是**替你宣称你看过没看过的电影**。');
    L.push('');
    L.push(`⚠ Letterboxd 只收电影。剧集 ${r.letterboxd.skippedTv} 部、`);
    L.push(`非影视 ${r.letterboxd.skippedOther} 条，一条都没导。`);
    if (r.letterboxd.skippedUnknown) {
      L.push(`另有 ${r.letterboxd.skippedUnknown} 条没读到详情页、分不清是电影还是剧集，也没导。`);
    }
    L.push('');
    if (r.letterboxd.noImdb) {
      L.push(`⚠ ${r.letterboxd.noImdb} 部**没有 IMDb 号**，见 \`letterboxd-needs-check.csv\`。`);
      L.push('它们照样写进上面两个文件了，只是匹配全靠标题和年份，多半要手工挑。');
      L.push('');
    }
  }

  if (r.goodreads) {
    L.push('## Goodreads');
    L.push('');
    L.push('My Books → Import and export → Import Books，上传 `goodreads/goodreads.csv`。');
    L.push('');
    L.push(`这一次带了 **${r.goodreads.books} 本书**`
      + `（读过 ${r.goodreads.read} · 在读 ${r.goodreads.reading} · 想读 ${r.goodreads.toRead}）。`);
    L.push('Goodreads 的匹配基本只认 ISBN——书名和作者名都是中文，帮不上忙。');
    if (r.goodreads.noIsbn) {
      L.push(`⚠ ${r.goodreads.noIsbn} 本没有 ISBN，见 \`goodreads-needs-check.csv\`。`);
    }
    L.push('');
  }

  L.push('## 有一样东西三个平台都收不下');
  L.push('');
  L.push('canonical 里一条标记记的是**一串观测**：哪个版本的解析器、在什么时候、看见了什么。');
  L.push('三个平台都只收「现在是什么样」，一条记录一行。');
  if (r.multiRevisionMarks) {
    L.push('');
    L.push(`这份档案里有 **${r.multiRevisionMarks} 条标记改过**，导出的是最后一次。`);
  }
  L.push('');
  L.push('这是对外导出该有的方向，但反过来不成立：**别把这些 CSV 当成你的档案。**');
  L.push('');
  return L.join('\n');
}
