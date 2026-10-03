/**
 * A system volume Longhorn cannot snapshot (the mail store, on node-local
 * storage) must not offer snapshot actions: "Take snapshot" on it reached the
 * operator as a 500 "Rejected by an admission webhook".
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SystemPvcSnapshotSummary } from '@insula/api-contracts';
import SystemSnapshotsModal from '@/components/SystemSnapshotsModal';

// Hook results are stable objects, as react-query's are. `jobs.data` is left
// undefined on purpose: the modal's `?? []` fallback used to be a fresh array
// per render, which looped the draft-reset effect forever (this test OOMed
// its worker before the fix — and the browser tab spun the same way).
const m = vi.hoisted(() => {
  const fn = () => () => undefined;
  const idle = { mutate: fn(), mutateAsync: fn(), isPending: false, error: null, reset: fn() };
  return {
    idle,
    snaps: { data: { data: { snapshots: [] } }, isLoading: false, isFetching: false, error: null, refetch: fn() },
    jobs: { data: undefined, isLoading: false, error: null },
    none: { data: undefined, isLoading: false, error: null },
  };
});
vi.mock('@/hooks/use-system-snapshots', () => ({
  useVolumeSnapshots: () => m.snaps,
  useRecurringJobs: () => m.jobs,
  useTakeSnapshot: () => m.idle,
  useDeleteSystemSnapshot: () => m.idle,
  usePruneSystemSnapshots: () => m.idle,
  useRestoreSystemSnapshot: () => m.idle,
  useUpdateRecurringJob: () => m.idle,
}));
vi.mock('@/hooks/use-postgres-restore', () => ({
  useStartPitr: () => m.idle,
  usePitrPrechecks: () => m.none,
  useRestoreStatus: () => m.none,
}));

const base: SystemPvcSnapshotSummary = {
  namespace: 'mail', pvcName: 'mail-stack-data', longhornVolumeName: 'pvc-local',
  volumeSizeBytes: 1, snapshotCount: 0, snapshotBytesTotal: 0,
  oldestSnapshotAt: null, newestSnapshotAt: null, recurringJobs: [], degraded: false,
  cnpgCluster: null, cnpgRole: null, snapshotCapable: true,
};

function renderModal(volume: SystemPvcSnapshotSummary) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <SystemSnapshotsModal volume={volume} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe('SystemSnapshotsModal — volumes Longhorn cannot snapshot', () => {
  it('explains instead of offering snapshot actions', () => {
    renderModal({ ...base, snapshotCapable: false });
    expect(screen.getByTestId('snapshot-not-capable')).toHaveTextContent('mail backup');
    expect(screen.queryByTestId('manual-take-snapshot')).toBeNull();
  });

  it('a Longhorn-backed volume keeps its snapshot actions', () => {
    renderModal(base);
    expect(screen.getByTestId('manual-take-snapshot')).toBeInTheDocument();
    expect(screen.queryByTestId('snapshot-not-capable')).toBeNull();
  });
});
