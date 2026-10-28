/**
 * Byte counts, for every page of the admin panel.
 *
 * `formatBytes` is for what a backup, snapshot, bundle or transfer holds.
 * Decimal units (1 GB = 10^9 bytes): the units storage targets report and
 * providers sell in, and the ones `format-traffic.ts` uses for bandwidth.
 * Pages used to carry their own copies, some dividing by 1024 and printing
 * "GB": the same backup folder read 190.3 GB on one page and 204.4 GB on
 * another.
 *
 * `formatVolumeBytes` is for a volume or disk: its size and what is used of
 * it. Volumes and storage allowances are set in GiB, so these figures stay in
 * the unit typed into the resize dialog. Binary units, labelled as such.
 */

const DECIMAL = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'] as const;
const BINARY = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

function scaled(bytes: number, base: number, units: readonly string[]): string {
  // Round first: an average of 999.6 bytes is 1.0 kB, not "1000 B".
  const whole = Math.round(bytes);
  if (whole < base) return `${whole} ${units[0]}`;
  let value = whole;
  let i = 0;
  while (value >= base && i < units.length - 1) {
    value /= base;
    i += 1;
  }
  // 999.96 kB would print as "1000.0 kB"; it is 1.0 MB.
  if (Number(value.toFixed(1)) >= base && i < units.length - 1) {
    value /= base;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

/** Data size in decimal units ("204.4 GB"). "—" when there is no figure. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  return scaled(bytes, 1000, DECIMAL);
}

/** A volume's size or usage in binary units ("10.0 GiB"), matching what was set. */
export function formatVolumeBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  return scaled(bytes, 1024, BINARY);
}
