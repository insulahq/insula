/**
 * Admin tenant snapshots: the step-by-step restore modal (operator view) and
 * the Data size column next to the volume size.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SnapshotRestoreStatus, TenantSnapshot } from '@insula/api-contracts';

let statusResult: { data?: { data: SnapshotRestoreStatus }; isError: boolean; error?: unknown } = { isError: false };
let snapshots: TenantSnapshot[] = [];
const restoreMutate = vi.fn();

vi.mock('@/hooks/use-tenant-snapshots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-tenant-snapshots')>()),
  useTenantRestoreStatus: vi.fn(() => statusResult),
  useTenantSnapshots: vi.fn(() => ({
    data: { data: { snapshots, expiryHours: 48 } }, isLoading: false, isError: false, refetch: vi.fn(),
  })),
  useCreateTenantSnapshot: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useDeleteTenantSnapshot: vi.fn(() => ({ mutate: vi.fn(), isPending: false, reset: vi.fn(), error: null })),
  useRestoreTenantSnapshot: vi.fn(() => ({ mutate: restoreMutate, isPending: false })),
}));
vi.mock('@/hooks/use-task-center', () => ({ useRefreshTaskCenter: () => vi.fn(), useTaskCenter: () => ({ data: undefined }) }));

const SnapshotRestoreProgressModal = (await import('@/components/SnapshotRestoreProgressModal')).default;
const TenantSnapshotsPanel = (await import('@/components/TenantSnapshotsPanel')).default;

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const startedAt = new Date(Date.now() - 20_000).toISOString();

function runningStatus(over: Partial<SnapshotRestoreStatus> = {}): SnapshotRestoreStatus {
  return {
    operationId: 'op-1', state: 'restoring', outcome: 'running', progressPct: 58, progressMessage: null,
    lastError: null, error: null, snapshotLabel: null, startedAt, completedAt: null,
    steps: [
      { key: 'quiesce', label: 'Stop workloads', state: 'succeeded', startedAt, finishedAt: startedAt, elapsedMs: 8_000, detail: null },
      { key: 'attach-maintenance', label: 'Attach the volume for the restore', state: 'succeeded', startedAt, finishedAt: startedAt, elapsedMs: 900, detail: 'node=node-a' },
      { key: 'wait-maintenance', label: 'Wait for the volume to be ready', state: 'running', startedAt, finishedAt: null, elapsedMs: null, detail: null },
    ],
    ...over,
  };
}

const ready: TenantSnapshot = {
  id: 'snap-1', tenantId: TENANT, label: 'nightly', status: 'ready', sizeBytes: 2147483648, dataSizeBytes: 67399680,
  lastError: null, createdAt: new Date().toISOString(), readyAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 40 * 3600_000).toISOString(),
};

beforeEach(() => {
  statusResult = { isError: false };
  snapshots = [];
  restoreMutate.mockReset();
});

describe('SnapshotRestoreProgressModal (admin)', () => {
  it('shows the operator detail the server sends for each step', () => {
    statusResult = { data: { data: runningStatus() }, isError: false };
    render(<SnapshotRestoreProgressModal tenantId={TENANT} operationId="op-1" onClose={() => {}} />);
    expect(screen.getByTestId('restore-step-attach-maintenance').textContent).toContain('node=node-a');
    expect(screen.getByTestId('restore-step-wait-maintenance').getAttribute('data-state')).toBe('running');
  });

  it('can run in the background while the restore continues', () => {
    const onClose = vi.fn();
    statusResult = { data: { data: runningStatus() }, isError: false };
    render(<SnapshotRestoreProgressModal tenantId={TENANT} operationId="op-1" onClose={onClose} />);
    const btn = screen.getByTestId('restore-close');
    expect(btn.textContent).toBe('Run in background');
    fireEvent.click(btn);
    expect(onClose).toHaveBeenCalled();
  });

  it('renders the raw engine error inside the ErrorPanel for operators', () => {
    statusResult = {
      data: {
        data: runningStatus({
          state: 'failed', outcome: 'failed', lastError: 'Longhorn snapshotRevert failed: HTTP 500',
          error: {
            code: 'SNAPSHOT_RESTORE_FAILED', title: 'Snapshot restore failed at “Revert the volume to the snapshot”',
            detail: 'Longhorn snapshotRevert failed: HTTP 500', remediation: ['Retry.'], retryable: true,
            diagnostics: { operationId: 'op-1', failedStep: 'revert', raw: 'Longhorn snapshotRevert failed: HTTP 500' },
          },
        }),
      },
      isError: false,
    };
    render(<SnapshotRestoreProgressModal tenantId={TENANT} operationId="op-1" onClose={() => {}} />);
    const panel = screen.getByTestId('restore-failed');
    expect(panel.textContent).toContain('Snapshot restore failed at “Revert the volume to the snapshot”');
    expect(panel.textContent).toContain('HTTP 500');
  });
});

describe('TenantSnapshotsPanel (admin)', () => {
  it('shows Data size next to Volume size, and "—" (not 0) when unmeasured', () => {
    snapshots = [ready, { ...ready, id: 'snap-2', dataSizeBytes: null }, { ...ready, id: 'snap-3', dataSizeBytes: 0 }];
    render(<TenantSnapshotsPanel tenantId={TENANT} />);
    expect(screen.getByTestId('admin-snapshot-volume-size-snap-1').textContent).toBe('2.0 GB');
    expect(screen.getByTestId('admin-snapshot-data-size-snap-1').textContent).toBe('64.3 MB');
    const unknown = screen.getByTestId('admin-snapshot-data-size-snap-2');
    expect(unknown.textContent).toBe('—');
    expect(unknown.getAttribute('title')).toMatch(/Not measured/);
    expect(screen.getByTestId('admin-snapshot-data-size-snap-3').textContent).toBe('0 B');
  });

  it('★ a confirmed restore opens the step-by-step modal, not the old single-line one', () => {
    snapshots = [ready];
    statusResult = { data: { data: runningStatus() }, isError: false };
    restoreMutate.mockImplementation((_id: string, opts: { onSuccess: (r: unknown) => void }) => {
      opts.onSuccess({ data: { operationId: 'op-1' } });
    });
    render(<TenantSnapshotsPanel tenantId={TENANT} />);
    fireEvent.click(screen.getByTestId('admin-restore-snapshot-snap-1'));
    fireEvent.click(screen.getByTestId('admin-confirm-restore-snapshot'));
    expect(restoreMutate).toHaveBeenCalledWith('snap-1', expect.anything());
    expect(screen.getByTestId('restore-step-timeline')).toBeInTheDocument();
  });
});

describe('task-center registry', () => {
  it('re-opens a snapshot restore from the chip', async () => {
    const { TaskModalHost } = await import('@/tasks/modal-registry');
    statusResult = { data: { data: runningStatus() }, isError: false };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<TaskModalHost modal="snapshot-restore" props={{ operationId: 'op-1', tenantId: TENANT }} onClose={() => {}} />);
    expect(await screen.findByTestId('restore-step-timeline')).toBeInTheDocument();
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('no modal registered'));
    warn.mockRestore();
  });
});
