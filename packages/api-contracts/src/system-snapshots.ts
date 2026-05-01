import { z } from 'zod';

// ─── System Snapshots ────────────────────────────────────────────────────────
//
// Inventory + per-volume snapshot management for platform/system PVCs
// (postgres, stalwart-mail, monitoring, etc). Distinct from the
// per-tenant snapshot UI exposed by storage-lifecycle.

export const systemPvcSnapshotSummarySchema = z.object({
  namespace: z.string(),
  pvcName: z.string(),
  longhornVolumeName: z.string(),
  volumeSizeBytes: z.number().int().nonnegative(),
  snapshotCount: z.number().int().nonnegative(),
  snapshotBytesTotal: z.number().int().nonnegative(),
  oldestSnapshotAt: z.string().nullable(),
  newestSnapshotAt: z.string().nullable(),
  recurringJobs: z.array(z.string()).default([]),
  degraded: z.boolean(),
});
export type SystemPvcSnapshotSummary = z.infer<typeof systemPvcSnapshotSummarySchema>;

export const systemSnapshotEntrySchema = z.object({
  snapshotName: z.string(),
  volumeName: z.string(),
  createdAt: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  usable: z.boolean(),
  userLabel: z.string().nullable(),
  markedForRemoval: z.boolean(),
});
export type SystemSnapshotEntry = z.infer<typeof systemSnapshotEntrySchema>;

export const recurringJobPolicySchema = z.object({
  jobName: z.string(),
  task: z.enum(['snapshot', 'backup']),
  cron: z.string(),
  retain: z.number().int().min(0),
  groups: z.array(z.string()).default([]),
});
export type RecurringJobPolicy = z.infer<typeof recurringJobPolicySchema>;

export const systemSnapshotsResponseSchema = z.object({
  items: z.array(systemPvcSnapshotSummarySchema),
});
export type SystemSnapshotsResponse = z.infer<typeof systemSnapshotsResponseSchema>;

export const systemRecurringJobsResponseSchema = z.object({
  jobs: z.array(recurringJobPolicySchema),
});
export type SystemRecurringJobsResponse = z.infer<typeof systemRecurringJobsResponseSchema>;

export const systemSnapshotsListResponseSchema = z.object({
  snapshots: z.array(systemSnapshotEntrySchema),
});
export type SystemSnapshotsListResponse = z.infer<typeof systemSnapshotsListResponseSchema>;

export const systemSnapshotPruneResponseSchema = z.object({
  deleted: z.array(z.string()),
  kept: z.array(z.string()),
});
export type SystemSnapshotPruneResponse = z.infer<typeof systemSnapshotPruneResponseSchema>;
