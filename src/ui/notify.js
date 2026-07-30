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
  write_failed: '写入档案时出错',
};

const NEEDS_ACTION_BODY = {
  challenge: '请在浏览器里完成验证，然后回到豆备点继续。插件和你共用登录状态。',
  blocked: '已经停下来了，不会自动重试——继续请求可能导致账号被限制。建议等待 30 分钟以上。',
  session_expired: '这不是错误，抓取已安全停下，进度都在。重新登录豆瓣后回来继续。',
  account_switched: '一个档案只能属于一个账号。请切回原来的账号，或另开一次抓取。',
  host_permission_lost: '请在浏览器的扩展设置里把站点访问权限改回「在所有网站上」。',
  quota: '需要先导出或清理再继续。已经抓到的都还在。',
  missing_user_id: '豆瓣的页面结构可能变了。请到调试页跑一次演练确认其余环节正常，并把详细信息反馈给我们。',
  write_failed: '已经停下来了，以免损坏已有数据。继续之前会先自动修复段文件尾部。',
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
 * 角标先点亮再发通知：角标是那条不会消失的兜底，通知可能压根没权限。
 *
 * @param {string} reason  停机原因，或一句现成的话
 */
export async function notifyNeedsAction(reason) {
  await setBadge('!', '#d93025', `豆备：${copyFor(reason).title}`);

  const { title, body } = copyFor(reason);
  await show(ATTENTION_ID, {
    title,
    message: body,
    // 要人处理的事不许自己消失。用户没看见 = 抓取继续停着。
    requireInteraction: true,
  });
}

/**
 * 抓完了。
 *
 * @param {{captured?: number, failed?: number}} [result]
 */
export async function notifyDone(result = {}) {
  await clearAttention();

  const n = result.captured ?? 0;
  await show(DONE_ID, {
    title: '备份完成',
    // 提醒导出，因为**没导出之前档案不算用户的**：它挂在扩展的存储里，
    // 卸载扩展或清站点数据都会把它一次性抹掉，而且不会问一句。
    message:
      `抓到 ${n} 个页面` +
      (result.failed ? `，${result.failed} 个失败` : '') +
      '。打开面板导出到你自己的文件夹——档案没导出之前还在浏览器的存储里。',
  });
}

/** 问题解决了：角标和「要处理」的通知一起收掉。 */
export async function clearAttention() {
  await setBadge('', '#5f6368', '豆备 Doubak');
  try {
    await globalThis.chrome?.notifications?.clear?.(ATTENTION_ID);
  } catch {
    // 通知本来就可能不存在，清不掉不是问题。
  }
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
      await chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/panel.html') });
      await chrome.notifications.clear(id);
    } catch (e) {
      console.log('[doubak] 打开面板失败', e);
    }
  });
}
