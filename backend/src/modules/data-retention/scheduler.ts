// Data-retention cron — prunes the four append-only tables that lack
// any other retention (see service.ts for the rationale + windows).
//
// Mirrors the tasks/retention.ts pattern: run once at startup (so a
// long-stopped cluster cleans up promptly instead of waiting 6h), then
// every 6 hours. Never throws — the cron must keep running.

import { runDataRetention } from './service.js';
import type { DataRetentionResult } from './service.js';
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

/**
 * Human labels for the log line, keyed by DataRetentionResult field.
 *
 * EXHAUSTIVE BY TYPE (`Record<keyof DataRetentionResult, string>`): adding a
 * counter to the result without a label here is a COMPILE ERROR. That is
 * deliberate — it is the only remaining manual step, since the total itself is
 * now derived with Object.values() and cannot drift.
 *
 * It lives in this file rather than the test because `backend/tsconfig.json`
 * excludes `**\/*.test.ts`, so a type-level guard written in a test is never
 * checked by `npm run typecheck` and only looks like protection.
 */
export const TABLE_LABELS: Readonly<Record<keyof DataRetentionResult, string>> = {
  auditLogs: 'audit_logs',
  lifecycleTransitions: 'lifecycle_transitions(+cascaded hook_runs)',
  storageOperations: 'storage_operations',
  provisioningTasks: 'provisioning_tasks',
  emailSendCounters: 'email_send_counters',
  fblComplaints: 'email_fbl_complaints',
  imageAuditRows: 'custom_deployment_image_audit',
  deploymentUpgrades: 'deployment_upgrades',
  storageApplyRuns: 'platform_storage_apply_runs',
  drDrillRuns: 'dr_drill_runs',
  imageReapLogRows: 'image_reap_log',
  crowdsecAutobanRuns: 'crowdsec_autoban_runs',
  sftpAuditLogRows: 'sftp_audit_log',
};

async function runOnce(db: Database): Promise<void> {
  try {
    const r = await runDataRetention(db);
    // Sum EVERY counter — a table missing from this total is a table whose
    // pruning is invisible in the logs, which is how the 2026-06-01 sweep's
    // gaps went unnoticed for three months.
    //
    // Derived from the RESULT OBJECT rather than a hand-written sum, because
    // the hand-written one had already drifted: the crowdsec_autoban_runs and
    // sftp_audit_log counters added on 2026-09-11 were missing from it, so a
    // cycle that pruned only those two would have reported nothing at all —
    // the exact failure this comment warns about, reintroduced by the change
    // that was fixing unbounded tables. Object.values() cannot forget a field.
    const total = Object.values(r).reduce((a, b) => a + b, 0);
    if (total > 0) {
      const parts = Object.entries(r)
        .filter(([, n]) => n > 0)
        // Fallback is unreachable while the Record above stays exhaustive —
        // kept so a future refactor that loosens the type degrades to an ugly
        // label rather than a missing table.
        .map(([k, n]) => `${n} ${(TABLE_LABELS as Record<string, string>)[k] ?? k}`);
      console.log(`[data-retention] pruned ${parts.join(' · ')}`);
    }
  } catch (err) {
    console.warn('[data-retention] cycle failed:', err instanceof Error ? err.message : String(err));
  }
}
