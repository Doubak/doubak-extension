/**
 * 恢复策略：service worker 醒来之后，该不该自己接着抓？
 *
 * 设计：DESIGN.md F-06a、F-10a/b/c
 *
 * ## 为什么这是个安全问题而不是调度问题
 *
 * MV3 的 service worker 约 30 秒空闲就被杀，系统休眠、进程崩溃、浏览器重启
 * 也都会让它没。所以「醒来后自动接着干」是必须有的能力——否则用户合上笔记本
 * 再打开，抓取就永远停在那儿了。
 *
 * 但**不能无条件自动接着干**。抓取停下来的原因分两类：
 *
 * - **意外中断**（进程被杀、崩溃、休眠）——什么都没发生，接着抓就是了
 * - **刻意停下**（风控、验证码、会话失效、用户暂停）——停下来是**保护措施**，
 *   自动恢复等于把这个保护绕过去
 *
 * 醒来就重试一个软封锁，正是把限流升级成封号的标准路径。所以自动恢复
 * **只允许**发生在第一类上。
 *
 * ## 判据是 pause_reason
 *
 * checkpoint 里本来就记了停下来的原因，这里直接拿它当判据——不需要另发明
 * 一套状态。
 */

/**
 * 各种停止原因该怎么处理。
 *
 * `autoResume` 为 true 的只有「意外中断」那一类。其余都要等人。
 */
const POLICY = {
  /** 进程被杀、崩溃、系统休眠——没有任何外部信号说我们该停。 */
  crash: {
    autoResume: true,
    reason: '上次抓取被意外中断（进程被杀或系统休眠），从断点继续',
    userVisible: false, // 这条应当安静，不该吓人
  },

  /** 用户自己按的暂停。他没按继续，我们就不动。 */
  user_paused: {
    autoResume: false,
    reason: '你手动暂停了抓取',
    userVisible: true,
  },

  /** 豆瓣要求验证。必须人来解，解完还要先探测再降速。 */
  challenge: {
    autoResume: false,
    reason: '豆瓣要求验证，需要你在浏览器里完成',
    userVisible: true,
  },

  /** 软封锁。自动重试正是把限流升级成封号的路径。 */
  blocked: {
    autoResume: false,
    reason: '豆瓣暂时限制了访问。不会自动重试——继续请求可能导致账号被限制',
    userVisible: true,
  },

  /** 会话失效。继续抓会拿到公开视图，且未登录的频率上限更低。 */
  session_expired: {
    autoResume: false,
    reason: '登录状态已失效，需要重新登录',
    userVisible: true,
  },

  /** 账号变了。一个档案只能属于一个账号，不存在「继续」这种选项。 */
  account_switched: {
    autoResume: false,
    reason: '抓取途中账号变了。一个档案只能属于一个账号',
    userVisible: true,
  },

  /**
   * 站点权限被用户收回。
   *
   * 不能自动恢复，原因和风控不同：这里**根本不是等一等就好**。权限得由用户
   * 在扩展设置里改回来，而重新授权必须发生在用户手势里，后台自己发起不了。
   */
  host_permission_lost: {
    autoResume: false,
    reason: '豆备已经没有访问豆瓣的权限了，需要你在扩展设置里重新授权',
    userVisible: true,
  },

  /**
   * 有条目反复抓不下来，等用户处置。
   *
   * **不自动恢复**：自动重试一个反复失败的页面，在最坏情况下是每次心跳都去撞同一面墙
   * ——如果那面墙是风控，代价是账号。而且「要不要就这样收尾」本来就该是人的决定：
   * 代码替用户标 complete，等于代他做了一个关于自己档案完整性的声明。
   */
  failures_pending: {
    autoResume: false,
    reason: '有页面反复抓不下来，需要你决定是重试还是就这样收尾',
    userVisible: true,
  },

  /** 存储空间不足。自动继续只会再撞一次。 */
  quota: {
    autoResume: false,
    reason: '存储空间不足，需要先导出或清理',
    userVisible: true,
  },

  /**
   * 写档案失败，原因不是空间不足。
   *
   * 不自动恢复的理由和风控不同：这里**不知道**上一次写留下了什么。段尾可能
   * 有半条撕裂的记录，得先跑一次崩溃恢复把它切掉。自动接着写只会继续往一个
   * 状态不明的文件上追加。
   */
  write_failed: {
    autoResume: false,
    reason: '写入档案时出错，抓取已停下以免损坏已有数据',
    userVisible: true,
  },
};

/**
 * @typedef {object} ResumeDecision
 * @property {boolean} resume
 * @property {string} reason        给用户看的说明
 * @property {boolean} userVisible  是否需要在界面上提示
 * @property {number} [cooldownMs]  建议在恢复前等待多久
 */

/**
 * 醒来后该不该自动接着抓。
 *
 * @param {object | null} checkpoint  bundle 里的 checkpoint.json；null 表示没有未完成的抓取
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @returns {ResumeDecision}
 */
export function decideResume(checkpoint, { now = Date.now() } = {}) {
  if (!checkpoint) {
    return { resume: false, reason: '没有未完成的抓取', userVisible: false };
  }

  const policy = POLICY[checkpoint.pause_reason];

  if (!policy) {
    // 未知的停止原因。**保守处理：不自动恢复。**
    // 与 verdict 的处理同理——判不出来就不能当作没事。
    return {
      resume: false,
      reason: `未知的停止原因（${checkpoint.pause_reason}），出于谨慎不自动恢复`,
      pauseReason: checkpoint.pause_reason,
      userVisible: true,
    };
  }

  if (!policy.autoResume) {
    // `reason` 是给人看的整句话，`pauseReason` 是机器可读的键。通知文案要按后者
    // 查表——拿整句话去查表只会次次落到兜底文案上。
    return {
      resume: false,
      reason: policy.reason,
      pauseReason: checkpoint.pause_reason,
      userVisible: policy.userVisible,
    };
  }

  // 意外中断也要尊重降速：如果上次已经退避过，恢复前先把冷却等够。
  const cooldownMs = requiredCooldownMs(checkpoint, now);
  if (cooldownMs > 0) {
    return {
      resume: false,
      reason: `上次抓取被意外中断，但此前曾被限速，还需等待约 ${Math.ceil(cooldownMs / 60000)} 分钟`,
      userVisible: false,
      cooldownMs,
    };
  }

  return { resume: true, reason: policy.reason, userVisible: policy.userVisible };
}

/**
 * 还需要等多久才可以恢复。
 *
 * 退避层级会跨会话保留（写在 checkpoint 的 rate_state 里）。一次意外中断
 * **不该洗掉**之前的降速——否则「崩一次就恢复原速」会变成一个绕过退避的
 * 后门。
 *
 * @param {object} checkpoint
 * @param {number} now
 * @returns {number} 毫秒；0 表示可以立即恢复
 */
export function requiredCooldownMs(checkpoint, now = Date.now()) {
  const level = checkpoint?.rate_state?.backoff_level ?? 0;
  if (level === 0) return 0;

  const pausedAt = Date.parse(checkpoint.paused_at ?? '');
  if (Number.isNaN(pausedAt)) return 0;

  // 与 pacing.js 的建议冷却一致：第一次半小时，第二次一小时，之后四小时
  const table = [30 * 60_000, 60 * 60_000, 4 * 60 * 60_000];
  const need = table[Math.min(level - 1, table.length - 1)];
  return Math.max(0, pausedAt + need - now);
}

/**
 * 一次意外中断该记成什么原因。
 *
 * service worker 被杀时没有机会写 checkpoint——所以**开始抓取时就先写一个
 * `crash` 的 checkpoint**，正常暂停或结束时再改写。这样「没来得及改写」
 * 本身就是崩溃的证据。
 *
 * 这是个刻意的默认值：宁可把一次正常结束误标成崩溃（后果是多做一次幂等的
 * 恢复检查），也不要把一次崩溃误标成正常（后果是数据对不上却无人察觉）。
 */
export const CRASH_SENTINEL_REASON = 'crash';

/** 已知的停止原因，供界面与测试使用。 */
export const PAUSE_REASONS = Object.keys(POLICY);

/** @param {string} reason */
export function policyFor(reason) {
  return POLICY[reason] ?? null;
}

/** 有未解决的失败条目，等用户处置。 */
export const FAILURES_PENDING = 'failures_pending';
