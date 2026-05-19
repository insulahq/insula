/**
 * Secrets coverage audit (DR-bundle bundle-everything redesign).
 *
 * Lists every Secret in the cluster and classifies each into one of
 * five buckets:
 *
 *   - denied         → not in bundle at all (auto-managed by
 *                      controllers — SA tokens, helm release state,
 *                      cert-manager TLS, sealed-secrets, CNPG creds).
 *                      Predicate is shared with the exporter +
 *                      bootstrap.sh + CronJob via `secrets-denylist.ts`.
 *   - skip-at-restore → in bundle, but operator-marked in the
 *                      `secrets-audit-allowlist` ConfigMap with a
 *                      documented reason. Restore profiles refuse
 *                      to apply these by default.
 *   - tier-1-platform → in bundle, applied by the `conservative`
 *                      restore profile. Namespace-based assignment.
 *   - tier-2-tenant   → in bundle, applied by the `full` restore
 *                      profile. `client-*` namespace pattern.
 *   - unclassified    → in bundle, applied by the `full` restore
 *                      profile. Everything else.
 *
 * Under bundle-everything semantics there's no "uncovered" bucket —
 * every non-denied Secret ends up in the bundle by default. The
 * audit UI shows the breakdown for visibility but no longer flashes
 * red. Operators who want to exclude specific Secrets from the
 * apply step (e.g. session cookies) mark them as "skip at restore"
 * via the allowlist.
 *
 * Result is computed on-demand (no DB persistence) with a short
 * cache; operator-triggered "refresh" busts it.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  type AllowlistEntry,
  type AuditedSecret,
  type SecretCoverageCategory,
  type SecretsAuditResult,
} from '@k8s-hosting/api-contracts';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { isAutoManaged } from './secrets-denylist.js';
import { restoreTierForNamespace } from './secrets-tiers.js';

/** Where the operator-curated allowlist lives. */
export const ALLOWLIST_NAMESPACE = 'platform-system';
export const ALLOWLIST_CONFIGMAP_NAME = 'secrets-audit-allowlist';
/** Key inside the ConfigMap whose value is a YAML list of entries. */
const ALLOWLIST_DATA_KEY = 'allowlist.yaml';

/** Cache TTL — short, since the operator typically clicks Refresh
 *  while watching the page after fixing coverage gaps. */
const CACHE_TTL_MS = 30_000;

interface SecretListItem {
  readonly metadata?: {
    readonly namespace?: string;
    readonly name?: string;
    readonly creationTimestamp?: Date | string;
    readonly ownerReferences?: ReadonlyArray<{
      readonly apiVersion?: string;
      readonly kind?: string;
      readonly name?: string;
    }>;
  };
  readonly type?: string;
}

interface SecretList {
  readonly items?: ReadonlyArray<SecretListItem>;
}

let cached: { result: SecretsAuditResult; computedAt: number } | null = null;

/** Bust the cache. Called by the refresh endpoint. */
export function invalidateAuditCache(): void {
  cached = null;
}

/** Top-level: list secrets cluster-wide, read allowlist, classify, return. */
export async function runSecretsAudit(
  k8s: K8sClients,
  opts: { now?: () => Date; useCache?: boolean } = {},
): Promise<SecretsAuditResult> {
  const now = opts.now ?? (() => new Date());
  if (opts.useCache !== false && cached && now().getTime() - cached.computedAt < CACHE_TTL_MS) {
    return cached.result;
  }

  const [secretList, allowlist] = await Promise.all([
    listAllSecrets(k8s),
    readAllowlist(k8s),
  ]);

  const allowlistKey = (ns: string, name: string): string => `${ns}/${name}`;
  const allowlistMap = new Map<string, AllowlistEntry>();
  for (const entry of allowlist) {
    allowlistMap.set(allowlistKey(entry.namespace, entry.name), entry);
  }

  const audited: AuditedSecret[] = [];
  for (const item of secretList) {
    const ns = item.metadata?.namespace ?? '';
    const name = item.metadata?.name ?? '';
    if (!ns || !name) continue;
    const type = item.type ?? 'Opaque';
    const createdAtRaw = item.metadata?.creationTimestamp;
    const createdAt = toIso(createdAtRaw);
    const ageSeconds = createdAt
      ? Math.max(0, Math.floor((now().getTime() - new Date(createdAt).getTime()) / 1000))
      : 0;
    const owner = item.metadata?.ownerReferences?.[0];
    const ownerKind = owner?.kind ?? null;
    const ownerName = owner?.name ?? null;

    const { category, reason } = classify({
      namespace: ns,
      name,
      type,
      owner: owner ?? null,
      allowlistMap,
    });

    audited.push({
      namespace: ns,
      name,
      type,
      createdAt: createdAt ?? new Date(0).toISOString(),
      ageSeconds,
      ownerKind,
      ownerName,
      category,
      reason,
    });
  }

  const byCategory = {
    denied: 0,
    tier1Platform: 0,
    tier2Tenant: 0,
    unclassified: 0,
    skipAtRestore: 0,
  };
  for (const a of audited) {
    switch (a.category) {
      case 'denied': byCategory.denied++; break;
      case 'tier-1-platform': byCategory.tier1Platform++; break;
      case 'tier-2-tenant': byCategory.tier2Tenant++; break;
      case 'unclassified': byCategory.unclassified++; break;
      case 'skip-at-restore': byCategory.skipAtRestore++; break;
    }
  }

  const result: SecretsAuditResult = {
    generatedAt: now().toISOString(),
    totalSecretsCount: audited.length,
    byCategory,
    /** Under bundle-everything every non-denied Secret is bundled, so
     *  there's nothing to flash red about. Field kept in the contract
     *  for future use (e.g. flag "tier-1 namespace has zero secrets"
     *  as a soft warning). */
    healthy: true,
    skipAtRestoreSecrets: audited.filter((a) => a.category === 'skip-at-restore'),
    /** All Secrets, ordered by category then namespace/name. The UI
     *  filters client-side rather than re-querying for each bucket. */
    allSecrets: audited.sort((a, b) => {
      if (a.category !== b.category) return a.category.localeCompare(b.category);
      if (a.namespace !== b.namespace) return a.namespace.localeCompare(b.namespace);
      return a.name.localeCompare(b.name);
    }),
  };
  cached = { result, computedAt: now().getTime() };
  return result;
}

interface ClassifyInput {
  readonly namespace: string;
  readonly name: string;
  readonly type: string;
  readonly owner: { kind?: string; apiVersion?: string } | null;
  readonly allowlistMap: ReadonlyMap<string, AllowlistEntry>;
}

/** Pure classifier — no IO. Exported for unit-testing.
 *
 *  Priority order (first match wins):
 *    1. DENIED      → controller-managed, never bundled.
 *    2. SKIP-AT-RESTORE → operator-marked in allowlist; in bundle but
 *                         skipped by every restore profile by default.
 *    3. TIER-1 / TIER-2 / UNCLASSIFIED → namespace-based assignment. */
export function classify(input: ClassifyInput): { category: SecretCoverageCategory; reason: string } {
  const { namespace, name, type, owner, allowlistMap } = input;

  const den = isAutoManaged({ name, type, owner });
  if (den.denied) return { category: 'denied', reason: den.reason };

  if (allowlistMap.has(`${namespace}/${name}`)) {
    const entry = allowlistMap.get(`${namespace}/${name}`)!;
    return { category: 'skip-at-restore', reason: entry.reason };
  }

  const tier = restoreTierForNamespace(namespace);
  if (tier === 'tier-1-platform') {
    return { category: 'tier-1-platform', reason: 'platform namespace (conservative profile applies)' };
  }
  if (tier === 'tier-2-tenant') {
    return { category: 'tier-2-tenant', reason: 'tenant namespace (full profile applies)' };
  }
  return { category: 'unclassified', reason: 'non-platform/non-tenant namespace (full profile applies)' };
}

// ─── K8s IO ────────────────────────────────────────────────────────────

async function listAllSecrets(k8s: K8sClients): Promise<SecretListItem[]> {
  const core = k8s.core as unknown as {
    listSecretForAllNamespaces: () => Promise<SecretList>;
  };
  const list = await core.listSecretForAllNamespaces();
  return [...(list.items ?? [])];
}

/** Read the allowlist ConfigMap. Returns [] if the CM doesn't exist
 *  yet (fresh cluster). Defensive about malformed YAML — logs + skips. */
export async function readAllowlist(k8s: K8sClients): Promise<AllowlistEntry[]> {
  const core = k8s.core as unknown as {
    readNamespacedConfigMap: (a: { namespace: string; name: string }) => Promise<{ data?: Record<string, string> }>;
  };
  let cm: { data?: Record<string, string> };
  try {
    cm = await core.readNamespacedConfigMap({
      namespace: ALLOWLIST_NAMESPACE,
      name: ALLOWLIST_CONFIGMAP_NAME,
    });
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    if (code === 404) return [];
    throw err;
  }
  const raw = cm.data?.[ALLOWLIST_DATA_KEY];
  if (!raw) return [];
  try {
    const parsed = parseYaml(raw) as { entries?: ReadonlyArray<unknown> } | null;
    if (!parsed || !Array.isArray(parsed.entries)) return [];
    const out: AllowlistEntry[] = [];
    for (const e of parsed.entries) {
      const entry = e as Partial<AllowlistEntry>;
      if (
        typeof entry.namespace === 'string' &&
        typeof entry.name === 'string' &&
        typeof entry.reason === 'string' &&
        typeof entry.addedBy === 'string' &&
        typeof entry.addedAt === 'string'
      ) {
        out.push({
          namespace: entry.namespace,
          name: entry.name,
          reason: entry.reason,
          addedBy: entry.addedBy,
          addedAt: entry.addedAt,
        });
      }
    }
    return out;
  } catch (err) {
    console.warn('[secrets-audit] allowlist YAML parse failed; treating as empty', {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export interface UpsertAllowlistInput {
  readonly namespace: string;
  readonly name: string;
  readonly reason: string;
  readonly addedBy: string;
  readonly now?: () => Date;
}

/** Add OR update an allowlist entry. Idempotent. */
export async function upsertAllowlistEntry(
  k8s: K8sClients,
  input: UpsertAllowlistInput,
): Promise<AllowlistEntry[]> {
  const now = input.now ?? (() => new Date());
  const current = await readAllowlist(k8s);
  const idx = current.findIndex(
    (e) => e.namespace === input.namespace && e.name === input.name,
  );
  const next: AllowlistEntry = {
    namespace: input.namespace,
    name: input.name,
    reason: input.reason,
    addedBy: input.addedBy,
    addedAt: idx >= 0 ? current[idx].addedAt : now().toISOString(),
  };
  const updated = idx >= 0
    ? [...current.slice(0, idx), next, ...current.slice(idx + 1)]
    : [...current, next];
  await writeAllowlist(k8s, updated);
  invalidateAuditCache();
  return updated;
}

/** Remove an allowlist entry by (namespace, name). No-op if absent. */
export async function removeAllowlistEntry(
  k8s: K8sClients,
  namespace: string,
  name: string,
): Promise<AllowlistEntry[]> {
  const current = await readAllowlist(k8s);
  const updated = current.filter((e) => !(e.namespace === namespace && e.name === name));
  if (updated.length === current.length) return current;
  await writeAllowlist(k8s, updated);
  invalidateAuditCache();
  return updated;
}

async function writeAllowlist(k8s: K8sClients, entries: AllowlistEntry[]): Promise<void> {
  const yamlBody = stringifyYaml({ entries });
  const core = k8s.core as unknown as {
    readNamespacedConfigMap: (a: { namespace: string; name: string }) => Promise<unknown>;
    createNamespacedConfigMap: (a: {
      namespace: string;
      body: { metadata: { name: string; namespace: string }; data: Record<string, string> };
    }) => Promise<unknown>;
    patchNamespacedConfigMap: (
      a: { namespace: string; name: string; body: { data: Record<string, string> } },
      ...rest: unknown[]
    ) => Promise<unknown>;
  };
  try {
    await core.readNamespacedConfigMap({
      namespace: ALLOWLIST_NAMESPACE,
      name: ALLOWLIST_CONFIGMAP_NAME,
    });
    await core.patchNamespacedConfigMap(
      {
        namespace: ALLOWLIST_NAMESPACE,
        name: ALLOWLIST_CONFIGMAP_NAME,
        body: { data: { [ALLOWLIST_DATA_KEY]: yamlBody } },
      },
      MERGE_PATCH,
    );
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    if (code !== 404) throw err;
    try {
      await core.createNamespacedConfigMap({
        namespace: ALLOWLIST_NAMESPACE,
        body: {
          metadata: { name: ALLOWLIST_CONFIGMAP_NAME, namespace: ALLOWLIST_NAMESPACE },
          data: { [ALLOWLIST_DATA_KEY]: yamlBody },
        },
      });
    } catch (createErr) {
      const createCode = (createErr as { code?: number; statusCode?: number }).code
        ?? (createErr as { statusCode?: number }).statusCode;
      if (createCode !== 409) throw createErr;
      await core.patchNamespacedConfigMap(
        {
          namespace: ALLOWLIST_NAMESPACE,
          name: ALLOWLIST_CONFIGMAP_NAME,
          body: { data: { [ALLOWLIST_DATA_KEY]: yamlBody } },
        },
        MERGE_PATCH,
      );
    }
  }
}

function toIso(d: Date | string | undefined): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  return new Date(d).toISOString();
}
