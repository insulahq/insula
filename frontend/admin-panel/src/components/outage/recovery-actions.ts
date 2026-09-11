import type { TenantHealthFindingKind } from '@insula/api-contracts';

/**
 * What the operator should actually DO about each finding.
 *
 * The recovery primitives all existed before the 2026-09-11 drill — what was
 * missing was the mapping from "this tenant is degraded" to "here is the
 * button". Every finding kind must appear here; the `Record` type makes
 * adding a kind without an action a compile error rather than a blank modal
 * row.
 */
export interface RecoveryAction {
  /** Imperative label — what happens when the operator follows it. */
  readonly label: string;
  /** One sentence of why this is the right move. */
  readonly rationale: string;
  /**
   * Where to go. `tenantPath: true` means the link is the tenant's own
   * detail page, resolved at render time from the entry.
   */
  readonly href?: string;
  readonly tenantPath?: boolean;
  /** True when nothing is required — the platform resolves it on its own. */
  readonly selfHealing?: boolean;
}

export const RECOVERY_ACTIONS: Record<TenantHealthFindingKind, RecoveryAction> = {
  workloads_pinned_to_down_node: {
    label: 'Re-pin the tenant to a live node',
    rationale:
      'The tenant is pinned to the offline node, so nothing can be scheduled elsewhere. '
      + 'Draining the node lets you re-target this tenant\'s workloads and volumes in one step.',
    href: '/cluster/nodes',
  },
  volume_last_replica_on_down_node: {
    label: 'Restore the tenant from its latest backup',
    rationale:
      'No replica survives on a live node, so the data cannot be served until the node returns. '
      + 'If waiting is not acceptable, recover the tenant from its most recent bundle.',
    href: '/backups/tenants',
  },
  volume_degraded_rebuilding: {
    label: 'No action needed',
    rationale: 'Longhorn is rebuilding the missing replica onto a surviving node.',
    selfHealing: true,
  },
  workloads_not_ready: {
    label: 'Inspect the tenant\'s workloads',
    rationale: 'Pods exist but are not passing readiness — check events and logs on the tenant.',
    tenantPath: true,
  },
  mail_unavailable: {
    label: 'Fail mail over to another node',
    rationale:
      'The mail stack\'s active node is offline. Failover moves Stalwart and the webmail to a '
      + 'standby node; fail back once the original node is healthy again.',
    href: '/email/operations',
  },
};
