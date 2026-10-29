/** JSON has no trusted login navigation. Cookie invalidation must pause opt-in runs. */
export async function pauseSnapshotOnSessionChange({ loadCheckpoint, pause }) {
  const cp = await loadCheckpoint();
  if (cp?.run_context?.options?.broadcastReplySnapshot === true) await pause();
}
