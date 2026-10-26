# 同系列作品：本地 WARC 中的公开目录片段

来源：2026-10-26 只读检查 `~/downloads/exports`。对应设计见
[同系列作品归档与导航](../../subject-series-and-site-navigation.md) §2.3。

这些 `.html` 是真实详情页里完整的 `_CONFIG` script 元素（末尾补一个换行），
不是整个页面，也不是浏览器执行脚本之后的 DOM。包含公开作品 ID、系列成员、系列 URL、
计数、季名和上映进度；不含登录导航、用户评分 / 短评、Cookie 或响应头。
`sources.json` 记录原始 capture、观测时间、片段 SHA-256 与预期成员 ID，便于从本地原档案复查。
这些是设计证据，不是已经落地的 parser 测试套件。

| 片段 | 要验证的行为 |
| --- | --- |
| `film-before.html` / `film-after.html` | 同一作品、同一系列 URL，其他成员 3 → 4，总数 4 → 5 |
| `tv-many-members.html` | 10 个其他成员、总数 11；季名有字符串也有 null，不能只取前五项或只取带季名的项 |
| `no-series.html` | 其他成员为空、series_url 空串、总数 0；有配置的明确空状态 |
| `singleton-series.html` | 其他成员为空但有系列 URL、总数 1；不能与无系列混同 |
| `members-before-removal.html` / `members-after-removal.html` | 同一来源的其他成员 19 → 14，总数 20 → 15；不能只做历史并集 |
| `order-before.html` / `order-after.html` | 相同两个成员交换顺序；不能描述为新增 / 删除成员 |

读取方式：只读取受限数据字面量，不执行 script，不用 `eval` / `Function` / VM。
`SERIES_OTHER_SUBJECTS` 与 `SERIES_SEASON_NAMES` 的值是 JSON；外层 `_CONFIG` 是 JS
对象字面量，含单引号及未加引号的键，不能把整个对象直接交给 `JSON.parse()`，
也不能用全局替换引号的方式转换。正式实现需有字符串 / 转义感知的边界扫描及负例。

`scope` 是否为完整枚举仍须按设计验证来源契约；这里的 `expected` 只记录原始数组与总数，
没有把数量对上当成完整性证明。片段也不证明系列页的点击 / 分页行为或整个系列身份永不变化。
