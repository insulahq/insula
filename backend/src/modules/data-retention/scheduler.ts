// Data-retention cron — prunes the four append-only tables that lack
// any other retention (see service.ts for the rationale + windows).
//
// Mirrors the tasks/retention.ts pattern: run once at startup (so a
// long-stopped cluster cleans up promptly instead of waiting 6h), then
// every 6 hours. Never throws — the cron must keep running.

import { runDataRetention } from './service.js';
import type { Database } from '../../db/index.js';

const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export function startDataRetention(db: Database): NodeJS.Timeout {
  void runOnce(db);
  const timer = setInterval(() => {
    void runOnce(db);
  }, RETENTION_INTERVAL_MS);
  // Don't hold the event loop open during shutdown — the onClose hook
  // clears the interval anyway, but unref() is belt-and-braces.
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

async function runOnce(db: Database): Promise<void> {
  try {
    const r = await runDataRetention(db);
    const total = r.auditLogs + r.lifecycleTransitions + r.storageOperations + r.provisioningTasks;
    if (total > 0) {
      console.log(
        `[data-retention] pruned ${r.auditLogs} audit_logs · ${r.lifecycleTransitions} lifecycle_transitions(+cascaded hook_runs) · ${r.storageOperations} storage_operations · ${r.provisioningTasks} provisioning_tasks`,
      );
    }
  } catch (err) {
    console.warn('[data-retention] cycle failed:', err instanceof Error ? err.message : String(err));
  }
}
