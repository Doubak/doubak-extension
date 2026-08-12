/**
 * 导入用的 OPFS Worker。**面板（窗口）用它把用户磁盘上的档案搬进 OPFS。**
 *
 * ## 为什么它必须存在，而不是复用另外两个
 *
 * 导入这件事跨着一条谁也绕不开的边界：
 *
 * - `showDirectoryPicker()` **只有窗口有**——offscreen document 拿不到它；
 * - 字节**过不了** `chrome.runtime.sendMessage`（那条通道只认 JSON，
 *   `Uint8Array` 过去会变成 `{"0":1,"1":2,…}`）；
 * - `createSyncAccessHandle()` **只在专用 Worker 里可用**。
 *
 * 所以「让抓取那条写路径去导入」根本不是一个选项：读源目录的只能是窗口，
 * 而窗口把几百 MB 转给 offscreen 的通道不存在。面板必须自己能写。
 *
 * ## 那「写 OPFS 只有一条路径」这条规矩呢
 *
 * 它保护的是**已有档案里的偏移量**：索引里每一条捕获都记着
 * `segment @offset+length`，而「第三方顺着索引就能把字节取出来」这个承诺全靠它。
 *
 * 导入模式因此不是「宽松一点的读写」，而是一条**只增不改**的规矩：**只能新建文件，
 * 碰不到任何已经在那儿的字节。** 判据由 Worker 逐个文件去问存储，不是听调用方声称。
 * 详见 opfs-rpc.js 开头。
 *
 * 逻辑全在 opfs-rpc.js，这里只是选一个模式。
 */

import { serveOpfsRpc } from './opfs-rpc.js';

serveOpfsRpc({ allowWrites: true, importOnly: true });
