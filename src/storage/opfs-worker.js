/**
 * 只读的 OPFS Worker。面板（窗口）用它看档案与导出。
 *
 * 窗口里 `createSyncAccessHandle()` 不可用，而 `showDirectoryPicker()` 只有窗口
 * 有——两端的限制恰好互斥，所以导出必然是「Worker 读、窗口写，中间按块传」。
 *
 * **不接受任何写操作**：写 OPFS 只该有一条路径（抓取），多一条就多一个能破坏
 * 偏移量的入口。这条限制在 Worker 一侧执行，不是靠客户端自觉。
 *
 * 逻辑全在 opfs-rpc.js，这里只是选一个模式。
 */

import { serveOpfsRpc } from './opfs-rpc.js';

serveOpfsRpc({ allowWrites: false });
