/**
 * The account banner's storage line, decided from facts rather than from the
 * bare lifecycle state (see `tenantStorageNoticeSchema` for why the state
 * alone misleads). Pure; `/auth/me` gathers the facts.
 */
import type { StorageLifecycleState, StorageOperationType, TenantStorageNotice } from '@insula/api-contracts';

/**
 * Platform components that run in a tenant namespace under their own
 * Deployment name. A tenant never named them, so the banner gives them a
 * label; every other workload is one of the tenant's applications and keeps
 * the name the Applications page shows.
 */
const PLATFORM_COMPONENT_LABELS: Readonly<Record<string, string>> = {
  'file-manager': 'File manager',
  'private-worker-server': 'Private worker server',
};

export function workloadLabel(deploymentName: string): string {
  return PLATFORM_COMPONENT_LABELS[deploymentName] ?? deploymentName;
}

export interface StorageNoticeFacts {
  readonly state: StorageLifecycleState | null;
  /** The operation behind a running state, when its row could be read. */
  readonly activeOpType: StorageOperationType | null;
  /** The tenant's newest storage operation, whatever its state. */
  readonly latestOpType: StorageOperationType | null;
  /** Deployments with an open outage episode (workload-health). */
  readonly downWorkloads: readonly string[];
}

export function buildStorageNotice(facts: StorageNoticeFacts): TenantStorageNotice | null {
  if (!facts.state || facts.state === 'idle') return null;
  if (facts.state !== 'failed') return { kind: 'operation_running', opType: facts.activeOpType };

  // A failed AUTOMATIC restart is about the applications, not the storage:
  // nothing is running, and the only thing the tenant needs to know is which
  // application is down. Once none is, the state is over — workload-health
  // resets it on its next pass — so there is nothing to say.
  if (facts.latestOpType === 'autoheal') {
    if (facts.downWorkloads.length === 0) return null;
    const workloads = [...new Set(facts.downWorkloads.map(workloadLabel))].sort((a, b) => a.localeCompare(b));
    return { kind: 'workloads_down', workloads };
  }
  return { kind: 'operation_failed', opType: facts.latestOpType };
}
