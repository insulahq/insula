import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FailbackReview } from '@insula/api-contracts';
import FailbackReviewPanel from '../components/outage/FailbackReviewPanel';

const useFailbackReview = vi.fn();

vi.mock('../hooks/use-failback-review', async () => {
  const actual = await vi.importActual<typeof import('../hooks/use-failback-review')>(
    '../hooks/use-failback-review',
  );
  return {
    ...actual,
    useFailbackReview: () => useFailbackReview(),
    useAcknowledgeFailback: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

vi.mock('../hooks/use-cluster-nodes', () => ({
  useClusterNodes: () => ({ data: { data: [] } }),
}));

const review = (over: Partial<FailbackReview> = {}): FailbackReview => ({
  returnedNodes: ['node-b'],
  items: [],
  observedAt: '2026-09-11T21:00:00Z',
  readError: null,
  ...over,
});

const item = (over: Partial<FailbackReview['items'][number]> = {}) => ({
  tenantId: 't1',
  tenantName: 'acme',
  movedFromNode: 'node-b',
  currentNode: null,
  storageTier: 'ha',
  movedBy: 'auto' as const,
  movedAt: '2026-09-11T20:30:00Z',
  recommendation: 'keep_current_placement' as const,
  detail: 'This tenant is on the HA storage tier and is now unpinned, more resilient.',
  ...over,
});

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FailbackReviewPanel />
    </QueryClientProvider>,
  );
}

describe('FailbackReviewPanel', () => {
  beforeEach(() => useFailbackReview.mockReset());

  it('renders nothing when no tenant is displaced — the normal case', () => {
    useFailbackReview.mockReturnValue({ data: { data: review() }, isLoading: false });
    renderPanel();
    expect(screen.queryByTestId('failback-review-panel')).toBeNull();
  });

  it('renders nothing while loading rather than flashing an empty state', () => {
    useFailbackReview.mockReturnValue({ data: undefined, isLoading: true });
    renderPanel();
    expect(screen.queryByTestId('failback-review-panel')).toBeNull();
  });

  it('names the returned node and the displaced tenant', () => {
    useFailbackReview.mockReturnValue({
      data: { data: review({ items: [item()] }) },
      isLoading: false,
    });
    renderPanel();
    expect(screen.getByTestId('failback-review-panel')).toBeTruthy();
    expect(screen.getByText(/node-b is back online/)).toBeTruthy();
    expect(screen.getByTestId('failback-item-t1')).toBeTruthy();
    expect(screen.getByText('acme')).toBeTruthy();
  });

  it('shows KEEP for an unpinned HA tenant and RE-PIN for a local one', () => {
    useFailbackReview.mockReturnValue({
      data: {
        data: review({
          items: [
            item(),
            item({
              tenantId: 't2', tenantName: 'beta', storageTier: 'local', currentNode: 'node-c',
              movedBy: 'operator', recommendation: 'consider_repin', detail: 'Still on node-c.',
            }),
          ],
        }),
      },
      isLoading: false,
    });
    renderPanel();
    expect(screen.getByText('Keep as is')).toBeTruthy();
    expect(screen.getByText('Consider re-pinning')).toBeTruthy();
    expect(screen.getByText('moved automatically')).toBeTruthy();
    expect(screen.getByText('moved by an operator')).toBeTruthy();
  });

  it('offers both an acknowledge and a placement-change action per tenant', () => {
    useFailbackReview.mockReturnValue({
      data: { data: review({ items: [item()] }) },
      isLoading: false,
    });
    renderPanel();
    expect(screen.getByTestId('failback-ack-t1')).toBeTruthy();
    expect(screen.getByTestId('failback-repin-t1')).toBeTruthy();
  });

  it('says so when the review could not be read — never silently "nothing to do"', () => {
    // The failure mode this guards: a DB read fails, items is [], and an
    // operator reads the absence of a panel as "no tenants displaced".
    useFailbackReview.mockReturnValue({
      data: { data: review({ items: [], readError: 'placement history: fetch failed' }) },
      isLoading: false,
    });
    renderPanel();
    expect(screen.getByTestId('failback-review-panel').textContent).toContain(
      'Placement review unavailable',
    );
  });
});
