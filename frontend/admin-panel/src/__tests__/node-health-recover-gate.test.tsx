import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NodeHealthEntry } from '@/hooks/use-node-health';
import NodeHealthPanel from '@/components/NodeHealthPanel';

/**
 * The "Recover…" button used to render only when `severity !== 'normal'`.
 *
 * A node reboot leaves Failed pod records behind while producing no evictions
 * and no disk/memory pressure, so the node stays `normal`, the cell rendered a
 * bare em-dash, and the recovery modal — with every action in it — was
 * unreachable. Production sat on 17 such records across four reboots with no
 * way to clear them from the UI.
 *
 * NodeRecoveryModal's own `suggestedWhen` had already been fixed for this exact
 * case; the fix just never reached the button that opens the modal.
 */

const mockHealth = vi.fn();
const mockStale = vi.fn();

vi.mock('@/hooks/use-node-health', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useNodeHealth: () => mockHealth(),
  useStalePodCounts: () => mockStale(),
  useNodeMemoryEvents: () => ({ data: { data: { events: [] } }, isLoading: false, isError: false }),
  useReconcileNodeHealth: () => ({ mutate: vi.fn(), isPending: false }),
}));

function entry(overrides: Partial<NodeHealthEntry> = {}): NodeHealthEntry {
  return {
    name: 'node-a',
    ready: true,
    severity: 'normal',
    pressures: [],
    csiDriversPresent: 3,
    csiDriversExpected: 3,
    csiDriversMissing: [],
    evictionsLastHour: 0,
    diskUsedPct: 12,
    observedAt: new Date().toISOString(),
    ...overrides,
  } as NodeHealthEntry;
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NodeHealthPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHealth.mockReturnValue({
    data: { data: { nodes: [entry()], overallSeverity: 'normal', lastTickAt: new Date().toISOString() } },
    isLoading: false, isError: false, error: null,
  });
  mockStale.mockReturnValue({ data: {} });
});

describe('NodeHealthPanel — Recover button gate', () => {
  it('THE REGRESSION: offers Recover on a HEALTHY node that has stale pods', () => {
    mockStale.mockReturnValue({ data: { 'node-a': 17 } });
    renderPanel();
    expect(screen.getByTestId('recovery-open-node-a')).toBeTruthy();
  });

  it('offers Recover on an unhealthy node even with no stale pods', () => {
    mockHealth.mockReturnValue({
      data: { data: { nodes: [entry({ severity: 'critical', pressures: ['disk'] })], overallSeverity: 'critical', lastTickAt: null } },
      isLoading: false, isError: false, error: null,
    });
    mockStale.mockReturnValue({ data: { 'node-a': 0 } });
    renderPanel();
    expect(screen.getByTestId('recovery-open-node-a')).toBeTruthy();
  });

  it('does NOT offer Recover on a healthy node with nothing to clean', () => {
    mockStale.mockReturnValue({ data: { 'node-a': 0 } });
    renderPanel();
    expect(screen.queryByTestId('recovery-open-node-a')).toBeNull();
  });

  it('falls back to severity when the stale count could not be fetched', () => {
    // undefined means the request failed. Offering an action whose target set
    // is unknown is worse than not offering it.
    mockStale.mockReturnValue({ data: undefined });
    renderPanel();
    expect(screen.queryByTestId('recovery-open-node-a')).toBeNull();
  });

  it('gates per node, not globally', () => {
    mockHealth.mockReturnValue({
      data: {
        data: {
          nodes: [entry({ name: 'node-a' }), entry({ name: 'node-b' })],
          overallSeverity: 'normal', lastTickAt: null,
        },
      },
      isLoading: false, isError: false, error: null,
    });
    mockStale.mockReturnValue({ data: { 'node-b': 4 } });
    renderPanel();
    expect(screen.queryByTestId('recovery-open-node-a')).toBeNull();
    expect(screen.getByTestId('recovery-open-node-b')).toBeTruthy();
  });
});
