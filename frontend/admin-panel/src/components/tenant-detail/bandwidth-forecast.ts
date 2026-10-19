import type { TenantBandwidthUsage } from '@insula/api-contracts';

/**
 * "Runs out around 28 Oct at this rate" — or null when it will not run out
 * this cycle, there is no allowance, or too little of the cycle has passed to
 * say (under a day, the rate is noise).
 *
 * The cycle is a calendar month from `cycleStart`; usage is assumed to keep
 * its average pace so far.
 */
export function bandwidthForecast(bw: TenantBandwidthUsage, now: Date): string | null {
  if (bw.capped || bw.limitGb <= 0 || !bw.cycleStart) return null;
  const start = new Date(bw.cycleStart);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const elapsedDays = (now.getTime() - start.getTime()) / 86_400_000;
  if (elapsedDays < 1 || bw.usedGb <= 0) return null;
  const perDay = bw.usedGb / elapsedDays;
  const daysLeft = (bw.limitGb - bw.usedGb) / perDay;
  const runsOut = new Date(now.getTime() + daysLeft * 86_400_000);
  if (runsOut >= end) return null;
  return `Runs out around ${runsOut.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} at this rate`;
}
