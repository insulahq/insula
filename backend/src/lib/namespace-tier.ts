/**
 * Is this namespace a tenant's, or the platform's?
 *
 * ONE definition, because there were FOUR. On 2026-08-31 an admin was paged
 * that `tenant "traefik"` had a container OOM-killed and was advised to "raise
 * the tenant's plan/memory limit". `traefik` is a platform namespace; no such
 * tenant exists. The alert path enumerated 9 SYSTEM namespaces out of the 27 on
 * production and treated *everything else* as a tenant, so eleven platform
 * namespaces were being reported as tenants: traefik, monitoring, crowdsec,
 * calico-system, tigera-operator, redis-system, system-upgrade, hosting,
 * plesk-migration, kube-public, kube-node-lease.
 *
 * Three other modules had independently grown their own list — 9, 18 and 13
 * entries, all different, all incomplete. `nodes/service.ts` had even written
 * the lesson down ("Anything missing here gets shown to the operator as a
 * tenant pod — which is wrong for cluster-infra namespaces") without the fix
 * reaching the others. An enumeration of "everything that is not a tenant"
 * drifts by construction: every namespace the platform gains has to be
 * remembered in N places, and forgetting is silent.
 *
 * So classify by the platform's own invariant instead. Every tenant namespace
 * is minted by `tenants/service.ts:generateNamespace()` as
 * `tenant-<slug>-<8hex>`, and the SYSTEM tenant is the fixed `tenant-system`
 * (`system-tenant/slug.ts`). Nothing else may take the prefix — the DB holds a
 * UNIQUE on `tenants.kubernetes_namespace`, and CI guard
 * `scripts/ci-namespace-classification-check.sh` keeps new hardcoded lists out.
 *
 * The default now fails CLOSED. An unclassified namespace raises a PLATFORM
 * alert (over-escalation: visible, annoying, fixable) rather than a tenant
 * alert naming a tenant that does not exist (under-escalation: silent, and it
 * buries real platform incidents in tenant noise — `monitoring` is where
 * vmsingle lives, the one workload that genuinely does OOM).
 *
 * NOT for choosing which namespaces to act ON. This answers "what tier does
 * this namespace belong to". A module that iterates a curated set — e.g.
 * `system-snapshots` picking the namespaces whose PVCs get snapshotted — is
 * making a selection, not a classification, and should keep its explicit list.
 */

/** Every tenant namespace starts with this. Enforced by generateNamespace(). */
export const TENANT_NAMESPACE_PREFIX = 'tenant-';

/** True when the namespace belongs to a tenant. */
export function isTenantNamespace(namespace: string | null | undefined): boolean {
  if (!namespace) return false;
  return namespace.startsWith(TENANT_NAMESPACE_PREFIX);
}

/**
 * True when the namespace is platform-owned.
 *
 * A null/absent namespace is node-scoped (a SystemOOM event carries no
 * namespace) and counts as platform, never as a tenant.
 */
export function isSystemNamespace(namespace: string | null | undefined): boolean {
  return !isTenantNamespace(namespace);
}
