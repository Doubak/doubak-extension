import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pauseSnapshotOnSessionChange } from '../src/crawl/snapshot-session-change.js';

test('cookie changes pause only runs with frozen snapshot opt-in, not legacy or idle runs', async () => {
  for (const enabled of [null, undefined, false, true]) {
    let pauses = 0;
    await pauseSnapshotOnSessionChange({
      loadCheckpoint: async () => enabled === null ? null : { run_context: { options: { broadcastReplySnapshot: enabled } } },
      pause: async () => { pauses++; },
    });
    assert.equal(pauses, enabled === true ? 1 : 0);
  }
});
