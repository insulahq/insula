/**
 * Names the platform reserves for its OWN workloads inside a tenant namespace.
 *
 * A tenant namespace is not only the tenant's: the platform runs Jobs there
 * too, and the bandwidth meter tells them apart by Job name in order to keep
 * platform-scheduled backup egress out of the tenant's bill
 * (`backend/src/modules/bandwidth/backup-exclusion.ts`).
 *
 * That makes a tenant-chosen workload name a billing-integrity boundary. A
 * one-shot Job's pod is `<job-name>-<5 chars>`, and a single-component catalog
 * entry of type `job` takes the tenant's deployment name VERBATIM as its Job
 * name — so without this list a tenant could install such an entry under the
 * name of one of their own past platform backups and have that pod's egress
 * excluded from their meter. Reserving the prefix removes the possibility at
 * the point the name is chosen, rather than relying on the meter to
 * out-argue it later.
 *
 * Mirrors the reserved-platform-hostname rule (ADR-040): the platform owns a
 * slice of the namespace, and says so at the boundary.
 */

/** Prefixes no tenant-chosen workload name may start with. */
export const RESERVED_WORKLOAD_NAME_PREFIXES = ['bk-files-', 'bk-mbox-'] as const;

export const RESERVED_WORKLOAD_NAME_MESSAGE =
  'Name may not start with a prefix reserved for platform workloads (bk-files-, bk-mbox-)';

/** True when `name` would collide with a platform workload name. */
export function isReservedWorkloadName(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED_WORKLOAD_NAME_PREFIXES.some((p) => lower.startsWith(p));
}
