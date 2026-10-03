/**
 * "Re-pinned to sv1 — restarted 0 deployment(s)" read as success for a stopped
 * tenant whose data never moved, and the operator pressed Move back again and
 * again. The note must say where the data is going, or why it is not.
 */
import type { ReactElement } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MigrateToWorkerResult } from '@insula/api-contracts';
import MigrateResultNote from '@/components/tenants/MigrateResultNote';

vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(async (path: string) => (path.startsWith('/api/v1/admin/storage/operations/')
    ? { data: { id: 'op-1', opType: 'relocate', state: 'quiescing', progressPct: 20, progressMessage: 'Waiting for the volume to detach from node-b', lastError: null, completedAt: null } }
    : { data: [] })),
}));

function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const result = (over: Partial<MigrateToWorkerResult> = {}): MigrateToWorkerResult => ({
  tenantId: 't1', previousWorker: 'node-b', currentWorker: 'node-a', deploymentsRestarted: 0,
  dataRelocation: { started: [], skipped: [], error: null }, moveOperationId: null, ...over,
});

describe('MigrateResultNote', () => {
  it('a stopped tenant: says its data is being moved, not "restarted 0"', () => {
    render(<MigrateResultNote result={result({ dataRelocation: { started: ['pvc-1'], skipped: [], error: null } })} />);
    const note = screen.getByTestId('migrate-result');
    expect(note).toHaveTextContent('Pinned to node-a. Moving the data there now (1 volume)');
    expect(note).not.toHaveTextContent('restarted 0');
  });

  it('a running tenant: the restarted workloads carry the data', () => {
    render(<MigrateResultNote result={result({ deploymentsRestarted: 2, dataRelocation: { started: [], skipped: [{ volumeName: 'pvc-1', reason: 'in-use' }], error: null } })} />);
    expect(screen.getByTestId('migrate-result')).toHaveTextContent('Pinned to node-a — restarted 2 deployment(s). The restarted workloads take the data with them');
  });

  it('a tenant running on another node: says it is stopped, moved and started, and opens the move progress', () => {
    render(<MigrateResultNote result={result({ deploymentsRestarted: 3, moveOperationId: 'op-1' })} />);
    const note = screen.getByTestId('migrate-result');
    expect(note).toHaveTextContent('Moving to node-a: the tenant stops, its volume is released by the node it ran on');
    expect(note).not.toHaveTextContent('restarted 3');
    expect(screen.getByTestId('operation-progress-modal')).toHaveTextContent('Moving to node-a');
  });

  it('shows the live step of the move in the progress', async () => {
    render(<MigrateResultNote result={result({ moveOperationId: 'op-1' })} />);
    expect(await screen.findByText('Waiting for the volume to detach from node-b')).toBeInTheDocument();
  });

  it('reopens the move progress after it was closed', () => {
    render(<MigrateResultNote result={result({ moveOperationId: 'op-1' })} />);
    fireEvent.click(screen.getByTestId('operation-progress-dismiss'));
    expect(screen.queryByTestId('operation-progress-modal')).toBeNull();
    fireEvent.click(screen.getByTestId('migrate-show-progress'));
    expect(screen.getByTestId('operation-progress-modal')).toBeInTheDocument();
  });

  it('says plainly when the data could not be moved', () => {
    render(<MigrateResultNote result={result({ dataRelocation: { started: [], skipped: [], error: 'forbidden' } })} />);
    expect(screen.getByTestId('migrate-relocation-error')).toHaveTextContent('The data could not be moved: forbidden.');
  });
});
