/**
 * Platform-migration 0001 — record the install-time cluster baseline.
 *
 * The first dogfood of the W9 registry. Records what the platform was first
 * installed onto (platform / k3s / Calico / Longhorn versions) into
 * `platform_baselines`, so later upgrade tooling can reason about how far a
 * cluster has moved from its origin.
 *
 * Discipline: idempotent (upsert keyed by `key`), self-contained (depends on no
 * prior migration), order-stable (id is its contract). Cluster reads are
 * best-effort — a missing k8s client or an unreadable source just skips that
 * key (a later boot with the source available fills it in); the migration NEVER
 * throws, so a partial cluster can't brick boot.
 */
import { sql } from 'drizzle-orm';
import { platformBaselines } from '../../../db/schema.js';
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import type { PlatformMigration, PlatformMigrationContext } from '../registry/types.js';

interface BaselineEntry {
  readonly key: string;
  readonly value: string;
  readonly source: string;
}

/** Parse the version tag off a container image ref (`repo:tag` / `repo@sha`). */
function imageTag(image: string | undefined): string | null {
  if (!image) return null;
  const at = image.split('@')[0]; // drop any digest
  const slash = at.lastIndexOf('/');
  const colon = at.indexOf(':', slash + 1); // colon AFTER the last '/' (not the registry port)
  return colon === -1 ? null : at.slice(colon + 1) || null;
}

/** First container image tag of a DaemonSet, or null (best-effort). */
async function dsImageTag(k8s: K8sClients, namespace: string, name: string): Promise<string | null> {
  try {
    const ds = await k8s.apps.readNamespacedDaemonSet({ namespace, name });
    return imageTag(ds.spec?.template?.spec?.containers?.[0]?.image);
  } catch {
    return null;
  }
}

/** Collect the baselines that can be read in this environment. */
async function collectBaselines(ctx: PlatformMigrationContext): Promise<BaselineEntry[]> {
  const out: BaselineEntry[] = [];
  if (ctx.config.PLATFORM_VERSION) {
    out.push({ key: 'platform', value: ctx.config.PLATFORM_VERSION, source: 'config' });
  }
  const k8s = ctx.k8s;
  if (!k8s) return out;

  // k3s — kubeletVersion off any node (e.g. v1.33.10+k3s1).
  try {
    const nodes = await k8s.core.listNode();
    const v = nodes.items?.[0]?.status?.nodeInfo?.kubeletVersion;
    if (v) out.push({ key: 'k3s', value: v, source: 'k8s-node' });
  } catch (err) {
    ctx.log.warn('[0001_record_baseline] could not read k3s version', err);
  }

  // Calico — calico-node DS image tag (operator install: calico-system; classic: kube-system).
  const calico = (await dsImageTag(k8s, 'calico-system', 'calico-node'))
    ?? (await dsImageTag(k8s, 'kube-system', 'calico-node'));
  if (calico) out.push({ key: 'calico', value: calico, source: 'calico-node-ds' });

  // Longhorn — longhorn-manager DS image tag.
  const longhorn = await dsImageTag(k8s, 'longhorn-system', 'longhorn-manager');
  if (longhorn) out.push({ key: 'longhorn', value: longhorn, source: 'longhorn-manager-ds' });

  return out;
}

export const recordBaseline: PlatformMigration = {
  id: '0001_record_baseline',
  version: '2026.6.1',
  description: 'Record install-time cluster baseline (platform / k3s / Calico / Longhorn versions)',
  async up(ctx) {
    const baselines = await collectBaselines(ctx);
    if (ctx.dryRun) {
      ctx.log.info(`[0001_record_baseline] would record ${baselines.length} baseline(s): ${baselines.map((b) => `${b.key}=${b.value}`).join(', ') || '(none)'}`);
      return;
    }
    for (const b of baselines) {
      await ctx.db
        .insert(platformBaselines)
        .values({ key: b.key, value: b.value, source: b.source })
        .onConflictDoUpdate({
          target: platformBaselines.key,
          set: { value: b.value, source: b.source, updatedAt: sql`now()` },
        });
    }
    ctx.log.info(`[0001_record_baseline] recorded ${baselines.length} baseline(s): ${baselines.map((b) => b.key).join(', ') || '(none)'}`);
  },
};
