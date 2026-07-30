/**
 * 抓取状态的持久化：`Supervisor` 需要的 `RunStore` 的真实实现。
 *
 * 规范：doubak-data-specs/bundle/v1/SPEC.md §7（checkpoint.json）
 *
 * ## 状态分两处放，各有理由
 *
 * | 放哪 | 内容 | 为什么 |
 * |---|---|---|
 * | KV（IndexedDB） | 当前 bundle 的 id 与目录 | worker 启动时还不知道 bundle 是哪个，得先有地方问一句 |
 * | bundle 目录里的 `checkpoint.json` | 真正的抓取状态 | 规范要求它随档案走——导出的半成品到别的机器上也能续抓 |
 *
 * ## checkpoint 不需要、也不该每页重写
 *
 * 一个直觉是「每抓完一页就把整个队列写下来」。但队列里可能有上万条 URL，
 * 每页重写一遍是几 MB 的无谓写入。
 *
 * 更重要的是**没必要**：`index.ndjson` 本身就是「哪些抓过了」的权威记录，
 * 而且它每页都落盘。待抓的部分在我们的分页模型里是**可推导的**——每条路线
 * 记住当前游标，下一页就是游标加步长。
 *
 * 所以 checkpoint 里只放推导不出来的东西：
 *
 * - 每条路线的游标与停滞计数
 * - **未完成**的队列条目（失败、等待人工）——通常只有零星几条
 * - 退避层级（降速必须跨会话保留）
 * - 停止原因
 *
 * 已完成的条目一条都不写：那是 index 的职责，重复记录只会带来两个可能
 * 不一致的真相来源。
 */

import { SPEC_VERSION } from '../core/spec-constants.js';

/** KV 里存「当前在抓什么」的键。 */
export const CURRENT_RUN_KEY = 'doubak.currentRun';

const CHECKPOINT_FILE = 'checkpoint.json';

/**
 * @implements {import('./supervisor.js').RunStore}
 */
export class RunStore {
  /**
   * @param {object} opts
   * @param {import('../storage/kv-store.js').KvStore} opts.kv
   * @param {(dir: string) => Promise<import('../storage/file-store.js').FileStore>} opts.openBundle
   *   按目录名打开 bundle 的 FileStore（浏览器里是 OPFS）
   */
  constructor({ kv, openBundle }) {
    this._kv = kv;
    this._openBundle = openBundle;
  }

  /**
   * 记下「现在在抓哪个 bundle」。
   *
   * @param {{bundleId: string, dir: string}} pointer
   */
  async setCurrentRun(pointer) {
    await this._kv.set(CURRENT_RUN_KEY, pointer);
  }

  /** @returns {Promise<{bundleId: string, dir: string} | undefined>} */
  async getCurrentRun() {
    return /** @type {any} */ (await this._kv.get(CURRENT_RUN_KEY));
  }

  /**
   * 读回 checkpoint。
   *
   * 任何一步取不到都返回 null——「没有未完成的抓取」是完全正常的状态，
   * 不该抛错。
   */
  async loadCheckpoint() {
    const pointer = await this.getCurrentRun();
    if (!pointer?.dir) return null;

    let store;
    try {
      store = await this._openBundle(pointer.dir);
    } catch {
      // 目录没了（用户删了档案，或换了机器）。清掉悬空指针，当作没有未完成的抓取。
      await this._kv.remove(CURRENT_RUN_KEY);
      return null;
    }

    if (!(await store.exists(CHECKPOINT_FILE))) return null;

    try {
      const bytes = await store.read(CHECKPOINT_FILE);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      // checkpoint 坏了。**不要**当作「没有未完成的抓取」——那会让恢复逻辑
      // 以为一切正常。返回一个原因未知的 checkpoint，交给恢复策略保守处理。
      return {
        spec_version: SPEC_VERSION,
        bundle_id: pointer.bundleId,
        pause_reason: 'checkpoint_unreadable',
        paused_at: new Date().toISOString(),
        routes: [],
        frontier: [],
      };
    }
  }

  /**
   * 写 checkpoint —— 同时落两处，各有各的读者。
   *
   * | 写到哪 | 谁读 | 为什么 |
   * |---|---|---|
   * | bundle 里的 `checkpoint.json` | 恢复抓取时的 offscreen | **portable 的真相**。规范要求它随档案走，导出的半成品到别的机器上也能续抓 |
   * | IDB 指针里的几个调度字段 | service worker 的 `Supervisor` | SW **读不了 OPFS**（`createSyncAccessHandle` 只在专用 Worker 里可用），但它必须知道「有没有没抓完的、为什么停的」才能决定要不要自动恢复 |
   *
   * 镜像的只有 `pause_reason` / `paused_at` / `rate_state`——调度需要的最小集合。
   * 游标、frontier、路线状态一概不镜像：那些只有 offscreen 用得上，多存一份就是
   * 多一个会不一致的地方。
   *
   * **两者不一致时以档案里的为准。** 恢复走的是 offscreen 读档案那条路；指针只是
   * 给调度器看的缓存，删掉它顶多让下一次唤醒少一次判断依据，不丢数据。
   *
   * @param {object} cp
   */
  async saveCheckpoint(cp) {
    const pointer = await this.getCurrentRun();
    if (!pointer?.dir) throw new Error('还没有 setCurrentRun，无处写 checkpoint');

    const store = await this._openBundle(pointer.dir);
    const full = { spec_version: SPEC_VERSION, ...cp };
    await store.replace(
      CHECKPOINT_FILE,
      new TextEncoder().encode(JSON.stringify(full, null, 2) + '\n'),
    );

    // 顺序是刻意的：档案先落盘，再更新镜像。反过来的话，进程死在两次写之间会
    // 让调度器以为已经停在某个原因上，而档案里其实还是上一个状态。
    await this._kv.set(CURRENT_RUN_KEY, {
      ...pointer,
      pause_reason: full.pause_reason,
      paused_at: full.paused_at,
      rate_state: full.rate_state,
    });
  }

  /**
   * 抓取干净结束：删掉 checkpoint 与指针。
   *
   * 规范要求已完成的 bundle **不应**再有 checkpoint.json——它的存在本身
   * 就意味着「这份档案没抓完」。
   */
  async clearCheckpoint() {
    const pointer = await this.getCurrentRun();
    if (pointer?.dir) {
      try {
        const store = await this._openBundle(pointer.dir);
        await store.remove(CHECKPOINT_FILE);
      } catch {
        // 目录没了也无所谓，反正是要清掉
      }
    }
    await this._kv.remove(CURRENT_RUN_KEY);
  }
}

/**
 * 从运行中的各部件收集 checkpoint 内容。
 *
 * 刻意只收「推导不出来的东西」：已完成的条目一条都不写，那是 index 的职责。
 *
 * @param {object} parts
 * @param {string} parts.bundleId
 * @param {import('./frontier.js').Frontier} parts.frontier
 * @param {import('./pacing.js').Pacer} parts.pacer
 * @param {Map<string, {cursor: object | null, stall: import('./frontier.js').StallDetector}>} [parts.routes]
 * @param {string | null} [parts.lastCaptureId]
 * @param {string} parts.pauseReason
 * @param {string} [parts.pausedAt]
 */
export function buildCheckpoint({
  bundleId,
  frontier,
  pacer,
  routes = new Map(),
  lastCaptureId = null,
  pauseReason,
  pausedAt = new Date().toISOString(),
}) {
  return {
    spec_version: SPEC_VERSION,
    bundle_id: bundleId,
    paused_at: pausedAt,
    pause_reason: pauseReason,
    last_capture_id: lastCaptureId,
    routes: [...routes.entries()].map(([routeKey, r]) => ({
      route_key: routeKey,
      state: 'in_progress',
      cursor: r.cursor ?? null,
      items_seen: r.stall?.uniqueCount ?? 0,
      stall_counter: r.stall?.consecutiveNoProgress ?? 0,
    })),
    // 只保留未完成的条目。已完成的在 index 里，重复记录只会带来两个可能
    // 不一致的真相来源。
    frontier: frontier
      .snapshot()
      .filter((it) => it.state !== 'done')
      .map((it) => ({
        url: it.url,
        intent: it.intent,
        route_key: it.routeKey,
        state: it.state === 'in_flight' ? 'pending' : it.state,
        attempts: it.attempts,
        enqueued_by: it.enqueuedBy ?? null,
      })),
    rate_state: pacer.serialize(),
  };
}

/**
 * service worker 那一侧的调度状态：**只读写 IDB 指针，绝不碰 OPFS**。
 *
 * ## 为什么必须单独一个类
 *
 * `Supervisor` 要回答一个问题：**有没有没抓完的，为什么停的，现在该不该继续。**
 * 而完整的 checkpoint 是 bundle 目录里的一个文件，读它要 OPFS，而 OPFS 的
 * `createSyncAccessHandle()` **只在专用 Worker 里可用**——service worker 不是。
 *
 * 第一版让 SW 用完整的 `RunStore`，于是「开始抓取」直接撞上
 * 「service worker 里不能开 bundle」。给它一个会抛的 `openBundle` 只是把错误从
 * 「静默不可用」变成「响亮不可用」，并没有让它能工作。
 *
 * 正确的分工是**按需要的数据量分**：调度只需要三个字段，而那三个字段
 * `RunStore.saveCheckpoint()` 已经镜像进指针了。SW 读镜像就够，不必也不该去
 * 碰档案。
 *
 * ## 它刻意做不到的事
 *
 * 读不到 frontier、游标、路线状态。那是对的：SW 拿到它们也没用，而**能拿到**就
 * 意味着有人早晚会在 SW 里写抓取逻辑。
 *
 * @implements {import('./supervisor.js').RunStore}
 */
export class ScheduleStore {
  /** @param {object} opts @param {import('../storage/kv-store.js').KvStore} opts.kv */
  constructor({ kv }) {
    this._kv = kv;
  }

  /**
   * 调度用的 checkpoint 摘要；没有未完成的抓取时返回 null。
   *
   * 返回的形状与真 checkpoint 的**同名字段**一致，所以 `decideResume()` /
   * `requiredCooldownMs()` 不需要知道自己拿到的是摘要还是全本。
   */
  async loadCheckpoint() {
    const p = /** @type {any} */ (await this._kv.get(CURRENT_RUN_KEY));
    if (!p?.bundleId) return null;
    return {
      bundle_id: p.bundleId,
      // 指针刚建、还没写过 checkpoint 时没有原因。当成崩溃哨兵——与
      // `runner.start()` 的做法一致：宁可把正常状态误判成崩溃（代价是多做一次
      // 幂等的恢复检查），也不要把崩溃误判成正常。
      pause_reason: p.pause_reason ?? CRASH_SENTINEL,
      paused_at: p.paused_at ?? null,
      rate_state: p.rate_state ?? null,
    };
  }

  /** 只更新调度字段。档案里的 checkpoint 由 offscreen 写。 */
  async saveCheckpoint(cp) {
    const p = /** @type {any} */ (await this._kv.get(CURRENT_RUN_KEY));
    if (!p?.bundleId) return; // 没有在跑的抓取，没什么可记
    await this._kv.set(CURRENT_RUN_KEY, {
      ...p,
      pause_reason: cp.pause_reason,
      paused_at: cp.paused_at,
      ...(cp.rate_state ? { rate_state: cp.rate_state } : {}),
    });
  }

  /**
   * 抓取结束：清掉指针。
   *
   * 档案里的 `checkpoint.json` 由 offscreen 的 `finish()` 删——规范要求已完成的
   * bundle 不再有它，因为它的存在本身就意味着「这份档案没抓完」。
   */
  async clearCheckpoint() {
    await this._kv.remove(CURRENT_RUN_KEY);
  }
}

/** 与 resume-policy 的哨兵原因保持一致。 */
const CRASH_SENTINEL = 'crash';
