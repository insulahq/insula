import { z } from 'zod';

// ─── Postgres barman-cloud BACKUP restore (Phase 3 — 2026-05-22) ────────────
//
// Side-by-side restore from an off-cluster barman-cloud archive. The new
// cluster is created next to source via CNPG's bootstrap.recovery (with
// optional PITR target time) — the source cluster is NEVER touched.
//
// Phase 3 scope:
//   - POST   create:  build new Cluster CR + apply
//   - GET    status:  poll new cluster phase + conditions
//   - DELETE cleanup: delete side-by-side cluster + PVCs
//
// Phase 3.1 (deferred): promote operation that swaps connection strings
// to the restored cluster and tears down the source — the genuinely
// destructive step, kept separate by design for safer ops.

const NAME = z.string().min(1).max(50).regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/);

export const barmanRestoreRequestSchema = z.object({
  namespace: NAME,
  sourceClusterName: NAME,
  newClusterName: NAME,
  recoveryTargetTime: z.string().datetime().optional(),
  /** Defaults server-side to 1 (cheap restore; scale later). 1..5 allowed. */
  instances: z.number().int().min(1).max(5).optional(),
});
export type BarmanRestoreRequest = z.infer<typeof barmanRestoreRequestSchema>;

export const barmanRestoreAcceptedSchema = z.object({
  status: z.literal('side-by-side-restoring'),
  newClusterName: z.string(),
  namespace: z.string(),
  objectStoreName: z.string(),
  recoveryTargetTime: z.string().nullable(),
  clusterUid: z.string(),
  /** URL the wizard polls for status. */
  pollUrl: z.string(),
  /** Operator-facing summary. */
  message: z.string(),
});
export type BarmanRestoreAccepted = z.infer<typeof barmanRestoreAcceptedSchema>;

export const barmanRestoreConditionSchema = z.object({
  type: z.string(),
  status: z.string(),
  reason: z.string().nullable(),
  message: z.string().nullable(),
  lastTransitionTime: z.string().nullable(),
});

export const barmanRestoreStatusSchema = z.object({
  clusterName: z.string(),
  namespace: z.string(),
  phase: z.string().nullable(),
  readyInstances: z.number().int().nonnegative().nullable(),
  desiredInstances: z.number().int().nonnegative().nullable(),
  currentPrimary: z.string().nullable(),
  conditions: z.array(barmanRestoreConditionSchema),
  /** True when bootstrap is complete + primary is serving. */
  ready: z.boolean(),
});
export type BarmanRestoreStatus = z.infer<typeof barmanRestoreStatusSchema>;

export const barmanRestoreDeleteResponseSchema = z.object({
  deleted: z.boolean(),
  namespace: z.string(),
  newClusterName: z.string(),
});
export type BarmanRestoreDeleteResponse = z.infer<typeof barmanRestoreDeleteResponseSchema>;

// ─── Phase 3.1 (2026-05-23) — Barman-restore PROMOTE ────────────────────────
//
// Destructive cutover: take a Longhorn snapshot of the restored cluster's
// primary PVC, then invoke the existing postgres-restore PITR orchestrator
// against the SOURCE cluster name with that snapshot. The PITR machinery
// handles quiesce / suspend-Flux / delete-source / recreate-from-snapshot /
// normalize-bootstrap / resume-Flux. Post-PITR-success the Job pod
// additionally deletes the side-by-side restored Cluster CR.
//
// Type-to-confirm: the operator must POST `confirmSourceClusterName` with
// EXACTLY the source cluster name. Server-side enforcement so frontend
// gating is UX-only, not security.

export const barmanPromoteRequestSchema = z.object({
  /** Source cluster name to cut over INTO. The new (rebuilt) cluster
   *  will take this name. */
  sourceClusterName: NAME,
  /** Type-to-confirm gate: MUST equal `sourceClusterName`. The route
   *  rejects with 409 if they differ — prevents UI bugs / partial form
   *  submissions from triggering a destructive cutover. */
  confirmSourceClusterName: NAME,
});
export type BarmanPromoteRequest = z.infer<typeof barmanPromoteRequestSchema>;

export const barmanPromoteAcceptedSchema = z.object({
  status: z.literal('promoting'),
  /** Restored Cluster CR being cut over into the source. */
  restoredClusterName: z.string(),
  /** Source cluster name (== confirmed name). */
  sourceClusterName: z.string(),
  namespace: z.string(),
  /** Longhorn snapshot we just took of the restored cluster's primary PVC,
   *  passed to the PITR orchestrator. */
  snapshotName: z.string(),
  /** k8s Job name running the orchestration — same shape as the PITR
   *  endpoint's response. Lets the wizard track via task-center chip. */
  jobName: z.string(),
  jobNamespace: z.string(),
  pollUrl: z.string(),
  message: z.string(),
});
export type BarmanPromoteAccepted = z.infer<typeof barmanPromoteAcceptedSchema>;
