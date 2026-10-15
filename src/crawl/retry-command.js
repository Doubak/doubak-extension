/**
 * 一个用户重试操作包含恢复、会话确认和重新排队。确认会话可能花数秒；
 * 多个面板/按钮在此期间发来的同一请求必须共享结果，不能把第二次的 0
 * 当成第一次失败。只合并尚未完成的请求，不自动重试失败操作。
 */
export function createRetryCommand({ load, retry, resumeSchedule, clearAttention, drive }) {
  let pending = null;
  return function request(routeKey) {
    if (pending) {
      if (pending.routeKey === routeKey) return pending.promise;
      return Promise.reject(Object.assign(new Error('正在处理另一次重试，请稍候。'), { reason: 'busy' }));
    }
    const promise = (async () => {
      const loaded = await load();
      const count = loaded ? await retry(routeKey) : 0;
      if (count > 0) {
        await resumeSchedule();
        await clearAttention();
        void drive();
      }
      return { ok: true, count, loaded };
    })().finally(() => { pending = null; });
    pending = { routeKey, promise };
    return promise;
  };
}
