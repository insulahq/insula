/**
 * The task centre must re-open a progress modal it names.
 *
 * A tenant's on-demand backup keeps running after its modal is dismissed.
 * Until now the chip could not bring it back: it had no modal registry at
 * all, and the backend handed it `{type:'route', href:'/tenants/<id>?tab=
 * backups'}` — an ADMIN path with no route in this panel. Clicking your own
 * running backup did nothing, silently. These assert the two halves of the
 * fix: a modal target opens its modal, and an unknown key does not blow up.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import type { TaskRow } from '@insula/api-contracts';
import TaskCenterChip from '../components/TaskCenterChip';

const task = (target: TaskRow['target']): TaskRow => ({
  id: 't1',
  kind: 'backup.bundle',
  status: 'running',
  label: 'Backup bundle',
  progressPct: 40,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  clearedAt: null,
  target,
} as unknown as TaskRow);

let rows: TaskRow[] = [];
vi.mock('@/hooks/use-task-center', () => ({
  useTaskCenter: () => ({ data: { data: { tasks: rows } }, isLoading: false }),
  useClearTasks: () => ({ mutate: vi.fn(), isPending: false }),
}));

// The real modal polls; stand in for it so the test is about the CHIP.
vi.mock('@/components/BundleProgressModal', () => ({
  BundleProgressModal: ({ bundleId }: { bundleId: string }) => (
    <div role="dialog" aria-label="Backup progress">bundle {bundleId}</div>
  ),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>
  );
}

describe('tenant task centre', () => {
  it('re-opens the backup progress modal from a modal target', async () => {
    rows = [task({ type: 'modal', modal: 'bundle-progress', modalProps: { bundleId: 'bkp-1' } })];
    render(<TaskCenterChip />, { wrapper });

    await userEvent.click(screen.getByTestId('task-center-chip'));
    await userEvent.click(await screen.findByText('Backup bundle'));

    const dialog = await screen.findByRole('dialog', { name: 'Backup progress' });
    expect(dialog).toHaveTextContent('bundle bkp-1');
  });

  it('an unregistered key renders nothing rather than a blank modal', async () => {
    rows = [task({ type: 'modal', modal: 'not-a-real-modal', modalProps: {} })];
    render(<TaskCenterChip />, { wrapper });

    await userEvent.click(screen.getByTestId('task-center-chip'));
    await userEvent.click(await screen.findByText('Backup bundle'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
