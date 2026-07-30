/**
 * 把「一次唤醒」变成「一段有界的抓取工作」。
 *
 * 设计：DESIGN.md F-10a~h
 *
 * ## 为什么需要预算
 *
 * MV3 的 service worker 不能长期占着。一场抓取要几小时，而一次唤醒只能干
 * 一小会儿——所以每次醒来做**有时间上限**的一段工作，然后干净地让出去，
 * 等下一次心跳再继续。
 *
 * 这不是妥协，而是与「被杀等价于可恢复的空操作」同一个思路：把长任务切成
 * 一串短任务，每一段都自带落盘点。
 *
 * ## 预算怎么定
 *
 * 心跳周期是 30 秒。预算取得比它略小，这样正常情况下**上一段做完了下一次
 * 心跳才来**，不会两段重叠。重叠本身有 `Supervisor.tick()` 的幂等兜底，
 * 但能不重叠更省事。
 *
 * 预算是**软上限**：只在每批之间检查，不会打断进行中的一批。打断一批意味着
 * 丢掉已抓但未记账的游标，而那正是我们花力气避免的事。
 */

/** 一次唤醒最多干多久。比心跳周期（30 秒）略小。 */
export const DEFAULT_BUDGET_MS = 22_000;

/**
 * 在预算内持续推进抓取。
 *
 * @param {object} opts
 * @param {import('./runner.js').CrawlRunner} opts.runner
 * @param {number} [opts.budgetMs]
 * @param {() => number} [opts.now]
 * @param {(evt: object) => void} [opts.onEvent]
 * @returns {Promise<{batches: number, captured: number, failed: number, done: boolean, stoppedBy: string | null, unresolvedFailures: number, unresolvedOrderedFailures: number}>}
 */
export async function driveWithinBudget({
  runner,
  budgetMs = DEFAULT_BUDGET_MS,
  now = () => Date.now(),
  onEvent = () => {},
}) {
  const startedAt = now();
  let batches = 0;
  let captured = 0;
  let failed = 0;
  let done = false;
  let stoppedBy = null;
  let unresolvedFailures = 0;
  let unresolvedOrderedFailures = 0;

  while (true) {
    const r = await runner.runBatch();
    batches += 1;
    captured += r.captured;
    failed += r.failed;
    stoppedBy = r.stoppedBy;
    unresolvedFailures = r.unresolvedFailures ?? 0;
    unresolvedOrderedFailures = r.unresolvedOrderedFailures ?? 0;

    if (r.done) {
      done = true;
      break;
    }

    // 预算只在批与批之间检查——不打断进行中的一批。打断意味着丢掉已抓但
    // 未记账的游标，而那正是分批要避免的。
    const elapsed = now() - startedAt;
    if (elapsed >= budgetMs) {
      onEvent({ type: 'budget_exhausted', elapsed, batches });
      break;
    }
  }

  return { batches, captured, failed, done, stoppedBy, unresolvedFailures, unresolvedOrderedFailures };
}
