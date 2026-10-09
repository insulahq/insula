// ─── Tenant node-disk limits (ROADMAP R37) ──────────────────────────────────

/**
 * Bounds for `system_settings.tenant_app_disk_limit_mb` and
 * `system_settings.tenant_database_disk_limit_mb`, edited on the admin Limits
 * page.
 *
 * Every tenant container is given an `ephemeral-storage` limit of this size:
 * its writable layer, its `/tmp` and its logs together. Past it, the kubelet
 * evicts the pod and the workload restarts on a clean filesystem — so one
 * tenant can no longer fill a node's disk for every other tenant on it.
 *
 * Database components get the larger value: MariaDB and PostgreSQL write sorts
 * and temporary tables that do not fit in memory to the container's own
 * filesystem.
 *
 * The minimum keeps a typo from evicting every workload on the platform: a
 * container's logs alone may use up to 50 MiB (kubelet rotation: 10 MiB × 5).
 */
export const DEFAULT_TENANT_APP_DISK_LIMIT_MB = 2048;
export const DEFAULT_TENANT_DATABASE_DISK_LIMIT_MB = 8192;
export const MIN_TENANT_DISK_LIMIT_MB = 256;
export const MAX_TENANT_DISK_LIMIT_MB = 65536;
