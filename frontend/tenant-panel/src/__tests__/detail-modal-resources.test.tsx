import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import InstalledAppDetailModal from '../components/InstalledAppDetailModal';

/**
 * The details modal's resource tiles.
 *
 *   CPU   under tiers, "<used> / <burst ceiling>" — the request is the
 *         tenant's share under contention, not the app's size.
 *   Disk  measured for a stopped app too, as the list's Disk column is: the
 *         modal used to fetch only while running and print "0 B" otherwise.
 */

type Live = { data: { data: { cpuUsed: number; memoryUsedMi: number; storageUsedBytes: number; storageUsedFormatted: string } } | undefined; isLoading: boolean };
let live: Live = { data: undefined, isLoading: false };
const liveMetrics = vi.fn((_tenantId: string | undefined, deploymentId: string | undefined): Live =>
  (deploymentId ? live : { data: undefined, isLoading: false }));

vi.mock('@/hooks/use-deployments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-deployments')>()),
  useUpdateDeploymentResources: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null, reset: vi.fn() }),
  useUpdateDeployment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isError: false, error: null, reset: vi.fn() }),
  useResourceAvailability: () => ({ data: undefined, isLoading: false }),
  useDeploymentLiveMetrics: (t: string | undefined, id: string | undefined) => liveMetrics(t, id),
  useSwitchDeploymentVersion: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null, reset: vi.fn() }),
  useSetMultihost: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null, reset: vi.fn() }),
}));
vi.mock('@/hooks/use-resource-availability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-resource-availability')>()),
  useResourceAvailability: () => ({ data: { data: { cpuModel: 'tiered', cpuTier: 'normal', cpuBurstCores: 6 } }, isLoading: false }),
}));
vi.mock('@/hooks/use-resource-metrics', () => ({
  useResourceMetrics: () => ({ data: { data: { storage: { available: 100 } } } }),
}));
vi.mock('@/hooks/use-catalog', () => ({
  useCatalogEntryVersions: () => ({ data: { data: [] }, isLoading: false }),
}));
vi.mock('@/components/ResourceBreakdown', () => ({ ResourceBreakdown: () => <div data-testid="resource-breakdown" /> }));
vi.mock('@/components/NetworkAccessSection', () => ({ default: () => null }));
vi.mock('@/components/AvailableUpgradesCard', () => ({ default: () => <div data-testid="catalog-upgrades" /> }));
vi.mock('@/components/custom-deployments/CustomUpdatesCard', () => ({ CustomUpdatesCard: () => <div data-testid="custom-updates-card" /> }));

const GB = 1024 * 1024 * 1024;
const measured = (cpuUsed: number): Live => ({
  data: { data: { cpuUsed, memoryUsedMi: 120, storageUsedBytes: 1.2 * GB, storageUsedFormatted: '1.2 GB' } },
  isLoading: false,
});

function deployment(over: Record<string, unknown> = {}) {
  return {
    id: 'd1', name: 'blog-prod', tenantId: 't1', status: 'running', source: 'catalog',
    catalogEntryId: 'c1', cpuRequest: '100m', memoryRequest: '512Mi',
    replicaCount: 1, lastError: null, statusMessage: null, customSpec: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as never;
}

function renderModal(dep = deployment()) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <InstalledAppDetailModal
          open
          deployment={dep}
          catalogEntry={{ id: 'c1', name: 'WordPress', type: 'application', components: [], parameters: [], volumes: [] } as never}
          tenantId="t1"
          onClose={() => {}}
          onToggleStatus={() => {}}
          isToggling={false}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  live = { data: undefined, isLoading: false };
});

describe('CPU tile', () => {
  it('shows used / burst ceiling and no request', () => {
    live = measured(0.008);
    renderModal();
    const cpu = screen.getByTestId('detail-cpu');
    expect(cpu).toHaveTextContent('8m / 6 cores');
    expect(cpu).not.toHaveTextContent('100m');
  });

  it('shows no usage for a stopped app, only the ceiling', () => {
    live = measured(0.3);
    renderModal(deployment({ status: 'stopped' }));
    expect(screen.getByTestId('detail-cpu')).toHaveTextContent('— / 6 cores');
  });
});

describe('Disk tile', () => {
  it('measures a stopped app, as the list does', () => {
    live = measured(0);
    renderModal(deployment({ status: 'stopped' }));
    expect(liveMetrics).toHaveBeenCalledWith('t1', 'd1');
    expect(screen.getByTestId('detail-disk')).toHaveTextContent('1.2 GB');
    expect(screen.getByTestId('detail-disk')).toHaveTextContent('of 100 GB');
  });

  it('says it is loading rather than "0 B"', () => {
    live = { data: undefined, isLoading: true };
    renderModal();
    expect(screen.getByTestId('detail-disk')).toHaveTextContent('…');
    expect(screen.getByTestId('detail-disk')).not.toHaveTextContent('0 B');
  });

  it('does not measure an app being deleted', () => {
    renderModal(deployment({ status: 'deleting' }));
    expect(liveMetrics).not.toHaveBeenCalledWith('t1', 'd1');
  });
});

describe('Resource breakdown', () => {
  it('is shown for a catalog app', () => {
    renderModal();
    expect(screen.getByTestId('resource-breakdown')).toBeInTheDocument();
  });

  it('is not shown for a custom app — the API refuses it, and the refusal was printed as an error', () => {
    renderModal(deployment({ source: 'custom', catalogEntryId: null, customSpec: { sourceMode: 'simple', services: {} } }));
    expect(screen.queryByTestId('resource-breakdown')).not.toBeInTheDocument();
  });
});

describe('Updates', () => {
  it('a custom app gets its registry updates, not the catalog card that refused it', () => {
    renderModal(deployment({ source: 'custom', catalogEntryId: null, customSpec: { sourceMode: 'simple', services: {} } }));
    expect(screen.getByTestId('custom-updates-card')).toBeInTheDocument();
    expect(screen.queryByTestId('catalog-upgrades')).not.toBeInTheDocument();
  });

  it('a catalog app keeps the catalog card', () => {
    renderModal();
    expect(screen.getByTestId('catalog-upgrades')).toBeInTheDocument();
    expect(screen.queryByTestId('custom-updates-card')).not.toBeInTheDocument();
  });
});
