/**
 * Formatting for the traffic tabs.
 *
 * Decimal units on purpose — kB/MB/GB of 1000, not the binary Ki/Mi/Gi that
 * `format-metrics.ts` uses for memory. Bandwidth is sold and billed in decimal
 * GB (`BYTES_PER_GB = 1e9` in the meter), so showing a tenant 61.4 GiB against
 * a 100 GB allowance would be a different number from the one they are
 * charged on.
 */

import type { TrafficUnit } from '@insula/api-contracts';

const RATE_STEPS: ReadonlyArray<readonly [number, string]> = [
  [1e9, 'GB/s'], [1e6, 'MB/s'], [1e3, 'kB/s'], [1, 'B/s'],
];
const TOTAL_STEPS: ReadonlyArray<readonly [number, string]> = [
  [1e12, 'TB'], [1e9, 'GB'], [1e6, 'MB'], [1e3, 'kB'], [1, 'B'],
];

function scale(value: number, steps: ReadonlyArray<readonly [number, string]>): string {
  const abs = Math.abs(value);
  for (const [factor, suffix] of steps) {
    if (abs >= factor) {
      const scaled = value / factor;
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      return `${scaled.toFixed(digits)} ${suffix}`;
    }
  }
  return `0 ${steps[steps.length - 1][1]}`;
}

function countLabel(value: number, suffix: string): string {
  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(1)}B ${suffix}`;
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(1)}M ${suffix}`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}k ${suffix}`;
  return `${value.toFixed(value >= 10 || value === 0 ? 0 : 1)} ${suffix}`;
}

/** An instantaneous value: bytes/s, requests/s, or a latency in ms. */
export function formatTrafficRate(value: number | null, unit: TrafficUnit): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (unit === 'bytes') return scale(value, RATE_STEPS);
  if (unit === 'requests') return countLabel(value, 'req/s');
  return value >= 100 ? `${value.toFixed(0)} ms` : `${value.toFixed(1)} ms`;
}

/**
 * A rate accumulated over `seconds`.
 *
 * Latency has no total — summing an average is meaningless — so it reports
 * the average itself rather than a fabricated sum.
 */
export function formatTrafficTotal(value: number | null, unit: TrafficUnit, seconds: number): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (unit === 'milliseconds') return formatTrafficRate(value, unit);
  const total = value * seconds;
  return unit === 'bytes' ? scale(total, TOTAL_STEPS) : countLabel(total, 'req');
}

/** Already-integrated totals (the API's subject ranking hands these over). */
export function formatTrafficVolume(total: number | null, unit: TrafficUnit): string {
  if (total === null || !Number.isFinite(total)) return '—';
  if (unit === 'bytes') return scale(total, TOTAL_STEPS);
  if (unit === 'requests') return countLabel(total, 'req');
  return formatTrafficRate(total, unit);
}

/** The viewer's own zone, e.g. `Europe/Berlin`. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** `UTC+2`, for a compact pill. */
export function utcOffsetLabel(at: Date = new Date()): string {
  const minutes = -at.getTimezoneOffset();
  if (minutes === 0) return 'UTC';
  const sign = minutes > 0 ? '+' : '−';
  const h = Math.floor(Math.abs(minutes) / 60);
  const m = Math.abs(minutes) % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/** Axis tick: date-only for day steps, time-only within a day. */
export function formatAxisTick(iso: string, stepSeconds: number): string {
  const d = new Date(iso);
  if (stepSeconds >= 86_400) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (stepSeconds >= 3_600) {
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Full instant for the hover readout, in the viewer's zone. */
export function formatInstant(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
