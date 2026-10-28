import { AlertTriangle, Ban, Archive, Loader2 } from 'lucide-react';
import type { StorageLifecycleState, StorageOperationType, TenantStorageNotice } from '@insula/api-contracts';
import { useMyLifecycle } from '@/hooks/use-my-lifecycle';

/**
 * Global banner that warns the customer about non-operational states
 * of their account. Renders nothing when everything is healthy and
 * the orchestrator is idle.
 *
 *   - tenantStatus=suspended → red, destructive actions blocked
 *   - tenantStatus=archived → gray, read-only access
 *   - storage → the server's `storageNotice`, which knows what is behind the
 *     state: an operation running now (blue), applications an automatic
 *     restart could not bring back (red), or an operation that stopped partway
 *     (red). The bare state cannot tell those apart — `failed` used to read
 *     "until the operation completes" with nothing running at all.
 */
export default function LifecycleBanner() {
  const { data } = useMyLifecycle();
  if (!data) return null;

  const { tenantStatus, storageLifecycleState, storageNotice } = data;

  if (tenantStatus === 'suspended') {
    return (
      <Banner tone="red" icon={<Ban size={16} />}>
        <strong>Your account is suspended.</strong> Your sites and services are unavailable until an admin re-activates the account. Contact support if you believe this is in error.
      </Banner>
    );
  }

  if (tenantStatus === 'archived') {
    return (
      <Banner tone="gray" icon={<Archive size={16} />}>
        <strong>Your account is archived.</strong> Active services are stopped; data is retained on the snapshot store and can be restored on request.
      </Banner>
    );
  }

  const notice = storageNotice === undefined ? legacyNotice(storageLifecycleState) : storageNotice;
  return notice ? <StorageBanner notice={notice} state={storageLifecycleState} /> : null;
}

/** An API that predates `storageNotice`: say only what the state alone supports. */
function legacyNotice(state: StorageLifecycleState | null): TenantStorageNotice | null {
  if (!state || state === 'idle') return null;
  return state === 'failed'
    ? { kind: 'operation_failed', opType: null }
    : { kind: 'operation_running', opType: null };
}

const RUNNING_LABEL: Partial<Record<StorageLifecycleState, string>> = {
  resizing: 'Resizing your storage',
  snapshotting: 'Creating a snapshot of your data',
  restoring: 'Restoring your data',
  archiving: 'Archiving your account',
};

const OPERATION_NAME: Record<StorageOperationType, string> = {
  snapshot: 'snapshot',
  resize: 'storage resize',
  suspend: 'suspension',
  resume: 'reactivation',
  archive: 'archive',
  restore: 'restore',
  fsck: 'storage check',
  autoheal: 'automatic restart',
  relocate: 'server move',
};

function StorageBanner({ notice, state }: { readonly notice: TenantStorageNotice; readonly state: StorageLifecycleState | null }) {
  switch (notice.kind) {
    case 'operation_running':
      if (notice.opType === 'autoheal') {
        return (
          <Banner tone="blue" icon={<Loader2 size={16} className="animate-spin" />}>
            <strong>Restarting your applications automatically.</strong> They should be back within a few minutes.
          </Banner>
        );
      }
      return (
        <Banner tone="blue" icon={<Loader2 size={16} className="animate-spin" />}>
          <strong>{(state && RUNNING_LABEL[state]) ?? 'A storage operation is in progress'}.</strong> Some pages may be slow or briefly show errors until it finishes.
        </Banner>
      );
    case 'workloads_down': {
      const one = notice.workloads.length === 1;
      return (
        <Banner tone="red" icon={<AlertTriangle size={16} />}>
          <strong>{joinNames(notice.workloads)} {one ? 'is' : 'are'} not running.</strong> An automatic restart did not bring {one ? 'it' : 'them'} back, and our operators have been notified.
        </Banner>
      );
    }
    case 'operation_failed':
      return (
        <Banner tone="red" icon={<AlertTriangle size={16} />}>
          <strong>The last {notice.opType ? OPERATION_NAME[notice.opType] : 'storage operation'} on your account did not finish.</strong> Our operators have been notified. Storage changes such as resizing and restores are on hold until they resolve it.
        </Banner>
      );
  }
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function Banner({ tone, icon, children }: {
  readonly tone: 'red' | 'gray' | 'blue';
  readonly icon: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  const toneClasses = tone === 'red'
    ? 'bg-red-50 border-red-200 text-red-800 dark:bg-red-950/40 dark:border-red-900 dark:text-red-200'
    : tone === 'blue'
      ? 'bg-blue-50 border-blue-200 text-blue-800 dark:bg-blue-950/40 dark:border-blue-900 dark:text-blue-200'
      : 'bg-gray-100 border-gray-200 text-gray-800 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200';
  return (
    <div
      role="alert"
      className={`flex items-center gap-2 border-b px-4 py-2 text-sm ${toneClasses}`}
      data-testid="lifecycle-banner"
    >
      <span className="shrink-0">{icon}</span>
      <div className="flex-1">{children}</div>
    </div>
  );
}
