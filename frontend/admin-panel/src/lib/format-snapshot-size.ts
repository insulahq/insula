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
 *
 * Their units differ too: a volume is sized in GiB, data is counted in GB
 * (`format-bytes.ts`).
 */

import { formatBytes, formatVolumeBytes } from './format-bytes';

/** Volume size: 0 is "not known yet", shown as "—". GiB, as volumes are sized. */
export function formatVolumeSize(bytes: number): string {
  return bytes > 0 ? formatVolumeBytes(bytes) : '—';
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
