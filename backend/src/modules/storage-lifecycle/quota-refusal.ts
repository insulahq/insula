/**
 * Is a ResourceQuota refusal the transient kind a restart can clear, or is
 * the quota simply full?
 *
 * Auto-heal used to treat every refusal as the transient kind: a pod that is
 * still terminating keeps its requests counted for its grace period, so its
 * replacement is refused until it is gone. A namespace restart clears that.
 * It does nothing for a quota that is FULL — it only reshuffles which
 * workload gets admitted first. Production: a tenant at 530m of a 530m CPU
 * request quota added a 25m pod; the heal scaled all eight workloads to zero
 * and back, the new pod was admitted first, and the tenant's established
 * site (30m) was left out. Three restarts later it was still out.
 *
 * So the refusal is judged against the live quota: subtract what terminating
 * pods still hold, add what the refused workloads need, and see whether it
 * fits under `hard`. Only a fit is worth a restart.
 */
import { parseK8sQuantity } from '../../shared/k8s-quantity.js';

/** One "exceeded quota" message, as the API server words it. */
export interface QuotaRefusal {
  /** The refused pod, when the message names it (`pods "x" is forbidden`). */
  readonly pod: string | null;
  readonly quota: string;
  /** resource → quantity string, exactly as in the message. */
  readonly requested: Readonly<Record<string, string>>;
  readonly used: Readonly<Record<string, string>>;
  readonly limited: Readonly<Record<string, string>>;
}

// `exceeded quota: <name>, requested: a=1,b=2, used: a=3,b=4, limited: a=5,b=6`
// — lists are comma-joined without spaces, the four parts with ", ".
const REFUSAL_RE = /(?:pods "([^"]+)" is forbidden: )?exceeded quota: ([^,\s]+), requested: (\S+), used: (\S+), limited: ([^\s|"',]+(?:,[^\s|"',]+)*)/g;

function parseList(list: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of list.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

/** Every quota refusal in a block of pod/ReplicaSet messages, oldest wording first. */
export function parseQuotaRefusals(text: string | null | undefined): QuotaRefusal[] {
  if (!text) return [];
  const out: QuotaRefusal[] = [];
  for (const m of text.matchAll(REFUSAL_RE)) {
    out.push({ pod: m[1] ?? null, quota: m[2], requested: parseList(m[3]), used: parseList(m[4]), limited: parseList(m[5]) });
  }
  return out;
}

/**
 * The refusal that belongs to one Deployment. The evidence block is the whole
 * namespace's, so a workload's episode also carries its neighbours' refusals;
 * the pod name (`<deployment>-<rs-hash>-<suffix>`) says whose each one is.
 */
export function refusalForWorkload(detail: string | null | undefined, workload: string): QuotaRefusal | null {
  const all = parseQuotaRefusals(detail);
  return all.find((r) => r.pod !== null && r.pod.startsWith(`${workload}-`))
    ?? all.find((r) => r.pod === null)
    ?? null;
}

/** A quota as the API server counts it right now. */
export interface LiveQuota {
  readonly hard: Readonly<Record<string, string>>;
  readonly used: Readonly<Record<string, string>>;
  /** PriorityClass names the quota is scoped to; null = every pod counts. */
  readonly priorityClasses: readonly string[] | null;
}

/** A pod that is already terminating, and what it still holds. */
export interface TerminatingPod {
  readonly priorityClassName: string | null;
  /** resource (quota key: `requests.cpu`, `limits.memory`, …) → quantity. */
  readonly holds: Readonly<Record<string, string>>;
}

export interface QuotaShortfall {
  readonly quota: string;
  readonly resource: string;
  readonly used: string;
  readonly hard: string;
  readonly needed: string;
}

export type QuotaVerdict =
  | { readonly kind: 'fits' }
  | { readonly kind: 'full'; readonly shortfall: readonly QuotaShortfall[] }
  /** The quota could not be read or the refusal parsed — nothing to judge by. */
  | { readonly kind: 'unknown' };

const num = (q: string | undefined): number | null => (q === undefined ? null : parseK8sQuantity(q));

/**
 * Would the refused workloads fit once the terminating pods are gone? Pure.
 *
 * `refusals` holds ONE refusal per refused workload (its latest): each
 * workload needs its own room, so their requests add up. Unknown is not a
 * fit — a restart is disruptive, and "could not tell" is not a reason for one.
 */
export function quotaRefusalVerdict(
  refusals: readonly QuotaRefusal[],
  quotas: ReadonlyMap<string, LiveQuota>,
  terminating: readonly TerminatingPod[],
): QuotaVerdict {
  if (refusals.length === 0) return { kind: 'unknown' };
  const shortfall: QuotaShortfall[] = [];
  const byQuota = new Map<string, QuotaRefusal[]>();
  for (const r of refusals) byQuota.set(r.quota, [...(byQuota.get(r.quota) ?? []), r]);

  for (const [name, rs] of byQuota) {
    const live = quotas.get(name);
    if (!live) return { kind: 'unknown' };
    const resources = new Set(rs.flatMap((r) => Object.keys(r.requested)));
    for (const resource of resources) {
      const hard = num(live.hard[resource]);
      // The quota no longer limits this resource: nothing to be refused by.
      if (hard === null && live.hard[resource] === undefined) continue;
      const used = num(live.used[resource] ?? '0');
      if (hard === null || used === null) return { kind: 'unknown' };
      let needed = 0;
      for (const r of rs) {
        // The message lists only the resources that ran out: a refusal that
        // does not name this one asked nothing of it.
        if (r.requested[resource] === undefined) continue;
        const n = num(r.requested[resource]);
        if (n === null) return { kind: 'unknown' };
        needed += n;
      }
      let held = 0;
      for (const p of terminating) {
        if (live.priorityClasses && !live.priorityClasses.includes(p.priorityClassName ?? '')) continue;
        held += num(p.holds[resource]) ?? 0;
      }
      // Float noise on milli-units: compare with a tolerance far below 1m.
      if (used - held + needed > hard + 1e-9) {
        shortfall.push({
          quota: name,
          resource,
          used: live.used[resource] ?? '0',
          hard: live.hard[resource]!,
          needed: rs.map((r) => r.requested[resource]).filter(Boolean).join(' + '),
        });
      }
    }
  }
  return shortfall.length > 0 ? { kind: 'full', shortfall } : { kind: 'fits' };
}

/**
 * The operator's sentence for a refusal, from the message's own figures —
 * which resource, how much is in use, what was asked for. "Raise the plan
 * limits or free memory" was the advice for a CPU refusal on production.
 */
export function describeQuotaRefusal(detail: string | null | undefined, workload?: string): string | null {
  const latest = workload ? refusalForWorkload(detail, workload) : parseQuotaRefusals(detail)[0];
  if (!latest) return null;
  const parts = Object.keys(latest.requested).map((res) =>
    `${res}: ${latest.used[res] ?? '?'} of ${latest.limited[res] ?? '?'} in use, ${latest.requested[res]} more needed`);
  return parts.length > 0 ? parts.join('; ') : null;
}
