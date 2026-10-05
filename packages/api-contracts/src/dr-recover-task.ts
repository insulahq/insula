import { z } from 'zod';
import { operatorErrorSchema } from './operator-error.js';
import { restoreJobStatusSchema } from './restore.js';
import {
  drEncryptionKeyPreflightSchema,
  drRecoverAllSkippedSchema,
  drRecoverResponseSchema,
} from './dr-recover.js';

// ─── Tenant recovery as a task-center task ───────────────────────────────────
//
// A recover started with `background: true` runs server-side and reports
// through the task center: a `dr.recover` task (one tenant) or a
// `dr.recover-all` task (the batch, with one child `dr.recover` task per
// tenant). Its progress modal reads the task row's `details`, which carry the
// shapes below — so closing the modal never loses the run, and the chip
// re-opens the same view.

/** The phases of one tenant recovery, in the order they run. */
export const drRecoverStepKeySchema = z.enum([
  'recreate',
  'bundle',
  'provision',
  'queue',
  'restore',
  'reconcile',
]);
export type DrRecoverStepKey = z.infer<typeof drRecoverStepKeySchema>;

/** `skipped` = not needed this run (tenant exists, provision off, no reconcile). */
export const drRecoverStepStateSchema = z.enum(['pending', 'running', 'done', 'failed', 'skipped']);
export type DrRecoverStepState = z.infer<typeof drRecoverStepStateSchema>;

export const drRecoverStepSchema = z.object({
  key: drRecoverStepKeySchema,
  label: z.string(),
  state: drRecoverStepStateSchema,
  /** One line of what the step found or did — never a secret, never a raw upstream error. */
  note: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type DrRecoverStep = z.infer<typeof drRecoverStepSchema>;

/** `details` of a `dr.recover` task. */
export const drRecoverTaskDetailsSchema = z.object({
  tenantId: z.string(),
  tenantName: z.string().nullable(),
  /** Known once the bundle is resolved. */
  bundleId: z.string().nullable(),
  /** Known once the restore cart exists — the modal reads per-item progress from it. */
  cartId: z.string().nullable(),
  steps: z.array(drRecoverStepSchema),
  /** The terminal result — what the synchronous call answers with. Null until it finishes. */
  result: drRecoverResponseSchema.nullable(),
  /** Why the run failed, for `<ErrorPanel>`. Null unless it failed. */
  error: operatorErrorSchema.nullable(),
});
export type DrRecoverTaskDetails = z.infer<typeof drRecoverTaskDetailsSchema>;

/** 202 body of `POST /admin/dr/tenants/:tenantId/recover` with `background: true`. */
export const drRecoverStartedSchema = z.object({
  taskId: z.string(),
  tenantId: z.string(),
});
export type DrRecoverStarted = z.infer<typeof drRecoverStartedSchema>;

// ─── Batch ───────────────────────────────────────────────────────────────────

export const drRecoverAllTenantStateSchema = z.enum(['pending', 'running', 'done', 'failed']);
export type DrRecoverAllTenantState = z.infer<typeof drRecoverAllTenantStateSchema>;

/** One tenant's row in a running batch. */
export const drRecoverAllTenantProgressSchema = z.object({
  tenantId: z.string(),
  tenantName: z.string().nullable(),
  bundleId: z.string(),
  state: drRecoverAllTenantStateSchema,
  /** The step it is on while running; null otherwise. */
  step: z.string().nullable(),
  /** Its own `dr.recover` task (a child of the batch task). */
  taskId: z.string().nullable(),
  /** Terminal restore-cart status; null until it has one. */
  status: restoreJobStatusSchema.nullable(),
  recreated: z.boolean(),
  /** Why it failed — the operator-facing message, never a raw upstream error. */
  error: z.string().nullable(),
});
export type DrRecoverAllTenantProgress = z.infer<typeof drRecoverAllTenantProgressSchema>;

/** `details` of a `dr.recover-all` task. */
export const drRecoverAllTaskDetailsSchema = z.object({
  scope: z.enum(['missing', 'all']),
  total: z.number().int().nonnegative(),
  recovered: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  tenants: z.array(drRecoverAllTenantProgressSchema),
  /** Passed over, and why — carried from the run so the modal tells the whole story. */
  skipped: z.array(drRecoverAllSkippedSchema),
  encryptionKey: drEncryptionKeyPreflightSchema.nullable(),
  /** The batch itself broke (not one tenant). Null otherwise. */
  error: operatorErrorSchema.nullable(),
});
export type DrRecoverAllTaskDetails = z.infer<typeof drRecoverAllTaskDetailsSchema>;

/** 202 body of `POST /admin/dr/tenants/recover-all` with `background: true`. */
export const drRecoverAllStartedSchema = z.object({
  taskId: z.string(),
  total: z.number().int().nonnegative(),
});
export type DrRecoverAllStarted = z.infer<typeof drRecoverAllStartedSchema>;
