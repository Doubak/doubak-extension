/**
 * 把用户叫回来。
 *
 * ## 为什么需要通知，而不是只有角标
 *
 * 通知**不能**让 service worker 活得更久——那是闹钟的活。所以它的用处只有一个：
 * 在**用户不在看**的时候把状态送到他眼前。
 *
 * 而这个场景是真实的。一场抓取要几小时，中间撞上验证码或软封锁就会停下等人。
 * 只点亮一个角标的话，那个「等人」可能等几个小时都没人看见——而那几个小时里
 * 什么都没在发生。抓完了也一样：用户需要知道「可以去导出了」。
 *
 * ## 两类，只有两类
 *
 * | | 什么时候 | 会不会自己消失 |
 * |---|---|---|
 * | 需要你做点什么 | 验证码、软封锁、掉登录、权限被撤、空间不足 | 不会（`requireInteraction`） |
 * | 抓完了 | 一次抓取干净结束 | 会 |
 *
 * 「进行中」不发通知。一场几小时的抓取如果每个阶段都弹一次，用户会把通知权限
 * 关掉,然后连真正要紧的那两类也收不到了。
 *
 * ## 文案说要做什么，不说出了什么错
 *
 * 「豆瓣要求验证」而不是「Doubak 遇到错误 0x02」。用户需要的是下一步动作
 * （docs/ui.md §5）。风控与验证码是**正常的抓取过程**，不是故障。
 *
 * ## 角标仍然保留
 *
 * 通知会被划掉、会被系统免打扰吞掉、也可能压根没批权限。角标是那条**不会消失**
 * 的兜底——它一直亮着，直到问题被处理。两者互补，不是二选一。
 */

const ATTENTION_ID = 'doubak-attention';
const DONE_ID = 'doubak-done';

/** 可以直接对着用户说的话。keys 与 resume-policy 的停机原因对齐。 */
const NEEDS_ACTION_TITLE = {
  challenge: '豆瓣要求验证',
  blocked: '豆瓣暂时限制了访问',
  session_expired: '登录状态已失效',
  account_switched: '账号变了',
  host_permission_lost: '豆备没有访问豆瓣的权限了',
  quota: '存储空间不足',
  missing_user_id: '认不出你的数字用户 ID',
  failures_pending: '有几个页面抓不下来',
  write_failed: '写入档案时出错',
  driver_stalled: '抓取空转了，已停下',
  finalize_failed: '收尾失败，数据都在',
};

const NEEDS_ACTION_BODY = {
  challenge: '请在浏览器中完成验证，然后返回豆备点击「继续」。插件与浏览器共用登录状态。',
  blocked: '已经停下来了，不会自动重试——继续请求可能导致账号被限制。建议等待 30 分钟以上。',
  session_expired: '这不是错误，抓取已安全停下，进度都在。重新登录豆瓣后回来继续。',
  account_switched: '一个档案只能属于一个账号。请切回原来的账号，或另开一次抓取。',
  host_permission_lost: '请在浏览器的扩展设置里把站点访问权限改回「在所有网站上」。',
  quota: '需要先导出或清理再继续。已经抓到的都还在。',
  missing_user_id: '豆瓣的页面结构可能变了。请到调试页跑一次演练确认其余环节正常，并把详细信息反馈给我们。',
  failures_pending: '其余部分都抓完了。打开面板看看是哪几页——可以重试，也可以确认「就这样收尾」。',
  write_failed: '抓取已停止，以免损坏既有数据。继续之前会先自动修复段文件尾部。',
  driver_stalled: '连续多批未取得任何进展。这是插件自身的问题，并非豆瓣的限制；已抓取的内容均在档案中。',
  finalize_failed: '已抓取的每一页均已落盘，仅最后写入 manifest 的步骤失败。请在「日志」标签页复制日志以便反馈。',
};

/** @param {string} reason */
function copyFor(reason) {
  return {
    title: NEEDS_ACTION_TITLE[reason] ?? '豆备需要你处理一下',
    // 认不出的原因**照实说出原文**。翻成一句通顺但空洞的话，等于把唯一的线索
    // 藏起来——用户至少能把这行字发给我们。
    body: NEEDS_ACTION_BODY[reason] ?? `抓取已停下。原因：${reason}`,
  };
}

/**
 * 需要用户做点什么。
 *
 * ## 只在状态**变化**时弹
 *
 * 心跳每 30 秒醒一次，每次都会重新判断「该不该恢复」，不该恢复就走到这里。原来
 * 每次都弹一遍，于是同一件事每半分钟糊到用户脸上一次——而它还带
 * `requireInteraction`，不会自己消失。
 *
 * 那不只是烦：**被通知轰炸的用户会去关掉通知权限**，然后连真正要紧的那条也收不到，
 * 于是这个功能反而让「把人叫回来」更难了。
 *
 * 去重要跨 service worker 的生死，所以状态得**存起来**（内存里存不住，worker 随时
 * 清零）。角标不受这条限制——它本来就是常亮的兜底，重复设成同样的值没有代价。
 *
 * @param {string} reason  停机原因
 * @param {object} [opts]
 * @param {{get: (k: string) => Promise<any>, set: (k: string, v: any) => Promise<void>}} [opts.kv]
 *   去重状态存哪。不给就不去重（每次都弹）——刻意不静默去重，
 *   免得测试里以为去重生效了而实际没有。
 */
export async function notifyNeedsAction(reason, { kv } = {}) {
  const { title, body } = copyFor(reason);
  // 角标先点亮：它是那条不会消失的兜底，而通知可能压根没权限。
  await setBadge('!', '#d93025', `豆备：${title}`);

  if (kv) {
    const last = await kv.get(NOTIFIED_KEY);
    if (last === reason) return; // 同一件事已经说过了
    await kv.set(NOTIFIED_KEY, reason);
  }

  await show(ATTENTION_ID, {
    title,
    message: body,
    // 要人处理的事不许自己消失。用户没看见 = 抓取继续停着。
    requireInteraction: true,
  });
}

/** 去重状态的键。与抓取指针分开放：它是界面状态，不是抓取状态。 */
export const NOTIFIED_KEY = 'doubak.notifiedReason';

/**
 * 抓完了。
 *
 * @param {{captured?: number, failed?: number}} [result]
 */
export async function notifyDone(result = {}, { kv } = {}) {
  await clearAttention({ kv });

  // **数的是整份档案，不是最后那一段。**
  //
  // `result.captured` 来自 `driveWithinBudget`，而它只统计**这一次唤醒**里跑的那几批
  // ——预算 22 秒。一场抓取由几十上百次唤醒接力完成，所以那个数说的是最后 22 秒，
  // 却被写成了「抓到 N 个页面」。用户报的样子：通知说抓了 4 页，档案里躺着 29 页。
  //
  // 权威的数在刚写好的 manifest 里：index 有多少行，这份档案就有多少条捕获。
  const m = result.manifest;
  const n = m?.index?.line_count ?? result.captured ?? 0;
  // 不是 ok 的那些（被拦下、已删除、认不出来）也在档案里，但它们不是「抓到了」。
  // 这个数同样按整份档案算——每 22 秒报一次的失败数是纯噪音。
  const notOk = m?.counts?.by_verdict
    ? Object.entries(m.counts.by_verdict).reduce((a, [k, v]) => a + (k === 'ok' ? 0 : v), 0)
    : (result.failed ?? 0);
  await show(DONE_ID, {
    title: '备份完成',
    // 提醒导出，因为**没导出之前档案不算用户的**：它挂在扩展的存储里，
    // 卸载扩展或清站点数据都会把它一次性抹掉，而且不会问一句。
    message:
      `抓到 ${n} 个页面` +
      (notOk ? `，其中 ${notOk} 条不是正常抓到的` : '') +
      '。请打开面板导出到本机文件夹：导出之前，档案仅存在于浏览器的存储中。',
  });
}

/**
 * 问题解决了：角标、通知、以及去重状态一起收掉。
 *
 * 去重状态**必须**一起清：不清的话，同一个原因第二次发生时会被当成「已经说过了」
 * 而不再提醒——而那是一次全新的、真的需要人处理的事件。
 *
 * @param {object} [opts]
 * @param {{remove: (k: string) => Promise<void>}} [opts.kv]
 */
export async function clearAttention({ kv } = {}) {
  await setBadge('', '#5f6368', '豆备 Doubak');
  try {
    await globalThis.chrome?.notifications?.clear?.(ATTENTION_ID);
  } catch {
    // 通知本来就可能不存在，清不掉不是问题。
  }
  await kv?.remove(NOTIFIED_KEY).catch(() => {});
}

/**
 * @param {string} id
 * @param {object} opts
 */
async function show(id, { title, message, requireInteraction = false }) {
  const chrome = globalThis.chrome;
  if (!chrome?.notifications?.create) return; // 没权限或不支持：角标顶上
  try {
    // 固定 id：同一类事情只留一条，不堆成一串。用户回来时该看到「现在怎么了」，
    // 而不是一部历史。
    await chrome.notifications.clear(id);
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/128.png'),
      title,
      message,
      requireInteraction,
      silent: false,
    });
  } catch (e) {
    // 通知发不出去绝不能让抓取失败——它只是提示。
    console.log('[doubak] 通知发送失败（不影响抓取）', e);
  }
}

/** @param {string} text @param {string} color @param {string} title */
async function setBadge(text, color, title) {
  const chrome = globalThis.chrome;
  try {
    await chrome?.action?.setBadgeText?.({ text });
    await chrome?.action?.setBadgeBackgroundColor?.({ color });
    await chrome?.action?.setTitle?.({ title });
  } catch (e) {
    console.log('[doubak] 设置角标失败', e);
  }
}

/**
 * 点通知就打开面板。
 *
 * 通知说「回到豆备点继续」，那就得**真的能一下点回来**。让用户自己去找扩展图标
 * 是把一次点击变成一次寻宝。
 */
export function wireNotificationClicks() {
  const chrome = globalThis.chrome;
  chrome?.notifications?.onClicked?.addListener(async (id) => {
    try {
      await openPanel();
      await chrome.notifications.clear(id);
    } catch (e) {
      console.log('[doubak] 打开面板失败', e);
    }
  });
}

/** 面板页在扩展里的路径。 */
export const PANEL_URL = 'src/ui/panel.html';

/**
 * 打开面板——**已经开着就切过去，不再开一个**。
 *
 * 这是点图标和点通知共同的落点，一次抓取里会被点很多次。每次都 `tabs.create` 的话，
 * 一个下午下来会攒出十几个同一个页面的标签页，而它们还都在轮询状态。
 *
 * 用 `runtime.getContexts()` 找已有的那个：它只看得见本扩展自己的页面，所以**不需要
 * `tabs` 权限**（`tabs.query({url})` 就需要了——为了这个去多要一个权限不值得）。
 *
 * @returns {Promise<{created: boolean}>}
 */
export async function openPanel() {
  const chrome = globalThis.chrome;
  const url = chrome.runtime.getURL(PANEL_URL);

  // getContexts 是 Chrome 116+。拿不到就退回「直接开一个」——多开一个标签页是小事，
  // 打不开面板是大事。
  try {
    const ctxs = await chrome.runtime.getContexts?.({ contextTypes: ['TAB'] });
    const hit = ctxs?.find((c) => c.documentUrl?.startsWith(url));
    if (hit?.tabId != null) {
      await chrome.tabs.update(hit.tabId, { active: true });
      // 标签页可能在另一个窗口里，把那个窗口也提到前面来
      if (hit.windowId != null) await chrome.windows?.update(hit.windowId, { focused: true });
      return { created: false };
    }
  } catch (e) {
    console.log('[doubak] 找已有面板失败，直接开一个', e);
  }

  await chrome.tabs.create({ url });
  return { created: true };
}
