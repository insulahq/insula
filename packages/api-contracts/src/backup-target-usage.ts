/**
 * How much each backup target holds, and how much room it has left.
 *
 * Measured by platform-api with rclone against the target itself — not through
 * the shim, which only exposes the class currently bound — so a class that
 * moved to another target still shows what it left behind on the old one.
 *
 *   `classes`   bytes under `<target root>/<class>` (`rclone size`); null for a
 *               class whose folder could not be listed.
 *   `capacity`  the target's own total / used / free (`rclone about`). Null when
 *               the target does not report space — S3 has no such concept — with
 *               `capacityNote` saying why.
 */
import { z } from 'zod';

export const BACKUP_USAGE_CLASSES = ['system', 'tenant', 'mail'] as const;
export const backupUsageClassSchema = z.enum(BACKUP_USAGE_CLASSES);
export type BackupUsageClass = z.infer<typeof backupUsageClassSchema>;

export const classUsageSchema = z.object({
  bytes: z.number().int().nonnegative(),
  objects: z.number().int().nonnegative(),
});
export type ClassUsage = z.infer<typeof classUsageSchema>;

export const targetCapacitySchema = z.object({
  totalBytes: z.number().int().nonnegative().nullable(),
  usedBytes: z.number().int().nonnegative().nullable(),
  freeBytes: z.number().int().nonnegative().nullable(),
});
export type TargetCapacity = z.infer<typeof targetCapacitySchema>;

export const targetUsageMeasurementSchema = z.object({
  measuredAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  classes: z.object({
    system: classUsageSchema.nullable(),
    tenant: classUsageSchema.nullable(),
    mail: classUsageSchema.nullable(),
  }),
  /** Sum of the classes that were listed. */
  usedByBackupsBytes: z.number().int().nonnegative(),
  capacity: targetCapacitySchema.nullable(),
  /** Why `capacity` is null, in words an operator can act on. */
  capacityNote: z.string().nullable(),
  /** Per-class listing errors, keyed by class. Empty when every class listed. */
  errors: z.record(z.string(), z.string()),
});
export type TargetUsageMeasurement = z.infer<typeof targetUsageMeasurementSchema>;

export const targetUsageRowSchema = z.object({
  targetId: z.string(),
  name: z.string(),
  storageType: z.string(),
  enabled: z.boolean(),
  readOnly: z.boolean(),
  /** The classes bound to this target now. */
  boundClasses: z.array(backupUsageClassSchema),
  /** Null until the first measurement. */
  usage: targetUsageMeasurementSchema.nullable(),
  /** Set while a measurement runs. */
  measuringSince: z.string().nullable(),
});
export type TargetUsageRow = z.infer<typeof targetUsageRowSchema>;

export const targetUsageResponseSchema = z.object({
  targets: z.array(targetUsageRowSchema),
});
export type TargetUsageResponse = z.infer<typeof targetUsageResponseSchema>;
