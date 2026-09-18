/**
 * Firing engine for schedules the platform drives itself.
 *
 * Used only for `cronjob-flux` targets whose operator cadence differs from the
 * manifest default. Those CronJobs are suspended (Flux owns their schedule and
 * reverts any patch within its 1-minute interval), so the platform creates the
 * Jobs from the CronJob's own `jobTemplate` — the job runs exactly the same
 * container it always did, just at the operator's chosen time.
 *
 * Idempotency is by NAME, not by bookkeeping: the Job name embeds the minute it
 * fires for, so a second attempt in the same minute — a duplicate tick, two API
 * replicas, a pod restart inside the catch-up window — collides with a 409 and
 * is swallowed. That is deliberately stronger than a `last_fired_at` check,
 * which two replicas can both pass before either writes.
 */

import type { Logger } from 'pino';

import { cronMatchesMinute, minuteStamp } from '../../../shared/cron-match.js';

export interface FiringClients {
  readonly batch: {
    readNamespacedCronJob: (args: { name: string; namespace: string }) => Promise<unknown>;
    createNamespacedJob: (args: { namespace: string; body: object }) => Promise<unknown>;
  };
}

interface CronJobShape {
  readonly metadata?: { readonly name?: string };
  readonly spec?: {
    readonly jobTemplate?: {
      readonly metadata?: { readonly labels?: Record<string, string>; readonly annotations?: Record<string, string> };
      readonly spec?: unknown;
    };
  };
}

/**
 * Kubernetes object names cap at 63 characters and the CronJob name is already
 * long (`platform-cluster-state-backup` is 29). `<name>-<YYYYMMDDHHmm>` fits,
 * but a future longer CronJob would silently 422 on every fire, so the base is
 * trimmed rather than left to chance.
 */
export function firedJobName(cronJobName: string, at: Date): string {
  const stamp = minuteStamp(at).replace(/[^0-9]/g, '');
  const suffix = `-${stamp}`;
  const room = 63 - suffix.length;
  return `${cronJobName.slice(0, room)}${suffix}`;
}

export interface FireResult {
  readonly fired: boolean;
  /** True when this minute was already fired (409) — not an error. */
  readonly duplicate: boolean;
  readonly jobName: string;
  readonly errorMessage: string;
}

/**
 * Fire one Job for `at` if `cron` matches that minute.
 *
 * `at` is passed in rather than read from the clock so the caller can run a
 * catch-up window, and so tests are not timing-dependent.
 */
export async function fireIfDue(
  clients: FiringClients,
  args: {
    readonly namespace: string;
    readonly cronJobName: string;
    readonly cron: string;
    readonly at: Date;
  },
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<FireResult> {
  const jobName = firedJobName(args.cronJobName, args.at);
  if (!cronMatchesMinute(args.cron, args.at)) {
    return { fired: false, duplicate: false, jobName, errorMessage: '' };
  }

  let cronJob: CronJobShape;
  try {
    cronJob = (await clients.batch.readNamespacedCronJob({
      name: args.cronJobName,
      namespace: args.namespace,
    })) as CronJobShape;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, cronjob: args.cronJobName }, 'cadence-firing: CronJob read failed');
    return { fired: false, duplicate: false, jobName, errorMessage: msg };
  }

  const template = cronJob.spec?.jobTemplate;
  if (!template?.spec) {
    const msg = `CronJob ${args.cronJobName} has no jobTemplate.spec`;
    log.error({ cronjob: args.cronJobName }, 'cadence-firing: nothing to fire');
    return { fired: false, duplicate: false, jobName, errorMessage: msg };
  }

  const body = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: args.namespace,
      labels: {
        ...(template.metadata?.labels ?? {}),
        // Marks who created it, so these are distinguishable from Jobs the
        // CronJob controller made while the schedule was still native.
        'insula.host/fired-by': 'platform-cadence',
      },
      annotations: {
        ...(template.metadata?.annotations ?? {}),
        'insula.host/fired-for-minute': minuteStamp(args.at),
      },
    },
    spec: template.spec,
  };

  try {
    await clients.batch.createNamespacedJob({ namespace: args.namespace, body });
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code === 409) {
      // This minute is already fired. Expected whenever two ticks overlap.
      return { fired: false, duplicate: true, jobName, errorMessage: '' };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, job: jobName }, 'cadence-firing: Job create failed');
    return { fired: false, duplicate: false, jobName, errorMessage: msg };
  }

  log.info({ job: jobName, cron: args.cron }, 'cadence-firing: fired a Job on the operator schedule');
  return { fired: true, duplicate: false, jobName, errorMessage: '' };
}
