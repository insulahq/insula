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
