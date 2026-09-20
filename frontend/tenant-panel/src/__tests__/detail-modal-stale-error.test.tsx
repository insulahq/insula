import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import InstalledAppDetailModal from '../components/InstalledAppDetailModal';

/**
 * The parent renders this modal ALWAYS and only toggles `open`, so every
 * useMutation inside it outlives both closing the modal and switching to a
 * different application. Nothing called reset() on close, and only two of the
 * five editors reset on Cancel — so a resource change that failed on one app
 * came back, word for word, the next time any app's details were opened, shown
 * against whichever app happened to be on screen.
 *
 * The mock below keeps its error in module state exactly as the real mutation
 * keeps its own, so these assert what the tenant sees rather than that a spy
 * was called.
 */

const RESOURCE_ERROR = 'Quota exceeded — memory limit: requesting 512Mi';

let resourcesError: Error | null = null;
const resetResources = vi.fn(() => { resourcesError = null; });
const resetDeployment = vi.fn();
const resetMultihost = vi.fn();
const resetSwitchVersion = vi.fn();

vi.mock('@/hooks/use-deployments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-deployments')>()),
  useUpdateDeploymentResources: () => ({
    mutate: vi.fn(), isPending: false,
    isError: resourcesError !== null, error: resourcesError, reset: resetResources,
  }),
  useUpdateDeployment: () => ({
    mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false,
    isError: false, error: null, reset: resetDeployment,
  }),
  useResourceAvailability: () => ({ data: undefined, isLoading: false }),
  useDeploymentLiveMetrics: () => ({ data: undefined, isLoading: false }),
  useSwitchDeploymentVersion: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null, reset: resetSwitchVersion }),
  useSetMultihost: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null, reset: resetMultihost }),
}));

vi.mock('@/hooks/use-catalog', () => ({
  useCatalogEntryVersions: () => ({ data: { data: [] }, isLoading: false }),
}));

vi.mock('@/components/NetworkAccessSection', () => ({ default: () => null }));
vi.mock('@/components/AvailableUpgradesCard', () => ({ default: () => null }));

function deployment(id: string, name: string) {
  return {
    id, name, tenantId: 't1', status: 'running', source: 'catalog',
    catalogEntryId: 'c1', cpuRequest: '500m', memoryRequest: '512Mi',
    replicaCount: 1, lastError: null, statusMessage: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  } as never;
}

const CATALOG = {
  id: 'c1', name: 'WordPress', type: 'application',
  components: [], parameters: [], volumes: [],
} as never;

function modal(open: boolean, id: string, name: string) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <InstalledAppDetailModal
          open={open}
          deployment={deployment(id, name)}
          catalogEntry={CATALOG}
          tenantId="t1"
          onClose={() => {}}
          onToggleStatus={() => {}}
          isToggling={false}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** Open the resources editor and put it in the state a failed save leaves. */
function openEditorWithFailedSave(view: ReturnType<typeof render>, id: string, name: string) {
  fireEvent.click(screen.getByTestId('edit-resources-button'));
  resourcesError = new Error(RESOURCE_ERROR);
  view.rerender(modal(true, id, name));
}

beforeEach(() => {
  vi.clearAllMocks();
  resourcesError = null;
});

describe('InstalledAppDetailModal: a failed attempt does not follow you around', () => {
  it('shows the error while you are still on the app that produced it', () => {
    const view = render(modal(true, 'd1', 'blog-prod'));
    openEditorWithFailedSave(view, 'd1', 'blog-prod');
    expect(screen.getByText(RESOURCE_ERROR)).toBeInTheDocument();
  });

  it('forgets it when the modal is closed', () => {
    const view = render(modal(true, 'd1', 'blog-prod'));
    openEditorWithFailedSave(view, 'd1', 'blog-prod');
    expect(screen.getByText(RESOURCE_ERROR)).toBeInTheDocument();

    view.rerender(modal(false, 'd1', 'blog-prod'));
    expect(resetResources).toHaveBeenCalled();
    expect(resourcesError).toBeNull();

    view.rerender(modal(true, 'd1', 'blog-prod'));
    expect(screen.queryByText(RESOURCE_ERROR)).not.toBeInTheDocument();
  });

  // The sharp edge: the error was rendered against an application that never
  // produced it.
  it('does not carry one app’s failure onto the next app opened', () => {
    const view = render(modal(true, 'd1', 'blog-prod'));
    openEditorWithFailedSave(view, 'd1', 'blog-prod');
    expect(screen.getByText(RESOURCE_ERROR)).toBeInTheDocument();

    view.rerender(modal(true, 'd2', 'shop-staging'));
    expect(screen.queryByText(RESOURCE_ERROR)).not.toBeInTheDocument();
  });

  // Reopening into a half-open editor belonging to another application is the
  // same bug wearing different clothes.
  it('closes the editor too, not just the message', () => {
    const view = render(modal(true, 'd1', 'blog-prod'));
    openEditorWithFailedSave(view, 'd1', 'blog-prod');
    expect(screen.queryByTestId('edit-resources-button')).not.toBeInTheDocument();

    view.rerender(modal(true, 'd2', 'shop-staging'));
    expect(screen.getByTestId('edit-resources-button')).toBeInTheDocument();
  });

  it('resets every editor, not only the two that had a Cancel button', () => {
    render(modal(true, 'd1', 'blog-prod'));
    expect(resetResources).toHaveBeenCalled();
    expect(resetDeployment).toHaveBeenCalled();
    expect(resetMultihost).toHaveBeenCalled();
    expect(resetSwitchVersion).toHaveBeenCalled();
  });
});
