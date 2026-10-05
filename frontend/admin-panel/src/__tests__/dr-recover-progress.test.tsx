/**
 * Tenant recovery from an off-site bundle shows its progress in a modal and
 * the task center — not on the page that started it.
 *
 * Pinned here:
 *  - Recover starts the recovery in the background and opens the progress
 *    modal; the page itself renders no progress or result section any more.
 *  - The modal renders the `dr.recover` task: the step timeline, the restore
 *    cart's items, the final result (re-created, reconcile, manual steps) or
 *    the OperatorError through <ErrorPanel>.
 *  - Closing it leaves the recovery running ("Run in background"), and the
 *    task-center chip re-opens the same view from the task row.
 *  - A result stays on screen after its row ages out of the chip's feed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { DrRecoverStep, DrRecoverTaskDetails, RecoverableTenant, TaskRow } from '@insula/api-contracts';

const fetchMock = vi.fn();
vi.mock('@/lib/api-client', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-client')>()),
  apiFetch: (...a: unknown[]) => fetchMock(...a),
}));

const { default: DrRecoverProgressModal } = await import('@/components/DrRecoverProgressModal');
const { default: TenantRecoverTab } = await import('@/components/system-backup/TenantRecoverTab');
const { default: TaskCenterChip } = await import('@/components/TaskCenterChip');
const { TaskModalHost } = await import('@/tasks/modal-registry');

const TENANT_ID = '11111111-2222-4333-8444-555555555555';
const TASK_ID = '99999999-8888-4777-8666-555555555555';
const T0 = new Date(Date.now() - 90_000).toISOString();

function steps(states: Partial<Record<DrRecoverStep['key'], DrRecoverStep['state']>>, notes: Partial<Record<DrRecoverStep['key'], string>> = {}): DrRecoverStep[] {
  const labels: Record<DrRecoverStep['key'], string> = {
    recreate: 'Re-create the deleted tenant from its bundle',
    bundle: 'Check the bundle',
    provision: 'Provision the namespace and storage',
    queue: 'Queue the restore',
    restore: 'Restore the data',
    reconcile: 'Re-establish services',
  };
  return (Object.keys(labels) as DrRecoverStep['key'][]).map((key) => ({
    key, label: labels[key], state: states[key] ?? 'pending', note: notes[key] ?? null,
    startedAt: states[key] && states[key] !== 'pending' && states[key] !== 'skipped' ? T0 : null,
    finishedAt: states[key] === 'done' || states[key] === 'failed' ? T0 : null,
  }));
}

function details(over: Partial<DrRecoverTaskDetails> = {}): DrRecoverTaskDetails {
  return {
    tenantId: TENANT_ID, tenantName: 'ACME LEARNING', bundleId: 'bkp-79a722d1', cartId: 'rstr-cart-1',
    steps: steps({ recreate: 'done', bundle: 'done', provision: 'done', queue: 'done', restore: 'running' }, { bundle: 'Taken 2026-01-02 03:04 UTC · config, files' }),
    result: null, error: null,
    ...over,
  };
}

function task(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: TASK_ID, kind: 'dr.recover', refId: null, scope: 'admin', userId: 'admin-1', tenantId: TENANT_ID,
    label: 'Recover tenant ACME LEARNING', status: 'running', progressPct: 55, progressText: 'Restoring files (2 of 4)',
    target: { type: 'modal', modal: 'dr-recover', modalProps: { tenantId: TENANT_ID } },
    errorMessage: null, details: details() as unknown as Record<string, unknown>,
    startedAt: T0, updatedAt: T0, finishedAt: null, clearedAt: null, parentTaskId: null,
    ...over,
  };
}

const RESULT = {
  cartId: 'rstr-cart-1', bundleId: 'bkp-79a722d1', components: ['config', 'files'] as const, provisioned: true,
  status: 'done' as const, recreated: true,
  residualGaps: ['Re-point the tenant DNS at this cluster.', 'Ask mailbox users to re-enter app passwords.'],
  reconcile: { ingress: 'reconciled' as const, mail: { domainsTotal: 1, dkimRegenerated: 1, failed: 0 }, workloads: { total: 2, redeployed: 2, failed: 0 } },
};

const CART = {
  id: 'rstr-cart-1', tenantId: TENANT_ID, initiatorUserId: null, status: 'executing', preRestoreSnapshotId: null,
  description: 'dr-recover bkp-79a722d1', startedAt: T0, finishedAt: null, lastError: null, createdAt: T0, updatedAt: T0,
  items: [
    { id: 'a0000000-0000-4000-8000-000000000001', restoreJobId: 'rstr-cart-1', bundleId: 'bkp-79a722d1', type: 'config-tables', selector: {}, label: null, seq: 0, status: 'done', progressMessage: null, sizeBytes: 0, startedAt: T0, finishedAt: T0, lastError: null },
    { id: 'a0000000-0000-4000-8000-000000000002', restoreJobId: 'rstr-cart-1', bundleId: 'bkp-79a722d1', type: 'files-paths', selector: {}, label: null, seq: 1, status: 'applying', progressMessage: 'restic restore 41%', sizeBytes: 0, startedAt: T0, finishedAt: null, lastError: null },
  ],
};

const INFO = {
  tenantId: TENANT_ID, name: 'ACME LEARNING', deleted: true, deletedAt: T0, source: 'bundle', infoFromBundleId: 'bkp-79a722d1',
  infoError: null, status: 'active', planName: 'Business', storageTier: 'local', primaryNode: 'node-a',
  namespace: 'tenant-example-0a1b2c3d', namespacePresent: false, namespaceTerminating: false, resources: null,
  bundles: [{ id: 'bkp-79a722d1', createdAt: T0, finishedAt: null, status: 'completed', trigger: 'scheduled', label: null, sizeBytes: 1500, components: [], expiresAt: null }],
};

let tasks: TaskRow[] = [];
const posted: Array<{ url: string; body: unknown }> = [];

function api() {
  fetchMock.mockImplementation(async (raw: unknown, init?: { method?: string; body?: string }) => {
    const url = typeof raw === 'string' ? raw : '';
    if (init?.method === 'POST') posted.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
    if (url === '/api/v1/me/tasks') return { data: { tasks, serverTime: new Date().toISOString() } };
    if (url === '/api/v1/admin/restores/carts/rstr-cart-1') return { data: CART };
    if (url === '/api/v1/admin/tenant-bundles/recoverable-tenants') {
      const t: RecoverableTenant = {
        tenantId: TENANT_ID, name: 'ACME LEARNING', deleted: true, deletedAt: T0, bundleCount: 2,
        newestBundleAt: T0, newestCompletedBundleId: 'bkp-79a722d1', keptUntil: null,
      };
      return { data: [t] };
    }
    if (url.endsWith(`/dr/tenants/${TENANT_ID}/recover`)) return { data: { taskId: TASK_ID, tenantId: TENANT_ID } };
    if (url.includes(`/dr/tenants/${TENANT_ID}/recovery-info`)) return { data: INFO };
    return { data: [] };
  });
}

function wrap(node: React.ReactNode, path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  posted.length = 0;
  tasks = [task()];
  api();
});

describe('DrRecoverProgressModal', () => {
  it('shows where the recovery is: steps, the running step, the restore items', async () => {
    wrap(<DrRecoverProgressModal taskId={TASK_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('dr-recover-progress-msg')).toHaveTextContent('Restoring files (2 of 4)'));
    expect(screen.getByTestId('dr-recover-progress-tenant')).toHaveTextContent('ACME LEARNING');
    expect(screen.getByTestId('dr-recover-step-restore')).toHaveAttribute('data-state', 'running');
    expect(screen.getByTestId('dr-recover-step-bundle')).toHaveTextContent('Taken 2026-01-02 03:04 UTC · config, files');
    const item = await screen.findByTestId('dr-recover-item-1');
    expect(item).toHaveTextContent('Files');
    expect(item).toHaveTextContent('applying');
    expect(item).toHaveTextContent('restic restore 41%');
  });

  it('says so when a running recovery has stopped reporting (its process restarted)', async () => {
    tasks = [task({ updatedAt: new Date(Date.now() - 10 * 60_000).toISOString() })];
    wrap(<DrRecoverProgressModal taskId={TASK_ID} onClose={() => {}} />);
    expect(await screen.findByTestId('dr-recover-silent')).toHaveTextContent('may have restarted');
  });

  it('does not cry wolf while the run keeps reporting', async () => {
    tasks = [task({ updatedAt: new Date().toISOString() })];
    wrap(<DrRecoverProgressModal taskId={TASK_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('dr-recover-progress-msg')).toHaveTextContent('Restoring files'));
    expect(screen.queryByTestId('dr-recover-silent')).toBeNull();
  });

  it('runs in the background when closed while running', async () => {
    const onClose = vi.fn();
    wrap(<DrRecoverProgressModal taskId={TASK_ID} onClose={onClose} />);
    const btn = await screen.findByTestId('dr-recover-close');
    await waitFor(() => expect(btn).toHaveTextContent('Run in background'));
    expect(screen.getByText(/continues on the server if you close this/i)).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the final result: re-created, services re-established, manual steps left', async () => {
    tasks = [task({
      status: 'succeeded', progressPct: 100, finishedAt: new Date().toISOString(),
      details: details({
        steps: steps({ recreate: 'done', bundle: 'done', provision: 'done', queue: 'done', restore: 'done', reconcile: 'done' }),
        result: { ...RESULT, components: ['config', 'files'] },
      }) as unknown as Record<string, unknown>,
    })];
    wrap(<DrRecoverProgressModal taskId={TASK_ID} onClose={() => {}} />);
    expect(await screen.findByTestId('dr-recover-done')).toHaveTextContent('2 manual steps left');
    expect(screen.getByTestId('dr-recover-recreated')).toBeInTheDocument();
    expect(screen.getByTestId('dr-recover-reconcile')).toHaveTextContent('2/2');
    const gaps = screen.getByTestId('dr-recover-residual-gaps');
    expect(within(gaps).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByTestId('dr-recover-cart-id')).toHaveTextContent('rstr-cart-1');
    expect(screen.getByTestId('dr-recover-close')).toHaveTextContent('Close');
  });

  it('renders a failure as an OperatorError, on the step where it stopped', async () => {
    tasks = [task({
      status: 'failed', finishedAt: new Date().toISOString(), errorMessage: 'Recovery failed at “Provision the namespace and storage”: …',
      details: details({
        cartId: null,
        steps: steps({ recreate: 'skipped', bundle: 'done', provision: 'failed' }),
        error: {
          code: 'DR_PROVISION_FAILED', title: 'Recovery failed at “Provision the namespace and storage”',
          detail: 'Tenant namespace provisioning failed; recover aborted before restore.',
          remediation: ['Resolve the failed provisioning step (often a quota block), then retry.'], retryable: true,
        },
      }) as unknown as Record<string, unknown>,
    })];
    wrap(<DrRecoverProgressModal taskId={TASK_ID} onClose={() => {}} />);
    const panel = await screen.findByTestId('dr-recover-failed');
    expect(panel).toHaveTextContent('Recovery failed at “Provision the namespace and storage”');
    expect(panel).toHaveTextContent('often a quota block');
    expect(screen.getByTestId('dr-recover-step-provision')).toHaveAttribute('data-state', 'failed');
    expect(screen.getByTestId('dr-recover-step-queue')).toHaveAttribute('data-state', 'pending');
    expect(screen.queryByTestId('dr-recover-items')).toBeNull();
  });

  it('keeps the result after the row ages out of the task feed', async () => {
    tasks = [task({
      status: 'succeeded', finishedAt: new Date().toISOString(),
      details: details({ result: { ...RESULT, components: ['config', 'files'] } }) as unknown as Record<string, unknown>,
    })];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter><DrRecoverProgressModal taskId={TASK_ID} onClose={() => {}} /></MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('dr-recover-done')).toBeInTheDocument();
    tasks = [];
    await act(async () => { await qc.invalidateQueries({ queryKey: ['task-center', 'me'] }); });
    await waitFor(() => expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/v1/me/tasks').length).toBeGreaterThan(1));
    expect(screen.getByTestId('dr-recover-done')).toBeInTheDocument();
    expect(screen.getByTestId('dr-recover-residual-gaps')).toBeInTheDocument();
  });

  it('renders from the chip\'s copy of the row when the feed no longer has it', async () => {
    tasks = [];
    wrap(
      <DrRecoverProgressModal
        taskId={TASK_ID}
        onClose={() => {}}
        taskStatus="succeeded"
        taskDetails={details({ result: { ...RESULT, components: ['config', 'files'] } }) as unknown as Record<string, unknown>}
      />,
    );
    expect(await screen.findByTestId('dr-recover-done')).toBeInTheDocument();
    expect(screen.getByTestId('dr-recover-result')).toBeInTheDocument();
  });

  it('is registered with the task center under `dr-recover`', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    wrap(<TaskModalHost modal="dr-recover" props={{ taskId: TASK_ID }} onClose={() => {}} />);
    expect(await screen.findByTestId('dr-recover-progress-modal')).toBeInTheDocument();
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('no modal registered'));
    warn.mockRestore();
  });
});

describe('DR → Recover Tenant starts the recovery into the modal', () => {
  it('posts a background recover, opens the modal, and renders no progress on the page', async () => {
    tasks = [];
    wrap(<TenantRecoverTab />, `/backups/disaster-recovery?section=recover&tenant=${TENANT_ID}`);
    const submit = await screen.findByTestId('dr-recover-submit');
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => expect(posted.find((p) => p.url.endsWith('/recover'))).toBeDefined());
    const body = posted.find((p) => p.url.endsWith('/recover'))!.body as Record<string, unknown>;
    expect(body.background).toBe(true);
    expect(body.provision).toBe(true);

    const modal = await screen.findByTestId('dr-recover-progress-modal');
    expect(modal).toBeInTheDocument();
    // Nothing of the run outside the modal.
    const page = screen.getByTestId('dr-recover-submit').closest('section')!.parentElement!;
    for (const id of ['dr-recover-result', 'dr-recover-progress-table']) {
      const hits = within(page).queryAllByTestId(id).filter((el) => !modal.contains(el));
      expect(hits).toHaveLength(0);
    }

    fireEvent.click(within(modal).getByTestId('dr-recover-close'));
    await waitFor(() => expect(screen.queryByTestId('dr-recover-progress-modal')).toBeNull());
  });

  it('shows a refusal (already being recovered) in the form, and opens no modal', async () => {
    const { ApiError } = await import('@/lib/api-client');
    fetchMock.mockImplementation(async (raw: unknown, init?: { method?: string }) => {
      const url = typeof raw === 'string' ? raw : '';
      if (init?.method === 'POST' && url.endsWith('/recover')) {
        throw new ApiError(409, 'DR_RECOVER_IN_PROGRESS', 'A recovery of this tenant is already running.', {
          operatorError: {
            code: 'DR_RECOVER_IN_PROGRESS', title: 'Already being recovered',
            detail: 'A recovery of this tenant is already running.', remediation: ['Follow it from the task center.'], retryable: false,
          },
        });
      }
      if (url === '/api/v1/admin/tenant-bundles/recoverable-tenants') return { data: [] };
      if (url.includes('/recovery-info')) return { data: INFO };
      return { data: [] };
    });
    wrap(<TenantRecoverTab />, `/backups/disaster-recovery?section=recover&tenant=${TENANT_ID}`);
    const submit = await screen.findByTestId('dr-recover-submit');
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);
    expect(await screen.findByTestId('dr-recover-error')).toHaveTextContent('Already being recovered');
    expect(screen.queryByTestId('dr-recover-progress-modal')).toBeNull();
  });
});

describe('the task center re-opens a recovery', () => {
  it('lists the running recovery and opens its progress modal on click', async () => {
    wrap(<TaskCenterChip />);
    fireEvent.click(await screen.findByTestId('task-center-chip'));
    const row = await screen.findByTestId(`task-center-row-${TASK_ID}`);
    expect(row).toHaveTextContent('Recover tenant ACME LEARNING');
    expect(row).toHaveTextContent('Restoring files (2 of 4)');
    fireEvent.click(row);
    const modal = await screen.findByTestId('dr-recover-progress-modal');
    expect(within(modal).getByTestId('dr-recover-step-restore')).toHaveAttribute('data-state', 'running');
  });
});
