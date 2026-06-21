/**
 * Tenant lifecycle guards.
 *
 * `assertTenantActive` is the single helper used at every service-layer
 * callsite that provisions tenant resources — deploying workloads,
 * configuring domains/ingress, enabling email domains, creating
 * mailboxes. A tenant is only allowed to do these once it is `active`
 * (= provisioned). A freshly-created tenant is `pending` +
 * `unprovisioned` until an admin explicitly provisions it (which flips
 * it to `active`, see k8s-provisioner/service.ts). `suspended` /
 * `archived` tenants are likewise blocked.
 *
 * The guard accepts a minimal row shape so callers can pass either a
 * full tenant row (from `getTenantById`) or just the `{ id, status }`
 * columns they already selected.
 *
 * It throws `ApiError(TENANT_NOT_ACTIVE, 409)` with an `operatorError`
 * envelope so the frontend `<ErrorPanel>` renders a consistent,
 * actionable message instead of a confusing downstream failure (e.g.
 * the Stalwart `452 mail system full` a pending tenant used to hit).
 */

import { ApiError } from '../../shared/errors.js';

export type TenantLifecycleStatus = 'active' | 'suspended' | 'archived' | 'pending';

export interface MinimalActiveTenantRow {
  id: string;
  status: TenantLifecycleStatus | string;
}

/** Action labels passed to assertTenantActive — used in the error
 *  message so the operator sees `Cannot deploy workloads while the
 *  tenant is pending` rather than a generic `not active`. */
export type TenantActiveAction =
  | 'deploy workloads'
  | 'create custom deployments'
  | 'configure domains'
  | 'enable email for a domain'
  | 'create mailboxes';

const STATUS_HINT: Record<string, string> = {
  pending: 'It has been created but not provisioned yet.',
  suspended: 'It is currently suspended.',
  archived: 'It is currently archived.',
};

const REMEDIATION: Record<string, string[]> = {
  pending: [
    'Provision the tenant — it activates automatically on completion.',
    'Use "Provision Now" in the create dialog or the Provision button on the tenant detail page (POST /api/v1/admin/tenants/:id/provision).',
  ],
  suspended: ['Reactivate the tenant (set status to active) before retrying.'],
  archived: ['Restore the tenant (set status to active) before retrying.'],
};

/**
 * Throws `TENANT_NOT_ACTIVE` (HTTP 409) unless `row.status === 'active'`.
 * No-op for active tenants.
 *
 * Use at the top of every service-layer function that provisions tenant
 * resources (deployments, domains/ingress, email-domain enable, mailbox
 * create).
 */
export function assertTenantActive(
  row: MinimalActiveTenantRow | null | undefined,
  action: TenantActiveAction,
): void {
  if (row && row.status === 'active') return;
  const status = row?.status ?? 'unknown';
  const hint = STATUS_HINT[status] ?? `Its status is '${status}'.`;
  throw new ApiError(
    'TENANT_NOT_ACTIVE',
    `Cannot ${action} — the tenant is not active. ${hint}`,
    409,
    {
      tenantId: row?.id,
      status,
      action,
      operatorError: {
        code: 'TENANT_NOT_ACTIVE',
        title: 'Tenant is not active',
        detail: `A tenant must be provisioned and active before it can ${action}. ${hint}`,
        remediation: REMEDIATION[status] ?? [
          'Provision and activate the tenant before retrying.',
        ],
        retryable: false,
      },
    },
  );
}
