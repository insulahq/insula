// Data-retention cron — prunes the four append-only tables that lack
// any other retention (see service.ts for the rationale + windows).
//
// Mirrors the tasks/retention.ts pattern: run once at startup (so a
// long-stopped cluster cleans up promptly instead of waiting 6h), then
// every 6 hours. Never throws — the cron must keep running.

import { runDataRetention } from './service.js';
import type { Database } from '../../db/index.js';
import { safeTick } from '../../shared/safe-tick.js';

const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export function startDataRetention(db: Database): NodeJS.Timeout {
  safeTick('data-retention', () => runOnce(db));
  const timer = setInterval(() => {
    safeTick('data-retention', () => runOnce(db));
  }, RETENTION_INTERVAL_MS);
  // Don't hold the event loop open during shutdown — the onClose hook
  // clears the interval anyway, but unref() is belt-and-braces.
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

async function runOnce(db: Database): Promise<void> {
  try {
    const r = await runDataRetention(db);
    // Sum EVERY counter — a table missing from this total is a table whose
    // pruning is invisible in the logs, which is how the 2026-06-01 sweep's
    // gaps went unnoticed for three months.
    const total = r.auditLogs + r.lifecycleTransitions + r.storageOperations
      + r.provisioningTasks + r.emailSendCounters + r.fblComplaints + r.imageAuditRows
      + r.deploymentUpgrades + r.storageApplyRuns + r.drDrillRuns + r.imageReapLogRows;
    if (total > 0) {
      const parts = Object.entries({
        audit_logs: r.auditLogs,
        'lifecycle_transitions(+cascaded hook_runs)': r.lifecycleTransitions,
        storage_operations: r.storageOperations,
        provisioning_tasks: r.provisioningTasks,
        email_send_counters: r.emailSendCounters,
        email_fbl_complaints: r.fblComplaints,
        custom_deployment_image_audit: r.imageAuditRows,
        deployment_upgrades: r.deploymentUpgrades,
        platform_storage_apply_runs: r.storageApplyRuns,
        dr_drill_runs: r.drDrillRuns,
        image_reap_log: r.imageReapLogRows,
      }).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
      console.log(`[data-retention] pruned ${parts.join(' · ')}`);
    }
  } catch (err) {
    console.warn('[data-retention] cycle failed:', err instanceof Error ? err.message : String(err));
  }
}
