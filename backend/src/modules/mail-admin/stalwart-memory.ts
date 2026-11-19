/**
 * Mail-server memory — Stalwart's process memory against its container limit,
 * for the card on Email → Settings.
 *
 * Production Stalwart grows its heap over days until the kernel OOM-kills it
 * at the container limit (ADR-046). The card shows how close it runs now and
 * the shape of the last week, which is what tells slow growth from a spike.
 *
 * "Process memory" is the container's anonymous memory (cadvisor
 * `container_memory_rss`). The working set would mislead here: RocksDB's page
 * cache is charged to the same cgroup and holds the working set near the limit
 * even when the heap is small. The series are kept for the Stalwart container
 * only (k8s/base/monitoring/read-driven-relabel.yaml).
 *
 * The threshold drawn on the graph is the `stalwart-memory-near-limit` rule's
 * effective one, so the card and the alert never disagree about "too high".
 */

import { eq } from 'drizzle-orm';
import type * as k8s from '@kubernetes/client-node';
import {
  MAIL_SERVER_MEMORY_WINDOW_HOURS,
  type MailServerMemoryPoint,
  type MailServerMemoryResponse,
} from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import { classifyOom } from '../../lib/container-termination.js';
import { monitoringRuleOverrides } from '../../db/schema.js';
import { ruleById, STALWART_MEMORY_RULE_ID } from '../monitoring/rules.js';
import { queryInstant, queryRange, type VmClientOptions, type VmRangeSeries } from '../monitoring/vm-client.js';

const STEP_SECONDS = 3600;
const STALWART_SELECTOR = '{namespace="mail",container="stalwart"}';
// `last_over_time(…[2m])` rather than a bare selector: a killed container's
// series would otherwise answer for the default 5-minute lookback, and right
// after an OOM kill the card would show the dead process at its limit while
// the new one runs at a fraction of it. Two minutes is two scrapes.
const CURRENT_EXPR = `max(last_over_time(container_memory_rss${STALWART_SELECTOR}[2m]))`;
const LIMIT_EXPR = `max(last_over_time(container_spec_memory_limit_bytes${STALWART_SELECTOR}[2m]) > 0)`;
// The hour's highest value, not a point sample: a spike between two samples
// is exactly what the graph exists to show.
const HISTORY_EXPR = `max(max_over_time(container_memory_rss${STALWART_SELECTOR}[1h]))`;

const MAIL_NAMESPACE = 'mail';
const STALWART_POD_SELECTOR = 'app=stalwart-mail';
const STALWART_CONTAINER = 'stalwart';

export const NO_SAMPLES_REASON =
  'No memory samples for the mail server yet. The metrics store starts keeping them after its next daily restart, and only while Stalwart runs.';

export interface MailServerMemoryInput {
  readonly nowEpoch: number;
  readonly currentBytes: number | null;
  readonly limitBytes: number | null;
  readonly history: ReadonlyArray<VmRangeSeries>;
  readonly alertRatio: number | null;
  readonly lastOomKill: MailServerMemoryResponse['lastOomKill'];
}

export interface HistoryGrid {
  /** End of the first bucket, epoch seconds. */
  readonly firstEnd: number;
  /** End of the last bucket: the end of the hour in progress. */
  readonly lastEnd: number;
  readonly count: number;
}

/**
 * Hourly buckets, each labelled by the end of its hour. The last one is the
 * hour in progress, so the newest samples always have a bucket to land in.
 */
export function historyGrid(
  nowEpoch: number,
  windowHours: number = MAIL_SERVER_MEMORY_WINDOW_HOURS,
  stepSeconds: number = STEP_SECONDS,
): HistoryGrid {
  const lastEnd = Math.ceil(nowEpoch / stepSeconds) * stepSeconds;
  const count = Math.floor((windowHours * 3600) / stepSeconds) + 1;
  return { firstEnd: lastEnd - (count - 1) * stepSeconds, lastEnd, count };
}

/**
 * Places each range sample in its hour, oldest first. A sample at T is the
 * maximum over (T - 1h, T], so it belongs to the bucket whose end is the
 * first grid point at or after T. That holds however the store aligns its
 * steps, including a last point at `now` itself. An hour with no sample stays
 * null instead of being drawn as zero.
 */
export function bucketHistory(
  history: ReadonlyArray<VmRangeSeries>,
  nowEpoch: number,
  windowHours: number = MAIL_SERVER_MEMORY_WINDOW_HOURS,
  stepSeconds: number = STEP_SECONDS,
): MailServerMemoryPoint[] {
  const grid = historyGrid(nowEpoch, windowHours, stepSeconds);
  const values: Array<number | null> = Array.from({ length: grid.count }, () => null);
  for (const series of history) {
    for (const [t, v] of series.points) {
      const i = Math.ceil((t - grid.firstEnd) / stepSeconds);
      if (i < 0 || i >= grid.count || !Number.isFinite(v)) continue;
      const prev = values[i];
      values[i] = prev === null ? v : Math.max(prev, v);
    }
  }
  return values.map((bytes, i) => ({ t: grid.firstEnd + i * stepSeconds, bytes }));
}

export function buildMailServerMemory(input: MailServerMemoryInput): MailServerMemoryResponse {
  const bucketed = bucketHistory(input.history, input.nowEpoch);
  // The current sample belongs to the hour in progress. Folding it in keeps
  // the graph's last point and the 7-day peak from reading below "now" while
  // the store has not yet answered for the newest minutes.
  const last = bucketed[bucketed.length - 1];
  const points = input.currentBytes === null || last === undefined
    ? bucketed
    : [...bucketed.slice(0, -1), { t: last.t, bytes: Math.max(last.bytes ?? 0, input.currentBytes) }];
  const measured = points.map((p) => p.bytes).filter((b): b is number => b !== null);
  const available = input.currentBytes !== null || measured.length > 0;
  return {
    available,
    reason: available ? null : NO_SAMPLES_REASON,
    currentBytes: input.currentBytes,
    limitBytes: input.limitBytes,
    peakBytes: measured.length > 0 ? Math.max(...measured) : null,
    alertRatio: input.alertRatio,
    windowHours: MAIL_SERVER_MEMORY_WINDOW_HOURS,
    stepSeconds: STEP_SECONDS,
    points,
    lastOomKill: input.lastOomKill,
  };
}

interface PodStatusShape {
  readonly status?: {
    readonly containerStatuses?: ReadonlyArray<{
      readonly name?: string;
      readonly lastState?: {
        readonly terminated?: { readonly reason?: string; readonly exitCode?: number; readonly finishedAt?: Date | string };
      };
    }>;
  };
}

/**
 * The latest memory kill the kubelet recorded for a Stalwart container. The
 * kubelet keeps only the previous termination of each container, so this
 * sees a kill until the container restarts again for another reason.
 */
export function lastOomKill(pods: ReadonlyArray<PodStatusShape>): MailServerMemoryResponse['lastOomKill'] {
  let latest: { at: number; inferred: boolean } | null = null;
  for (const pod of pods) {
    for (const cs of pod.status?.containerStatuses ?? []) {
      const term = cs.lastState?.terminated;
      const kind = classifyOom(term);
      if (cs.name !== STALWART_CONTAINER || kind === null || !term?.finishedAt) continue;
      const at = new Date(term.finishedAt).getTime();
      if (Number.isFinite(at) && (latest === null || at > latest.at)) latest = { at, inferred: kind === 'inferred' };
    }
  }
  return latest === null ? null : { at: new Date(latest.at).toISOString(), inferred: latest.inferred };
}

async function effectiveAlertRatio(db: Database): Promise<number | null> {
  const rule = ruleById(STALWART_MEMORY_RULE_ID);
  if (!rule) return null;
  const [override] = await db
    .select()
    .from(monitoringRuleOverrides)
    .where(eq(monitoringRuleOverrides.ruleId, STALWART_MEMORY_RULE_ID));
  if (override && !override.enabled) return null;
  return override?.threshold ?? rule.threshold;
}

const firstValue = (samples: ReadonlyArray<{ value: number }>): number | null =>
  samples.length > 0 && Number.isFinite(samples[0].value) ? samples[0].value : null;

export interface MailServerMemoryDeps {
  readonly db: Database;
  readonly core: Pick<k8s.CoreV1Api, 'listNamespacedPod'>;
  readonly vm?: VmClientOptions;
  readonly now?: () => number;
  readonly logger?: { readonly warn: (obj: unknown, msg: string) => void };
}

/**
 * Reads the card's inputs. A failed metrics query throws: "could not read"
 * must not render as "no samples". The pod read is best-effort, because the
 * OOM marker is a footnote and the memory figures stand without it.
 */
export async function readMailServerMemory(deps: MailServerMemoryDeps): Promise<MailServerMemoryResponse> {
  const nowEpoch = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const grid = historyGrid(nowEpoch);
  const [current, limit, history, alertRatio, pods] = await Promise.all([
    queryInstant(CURRENT_EXPR, deps.vm),
    queryInstant(LIMIT_EXPR, deps.vm),
    queryRange(HISTORY_EXPR, grid.firstEnd, nowEpoch, STEP_SECONDS, deps.vm),
    effectiveAlertRatio(deps.db),
    deps.core
      .listNamespacedPod({ namespace: MAIL_NAMESPACE, labelSelector: STALWART_POD_SELECTOR })
      .then((list) => (list.items ?? []) as ReadonlyArray<PodStatusShape>)
      .catch((err: unknown) => {
        deps.logger?.warn({ err }, 'mail-server memory: Stalwart pod read failed; OOM marker omitted');
        return [] as ReadonlyArray<PodStatusShape>;
      }),
  ]);
  return buildMailServerMemory({
    nowEpoch,
    currentBytes: firstValue(current),
    limitBytes: firstValue(limit),
    history,
    alertRatio,
    lastOomKill: lastOomKill(pods),
  });
}
