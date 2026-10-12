import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import type { CrowdsecStatus } from '@insula/api-contracts';
import { ApiError } from '@/lib/api-client';

/**
 * Three "run now" buttons ended a failed request with the spinner and nothing
 * else: the node health check, the image purge and the CrowdSec bouncer prune.
 * Their endpoints now refuse — 409 JOB_ALREADY_RUNNING — when the scheduled
 * run of the same job is still under way after a short wait, so an operator
 * who clicked during one would have been left guessing whether anything ran.
 *
 * The hooks are the real ones; only the network call is replaced.
 */

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/hooks/use-node-health', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useNodeHealth: () => ({
    data: { data: { nodes: [], overallSeverity: 'normal', lastTickAt: new Date().toISOString() } },
    isLoading: false, isError: false, error: null,
  }),
  useStalePodCounts: () => ({ data: {} }),
  useNodeMemoryEvents: () => ({ data: { data: { events: [] } }, isLoading: false, isError: false }),
}));

vi.mock('@/hooks/use-storage', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useStorageOverview: () => ({
    isLoading: false,
    data: { data: {
      node: { name: 'n1', totalBytes: 100, usedBytes: 50, availableBytes: 50 },
      system: { platformDatabase: { usedBytes: 1024 }, dockerImages: { totalBytes: 2048, count: 3 } },
      tenants: [],
      total: { systemBytes: 3072, tenantBytes: 0 },
    } },
  }),
  useImageInventory: () => ({
    isLoading: false,
    data: { data: { images: [], totalBytes: 2048, purgeableBytes: 1024, purgeableCount: 1 } },
  }),
}));

const { default: NodeHealthPanel } = await import('@/components/NodeHealthPanel');
const { default: StorageUsageTab } = await import('@/components/StorageUsageTab');
const { CrowdsecStatusPanel } = await import('@/components/security/web-defense-tabs');

/** What the API answers when the job is still running after the wait. */
function alreadyRunning(what: string, job: string): ApiError {
  return new ApiError(409, 'JOB_ALREADY_RUNNING', `${what} is already running.`, {
    job,
    operatorError: {
      code: 'JOB_ALREADY_RUNNING',
      title: 'Already running',
      detail: `${what} is already running, started by its schedule or by another request.`,
      remediation: ['Nothing was started by this request. Wait a moment, then try again.'],
      retryable: true,
    },
  });
}

function renderWithClient(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const STATUS = {
  lapiHealthy: true,
  lapiError: null,
  capiAuthenticated: true,
  communityBlocklistEnabled: false,
  machines: [],
  bouncers: [
    { name: 'traefik@a', online: true },
    { name: 'traefik@b', online: false },
  ],
  scenariosLoaded: 3,
  coverage: { traefikPodsTotal: 1, traefikPodsCovered: 1, nodesTotal: 1, modsecPodsTotal: 1 },
  decisionCounts: null,
} as unknown as CrowdsecStatus;

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe('a refused "run now" is shown, not swallowed', () => {
  it('node health: Reconcile now', async () => {
    apiFetchMock.mockRejectedValue(alreadyRunning('The node health check', 'node-health-monitor'));
    renderWithClient(<NodeHealthPanel />);
    expect(screen.queryByTestId('node-health-reconcile-error')).toBeNull();

    fireEvent.click(screen.getByTestId('node-health-reconcile'));

    const panel = await screen.findByTestId('node-health-reconcile-error');
    expect(panel.textContent).toContain('Already running');
    expect(panel.textContent).toContain('The node health check is already running');
    expect(panel.textContent).toContain('Nothing was started by this request');
    expect(apiFetchMock).toHaveBeenCalledWith('/api/v1/admin/node-health/reconcile', { method: 'POST' });
  });

  it('image purge: the preview', async () => {
    apiFetchMock.mockRejectedValue(alreadyRunning('An image purge', 'daily-image-prune'));
    renderWithClient(<StorageUsageTab />);
    expect(screen.queryByTestId('image-purge-error')).toBeNull();

    fireEvent.click(screen.getByTestId('purge-preview-button'));

    const panel = await screen.findByTestId('image-purge-error');
    expect(panel.textContent).toContain('An image purge is already running');
  });

  it('CrowdSec: Prune stale bouncers', async () => {
    apiFetchMock.mockRejectedValue(alreadyRunning('A bouncer prune', 'crowdsec-bouncer-prune'));
    renderWithClient(<CrowdsecStatusPanel status={STATUS} />);
    expect(screen.queryByTestId('crowdsec-prune-bouncers-error')).toBeNull();

    fireEvent.click(screen.getByTestId('crowdsec-prune-bouncers'));

    const panel = await screen.findByTestId('crowdsec-prune-bouncers-error');
    expect(panel.textContent).toContain('A bouncer prune is already running');
    // The button is usable again, and says what it said before.
    await waitFor(() => expect(screen.getByTestId('crowdsec-prune-bouncers').textContent).toContain('Prune 1 stale'));
  });

  it('an error the API did not explain still gets a panel', async () => {
    apiFetchMock.mockRejectedValue(new ApiError(502, 'CROWDSEC_BOUNCER_PRUNE_FAILED', 'cscli exited 1'));
    renderWithClient(<CrowdsecStatusPanel status={STATUS} />);

    fireEvent.click(screen.getByTestId('crowdsec-prune-bouncers'));

    const panel = await screen.findByTestId('crowdsec-prune-bouncers-error');
    expect(panel.textContent).toContain('CROWDSEC_BOUNCER_PRUNE_FAILED');
    expect(panel.textContent).toContain('cscli exited 1');
  });
});
