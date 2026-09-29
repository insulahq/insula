/**
 * Remove a stale `max` from tenant LimitRanges that already have one.
 *
 * WHY THIS EXISTS. The tier model briefly wrote `max.cpu` into every tenant
 * namespace's LimitRange. A LimitRange polices EVERY container in the
 * namespace, and a tenant namespace is not only the tenant's — the platform
 * runs its own Jobs there. The file-backup Job declares 1.5 cores, so a
 * 1-core `max` refused it at admission ("maximum cpu usage per Container is
 * 1, but limit is 1500m"), the Job retried until its 29-minute deadline, and
 * the bundle reported `partial` with the files silently missing.
 *
 * The builder stopped writing `max` two releases ago. That fixed namespaces
 * created AFTER the upgrade and nothing else: a builder only takes effect
 * when something applies it, and the only appliers are provisioning (new
 * namespaces) and the per-tenant Apply button. Twenty-four of thirty-one
 * namespaces on the reference cluster kept their `max` and kept failing
 * their file backups nightly, for days, while the release notes said the
 * problem was fixed. Shipping a corrected builder is not the same as
 * reconciling what is already on the cluster, and this is the part that was
 * missing.
 *
 * ── deliberately narrow ──────────────────────────────────────────────────
 * This removes `max` and touches NOTHING else. It does not re-apply a tier.
 * `default` is what bounds a tenant's own containers and is stamped at
 * admission, so rewriting it would replace every running pod in the
 * namespace — which is exactly why applying a tier is a deliberate operator
 * action and not a boot-time one. Stripping a field that only ever refused
 * the platform's own jobs changes no ceiling and restarts nothing.
 */

import type { Database } from '../../db/index.js';
import { tenants } from '../../db/schema.js';
import { isNotNull } from 'drizzle-orm';

const limitRangeName = (ns: string) => `${ns}-cpu`;

interface LimitRangeItem {
  readonly type?: string;
  max?: Record<string, string>;
}
interface LimitRangeObject {
  spec?: { limits?: LimitRangeItem[] };
}

export interface LimitRangeSweepDeps {
  readonly read: (namespace: string) => Promise<LimitRangeObject | null>;
  readonly replace: (namespace: string, body: LimitRangeObject) => Promise<void>;
  readonly log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface LimitRangeSweepResult {
  readonly scanned: number;
  readonly stripped: readonly string[];
  readonly failed: readonly string[];
}

/**
 * Drop `max.cpu` from one LimitRange object, in place.
 *
 * ★ MUTATES rather than rebuilds, and that is not a style choice. The
 * Kubernetes JS client renames reserved words: the ceiling round-trips as
 * `_default` on the model and `default` on the wire, so an object
 * reconstructed field-by-field from a read silently loses its ceiling and
 * every tenant in that namespace becomes unbounded. Deleting one key from
 * the object the client handed us keeps every other field — including the
 * renamed one — exactly as it was.
 *
 * Exported for tests: the ceiling surviving is the property worth pinning.
 */
export function dropMaxCpu(obj: LimitRangeObject): boolean {
  let changed = false;
  for (const item of obj.spec?.limits ?? []) {
    if (item.type !== 'Container' || item.max === undefined) continue;
    if (item.max.cpu === undefined) continue;
    delete item.max.cpu;
    // An empty `max` is not the same as no `max` to the API server's
    // validation, and it carries no meaning — drop the whole key.
    if (Object.keys(item.max).length === 0) delete item.max;
    changed = true;
  }
  return changed;
}

export async function sweepStaleLimitRangeMax(
  db: Database, deps: LimitRangeSweepDeps,
): Promise<LimitRangeSweepResult> {
  const rows = await db
    .select({ ns: tenants.kubernetesNamespace })
    .from(tenants)
    .where(isNotNull(tenants.kubernetesNamespace));

  const stripped: string[] = [];
  const failed: string[] = [];
  let scanned = 0;

  for (const { ns } of rows) {
    if (!ns) continue;
    scanned += 1;
    try {
      const obj = await deps.read(ns);
      // A namespace with no LimitRange is not a problem to solve here.
      if (!obj || !dropMaxCpu(obj)) continue;
      await deps.replace(ns, obj);
      stripped.push(ns);
    } catch {
      // One unreachable namespace must not stop the other thirty. The
      // caller logs the list; the next start tries again.
      failed.push(ns);
    }
  }
  return { scanned, stripped, failed };
}

export { limitRangeName };
