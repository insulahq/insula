/**
 * Object times seen through the backup shim are not upload times.
 *
 * The shim serves S3 with `rclone serve s3 … --no-modtime`, and then reports
 * one fixed placeholder — the start of the year 2000 — as the LastModified of
 * every object, in LISTs and HEADs alike. A reader that takes it at face value
 * concludes everything is decades old: the DR-artefact retention removed every
 * copy but the newest on its first run, and the Postgres WAL summary put the
 * end of the restorable window at the placeholder.
 *
 * Read through {@link shimObjectTime}: the placeholder becomes "unknown".
 * Where a real time matters, read it from the target itself
 * (backup-config/target-usage.ts `listTargetFileTimes`) or from the object's
 * own content (a name stamp, backup.info).
 */

/** Anything before this is the shim's placeholder, not an upload. */
const PLACEHOLDER_BEFORE_MS = Date.UTC(2001, 0, 1);

/** The object's real upload time, or undefined when the shim did not report one. */
export function shimObjectTime(t: Date | undefined | null): Date | undefined {
  if (!t) return undefined;
  const ms = t.getTime();
  return Number.isFinite(ms) && ms >= PLACEHOLDER_BEFORE_MS ? t : undefined;
}
