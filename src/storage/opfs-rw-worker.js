/**
 * 可读写的 OPFS Worker。**只有 offscreen document 用它**（抓取写档案）。
 *
 * 为什么抓取不能直接写：service worker 不是专用 Worker，
 * `createSyncAccessHandle()` 在里面不可用。所以抓取跑在 offscreen document 里，
 * 由它起这个 Worker 落盘。见 src/offscreen/offscreen.js。
 *
 * 逻辑全在 opfs-rpc.js，这里只是选一个模式。
 */

import { serveOpfsRpc } from './opfs-rpc.js';

serveOpfsRpc({ allowWrites: true });
