/**
 * How "workloads down" episodes become notifications. Pure — the reconcile
 * loop in workload-health.ts gathers the rows and dispatches what this returns.
 *
 *   - ONE notification per tenant, its workloads as a list. On production
 *     a tenant with three workloads sent the operator three
 *     pushes and three emails for one outage (operator rule: several items
 *     are a list, on every channel).
 *   - ONE notification per NODE when the cause is that the tenants' pinned
 *     node is down. That failure is shared: one alert per tenant would be the
 *     fan-out a single dead server must not produce (26 tenants were pinned to
 *     one production node that day).
 *   - The same grouping for the "back up" notice, so a recovery is reported
 *     in the shape the outage was.
 */
import { createHash } from 'node:crypto';
import type { HealReason } from './workload-health.js';

/** An episode that reached the alert stage this tick. */
export interface AlertRow {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly namespace: string;
  readonly workload: string;
  readonly reason: HealReason;
  readonly detail: string | null;
  readonly downMinutes: number;
  /** ISO time the episode started. */
  readonly firstSeenAt: string;
  readonly attempts: number;
  readonly lastHealError: string | null;
  /** The tenant's node pin, if any. */
  readonly pin: string | null;
}

export interface AlertGroup {
  /** `tenant:<id>` or `node:<name>` — part of the dedupe key. */
  readonly key: string;
  /** Who the notification is about: a tenant name, or "Tenants pinned to <node>". */
  readonly subject: string;
  readonly namespace: string;
  /** One line per workload (tenant group) or per tenant (node group). */
  readonly workloads: string[];
  readonly reason: HealReason;
  readonly detail: string | null;
  readonly downMinutes: number;
  /** ISO start of the earliest episode in the group. */
  readonly downSince: string;
  readonly attempts: number;
  readonly lastHealError: string | null;
  readonly tenantIds: string[];
}

export function alertGroupKey(r: { readonly reason: HealReason; readonly pin: string | null; readonly tenantId: string }): string {
  return r.reason === 'node_down' && r.pin ? `node:${r.pin}` : `tenant:${r.tenantId}`;
}

const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

/**
 * Group the rows. `label` turns a reason into plain language; it is used for
 * a per-workload suffix only when a tenant's workloads are down for different
 * reasons (a recovery notice passes none). Groups come back in the order
 * their first row arrived.
 */
export function groupAlerts(
  rows: readonly AlertRow[],
  label?: (reason: HealReason) => string,
): AlertGroup[] {
  const byKey = new Map<string, AlertRow[]>();
  for (const r of rows) {
    const k = alertGroupKey(r);
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  return [...byKey.entries()].map(([key, rs]) => {
    const first = rs[0];
    const isNode = key.startsWith('node:');
    let workloads: string[];
    if (isNode) {
      const tenants = uniq(rs.map((r) => r.tenantId));
      workloads = tenants.map((id) => {
        const of = rs.filter((r) => r.tenantId === id);
        return `${of[0].tenantName}: ${of.map((r) => r.workload).join(', ')}`;
      });
    } else {
      const mixed = label !== undefined && uniq(rs.map((r) => r.reason)).length > 1;
      workloads = rs.map((r) => (mixed && label ? `${r.workload} (${label(r.reason)})` : r.workload));
    }
    return {
      key,
      subject: isNode ? `Tenants pinned to ${first.pin}` : first.tenantName,
      namespace: isNode ? (first.pin ?? '') : first.namespace,
      workloads,
      reason: first.reason,
      detail: rs.find((r) => r.detail)?.detail ?? null,
      downMinutes: Math.max(...rs.map((r) => r.downMinutes)),
      downSince: rs.map((r) => r.firstSeenAt).sort()[0],
      attempts: Math.max(...rs.map((r) => r.attempts)),
      lastHealError: rs.find((r) => r.lastHealError)?.lastHealError ?? null,
      tenantIds: uniq(rs.map((r) => r.tenantId)),
    };
  });
}

/**
 * The dedupe suffix for one alert: WHICH episodes it announces, at which
 * ladder round. Not the group's earliest start — a workload that reaches the
 * alert stage later in the same outage (or a second tenant joining a node
 * group) would reuse that key and its alert would be swallowed as a duplicate.
 * Same set, same round → same key, so a retried dispatch still deduplicates.
 */
export function claimedEpisodesKey(
  claimed: ReadonlyArray<{ readonly row: Pick<AlertRow, 'tenantId' | 'workload' | 'firstSeenAt'>; readonly notifyCount: number }>,
): string {
  const ids = claimed.map((c) => `${c.row.tenantId}/${c.row.workload}@${c.row.firstSeenAt}#${c.notifyCount}`).sort();
  return createHash('sha256').update(ids.join('|')).digest('hex').slice(0, 16);
}

/** One line for the alert: whether auto-heal ran, and that it did not fix it. */
export function healSummary(attempts: number): string {
  return attempts > 0
    ? `Auto-heal tried ${attempts}x and could not bring it back.`
    : 'Auto-heal was not attempted: restarting the workloads cannot fix this cause.';
}

/** The tenant's own copy: one per tenant, its workloads as a list. */
export function workloadsByTenant(rows: readonly AlertRow[]): Array<{ tenantId: string; workloads: string[]; downSince: string; reason: HealReason }> {
  const tenants = uniq(rows.map((r) => r.tenantId));
  return tenants.map((id) => {
    const of = rows.filter((r) => r.tenantId === id);
    return {
      tenantId: id,
      workloads: of.map((r) => r.workload),
      downSince: of.map((r) => r.firstSeenAt).sort()[0],
      reason: of[0].reason,
    };
  });
}
