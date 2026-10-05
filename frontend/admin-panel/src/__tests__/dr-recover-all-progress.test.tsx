/**
 * Recover All runs as a `dr.recover-all` task: confirming opens its progress
 * modal (one row per tenant), the page drops the spent preview, and the chip
 * re-opens the same view. What used to be the inline results table — and the
 * tenants passed over, and a run started past an encryption-key mismatch —
 * is in the modal now.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { DrRecoverAllTaskDetails, TaskRow } from '@insula/api-contracts';

const fetchMock = vi.fn();
vi.mock('@/lib/api-client', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-client')>()),
  apiFetch: (...a: unknown[]) => fetchMock(...a),
}));

const { default: RecoverAllTab } = await import('@/components/system-backup/RecoverAllTab');
const { default: DrRecoverAllProgressModal } = await import('@/components/DrRecoverAllProgressModal');
const { TaskModalHost } = await import('@/tasks/modal-registry');

const TASK_ID = '77777777-6666-4555-8444-333333333333';
const T0 = new Date(Date.now() - 60_000).toISOString();
const KEY_OK = { verdict: 'ok', probed: 1, ok: 1, failed: 0, probes: [], summary: 'decrypted 1', remedy: null };

const TARGET = {
  tenantId: 't-1', tenantName: 'Acme', bundleId: 'bundle-abcdef0123456789', namespacePresent: false,
  bundleCreatedAt: T0, bundleAgeDays: 0, components: ['config', 'files'],
};

function batchDetails(over: Partial<DrRecoverAllTaskDetails> = {}): DrRecoverAllTaskDetails {
  return {
    scope: 'missing', total: 2, recovered: 1, failed: 0,
    tenants: [
      { tenantId: 't-1', tenantName: 'Acme', bundleId: 'b-1', state: 'done', step: null, taskId: 'c-1', status: 'done', recreated: true, error: null },
      { tenantId: 't-2', tenantName: 'Globex', bundleId: 'b-2', state: 'running', step: 'Restore the data', taskId: 'c-2', status: null, recreated: false, error: null },
    ],
    skipped: [{ tenantId: 't-9', tenantName: 'Initech', reason: 'no_completed_bundle', latestBundleStatus: 'partial', latestBundleAt: T0 }],
    encryptionKey: KEY_OK as DrRecoverAllTaskDetails['encryptionKey'],
    error: null,
    ...over,
  };
}

function batchTask(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: TASK_ID, kind: 'dr.recover-all', refId: null, scope: 'admin', userId: 'admin-1', tenantId: null,
    label: 'Recover 2 tenants from their bundles', status: 'running', progressPct: 50, progressText: '1 of 2 tenants',
    target: { type: 'modal', modal: 'dr-recover-all', modalProps: {} }, errorMessage: null,
    details: batchDetails() as unknown as Record<string, unknown>,
    startedAt: T0, updatedAt: T0, finishedAt: null, clearedAt: null, parentTaskId: null,
    ...over,
  };
}

let tasks: TaskRow[] = [];
const posted: Array<Record<string, unknown>> = [];

beforeEach(() => {
  tasks = [batchTask()];
  posted.length = 0;
  fetchMock.mockReset().mockImplementation(async (raw: unknown, init?: { method?: string; body?: string }) => {
    const url = typeof raw === 'string' ? raw : '';
    if (url === '/api/v1/me/tasks') return { data: { tasks, serverTime: new Date().toISOString() } };
    if (url === '/api/v1/admin/dr/tenants/recover-all' && init?.body) {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      posted.push(body);
      if (body.dryRun) {
        return { data: { dryRun: true, scope: 'missing', total: 1, recovered: 0, failed: 0, targets: [TARGET], skipped: [], encryptionKey: KEY_OK } };
      }
      return { data: { taskId: TASK_ID, total: 1 } };
    }
    return { data: [] };
  });
});

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
}

describe('DrRecoverAllProgressModal', () => {
  it('lists every tenant with its state, the step it is on, and how far the batch is', async () => {
    wrap(<DrRecoverAllProgressModal taskId={TASK_ID} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('dr-recover-all-msg')).toHaveTextContent('1 of 2 tenants'));
    expect(screen.getByTestId('dr-recover-all-row-t-1')).toHaveTextContent('recovered (re-created)');
    const running = screen.getByTestId('dr-recover-all-row-t-2');
    expect(running).toHaveTextContent('recovering');
    expect(running).toHaveTextContent('Restore the data');
    expect(screen.getByTestId('dr-recover-all-close')).toHaveTextContent('Run in background');
  });

  it('still lists the tenants the run passed over, and why', async () => {
    wrap(<DrRecoverAllProgressModal taskId={TASK_ID} onClose={() => {}} />);
    const skipped = await screen.findByTestId('dr-recover-all-skipped');
    expect(skipped).toHaveTextContent('Initech');
    expect(skipped).toHaveTextContent('no completed bundle (newest is partial)');
  });

  it('a run started past an encryption-key mismatch says so', async () => {
    tasks = [batchTask({
      details: batchDetails({ encryptionKey: { ...KEY_OK, verdict: 'mismatch', ok: 0, failed: 1, remedy: 'x' } as DrRecoverAllTaskDetails['encryptionKey'] }) as unknown as Record<string, unknown>,
    })];
    wrap(<DrRecoverAllProgressModal taskId={TASK_ID} onClose={() => {}} />);
    expect(await screen.findByTestId('dr-recover-all-key-override')).toHaveTextContent('re-entered by hand');
  });

  it('a batch with failures ends in an ErrorPanel, each failed tenant with its reason', async () => {
    tasks = [batchTask({
      status: 'failed', finishedAt: new Date().toISOString(), errorMessage: '1 of 2 tenants could not be recovered',
      details: batchDetails({
        recovered: 1, failed: 1,
        tenants: [
          { tenantId: 't-1', tenantName: 'Acme', bundleId: 'b-1', state: 'done', step: null, taskId: 'c-1', status: 'done', recreated: false, error: null },
          { tenantId: 't-2', tenantName: 'Globex', bundleId: 'b-2', state: 'failed', step: null, taskId: 'c-2', status: 'failed', recreated: false, error: 'The restore stopped at a failed item.' },
        ],
        error: {
          code: 'DR_RECOVER_ALL_INCOMPLETE', title: '1 of 2 tenants could not be recovered',
          detail: 'Every tenant that failed is listed with the reason; the others were recovered.',
          remediation: ['Recover each of them on its own from Recover Tenant.'], retryable: false,
        },
      }) as unknown as Record<string, unknown>,
    })];
    wrap(<DrRecoverAllProgressModal taskId={TASK_ID} onClose={() => {}} />);
    expect(await screen.findByTestId('dr-recover-all-failed')).toHaveTextContent('1 of 2 tenants could not be recovered');
    expect(screen.getByTestId('dr-recover-all-row-t-2')).toHaveTextContent('The restore stopped at a failed item.');
    expect(screen.getByTestId('dr-recover-all-close')).toHaveTextContent('Close');
  });

  it('is registered with the task center under `dr-recover-all`', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    wrap(<TaskModalHost modal="dr-recover-all" props={{ taskId: TASK_ID }} onClose={() => {}} />);
    expect(await screen.findByTestId('dr-recover-all-modal')).toBeInTheDocument();
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('no modal registered'));
    warn.mockRestore();
  });
});

describe('DR → Recover All starts the batch into the modal', () => {
  it('preview → confirm posts a background run, opens the modal and drops the spent preview', async () => {
    wrap(<RecoverAllTab />);
    fireEvent.click(screen.getByRole('button', { name: /Preview lost tenants/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Recover 1 tenant/i }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm recover/i }));

    const modal = await screen.findByTestId('dr-recover-all-modal');
    const run = posted.find((p) => !p.dryRun)!;
    expect(run.background).toBe(true);
    expect(run.allowEncryptionKeyMismatch).toBe(false);
    // The spent preview is gone from the page: no target list, no second Recover.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Recover 1 tenant/i })).toBeNull());
    expect(screen.queryByText(/^bundle-abcdef012/)).toBeNull();

    fireEvent.click(within(modal).getByTestId('dr-recover-all-close'));
    await waitFor(() => expect(screen.queryByTestId('dr-recover-all-modal')).toBeNull());
  });
});
