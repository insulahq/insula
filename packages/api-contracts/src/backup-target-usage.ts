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

export interface ClassStoredTotal {
  /** Sum over `holders`. */
  readonly bytes: number;
  /** Targets whose class folder was listed and counts. */
  readonly holders: ReadonlyArray<{ readonly targetId: string; readonly name: string; readonly bytes: number }>;
  /** Targets the class is bound to whose class folder could not be listed. */
  readonly unlisted: ReadonlyArray<{ readonly targetId: string; readonly name: string; readonly error: string | null }>;
  /** Targets the class is bound to that have not been measured yet. */
  readonly unmeasured: ReadonlyArray<{ readonly targetId: string; readonly name: string }>;
  /** The oldest measurement among `holders`; null when there are none. */
  readonly measuredAt: string | null;
}

/**
 * What one backup class takes up: its folder on every target that holds it.
 *
 * Not a figure the backup tool keeps. restic counts only the data its kept
 * snapshots use; the folder also holds what the daily prune has not removed
 * yet and restic's index, and on an old target whatever a class switch left
 * there. The class pages read this, and so does the dashboard for tenant and
 * mail, so those cannot show one class at two sizes.
 *
 * A target counts when its folder holds data, or when the class is bound to it
 * (an empty folder there is a real 0, not "no figure").
 */
export function classStoredTotal(rows: readonly TargetUsageRow[], cls: BackupUsageClass): ClassStoredTotal {
  const holders: Array<ClassStoredTotal['holders'][number]> = [];
  const unlisted: Array<ClassStoredTotal['unlisted'][number]> = [];
  const unmeasured: Array<ClassStoredTotal['unmeasured'][number]> = [];
  const measured: string[] = [];
  for (const row of rows) {
    const usage = row.usage;
    const bound = row.boundClasses.includes(cls);
    if (!usage) {
      if (bound) unmeasured.push({ targetId: row.targetId, name: row.name });
      continue;
    }
    const folder = usage.classes[cls];
    if (folder && (folder.bytes > 0 || bound)) {
      holders.push({ targetId: row.targetId, name: row.name, bytes: folder.bytes });
      measured.push(usage.measuredAt);
    } else if (!folder && bound) {
      unlisted.push({ targetId: row.targetId, name: row.name, error: usage.errors[cls] ?? null });
    }
  }
  return {
    bytes: holders.reduce((n, h) => n + h.bytes, 0),
    holders,
    unlisted,
    unmeasured,
    measuredAt: measured.sort()[0] ?? null,
  };
}
