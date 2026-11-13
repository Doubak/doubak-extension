# 定期备份提醒与多本人账号到期巡检设计（Issue #7）

- **关联议题**：[`Doubak/doubak-extension#7`](https://github.com/Doubak/doubak-extension/issues/7)（「然后也要考虑下是否需要弄一个定时自动备份的功能，比如每天/周/月备份一次」）
- **设计日期**：2026-11-13
- **当前状态**：待实现（设计定稿）
- **影响范围**：`doubak-extension`（后台常驻巡检、`IdbKvStore` 持久化、通知与角标仲裁、概览页状态提示与单账号提醒开关）

---

## 1. 背景与边界：为什么用「到期提醒」替代「后台静默定时抓取」

Issue #7 最初提出“每天/周/月定时自动备份一次”。结合 `doubak-extension` 现有的架构约束与豆瓣反爬策略，**无人值守的后台静默定时抓取不可行，且会危及用户账号安全**；正确的解法是**纯本地离线到期巡检 + 每日最多一次提醒 + 用户在场一键增量备份**：

1. **反爬与账号安全硬约束（最重要）**
   - 抓取请求必须携带真实 Cookie（`credentials: 'include'`）。豆瓣会在任意时刻下发 SHA-512 PoW 挑战（`sec.douban.com/c`）、图形验证码、`403` 软封禁或 `302` 异常跳转。
   - 无人值守时，后台无法自行完成人机验证；若在用户不知情时反复唤醒抓取并触发风控，极易将临时软限制升级为长时封禁甚至账号锁定。
   - 这也违背 `DESIGN.md` §1 与 `docs/permissions.md` 的核心承诺：**扩展只在用户显式点击「开始抓取」时发起网络请求，绝不在后台偷偷连网访问豆瓣**。
2. **多账号登录态漂移**
   - 豆瓣 Web 会话由浏览器单份 `dbcl2` Cookie 决定，同一浏览器配置下同一时刻只能登录一个豆瓣账号。
   - 后台定时器触发时，浏览器可能未登录豆瓣，或正登录着用户的另一个小号。静默开抓会导致直接报错暂停，或抓错对象。
3. **本地磁盘落盘需要用户手势（User Gesture）**
   - 浏览器 File System Access API（`showDirectoryPicker` / `requestPermission`）在 Service Worker 重启后无法静默重新获取宿主机目录写权限。静默抓取只能把数据堆在浏览器私有的 OPFS 中，既未真正落盘到用户备份目录，又会无声挤占磁盘配额（参见 `#35`）。
4. **增量水位线已让「手动确认一次」足够轻量**
   - `src/crawl/chain.js` 已实现同账号跨档案增量水位线（`buildPriorState`）。只要定期收到提醒、打开面板点一次「开始抓取」，增量备份通常只需几十秒到几分钟即可跑完。

### 核心设计决策汇总

| 维度 | 决策规则 |
| --- | --- |
| **网络行为** | 提醒巡检 **100% 纯本地离线计算**（仅读取 IndexedDB / OPFS），绝不发起任何豆瓣网络请求 |
| **纳管范围** | **仅限本人账号（`visibility === 'self'`）**。纯公开抓取的第三方账号（`visibility === 'public'`）不参与提醒、不设开关，仅在「已有档案的账号」气泡上被动显示距今天数 |
| **多本人账号** | 支持同一用户拥有多个本人账号（如大号 A、小号 B 轮流登录抓取）。每个 `visibility === 'self'` 的账号拥有独立的提醒开关（Toggler），**默认开启（`ON` / `true`）** |
| **提醒频率** | **每天最多发出一次系统通知**。若今日发出的提醒未被处理（未完成新备份、也未关闭开关），**次日及之后每天最多再提醒一次**，直至处理完毕 |
| **单人抓取对齐** | 备份执行严格保持单人单次。当存在多个超期本人账号、或当前浏览器登录的账号与超期本人账号不一致时，UI 明确引导先抓当前号或先在豆瓣切换登录，防止误抓 |

---

## 2. 账号准入与基准时间计算（纯函数契约）

### 2.1 什么是「本人账号（`visibility === 'self'`）」

在 `manifest.json` 中，每次抓取的范围记录在 `manifest.crawl_scope`：

```json
"crawl_scope": {
  "visibility": "self",
  "operator_uid": "12345678",
  "target_input": null
}
```

- **单档案判定**：若 `manifest.crawl_scope?.visibility` 为 `'self'`，或旧版档案缺失 `crawl_scope` 字段（v1.5 之前仅支持本人抓取，缺省视为 `'self'`），则该档案属于本人视角档案。
- **账号级准入（`isSelfAccount`）**：按稳定数字 `uid`（`manifest.account.uid`）聚合。只要某 `uid` 下**至少存在一份**本人视角（`visibility === 'self'`）的已记录档案，该 `uid` 即被认定为用户的**本人账号**，纳入到期提醒与单号 Toggler 管理。
  - *推论*：如果用户曾登录自己的小号 B 抓过一次 `self` 档案，后来又在大号 A 登录态下用输入框把小号 B 当作 `public` 抓过一次，小号 B 依然保有本人账号身份（`hasSelfArchive === true`）。
  - *反之*：如果某账号 C 从头到尾只有 `visibility === 'public'` 的档案（纯粹围观的第三方博友），则 `hasSelfArchive === false`，**绝不进入提醒队列，也不展示提醒 Toggler**。

### 2.2 什么样的档案才算「完成了一次有效备份」（重置计时器判据）

并非所有带有 `manifest.json` 的目录都能重置备份倒计时。用户在抓取中途点击「中止（Abort）」或刚建好目录就中断时，也会写出 `manifest.json`。

一份档案 `manifest` 能更新某本人账号的「上次有效备份时间（`lastCompletedAtMs`）」，必须**同时满足**以下三个条件：

1. **身份匹配**：`manifest.account?.uid` 非空，且 `(manifest.crawl_scope?.visibility ?? 'self') === 'self'`。
   - *注意*：在大号下以 `visibility === 'public'` 顺手抓了一次小号，由于公开视角无法读取私密条目与受限广播，不能算作小号完成了本人全量/增量备份，**不重置**小号的本人备份计时器。
2. **实质推进（Baseline Qualification）**：参照 `src/crawl/chain.js` 的 `buildPriorState()` 契约：
   - 若存在 `Array.isArray(manifest.crawl_state)`：必须至少有一条路线完成了水位线推进，即 `manifest.crawl_state.some(cs => cs.advanced === true)`；
   - 若为早期不含 `advanced` 布尔位的旧版档案：回退要求 `manifest.status === 'complete'`。
   - **拦截效果**：刚开抓就点中止（0 条路线 `advanced: true`）的 `aborted` 档案、或所有路线全部失败的档案，**不会重置**到期提醒计时器。
3. **有效时间戳提取**：复用 `src/crawl/chain.js` 的 `timeKeyOf(manifest)` 优先级：
   - 优先解析 `Date.parse(manifest.completed_at)`；
   - 若缺失或非法，回退解析 `manifest.bundle_id` 前缀的 UTC 时间戳（`^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z_` -> `YYYY-MM-DDTHH:mm:ssZ`）；
   - 若仍无法解析则忽略该档案。

### 2.3 超期天数与状态判定公式

给定当前时间戳 `nowMs`、全局提醒周期 `intervalDays`（取整天数，`0` 表示全局关闭提醒；可选 `7` / `14` / `30` / `60` / `90`，默认 `30`）：

```js
const DAY_MS = 86_400_000;
const elapsedMs = Math.max(0, nowMs - account.lastCompletedAtMs);
const ageDays = Math.floor(elapsedMs / DAY_MS);
const isEnabled = reminderState.intervalDays > 0 && (reminderState.accountToggles[uid] ?? true);
const isOverdue = isEnabled && elapsedMs >= reminderState.intervalDays * DAY_MS;
```

- `Math.max(0, ...)` 用于防御系统时钟回拨导致的负数天数。
- 当 `intervalDays === 0`（全局关闭）或 `accountToggles[uid] === false`（该本人账号单独关闭）时，`isOverdue` 恒为 `false`。

---

## 3. 存储模型与跨上下文同步（`IdbKvStore`）

### 3.1 为什么必须在 `IdbKvStore` 维护轻量级账号备份摘要

1. **上下文能力隔离**：
   - `test/context-capabilities.test.js` 与 `src/background.js` 严格规定：Service Worker（`background.js`）只负责消息路由、闹钟唤醒、图标角标与系统通知，**不直接读取 OPFS**（OPFS 文件扫描集中在 `offscreen.js` 和 `panel.js`）。
   - `docs/permissions.md` 与 `test/manifest.test.js` 严格规定：`chrome.storage` 仅用于 `chrome.storage.session` 存放 5 分钟 TTL 的登录态探测缓存，所有持久化业务状态一律存放在 IndexedDB（`IdbKvStore`，库名 `doubak-state`）。
2. **「导出后删除 OPFS 档案释放空间」的核心场景**：
   - 用户完成备份并导出 ZIP / 落盘到宿主机目录后，经常会点击档案列表的「删除」按钮清空浏览器 OPFS 以释放吉字节级的磁盘空间（见 `README.md` §「把导出过的档案搬回来」与 `#35`）。
   - 如果提醒巡检仅依赖实时扫描 OPFS 中现存的目录，一旦用户导出后删掉 OPFS 里的旧包，扩展就会误以为该账号“从未备份过”或“退回到了半年前的残存旧包”，导致刚备份完第二天又乱发过期提醒，或者把账号直接从提醒列表里弄丢。

因此，在 `IdbKvStore`（`doubak-state`）中新增持久化键 `doubak.reminderState`，同时保存**提醒配置**与**本人账号最后有效备份摘要**。

### 3.2 `doubak.reminderState` 数据结构（Schema）

```js
// IdbKvStore key: 'doubak.reminderState'
{
  version: 1,

  // 全局提醒周期（天）：0 = 关闭全局提醒；支持 7 | 14 | 30 | 60 | 90，默认 30
  intervalDays: 30,

  // 每个本人账号 (uid) 的独立 Toggler 状态。
  // 缺省规则：只要 uid 在 accounts 中且 hasSelfArchive === true，
  // 读取时 `accountToggles[uid] ?? true` 默认视为 ON (true)。
  accountToggles: {
    "12345678": true,
    "87654321": false
  },

  // 每日最多一次通知的限频水位线
  lastNotifiedDate: "2026-11-13",      // 本地时区自然日 'YYYY-MM-DD'，未通知过为 null
  lastNotifiedAtMs: 1794567890000,     // 上次发出系统通知的 UTC 毫秒时间戳，未通知过为 0

  // 已识别的本人账号备份摘要字典（仅收录 hasSelfArchive === true 的账号）
  accounts: {
    "12345678": {
      uid: "12345678",
      username: "mewx",                // 最近一次档案的个性域名（如无则为 uid）
      nickname: "MewX",                // 最近一次档案的昵称（可为 null）
      hasSelfArchive: true,            // 恒为 true（纯 public 账号不写入此持久化表）
      lastCompletedAtMs: 1791975890000,// 最近一次有效 self 备份的完成时间戳（ms）
      lastBundleId: "20261014T082450Z_12345678_a1b2c3d4"
    }
  }
}
```

### 3.3 状态同步时机（Write Paths）

`doubak.reminderState` 通过专门的辅助模块 `src/storage/reminder-store.js` 进行原子读写（读-改-写封装），在以下 4 个时机同步更新：

1. **抓取收尾时（`offscreen.js` -> `runner` 完成写盘后）**
   - 当一次抓取结束并写出最终 `manifest.json` 后，若该 `manifest` 满足 §2.2 的有效本人备份判据（`visibility === 'self'` 且至少一条路线 `advanced === true`）：
   - 更新 `accounts[uid]` 的 `username`、`nickname`，并在 `completedAtMs >= (accounts[uid]?.lastCompletedAtMs ?? 0)` 时推进 `lastCompletedAtMs` 与 `lastBundleId`。
   - 若 `accountToggles[uid]` 尚未定义，初始化为 `true`（默认开启）。
   - 随后向 `background` 发送 `{ type: 'evaluateBackupReminder' }`，立即重算角标与提醒状态（若此前有超期角标，备份完成后立刻清除）。
2. **从外部导入档案时（`panel/overview.js` / `offscreen.js` 导入完成）**
   - 用户从磁盘导入历史档案（ZIP 或目录）后，若导入的 `manifest` 满足 §2.2 有效本人备份判据，且其完成时间比 `accounts[uid].lastCompletedAtMs` 更新（或该 `uid` 首次出现），同样正向推进 `accounts[uid]` 并触发 `evaluateBackupReminder`。
3. **打开面板扫描 OPFS 时的首次回填与对账（`panel/overview.js` -> `refreshBundles`）**
   - 升级到支持提醒功能的版本后，老用户首次打开面板时 `accounts` 为空。
   - `scanBundleDirs` 遍历现有 OPFS 中的所有 `manifest.json`：对每个满足 §2.2 的本人档案，按 `uid` 取最大 `completedAtMs` 与 `IdbKvStore` 中的 `accounts[uid]` 取 `Math.max` 合并（**只进不退**）。
   - *为什么只进不退*：保护「导出后删除了 OPFS 最新档案」的场景，避免因为 OPFS 只剩半年前的旧包甚至空目录而把 `lastCompletedAtMs` 倒退回去。
4. **删除档案或清理废弃本人账号记录时**
   - **常规删除 OPFS 档案**：用户在档案列表中删除某个已导出的 OPFS 档案以腾出空间时，**不回退、不删除** `accounts[uid].lastCompletedAtMs`。
   - **显式移除账号记录**：如果某个本人小号已经彻底注销或不再使用，用户除了可以把它的 Toggler 关掉（`OFF`），也可以在提醒账号列表中当该账号在 OPFS 中已无任何留存档案时点击「移除记录」（或直接关闭 Toggler），从 `accounts[uid]` 和 `accountToggles[uid]` 中清除。

---

## 4. 调度、每日限频与「未处理次日再提醒」机制

### 4.1 唤醒与巡检触发源（Triggers）

为了在不增加后台常驻开销的前提下做到准时、可靠，巡检函数 `evaluateBackupReminder({ allowNotify })` 由以下事件触发：

| 触发源 | `allowNotify` | 说明 |
| --- | --- | --- |
| `chrome.runtime.onStartup` | `true` | 浏览器每天首次启动时巡检一次（最主要的桌面端触发点） |
| `chrome.runtime.onInstalled` | `false` | 扩展安装/更新时注册周期闹钟并刷新角标，首装不弹窗打扰 |
| `chrome.alarms.onAlarm` (`doubak-backup-reminder`) | `true` | 浏览器长开不关时的周期巡检（`periodInMinutes: 240`，即每 4 小时检查一次） |
| 抓取结束 / 档案导入完成 | `false` | 备份刚完成，刷新并清除超期角标与残留提醒通知 |
| 用户在面板修改周期或切换单号 Toggler | `false` | 立即重算角标与面板文案，无需弹出系统通知自我打扰 |

> **与 `Supervisor` 心跳闹钟严格隔离**：
> `src/crawl/supervisor.js` 使用 `ALARM_NAME = 'doubak-heartbeat'`（每 0.5 分钟），且 `test/supervisor.test.js` 断言无抓取任务时会调用 `chrome.alarms.clear('doubak-heartbeat')`。
> 因此备份提醒必须使用独立的闹钟名 `REMINDER_ALARM_NAME = 'doubak-backup-reminder'`，在 `background.js` 的 `onAlarm` 监听器中按 `alarm.name` 分流，绝不干扰 `Supervisor`。

### 4.2 优先级仲裁：抓取进行中或暂停待处理时绝对避让

在 `background.js` 执行 `evaluateBackupReminder` 时，第一步检查当前是否有活跃抓取或未收尾的断点（Checkpoint）：

```js
const checkpoint = await scheduleStore.loadCheckpoint();
if (checkpoint !== null) {
  // 当前有正在运行的抓取，或因 challenge / blocked / failures_pending / user_paused 暂停的抓取。
  // 此时角标和通知的所有权归属抓取状态机（如红色 '!' 警告角标），提醒巡检直接退让。
  return { skipped: 'crawl_active_or_paused' };
}
```

- 这样可以保证：当抓取因验证码或软封禁暂停、角标显示红色 `!`（`notifyNeedsAction`）时，低优先级的备份提醒**绝不会覆盖红色 `!` 角标，也不会弹出提醒通知干扰用户处理验证码**。

### 4.3 「每天最多发出一次，未处理次日再提醒」的精确算法

用户需求明确规定：**对于提醒，每天最多发出一次，今天没处理的提醒明天会再提醒一下**。

#### 1. 为什么不能只用纯 24 小时滚动窗口（`now - last >= 86400_000`）？
如果只判断 `nowMs - lastNotifiedAtMs >= 86_400_000`：
- 假设第 1 天用户在 `15:00` 打开浏览器收到提醒但未处理；
- 第 2 天用户在 `09:00` 打开浏览器工作，`14:00` 关机离开。因为 `09:00 ~ 14:00` 距离昨天 `15:00` 不满 24 小时，**第 2 天整天都不会发出提醒**！这就违反了“今天没处理的提醒明天会再提醒一下”的直觉预期。

#### 2. 为什么不能只比较本地自然日字符串（`localDate !== lastNotifiedDate`）？
如果只判断 `localDate !== lastNotifiedDate`：
- 假设用户在 `23:50` 才打开浏览器，收到了一次今日提醒；
- 15 分钟后跨过午夜到了 `00:05`，4 小时闹钟刚好触发，自然日变成了第二天，就会在 15 分钟内连弹第二次通知。

#### 3. 组合判据：本地自然日变更 + 跨午夜最小冷却保护（`MIN_COOLDOWN_MS = 6 * 3600_000`）

格式化的本地自然日函数 `formatLocalDate(ms)`：

```js
export function formatLocalDate(ms) {
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
```

允许发出今日通知的充要条件 `shouldEmitDailyReminder(reminderState, overdueAccounts, nowMs)`：

1. **存在未处理的超期本人账号**：`overdueAccounts.length > 0`（至少有一个 `hasSelfArchive === true` 且 `accountToggles[uid] !== false` 的账号满足 `nowMs - lastCompletedAtMs >= intervalDays * DAY_MS`）。
2. **今日尚未通知过**：`formatLocalDate(nowMs) !== reminderState.lastNotifiedDate`。
3. **跨午夜最小冷却已过**：`nowMs - (reminderState.lastNotifiedAtMs || 0) >= 6 * 3600_000`（6 小时冷却窗，防止 `23:50` 与 `00:05` 连发；即使夜猫子 `23:50` 收到通知，睡醒后第二天早上 `08:00` 打开浏览器已满 8 小时，依然会正常收到次日提醒）。

一旦发出系统通知：
- 立即将 `lastNotifiedDate = formatLocalDate(nowMs)` 与 `lastNotifiedAtMs = nowMs` 写回 `IdbKvStore`。
- 同一自然日内后续无论触发多少次 `onStartup` 或 `onAlarm`，由于 `formatLocalDate(nowMs) === lastNotifiedDate`，**当天绝不会发出第二次通知**。
- 如果用户当天只是划掉了通知气泡（或忽略未理会），既没有完成备份，也没有关掉该账号的 Toggler：到了第二天，`overdueAccounts` 依然非空，且 `formatLocalDate(nowMs) !== lastNotifiedDate`，系统会在第二天自动再次发出提醒！

### 4.4 「已处理」与「未处理」的状态转移表

| 用户在收到提醒后的动作 | `overdueAccounts` 变化 | 工具栏角标变化 | 次日是否还会提醒？ |
| --- | --- | --- | --- |
| **忽略 / 直接关掉系统通知弹窗** | 仍为超期（未处理） | 保持琥珀色天数角标（如 `35d`） | **会**。次日首次满足冷却窗的唤醒会再次发出提醒 |
| **启动抓取，但中途报错或 0 路线推进即中止** | `lastCompletedAtMs` 未更新，仍为超期（未处理） | 抓取期间归属抓取状态；清理断点后恢复超期角标 | **会**。未形成有效增量备份，次日继续提醒 |
| **完成该账号的增量/全量备份（≥1 条路线 `advanced`）** | 该账号 `lastCompletedAtMs` 更新为当前时间，移出 `overdueAccounts` | 若无其他超期本人号，立即清除角标与通知；若有另一个超期本人号，角标更新为另一号的距今天数 | **该账号不再提醒**（重新进入下一个 `intervalDays` 周期）；若另一本人号仍超期，次日仅针对剩余超期号提醒 |
| **在面板将该本人账号的 Toggler 设为 `OFF`** | 该账号 `isEnabled = false`，移出 `overdueAccounts` | 若无其他开启且超期的本人号，立即清除角标与通知 | **该账号不再提醒**，直到用户重新将其 Toggler 拨回 `ON` |
| **将全局提醒周期调大（如从 `14天` 改为 `60天`）或设为 `不提醒`** | 若距今天数 `< 60`，移出 `overdueAccounts` | 立即清除角标与通知 | 在满 60 天前**不再提醒** |

---

## 5. 界面与多本人账号交互设计（UI）

### 5.1 系统通知与扩展图标角标（`src/ui/notify.js`）

扩展现有两类通知（`doubak-attention` 与 `doubak-done`），新增第三类低打扰通知 `REMINDER_ID = 'doubak-reminder'`（同步更新 `docs/permissions.md`）：

1. **工具栏角标（Badge）**：
   - 当 `overdueAccounts.length > 0` 且无活跃/暂停抓取时，在扩展图标上显示最久未备份的那个超期本人账号的天数：
     - `< 100` 天显示为 `${maxAgeDays}d`（如 `32d`，最多 3 个字符，适配 Chrome / Firefox 角标宽度）；
     - `>= 100` 天显示为 `99+`。
   - 背景色采用温和的琥珀色 `#8a6116`（与「需介入」的警示红 `#b5382a` 形成清晰视觉区分）。
   - 当所有开启提醒的本人账号均未超期（或提醒已关闭）且无需介入状态时，调用 `clearReminderBadge()` 清空角标文字并清除残留的 `doubak-reminder` 通知。
2. **系统通知文案（单号 vs 多本人号汇总）**：
   - **仅 1 个本人账号超期**：
     - 标题：`豆瓣备份已超过 N 天未更新`
     - 正文：`账号「<显示名>」上次备份于 N 天前，点击打开面板开始增量备份。`
   - **多个本人账号同时超期（例如大号 A 35 天、小号 B 48 天）**：
     - 标题：`有 M 个豆瓣账号已超期未备份`
     - 正文：`「<最久账号名>」等 M 个本人账号已超过设定周期（最久 N 天前），点击打开面板查看。`
   - **通知参数与跨浏览器兼容**：
     - 复用 `notify.js` 现有的 `tryCreate` 降级机制（Firefox 不支持 `requireInteraction` / `silent` 时自动回退为基础 `{ type, iconUrl, title, message }`）。
     - `doubak-reminder` 默认不开启 `requireInteraction: true`（避免像验证码警报那样霸屏不退），允许操作系统按常规通知自动收纳到通知中心；点击通知触发 `chrome.notifications.onClicked`（已绑定 `openPanel()`），直接呼出扩展工作台。

### 5.2 概览页 `#state` 状态卡：多本人账号与当前登录态的防呆对齐

备份执行严格是**单人单次**的：当概览页「要抓取的豆瓣账号」输入框（`#target-account`）为空时，点击 `[ 开始抓取 ]` 抓取的是**当前浏览器 Cookie 登录的账号**。

如果用户拥有两个本人账号（大号 A、小号 B），必须防止「提醒说小号 B 超期了，但浏览器当前登着大号 A，用户顺手点开始抓取结果把刚备过份的大号 A 又抓了一遍」。

因此在 `src/ui/panel/overview.js` 的 `renderOverviewState` 中，当处于空闲态（`!active && !paused`）且 `#target-account` 输入框为空时，结合当前登录态探测缓存（`loginHint`）与 `overdueAccounts` 分三种情况渲染 `#state`：

#### 场景 A：当前已登录的本人账号恰好在超期列表中（最常见）
- 例如：当前已登录「阿北（`ahbei`）」，且该账号距上次备份已 35 天（设定周期 30 天）。
- `#state` 提示（带柔和琥珀色左边框 `.state-reminder`）：
  > **备份提醒**：当前已登录账号「**阿北 (ahbei)**」距离上次备份已过 **35 天**（上次备份：2026-10-09）。直接点击下方「**开始抓取**」即可执行增量备份。

#### 场景 B：当前登录的是本人大号 A（未超期），但本人小号 B 超期了（跨号防呆！）
- 例如：当前已登录「大号 A」（3 天前刚备份过），而开启了提醒的「小号 B（`alt_b`）」已 42 天未备份。
- `#state` 提示（明确点出登录态差异，严防误点）：
  > **备份提醒**：本人账号「**小号 B (alt_b)**」已 **42 天**未备份。
  > 当前豆瓣登录的是「**大号 A**」（3 天前已备份）。如需完整备份「小号 B」的本人数据，请先在豆瓣网页切换登录为「小号 B」（面板会自动感知登录切换），再点击「开始抓取」；若暂不备份该号，可在下方关闭其提醒开关。
- **自动联动**：`src/background.js` 已有 `chrome.cookies.onChanged` 监听 `dbcl2` Cookie 变化并广播 `sessionHintsInvalidated`。用户在隔壁豆瓣标签页退出大号 A、登录小号 B 后，打开的面板会自动刷新 `loginHint` 并瞬间将 `#state` 切换为**场景 A**（「当前已登录账号『小号 B』距离上次备份已过 42 天，直接点击开始抓取即可」），体验无缝衔接。

#### 场景 C：存在超期本人账号，但当前浏览器未登录豆瓣
- `#state` 提示：
  > **备份提醒**：「**阿北 (ahbei)**」已 **35 天**未备份。当前浏览器未登录豆瓣，请先前往 `douban.com` 登录该账号后再点击「开始抓取」。

*(注：若用户在 `#target-account` 输入框里手动填入了某个第三方账号准备围观抓取，`#state` 保持现有的目标探测提示，不被备份提醒文案抢占。)*

### 5.3 概览页「已有档案的账号」气泡（`#target-accounts`）：被动展示距今天数

在概览页现有的 `#target-accounts` 区域（由 `src/ui/panel/target.js` 的 `renderKnownAccountChips` 渲染）：
- 对所有已知账号（**包含 `visibility === 'self'` 的本人账号和 `visibility === 'public'` 的第三方账号**），在气泡末尾追加灰色的相对距今天数：
  - 当天（`< 1` 天）：`· 今天`
  - `>= 1` 天：`· 12 天前`
- 若该账号是**本人账号**且当前处于**超期状态（`isOverdue === true`）**，气泡附加 `.target-account-chip-overdue` 样式（琥珀色边框与文字强调），直观标示哪几个本人号超期了。
- **交互保持纯粹**：点击 `#target-accounts` 里的气泡仍然保持现有的「填入输入框以公开视角抓取（或清空以抓当前登录号）」语义，不在该气泡内塞入复选框，避免点击开关时误触发 `probeTarget` 网络请求。

### 5.4 概览页「定期备份提醒」配置区与单账号 Toggler（默认 ON）

在 `src/ui/panel.html` 概览页（`#tab-overview`）的设置区域（紧随抓取路线与关联条目深度设置之后），新增折叠紧凑的「**定期备份提醒**」卡片（`#backup-reminder-section`）：

```text
┌──────────────────────────────────────────────────────────────────────┐
│ 定期备份提醒                     提醒周期：[ 每 30 天 ▾ ]            │
│ 仅对曾以「本人登录」抓取过的账号生效；每天最多提醒一次，未处理次日再提 │
│                                                                      │
│ 本人账号提醒开关：                                                   │
│  ┌────────────────────────────────────┐  ┌─────────────────────────┐ │
│  │ [● ON ] 阿北 (ahbei) · 3 天前      │  │ [● ON ] 小号B · 42 天前⚠│ │
│  └────────────────────────────────────┘  └─────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

1. **全局提醒周期下拉框（`#reminder-interval`）**：
   - 选项：`每 7 天` (`7`)、`每 14 天` (`14`)、`每 30 天（推荐）` (`30`，默认)、`每 60 天` (`60`)、`每 90 天` (`90`)、`关闭提醒` (`0`)。
2. **本人账号独立 Toggler 列表（`#reminder-self-accounts`）**：
   - **过滤规则**：仅渲染 `reminderState.accounts` 中 `hasSelfArchive === true` 的本人账号。纯 `public` 第三方账号不在此处出现。
   - **默认状态**：每个新识别的本人账号 Toggler 默认均为 **开启（`ON` / `true`）**（采用 `<button role="switch" aria-checked="true">` 或带 `.toggle-switch` 样式的 `<input type="checkbox">`）。
   - **零网络开销**：切换任意账号的 Toggler 仅修改 `IdbKvStore` 中的 `doubak.reminderState.accountToggles[uid]`，并立即刷新 `#state` 提示、气泡高亮与扩展图标角标，**绝不触发任何网络探测请求**。
   - **空状态**：如果用户刚安装扩展、尚未完成过任何一次本人抓取，列表处显示一行浅色说明：`完成首次本人账号备份后，可在此按账号管理提醒开关。`
   - **当全局周期选为「关闭提醒 (`0`)」时**：下方单账号 Toggler 列表置灰禁用（保留各自原本的开关记忆，重新开启全局周期后恢复）。

---

## 6. 极端边界情况（Edge Cases）完整处置矩阵

为确保实现无死角，以下逐一列出所有边界情况及其确定性处置逻辑：

| # | 边界情况（Edge Case） | 风险现象 | 确定性处置方案 |
| --- | --- | --- | --- |
| **E1** | **全新安装 / 从未备份过任何本人账号** | 安装后若把“无备份记录”当成“无穷久未备份”，会立刻弹出虚假超期提醒 | `accounts` 字典为空时，`overdueAccounts` 恒为空数组 `[]`。没有任何本人有效备份基线前，**绝不发出提醒**。 |
| **E2** | **只抓过第三方公开账号（`visibility === 'public'`），从未抓过本人** | 围观博友账号后被每日催促备份博友 | 准入契约严格检查 `(manifest.crawl_scope?.visibility ?? 'self') === 'self'`。纯 `public` 账号不写入 `reminderState.accounts`，不显示 Toggler，不触发提醒。 |
| **E3** | **本人账号抓取刚开始就点击「中止（Abort）」或全部路线报错** | 生成了 `status: 'aborted'` 的 `manifest.json`，若盲目采信其 `completed_at` 会导致超期计时被清零假重置 | 严格校验 `manifest.crawl_state?.some(cs => cs.advanced === true)`。0 条路线推进的中止/失败包**不更新** `lastCompletedAtMs`，超期提醒继续保持未处理状态。 |
| **E4** | **中途暂停后点击「中止」，但已有部分路线完成了增量推进** | 例如书/影抓完（`advanced: true`），音乐被中止 | 因至少有 1 条路线实质推进了水位线，按 §2.2 计为一次有效备份推进（与 `chain.js` `buildPriorState` 语义完全一致）。 |
| **E5** | **用户在大号 A 登录态下，用输入框把自己的小号 B 当作 `public` 抓了一次** | `public` 抓取漏掉了小号 B 的私密日记与仅自己可见条目，却重置了小号 B 的提醒倒计时 | 更新 `reminderState.accounts[B].lastCompletedAtMs` 时，强制要求**本次档案本身**的 `(crawl_scope?.visibility ?? 'self') === 'self'`。`public` 抓取绝不推进任何本人账号的 `lastCompletedAtMs`。 |
| **E6** | **用户导出 ZIP 到电脑硬盘后，删空了浏览器 OPFS 里的所有档案以释放空间** | 若每次只扫 OPFS，删包后账号从提醒列表消失，或倒退回半年前没删的旧包导致误报 | `reminderState.accounts[uid]` 持久化在 `IdbKvStore` 中。常规删除 OPFS 档案**不删除、不回退** `IdbKvStore` 中的 `lastCompletedAtMs`；面板 `scanBundleDirs` 与 `IdbKvStore` 对账时采用 `Math.max` 单向推进。 |
| **E7** | **同一天内多次开关浏览器、或后台 4 小时闹钟多次触发** | 每天弹好几次通知烦扰用户 | `lastNotifiedDate` 记录本地自然日 `YYYY-MM-DD`。同一本地自然日内一旦成功发出过一次通知，后续所有触发仅更新角标，**绝不二次弹窗**。 |
| **E8** | **午夜前后临界点（如 `23:55` 刚弹过通知，`00:05` 跨零点后闹钟触发）** | 虽然自然日变了，但间隔仅 10 分钟，连弹两次体验差 | 引入跨午夜最小冷却保护 `nowMs - lastNotifiedAtMs >= 6 * 3600_000`（6 小时）。`23:55` 弹过后，`00:05` 被冷却窗拦截；等到次日白天（`>= 05:55`）唤醒时正常发出次日提醒。 |
| **E9** | **用户今天收到提醒后没处理（划掉通知或没管），第二天打开浏览器** | 担心像一次性边沿触发那样“响一次就永远沉默” | 只要超期条件仍成立（未完成新备份、未关 Toggler），第二天 `formatLocalDate(nowMs) !== lastNotifiedDate` 且已过冷却窗，**必定再次提醒**，日复一日直到用户处理。 |
| **E10** | **后台正在抓取，或抓取因验证码/软封禁暂停（角标正显示红色 `!`）时闹钟触发** | 琥珀色天数角标覆盖了红色 `!` 救火角标，或提醒通知冲淡了验证码通知 | `evaluateBackupReminder` 首行检查 `ScheduleStore.loadCheckpoint()`。只要存在未收尾的 `checkpoint`，提醒巡检立即 `return`，绝对避让抓取状态机。 |
| **E11** | **抓取刚因为验证码暂停，用户随后中止并清理了任务** | 红色 `!` 清除后，若原本有另一个本人小号超期，角标怎么恢复？ | `finish` / `abort` 收尾清理 `checkpoint` 后，统一调用 `evaluateBackupReminder({ allowNotify: false })`，自动将角标恢复为剩余超期账号的琥珀色天数（不重复弹窗）。 |
| **E12** | **用户在豆瓣修改了个性域名（`username`）或昵称（`nickname`）** | 同一个账号被当成两个账号，旧域名一直报超期 | `reminderState.accounts` 与 `accountToggles` 严格以豆瓣不可变的数字 `uid` 为主键。新档案完成时自动用最新 `username` / `nickname` 覆盖展示名，Toggler 状态与历史时间无缝延续。 |
| **E13** | **用户跨时区旅行或系统时钟回拨** | `nowMs < lastCompletedAtMs` 算出来负天数，或向西飞越日界线导致当天重发 | `elapsedMs = Math.max(0, nowMs - lastCompletedAtMs)` 钳制非负；6 小时绝对毫秒冷却窗 `nowMs - lastNotifiedAtMs >= 6 * 3600_000` 在跨时区改变本地日期字符串时依然能兜底防抖。 |
| **E14** | **升级扩展前的老用户已有多个历史本人档案（含 v1.4/v1.5 无 `crawl_scope` 的旧档案）** | 升级后 `IdbKvStore` 中还没有 `doubak.reminderState` | 1) 旧档案缺省 `(manifest.crawl_scope?.visibility ?? 'self') === 'self'`，正常识别为本人档案；<br>2) 升级后首次打开面板，或后台首次巡检通过轻量 `ensureReminderSeeded` 消息委托 `offscreen` 扫描一次现有 OPFS `manifest.json`，即可把历史本人账号自动回填进 `reminderState.accounts`，且 Toggler 默认全为 `ON`。 |
| **E15** | **同时打开了两个扩展工作台标签页（Panel Tab A 与 Tab B）修改开关** | 内存状态覆盖导致刚关掉的 Toggler 被另一标签页写回 | `ReminderStore` 的每次更新均在 `IdbKvStore` 事务内执行最新的 `get -> patch -> set`，并通过 `chrome.runtime.sendMessage({ type: 'reminderStateChanged' })` 广播给所有打开的面板同步刷新 UI。 |
| **E16** | **Firefox 与 Chromium 的 `chrome.notifications` 差异** | Firefox 不支持 `silent` / `requireInteraction` 会抛异常导致 `lastNotifiedDate` 未记录或误记录 | 复用 `notify.js` 的 `tryCreate` 包装；且即便操作系统层禁用了浏览器通知权限，只要走完通知发射分支，仍正常记录 `lastNotifiedDate` 并更新工具栏角标，避免后台死循环重试。 |

---

## 7. 涉及文件、权限文档与测试计划

### 7.1 新增与修改文件清单

| 文件路径 | 变更内容说明 |
| --- | --- |
| `src/storage/reminder-store.js` *(新增)* | 封装 `doubak.reminderState` 的 Schema 默认值、纯函数判定（`qualifiesAsSelfBackup`、`computeOverdueAccounts`、`shouldEmitDailyReminder`、`formatLocalDate`）以及基于 `IdbKvStore` 的原子读写方法（`loadReminderState`、`recordCompletedBackup`、`reconcileFromManifests`、`setIntervalDays`、`setAccountToggle`、`markNotified`）。 |
| `src/ui/notify.js` | 新增 `REMINDER_ID = 'doubak-reminder'`、`notifyBackupReminder(overdueAccounts)` 与 `clearReminderBadge()`。<br>**测试兼容注意**：`test/offscreen.test.js` 对 `src/ui/notify.js` 使用了基于字符偏移的静态切片（从 `const NEEDS_ACTION_TITLE` 到 `/** @param {string} reason */`，以及从 `export async function notifyDone` 起 1200 字符）。因此新增常量和函数**必须放在文件末尾 `clearAttention` 之后**，保持既有切片区间字节不变。 |
| `src/background.js` | 1) 注册独立闹钟 `REMINDER_ALARM_NAME = 'doubak-backup-reminder'`（`periodInMinutes: 240`），在 `onInstalled` / `onStartup` / `onAlarm` 中触发 `evaluateBackupReminder`；<br>2) 若 `reminderState` 尚未初始化（升级后首次后台唤醒且未开过面板），短暂唤醒 `offscreen` 执行一次 `seedReminderFromOpfs` 回填历史档案；<br>3) 处理来自 `offscreen` / `panel` 的 `evaluateBackupReminder` 消息，并在 `checkpoint === null` 时更新角标与每日通知。 |
| `src/offscreen.js` | 1) 在抓取 `finish` / `abort` 写出最终 `manifest.json` 后调用 `recordCompletedBackup(manifest)` 并通知 `background` 重新评估提醒；<br>2) 新增消息处理 `seedReminderFromOpfs`：遍历 OPFS 各目录的 `manifest.json` 调用 `reconcileFromManifests` 完成升级首启回填。 |
| `src/ui/panel.html` & `src/ui/panel.css` | 在 `#tab-overview` 设置卡片中新增 `#backup-reminder-section`（全局周期 `<select id="reminder-interval">` 与本人账号独立开关容器 `#reminder-self-accounts`），以及 `.state-reminder`、`.target-account-chip-overdue` 与 `.reminder-account-toggle` 样式。 |
| `src/ui/panel/overview.js` & `src/ui/panel/target.js` | 1) `refreshBundles` 扫描完 `manifests` 后调用 `reconcileFromManifests` 对账；<br>2) 渲染 `#reminder-interval` 与每个 `visibility === 'self'` 账号的 Toggler（默认 `ON`）；<br>3) 在 `renderOverviewState` 中实现 §5.2 的三分支提醒与跨号登录防呆提示；<br>4) 在 `renderKnownAccountChips` 中为所有账号气泡追加 `· N 天前` 及超期本人账号高亮。 |
| `docs/permissions.md` & `docs/ui.md` | 同步更新 `notifications` 权限说明（从“两类通知”更新为“三类通知：需介入、抓取完成、定期备份提醒”，并写明每日最多一次及纯本地离线计算原则）与概览页 UI 文档。 |

### 7.2 自动化测试计划

1. **`test/reminder-store.test.js`（新增单元测试）**：
   - 验证 `qualifiesAsSelfBackup`：区分 `visibility === 'self'`、缺省 `crawl_scope` 的旧档案与 `visibility === 'public'` 档案；验证 `aborted` 且 0 条路线 `advanced` 的档案被拒绝，而 `>= 1` 条路线 `advanced: true` 的档案被接受。
   - 验证多本人账号独立 Toggler：新本人账号缺省 `accountToggles[uid] ?? true` 为 `ON`；关闭单号 Toggler 后该账号立即从 `overdueAccounts` 移除，不影响另一个开启的本人账号。
   - 验证 `reconcileFromManifests` 单向推进：当 OPFS 中的最新档案因导出后释放空间被删掉时，`IdbKvStore` 中已记录的 `lastCompletedAtMs` 不会倒退。
   - 验证每日限频与次日再提醒（`shouldEmitDailyReminder`）：
     - 同一本地自然日内调用多次，仅第一次返回 `true`；
     - 未处理情况下，时间推进到次日（`>= 6h`），再次返回 `true`；
     - `23:55` 通知后，`00:05`（虽跨自然日但未满 6 小时冷却窗）返回 `false`，同日 `08:00` 返回 `true`；
     - 完成备份或关闭 Toggler 后立即返回 `false`。
2. **`test/notify.test.js`（扩展现有通知测试）**：
   - 验证 `notifyBackupReminder` 单账号与多账号文案、琥珀色天数角标（`14d` / `99+`）、Firefox 降级兼容以及 `clearReminderBadge`。
3. **`test/supervisor.test.js` & `test/offscreen.test.js`（回归测试）**：
   - 确保 `doubak-backup-reminder` 闹钟与 `doubak-heartbeat` 互不干扰；
   - 确保当存在活跃或暂停 `checkpoint` 时，`evaluateBackupReminder` 绝不覆盖 `notifyNeedsAction` 的红色 `!` 角标。
4. **`test/ui-overview-reminder.test.js`（新增 UI 交互测试）**：
   - 验证概览页本人账号 Toggler 列表只展示 `hasSelfArchive === true` 的账号，不展示纯 `public` 账号；
   - 验证当前登录大号 A（正常）而本人小号 B 超期时，`#state` 准确渲染“请先在豆瓣切换登录为小号 B”的跨号防呆提示。
