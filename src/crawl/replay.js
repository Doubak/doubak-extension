/**
 * 崩溃恢复时，把「checkpoint 还没见过的那几条捕获」找出来重抓一遍。
 *
 * ## 那个窗口
 *
 * 捕获是**每页立刻落盘**的（写入器的契约），checkpoint 是**每批才落一次**（一批
 * 25 条，见 runner.js）。中间那段时间里，一张已经抓到的页面已经进了 index，而它
 * **派生出来的活**——下一页的链接、列表页上的作品链接、作品页上的封面图——只活在
 * 内存里的队列中。
 *
 * worker 被杀，那些派生条目就没了。而恢复时 index 会把这张页面标成「抓过了」
 * （`capturedUrlKeys` → `Frontier.markCaptured`），于是：
 *
 * - 它不会被重取
 * - 它派生的东西**永远不会再被派生出来**
 * - 没有任何地方记下这件事
 *
 * 实测（6 部剧的小档案，批大小 3，中途模拟被杀）：
 *
 *     不中断：  详情页 6，封面 6
 *     被杀过：  详情页 6，封面 2   ← 4 个作品有页无图，静默
 *
 * 这正是本项目最怕的那种：**永久且不可检测**。覆盖率上只是一个偏小的数字。
 *
 * ## 修法：重抓，而不是想办法把内存里的东西救回来
 *
 * 那几条捕获的序号一定大于 checkpoint 记下的 `last_capture_id`——`capture_id` 的
 * 序号是单调递增的，所以「checkpoint 之后写下的」是可以**精确算出来**的，不是猜。
 * 把它们重新入队，派生自然重来一遍，不需要任何新机制。
 *
 * 代价是每次崩溃多至多一批的重复请求。而这正是那句话的适用场合：
 * **重复是免费的，空洞是永久的。**（规范也明确允许同一个 URL 在一份档案里出现
 * 多次，只有 `capture_id` 必须唯一。）
 *
 * ## 计数不会因此虚高
 *
 * 容易担心的一点：重抓一页会不会把「已抓」加两次？不会——路线状态**也是从同一份
 * checkpoint 恢复的**，那份 checkpoint 同样没见过这一页。两边错得一致，重抓之后
 * 正好对上。
 */

/**
 * 这条路线会不会派生出新的活。
 *
 * 只有会派生的才值得重抓。重抓一张个人主页或一张封面图不会产出任何新东西，
 * 纯粹是白发一次请求——而这个项目里，多余的请求是要用账号安全去付的。
 *
 * @param {{key?: string, pagination?: object} | undefined} def
 */
export function derivesWork(def) {
  if (!def) return false;
  // 分页路线派生「下一页」；interest.* 派生作品链接（列表页）与封面图（详情页）。
  return Boolean(def.pagination) || String(def.key ?? '').startsWith('interest.');
}

/**
 * 上限：一次恢复最多重抓多少条。
 *
 * 正常情况下这个数天然不会超过一批（checkpoint 每批落一次）。会超只有一种情形：
 * 连着崩了好几次，每次都没活到写 checkpoint。那时候**不限量地重抓**比丢掉派生
 * 更危险——几百个多余请求正是撞上风控的样子，而风控的代价是账号。
 *
 * 所以截断，但**必须说出来**：被截掉的那部分派生确实丢了，用户有权知道。
 */
export const MAX_REPLAY = 100;

/**
 * 找出要重抓的捕获。
 *
 * @param {object} opts
 * @param {Array<{seq: number, url: string, urlKey: string, routeKey: string, intent: string}>} opts.captures
 *   index 里所有判定为 ok 的捕获（见 recovery.js 的 `captures`）
 * @param {number} opts.sinceSeq  checkpoint 记下的最后一个 capture_id 的序号
 * @param {(routeKey: string) => object | undefined} opts.routeOf
 * @returns {{items: Array<{url: string, urlKey: string, routeKey: string, intent: string}>,
 *            truncated: number}}
 */
export function replayableCaptures({ captures, sinceSeq, routeOf }) {
  const all = (captures ?? [])
    .filter((c) => c.seq > sinceSeq && derivesWork(routeOf(c.routeKey)))
    // 新的在前：真要截断的话，留下的应当是最近的那些——它们最可能是被打断的
    // 那一批，也就是派生真正丢掉的地方。
    .sort((a, b) => b.seq - a.seq);

  return {
    items: all.slice(0, MAX_REPLAY).map(({ url, urlKey, routeKey, intent }) => ({
      url, urlKey, routeKey, intent,
    })),
    truncated: Math.max(0, all.length - MAX_REPLAY),
  };
}
