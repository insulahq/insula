import { z } from 'zod';

// ─── Postgres PITR Restore ───────────────────────────────────────────────────
//
// Snapshot-only point-in-time-recovery for CNPG-managed Postgres.
// Operator picks a Longhorn snapshot in the System Backup modal,
// optionally a sub-hour PITR target, and the orchestrator auto-promotes
// the restored cluster (replaces the source).
//
// Async API: POST returns 202 immediately; orchestration runs in
// background (~5-10 min). Poll /status for progress.

export const pitrStepSchema = z.object({
  step: z.string(),
  ok: z.boolean(),
  elapsedMs: z.number().int().nonnegative().optional(),
  detail: z.string().optional(),
});
export type PitrStep = z.infer<typeof pitrStepSchema>;

export const pitrResultSchema = z.object({
  clusterName: z.string(),
  snapshotName: z.string(),
  recoveryTargetTime: z.string().nullable(),
  steps: z.array(pitrStepSchema),
  downtimeMs: z.number().int().nonnegative(),
  tempClusterName: z.string(),
});
export type PitrResult = z.infer<typeof pitrResultSchema>;

export const pitrStatusSchema = z.object({
  inProgress: z.boolean(),
  startedAt: z.string().optional(),
  snapshot: z.string().optional(),
  source: z.enum(['in-memory', 'db', 'none']).optional(),
});
export type PitrStatus = z.infer<typeof pitrStatusSchema>;

// 202 response from POST /admin/postgres-restore — orchestration kicked
// off as a one-shot Kubernetes Job. jobName + jobNamespace let the
// operator tail the run via `kubectl logs -n <ns> job/<name> -f`.
export const pitrAcceptedSchema = z.object({
  status: z.literal('started'),
  clusterNamespace: z.string(),
  clusterName: z.string(),
  snapshotName: z.string(),
  recoveryTargetTime: z.string().nullable(),
  jobName: z.string(),
  jobNamespace: z.string(),
  pollUrl: z.string(),
  message: z.string(),
});
export type PitrAccepted = z.infer<typeof pitrAcceptedSchema>;

export const pitrRequestSchema = z.object({
  clusterNamespace: z.string().min(1).max(253),
  clusterName: z.string().min(1).max(253),
  snapshotName: z.string().min(1).max(253),
  recoveryTargetTime: z.string().datetime().optional(),
});
export type PitrRequest = z.infer<typeof pitrRequestSchema>;

// ─── PITR prechecks (read-only) ──────────────────────────────────────────────
//
// Wizard Step 3 calls this BEFORE commit so static warnings give way to live
// state. `blockingError` is the gate: null = may POST; string = surface as
// the reason the Confirm button is disabled.

// Intentionally a direct reference to pitrRequestSchema — the prechecks
// endpoint accepts the same field set as the POST. If divergence is ever
// needed (e.g. prechecks-only flags), structurally clone with
// `pitrRequestSchema.extend({...})` rather than `.refine()` on this alias
// (refinements on the alias would silently also apply to POST validation).
export const pitrPrechecksRequestSchema = pitrRequestSchema;
export type PitrPrechecksRequest = z.infer<typeof pitrPrechecksRequestSchema>;

export const pitrPrechecksResponseSchema = z.object({
  snapshotUsable: z.boolean(),
  snapshotAgeSec: z.number().int().nonnegative().nullable(),
  snapshotCreatedAt: z.string().nullable(),
  walCoverageOk: z.boolean().nullable(),
  walOldestAt: z.string().nullable(),
  walCount: z.number().int().nonnegative().nullable(),
  lockState: z.enum(['free', 'in-memory', 'db']),
  lockSnapshot: z.string().nullable(),
  sourceInstances: z.number().int().nonnegative().nullable(),
  clusterPrimaryPvc: z.string().nullable(),
  blockingError: z.string().nullable(),
});
export type PitrPrechecksResponse = z.infer<typeof pitrPrechecksResponseSchema>;
