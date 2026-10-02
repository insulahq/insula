/**
 * Byte formatting for the snapshot tables.
 *
 * Two different "sizes" sit side by side, and they mean different things:
 *   - volume size  provisioned size of the snapshotted volume (`sizeBytes`);
 *                  0 means "not known yet" (the snapshot is still creating).
 *   - data size    what the snapshot actually holds (`dataSizeBytes`); `null`
 *                  means "not measured", and a real 0 means nothing changed
 *                  since the previous snapshot. The two must never render the
 *                  same — `formatDataSize(null)` is "—", `formatDataSize(0)`
 *                  is "0 B".
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Binary-unit bytes ("64.3 MB"). Assumes a finite, non-negative count. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${UNITS[i]}`;
}

/** Volume size: 0 is "not known yet", shown as "—". */
export function formatVolumeSize(bytes: number): string {
  return bytes > 0 ? formatBytes(bytes) : '—';
}

/** Data size: null is "not measured" ("—"); 0 is a measurement ("0 B"). */
export function formatDataSize(bytes: number | null): string {
  return bytes === null ? '—' : formatBytes(bytes);
}

export const VOLUME_SIZE_HELP =
  'Provisioned size of the storage volume the snapshot was taken of — what a restore gives back.';

export const DATA_SIZE_HELP =
  'Space the snapshot actually uses on the server: the data that changed since the previous snapshot. '
  + 'The first snapshot holds everything written up to that point.';

export const DATA_SIZE_UNKNOWN_HELP =
  'Not measured — the snapshot is still being created, was taken before data sizes were tracked, '
  + 'or the storage system did not report it just now.';
