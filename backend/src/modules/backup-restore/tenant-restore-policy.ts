/**
 * Tenant-initiated restore policy.
 *
 * The admin restore cart (super_admin / admin) can restore anything
 * in a bundle. Tenants now get their own restore cart via the
 * tenant panel (Phase 1 of the tenant-bundles tenant-side work,
 * 2026-05-28), but the platform's invariants demand that some
 * fields and tables stay operator-only — billing, plan/quota,
 * platform config, infra. This module is the single source of
 * truth for what a tenant-cart can touch.
 *
 * Enforcement is BOTH at the browse layer (so the UI hides denied
 * tables/columns) AND the execute layer (so a forged item payload
 * is rejected). Tests in tenant-restore-policy.test.ts pin both.
 *
 * Policy is code-defined so PR review catches accidental widening.
 * If a future operator wants per-platform overrides, we can lift
 * the structure to a `platform_settings` row — for now, code is
 * simpler and auditable.
 */

import type { RestoreItemPayload, RestoreItemType } from '@k8s-hosting/api-contracts';

export interface TenantRestorePolicy {
  /** Item types tenants may submit to a cart. */
  readonly allowedItemTypes: ReadonlySet<RestoreItemType>;
  /** Tables tenants may NOT browse or restore at all. */
  readonly deniedTables: ReadonlySet<string>;
  /** Per-table column redactions applied to allowed tables. */
  readonly deniedColumnsByTable: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Default policy as of 2026-05-28. Order of additions matters less
 * than completeness: the gate is "tenant can restore EVERYTHING by
 * default, except entries listed here". When in doubt, deny — a
 * follow-up PR can widen.
 */
export const DEFAULT_TENANT_RESTORE_POLICY: TenantRestorePolicy = {
  allowedItemTypes: new Set<RestoreItemType>([
    'files-paths',
    'mailboxes-by-address',
    'deployments-by-id',
    'domains-by-id',
    'config-tables',
  ]),
  deniedTables: new Set<string>([
    // ── Billing / plan / quota ──────────────────────────
    'hosting_plans',
    'tenant_invoices',
    'tenant_payment_methods',
    'tenant_subscription_changes',
    // ── Platform-level config ───────────────────────────
    'platform_settings',
    'platform_settings_audit',
    'platform_admin_seed',
    // ── Backup infra (operator-owned) ───────────────────
    'backup_targets',
    'backup_target_assignments',
    'backup_configurations',
    'backup_schedules',
    'external_backup_repos',
    'tenant_backup_schedules',
    'tenant_backup_v2_settings',
    // ── Cluster / node / region (cluster-level) ─────────
    'cluster_nodes',
    'cluster_node_taints',
    'cluster_pending_peers',
    'platform_regions',
    'cluster_trusted_proxies',
    // ── Auth / users / sessions (platform-wide) ─────────
    'users',
    'auth_consumed_tokens',
    'webauthn_credentials',
    'audit_logs',
    // ── Operator runbook surfaces ───────────────────────
    'system_backup_runs',
    'system_db_restore_runs',
    'mail_migration_runs',
    'restore_jobs',
    'restore_items',
  ]),
  deniedColumnsByTable: new Map<string, ReadonlySet<string>>([
    ['tenants', new Set<string>([
      // ── billing / plan ──────────────────────────────────────
      'plan_id',
      'monthly_price_override',
      'subscription_expires_at',
      // ── operator-set quotas / limits ────────────────────────
      'storage_limit_override',
      'cpu_limit_override',
      'memory_limit_override',
      // Note: schema column is `max_sub_users_override` (the underscore
      // is between sub_users, not subusers). The CI guard
      // scripts/ci-tenant-restore-policy-check.sh catches typos.
      'max_sub_users_override',
      'max_mailboxes_override',
      'email_send_rate_limit',
      'storage_tier',
      // ── cluster placement (operator decision) ───────────────
      'region_id',
      'node_name',
      // Tenant-namespace allocation is operator-controlled; restoring
      // an old namespace value could break PVC mounts + ingress.
      'kubernetes_namespace',
      // ── credentials / privilege flags ───────────────────────
      // is_system must never be restored to TRUE by a tenant cart.
      'is_system',
      // Private-worker auth secret — restoring an old value would
      // re-enable revoked workers.
      'private_worker_shared_secret',
      // ── scheduler control ───────────────────────────────────
      // DB column name (no `_override` suffix on the actual column —
      // Drizzle's TS field is `includeInScheduledBundlesOverride`
      // but the SQL column is bare `include_in_scheduled_bundles`).
      'include_in_scheduled_bundles',
      // ── lifecycle / internal state ──────────────────────────
      'provisioning_status',
      'storage_lifecycle_state',
      'active_storage_op_id',
      // ── audit fields ────────────────────────────────────────
      'created_by',
      'created_at',
      'updated_at',
      'archived_at',
      'suspended_at',
    ])],
  ]),
};

export function isItemTypeAllowedForTenant(
  type: RestoreItemType,
  policy: TenantRestorePolicy = DEFAULT_TENANT_RESTORE_POLICY,
): boolean {
  return policy.allowedItemTypes.has(type);
}

export function isTableAllowedForTenant(
  table: string,
  policy: TenantRestorePolicy = DEFAULT_TENANT_RESTORE_POLICY,
): boolean {
  return !policy.deniedTables.has(table);
}

/**
 * Strip denied columns from a table row. Returns a NEW object;
 * never mutates the input.
 */
export function redactRowForTenant<T extends Record<string, unknown>>(
  table: string,
  row: T,
  policy: TenantRestorePolicy = DEFAULT_TENANT_RESTORE_POLICY,
): Partial<T> {
  const denied = policy.deniedColumnsByTable.get(table);
  if (!denied || denied.size === 0) {
    // Immutability per common/coding-style: return a copy, not the
    // same reference.
    return { ...row };
  }
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!denied.has(k)) {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/** Filter a list of table names down to those a tenant may see. */
export function filterConfigTableNames(
  tables: ReadonlyArray<string>,
  policy: TenantRestorePolicy = DEFAULT_TENANT_RESTORE_POLICY,
): string[] {
  return tables.filter((t) => isTableAllowedForTenant(t, policy));
}

export type ValidateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'TYPE_DENIED' | 'TABLE_DENIED' | 'SELECTOR_TOO_BROAD'; readonly reason: string };

/**
 * Validate a restore-item payload for tenant submission. Called by
 * the tenant cart's add-item route AND its execute route (defence
 * in depth — a forged item shouldn't sneak past).
 */
export function validateRestoreItemForTenant(
  payload: RestoreItemPayload,
  policy: TenantRestorePolicy = DEFAULT_TENANT_RESTORE_POLICY,
): ValidateResult {
  if (!isItemTypeAllowedForTenant(payload.type, policy)) {
    return {
      ok: false,
      code: 'TYPE_DENIED',
      reason: `restore type '${payload.type}' is not allowed for tenant-initiated restores`,
    };
  }
  if (payload.type === 'config-tables') {
    const sel = payload.selector;
    if (sel.kind === 'all') {
      // "All" would silently restore denied tables in the bundle.
      // Force the tenant to enumerate tables.
      return {
        ok: false,
        code: 'SELECTOR_TOO_BROAD',
        reason: 'config-tables restore "all" is not permitted from the tenant panel — specify explicit table names',
      };
    }
    const forbidden = sel.tables.filter((t) => !isTableAllowedForTenant(t, policy));
    if (forbidden.length > 0) {
      return {
        ok: false,
        code: 'TABLE_DENIED',
        reason: `tables denied for tenant restore: ${forbidden.join(', ')}`,
      };
    }
  }
  return { ok: true };
}
