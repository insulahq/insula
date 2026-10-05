/**
 * Who gets EMAILED when a scheduled cron run fails — the opt-in, per-job leg.
 *
 * The tenant's admins already hear about every failure through their own
 * notification preferences. This module adds addresses on top: the tenant's
 * primary email and/or one extra address set on the job. Those go to the
 * dispatcher as `externalRecipients`, so they are rendered from the same
 * `tasks.scheduled_failure` template and sent through the same delivery queue,
 * retry and audit trail as every other notification email.
 *
 * Volume is bounded HERE, before dispatch, because the extra address is
 * tenant-entered and the platform will mail it:
 *
 *   - one email per job per UTC day while it keeps failing — a job broken on a
 *     `* * * * *` schedule costs one email, not 1,440;
 *   - CRON_FAILURE_EMAILS_PER_TENANT_PER_DAY across all of a tenant's jobs — so
 *     creating many jobs cannot multiply that.
 *
 * Both are atomic counters in `notification_rate_limit_buckets` (INSERT … ON
 * CONFLICT DO UPDATE), so three API replicas cannot each claim the same slot.
 * The per-job claim is taken first: a job already mailed today never spends
 * the tenant's allowance.
 */
import { eq } from 'drizzle-orm';
import { CRON_FAILURE_EMAILS_PER_TENANT_PER_DAY } from '@insula/api-contracts';
import { tenants } from '../../db/schema.js';
import { incrementBucket } from '../notifications/rate-limit/service.js';
import type { Database } from '../../db/index.js';

const DAY_S = 86_400;

export interface FailureEmailJob {
  readonly id: string;
  readonly tenantId: string;
  readonly notifyOnFailure: boolean;
  readonly notifyTenantEmail: boolean;
  readonly notifyEmail: string | null;
}

export type FailureEmailSkip =
  | 'disabled'
  | 'no-recipient'
  | 'already-sent-today'
  | 'tenant-daily-cap'
  | 'error';

export interface FailureEmailResolution {
  readonly recipients: readonly string[];
  readonly skipped?: FailureEmailSkip;
}

export interface FailureEmailDeps {
  /** The atomic bucket counter. Injected in tests. */
  readonly increment?: typeof incrementBucket;
}

/** The addresses a job names, de-duplicated case-insensitively. Pure. */
export function failureEmailRecipients(
  job: FailureEmailJob,
  tenantEmail: string | null,
): readonly string[] {
  if (!job.notifyOnFailure) return [];
  const candidates = [
    job.notifyTenantEmail ? tenantEmail : null,
    job.notifyEmail,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of candidates) {
    const address = raw?.trim();
    if (!address) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

/**
 * Bucket keys for the two limits. They end in `:win:<windowStart>` because
 * `incrementBucket` derives the window from that suffix.
 */
export function failureEmailBucketKeys(
  job: Pick<FailureEmailJob, 'id' | 'tenantId'>,
  now: Date,
): { readonly jobKey: string; readonly tenantKey: string } {
  const dayStartS = Math.floor(now.getTime() / 1000 / DAY_S) * DAY_S;
  return {
    jobKey: `cron-failure-email:job:${job.id}:win:${dayStartS}`,
    tenantKey: `cron-failure-email:tenant:${job.tenantId}:win:${dayStartS}`,
  };
}

async function tenantPrimaryEmail(db: Database, tenantId: string): Promise<string | null> {
  const [row] = await db
    .select({ primaryEmail: tenants.primaryEmail })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return row?.primaryEmail ?? null;
}

/**
 * The addresses to mail for THIS failure, with today's slot claimed — or an
 * empty list and the reason.
 *
 * Never throws: whatever goes wrong here costs the extra email, never the
 * tenant admins' own notification, which is dispatched regardless.
 */
export async function resolveFailureEmailRecipients(
  db: Database,
  job: FailureEmailJob,
  now: Date = new Date(),
  deps: FailureEmailDeps = {},
): Promise<FailureEmailResolution> {
  if (!job.notifyOnFailure) return { recipients: [], skipped: 'disabled' };
  const increment = deps.increment ?? incrementBucket;
  try {
    const tenantEmail = job.notifyTenantEmail ? await tenantPrimaryEmail(db, job.tenantId) : null;
    const recipients = failureEmailRecipients(job, tenantEmail);
    if (recipients.length === 0) return { recipients: [], skipped: 'no-recipient' };

    const { jobKey, tenantKey } = failureEmailBucketKeys(job, now);
    const perJob = await increment(db, jobKey, DAY_S, 1, now);
    if (!perJob.allowed) return { recipients: [], skipped: 'already-sent-today' };

    const perTenant = await increment(db, tenantKey, DAY_S, CRON_FAILURE_EMAILS_PER_TENANT_PER_DAY, now);
    if (!perTenant.allowed) {
      console.warn(
        `[cron-scheduler] tenant ${job.tenantId} reached its ${CRON_FAILURE_EMAILS_PER_TENANT_PER_DAY} `
        + `cron failure emails for today; job ${job.id} is reported in the panel only`,
      );
      return { recipients: [], skipped: 'tenant-daily-cap' };
    }
    return { recipients };
  } catch (err) {
    console.warn(
      `[cron-scheduler] could not resolve failure-email recipients for job ${job.id}:`,
      err instanceof Error ? err.message : err,
    );
    return { recipients: [], skipped: 'error' };
  }
}
