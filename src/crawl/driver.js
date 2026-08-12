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

import { Exclusive } from './exclusive.js';

/** 同一时间只推进一段；失联的一段被锁接管后，不再复用它的 Promise。 */
export function createDrive({ run, onPreempt, ...lockOptions }) {
  let current = null;
  const lock = new Exclusive({
    ...lockOptions,
    onPreempt: (info) => {
      current = null;
      onPreempt?.(info);
    },
  });

  async function drive() {
    if (current && !lock.stale) return current;

    const mine = lock.run('抓取', run).finally(() => {
      if (current === mine) current = null;
    });
    current = mine;
    return current;
  }

  return { drive, lock };
}

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
 * @returns {Promise<{batches: number, captured: number, failed: number, done: boolean, stoppedBy: string | null, unresolvedFailures: number, unresolvedOrderedFailures: number, awaitingHuman: number}>}
 */
/**
 * 连续多少批毫无进展就判定空转。
 *
 * 取小值：一批毫无进展已经很可疑（正常情况下队列里有活就至少会抓一页或失败一页），
 * 三批就是确定的死循环。留三批而不是一批，是为了给「上一页刚触发了降速、这一批
 * 恰好什么都没轮到」这类边角情形一点余地。
 */
export const MAX_IDLE_BATCHES = 3;

export async function driveWithinBudget({
  runner,
  budgetMs = DEFAULT_BUDGET_MS,
  now = () => Date.now(),
  onEvent = () => {},
}) {
  const startedAt = now();
  let batches = 0;
  /** 连续几批「什么都没发生」。见下面的空转检测。 */
  let idleBatches = 0;
  let captured = 0;
  let failed = 0;
  let done = false;
  let stoppedBy = null;
  let unresolvedFailures = 0;
  let unresolvedOrderedFailures = 0;
  let awaitingHuman = 0;

  while (true) {
    const r = await runner.runBatch();
    batches += 1;
    captured += r.captured;
    failed += r.failed;
    stoppedBy = r.stoppedBy;
    unresolvedFailures = r.unresolvedFailures ?? 0;
    unresolvedOrderedFailures = r.unresolvedOrderedFailures ?? 0;
    awaitingHuman = r.awaitingHuman ?? 0;

    if (r.done) {
      done = true;
      break;
    }

    // ── 空转检测
    //
    // 一批既没抓到、也没失败、还说自己没跑完——那它**什么都没推进**，而下一批
    // 会做一模一样的事。这不是慢，是死循环。
    //
    // 真实发生过：`resume()` 漏写了 `maxCaptures`，于是 `maxItems` 算成了 NaN，
    // `while (0 < NaN)` 一次都不进，一个请求都不发；而 NaN 又让 `hitCap` 为假，
    // `done` 保持为假。表现是每秒几十次 `runBatch`，日志里几百条 `batch`、一条
    // `capture` 都没有——而**豆瓣那边什么都看不到**，所以它不会自己撞停。
    //
    // 预算（22 秒）挡不住这个：它只是让空转每 22 秒重来一次，而心跳会一直把它
    // 叫醒。那是一个能烧到用户合上电脑为止的循环。
    //
    // 所以要有独立的一层：连续几批毫无进展就停下并说清楚。设计里对翻页写着
    // 「靠停滞检测终止，而不是靠『没有新条目』」——同一条道理，这里是驱动层。
    if (r.captured === 0 && r.failed === 0) {
      idleBatches += 1;
      if (idleBatches >= MAX_IDLE_BATCHES) {
        stoppedBy = 'driver_stalled';
        onEvent({ type: 'stalled', batches, idleBatches, counts: runner.status?.().counts ?? null });
        break;
      }
    } else {
      idleBatches = 0;
    }

    // 预算只在批与批之间检查——不打断进行中的一批。打断意味着丢掉已抓但
    // 未记账的游标，而那正是分批要避免的。
    const elapsed = now() - startedAt;
    if (elapsed >= budgetMs) {
      onEvent({ type: 'budget_exhausted', elapsed, batches });
      break;
    }
  }

  return {
    batches, captured, failed, done, stoppedBy,
    unresolvedFailures, unresolvedOrderedFailures, awaitingHuman,
  };
}
