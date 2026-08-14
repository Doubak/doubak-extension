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

/** 锁里那一段叫什么。会出现在「已经有『抓取』在进行中」这类拒绝信息里。 */
const SEGMENT_NAME = '抓取';

/**
 * 造一个「同一时间只推进一段」的驱动器。
 *
 * ## 为什么要复用同一个 promise
 *
 * 心跳可能在上一段还没跑完时又来一次——**重复唤醒是 MV3 的常态，不是冲突**。
 * service worker 约 30 秒就被杀一次，新起的那个内存全空、以为没人在跑，就来叫
 * 一次推进；而 offscreen 里那一段好好地跑着。所以这里返回**同一个** promise，
 * 而不是报错，也不是再开一段。
 *
 * ## 为什么它必须能识破「我这一段已经不是当前那一段了」
 *
 * 这是 #3 记的那次真实卡死（@Colafornia 在一次真实备份中发现并定位）：电影列表
 * 抓到 30 条以后不再推进，暂停再继续，日志里有 `preempted · stale_holder` 和
 * `resumed`，但一个新请求都没有发出去，只有重新加载扩展才能继续。
 *
 * 原因是缓存起来的那个 promise 永不结算，而判据只有一条 `!lock.stale`：
 *
 *   1. 一段卡死 → promise 永不结算，锁被它占着，5 分钟后判死；
 *   2. 用户点「继续」→ `lock.run('恢复抓取', …)` 抢占它 → 于是有了那两行日志；
 *   3. 「恢复抓取」跑完放锁 → `_held = null`；
 *   4. 下一次唤醒 → `stale` 以 `_held !== null` 开头，**从此永远是 false** →
 *      于是每一次都把那个死掉的 promise 原样返回，看起来像「在跑」。
 *
 * 关键在于第 4 步：`!lock.stale` 问的是「当前持有者还活着吗」，而真正该问的是
 * **「当前这一段还是我这一段吗」**。前者答不了「换人了」和「已经放手了」。
 *
 * 所以缓存**按代号存**：代号是锁给每一任持有者发的号，放锁归 null、抢占则加一。
 * 于是四种情形由同一个比较得出，没有需要维护的第二处状态，也没有回调时序：
 *
 * | 情形 | `lock.gen` | 结果 |
 * |---|---|---|
 * | 心跳重入，段还活着 | 相等 | 复用，不开新段 |
 * | 段卡死，锁还握着 | 相等但 `stale` | 抢占，开新段 |
 * | 被别的操作抢占了 | 变了 | 开新段 |
 * | 持有者已经放锁 | `null` | 开新段 |
 *
 * @param {object} opts
 * @param {() => Promise<any>} opts.run  一段工作。通常是 `driveWithinBudget`
 * @param {(info: {name: string, silentMs: number}) => void} [opts.onPreempt]
 * @param {number} [opts.staleAfterMs]
 * @param {() => number} [opts.now]
 * @returns {{drive: () => Promise<any>, lock: Exclusive}}
 */
export function createDrive({ run, onPreempt, staleAfterMs, now }) {
  /** @type {{gen: number | null, promise: Promise<any>} | null} */
  let segment = null;
  const lock = new Exclusive({ staleAfterMs, now, onPreempt });

  async function drive() {
    if (segment && lock.gen === segment.gen && !lock.stale) return segment.promise;

    // `run()` 在第一个 await 之前就同步占好了锁，所以调用返回之后读到的
    // `lock.gen` 就是我这一段的代号。
    const promise = lock.run(SEGMENT_NAME, run);
    segment = { gen: lock.gen, promise };
    return promise;
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
 * @returns {Promise<{batches: number, captured: number, failed: number, done: boolean, stoppedBy: string | null, finishing: boolean, unresolvedFailures: number, unresolvedOrderedFailures: number, awaitingHuman: number}>}
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
  /** 另一头正在收尾，这一段一批都没跑。见 runner.runBatch。 */
  let finishing = false;

  while (true) {
    const r = await runner.runBatch();
    // **不能接着往下走。** 下面那段会把 `done` 读成「干净跑完」，于是这一头也去
    // 叫一次收尾——而收尾正在另一头进行。如实报上去，让调用方什么都别做。
    if (r.finishing) { finishing = true; done = true; break; }
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
    batches, captured, failed, done, stoppedBy, finishing,
    unresolvedFailures, unresolvedOrderedFailures, awaitingHuman,
  };
}
