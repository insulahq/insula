import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ClusterNodeResponse } from '@insula/api-contracts';
import type { NodeSubsystemReport } from '@/hooks/use-cluster-health';
import ClusterNodes from '../pages/ClusterNodes';

// Mock the hooks. ClusterNodes uses useClusterNodes + useNodeSubsystemHealth
// at the page level, useDeleteNode + useNodeStorage inside the card.
const mockNodes = vi.fn();
const mockSubsystem = vi.fn();
const mockDeleteMutate = vi.fn();
const mockUsage = vi.fn(() => ({ data: undefined as unknown }));
vi.mock('@/hooks/use-cluster-nodes', () => ({
  useClusterNodes: () => mockNodes(),
  useNodeUsage: () => mockUsage(),
  useDeleteNode: () => ({ mutate: mockDeleteMutate, isPending: false }),
  useUpdateClusterNode: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false }),
  useDrainImpact: () => ({ data: undefined }),
}));
vi.mock('@/hooks/use-cluster-health', () => ({
  useNodeSubsystemHealth: () => mockSubsystem(),
}));
let hostStatus: Array<Record<string, unknown>> | undefined;
let role = 'super_admin';
const hostStatusEnabled: boolean[] = [];
vi.mock('@/hooks/use-host-migrations', () => ({
  useHostMigrationStatus: (enabled: boolean) => {
    hostStatusEnabled.push(enabled);
    return { data: enabled && hostStatus ? { data: { nodes: hostStatus } } : undefined };
  },
}));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'u', role } }) }));
vi.mock('@/hooks/use-node-storage', () => ({
  useNodeStorage: () => ({ data: undefined, isLoading: false, error: null }),
  usePatchNodeDisk: () => ({ mutate: vi.fn(), isPending: false }),
}));

function makeNode(overrides: Partial<ClusterNodeResponse> = {}): ClusterNodeResponse {
  return {
    name: 'staging1',
    displayName: null,
    role: 'server',
    canHostTenantWorkloads: false,
    cordoned: false,
    drained: false,
    ingressMode: 'all',
    publicIp: '192.0.2.58',
    k3sVersion: 'v1.30.4+k3s1',
    kubeletVersion: 'v1.30.4',
    cpuMillicores: 4000,
    cpuRequestsMillicores: 1000,
    memoryBytes: 8 * 1024 ** 3,
    memoryRequestsBytes: 2 * 1024 ** 3,
    storageBytes: 100 * 1024 ** 3,
    scheduledPods: 12,
    statusConditions: [{ type: 'Ready', status: 'True', reason: '', message: '' }],
    taints: [],
    notes: null,
    lastSeenAt: new Date().toISOString(),
    existsInKubernetes: true,
    ...overrides,
  } as unknown as ClusterNodeResponse;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ClusterNodes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ClusterNodes — health bar + collapsible node cards', () => {
  it('renders "All systems healthy" when every node is Ready and within thresholds', () => {
    mockNodes.mockReturnValue({
      data: { data: [makeNode({ name: 's1' }), makeNode({ name: 's2' })] },
      isLoading: false,
      error: null,
    });
    mockSubsystem.mockReturnValue({ data: { data: { nodes: [] } } });

    renderPage();
    const bar = screen.getByTestId('cluster-health-bar');
    expect(within(bar).getByTestId('health-all-ok')).toBeDefined();
  });

  it('shows CPU pressure chip when one node exceeds 75% CPU requests', () => {
    mockNodes.mockReturnValue({
      data: {
        data: [
          // 3500m of 4000m = 87% → amber pressure
          makeNode({ name: 'busy', cpuRequestsMillicores: 3500 }),
          makeNode({ name: 'idle' }),
        ],
      },
      isLoading: false,
      error: null,
    });
    mockSubsystem.mockReturnValue({ data: { data: { nodes: [] } } });

    renderPage();
    const bar = screen.getByTestId('cluster-health-bar');
    const cpuChip = within(bar).getByTestId('health-cpu');
    expect(cpuChip.textContent).toContain('CPU mostly committed: 1');
    // No memory or subsystem chips
    expect(within(bar).queryByTestId('health-memory')).toBeNull();
    expect(within(bar).queryByTestId('health-subsystem')).toBeNull();
  });

  it('escalates the CPU chip to red when >=90% on any node', () => {
    mockNodes.mockReturnValue({
      data: {
        data: [
          makeNode({ name: 'critical', cpuRequestsMillicores: 3800 }), // 95%
        ],
      },
      isLoading: false,
      error: null,
    });
    mockSubsystem.mockReturnValue({ data: { data: { nodes: [] } } });

    renderPage();
    const cpuChip = screen.getByTestId('health-cpu');
    expect(cpuChip.textContent).toMatch(/1 ≥90%/);
  });

  it('counts subsystem-degraded nodes', () => {
    const sub: NodeSubsystemReport = {
      nodeName: 'w1',
      calico: 'degraded',
      longhornCsi: 'healthy',
      csiDriverRegistered: true,
    };
    mockNodes.mockReturnValue({
      data: { data: [makeNode({ name: 'w1', role: 'worker' })] },
      isLoading: false,
      error: null,
    });
    mockSubsystem.mockReturnValue({ data: { data: { nodes: [sub] } } });

    renderPage();
    const subChip = screen.getByTestId('health-subsystem');
    expect(subChip.textContent).toContain('Worker subsystem issues: 1');
  });

  // The subsystem panel used to print one unconditional line for every fault:
  // "pods will fail to attach PVCs — drain + re-bootstrap". Wrong twice: PVC
  // attach is a CSI concern, so it misled whenever the fault was Calico; and
  // drain + re-bootstrap is a full-node outage offered as the FIRST move for
  // conditions that are usually a one-line fix.
  function renderWithSubsystem(sub: NodeSubsystemReport) {
    mockNodes.mockReturnValue({
      data: { data: [makeNode({ name: sub.nodeName, role: 'worker' })] },
      isLoading: false,
      error: null,
    });
    mockSubsystem.mockReturnValue({ data: { data: { nodes: [sub] } } });
    renderPage();
    fireEvent.click(screen.getByText(sub.nodeName));
  }

  it('a Calico fault talks about networking and policy, not PVCs', () => {
    renderWithSubsystem({ nodeName: 'w1', calico: 'degraded', longhornCsi: 'healthy', csiDriverRegistered: true });
    const panel = screen.getByTestId('node-subsystem-w1');
    expect(panel.textContent).toMatch(/pod networking/i);
    expect(panel.textContent).toMatch(/NetworkPolicy/);
    expect(panel.textContent).not.toMatch(/fail to attach PVCs/);
  });

  it('a Calico fault points at the usual cause before anything drastic', () => {
    renderWithSubsystem({ nodeName: 'w1', calico: 'degraded', longhornCsi: 'healthy', csiDriverRegistered: true });
    const panel = screen.getByTestId('node-subsystem-w1');
    expect(panel.textContent).toMatch(/iptables/);
    const link = within(panel).getByTestId('subsystem-troubleshooting-link');
    // Must point at the PUBLISHED manual: docs/operations/ is a repo-internal
    // runbook tree that is not on the docs site, and the host has no clone.
    expect(link.getAttribute('href')).toBe('https://insulahq.github.io/operator/troubleshooting/#worker-subsystem');
    expect(panel.textContent).toMatch(/last resort/i);
  });

  it('a CSI-only fault still says PVCs', () => {
    renderWithSubsystem({ nodeName: 'w1', calico: 'healthy', longhornCsi: 'degraded', csiDriverRegistered: true });
    const panel = screen.getByTestId('node-subsystem-w1');
    expect(panel.textContent).toMatch(/fail to attach PVCs/);
    // No iptables hint when networking is fine — it would be noise.
    expect(panel.textContent).not.toMatch(/iptables/);
  });

  it('node card is collapsed by default; clicking the row expands the body', () => {
    mockNodes.mockReturnValue({
      data: { data: [makeNode({ name: 'staging1' })] },
      isLoading: false,
      error: null,
    });
    mockSubsystem.mockReturnValue({ data: { data: { nodes: [] } } });

    renderPage();
    expect(screen.queryByTestId('node-card-body-staging1')).toBeNull();
    const toggle = screen.getByTestId('node-card-toggle-staging1');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(screen.getByTestId('node-card-header-staging1'));
    expect(screen.getByTestId('node-card-body-staging1')).toBeDefined();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    // Toggle back via the dedicated chevron button.
    fireEvent.click(toggle);
    expect(screen.queryByTestId('node-card-body-staging1')).toBeNull();
  });

  it('clicking the Edit button does not toggle expansion', () => {
    mockNodes.mockReturnValue({
      data: { data: [makeNode({ name: 'staging1' })] },
      isLoading: false,
      error: null,
    });
    mockSubsystem.mockReturnValue({ data: { data: { nodes: [] } } });

    renderPage();
    const toggle = screen.getByTestId('node-card-toggle-staging1');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByTestId('edit-node-staging1-button'));
    // The edit modal opens — card expansion is unchanged.
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('ClusterNodes — orphan node removal', () => {
  // Confirms the bugfix: a DB-known node that has been deleted out-of-band
  // from k8s (so listNodesEnriched flips existsInKubernetes to false)
  // must be removable directly from the admin UI without going through
  // the Drain modal — which would fail on the k8s readNode 404.
  it('shows an Orphaned pill and a Remove orphan button when existsInKubernetes is false', () => {
    mockNodes.mockReturnValue({
      data: { data: [makeNode({ name: 'orphan-3', existsInKubernetes: false })] },
      isLoading: false,
      error: null,
    });
    mockSubsystem.mockReturnValue({ data: { data: { nodes: [] } } });

    renderPage();

    expect(screen.getByTestId('node-orphan-tag-orphan-3')).toBeDefined();
    expect(screen.getByTestId('remove-orphan-node-orphan-3-button')).toBeDefined();
    // The drain/edit buttons must be hidden — both would hit
    // NODE_NOT_FOUND on the k8s readNode() pre-check.
    expect(screen.queryByTestId('edit-node-orphan-3-button')).toBeNull();
    expect(screen.queryByTestId('drain-node-orphan-3-open-button')).toBeNull();
  });

  it('Remove orphan button calls the delete mutation (confirm dialog auto-accepted)', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockDeleteMutate.mockClear();
    mockNodes.mockReturnValue({
      data: { data: [makeNode({ name: 'orphan-3', existsInKubernetes: false })] },
      isLoading: false,
      error: null,
    });
    mockSubsystem.mockReturnValue({ data: { data: { nodes: [] } } });

    renderPage();
    fireEvent.click(screen.getByTestId('remove-orphan-node-orphan-3-button'));

    expect(confirmSpy).toHaveBeenCalled();
    expect(mockDeleteMutate).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it('confirm=cancel aborts the Remove orphan flow without calling delete', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mockDeleteMutate.mockClear();
    mockNodes.mockReturnValue({
      data: { data: [makeNode({ name: 'orphan-3', existsInKubernetes: false })] },
      isLoading: false,
      error: null,
    });
    mockSubsystem.mockReturnValue({ data: { data: { nodes: [] } } });

    renderPage();
    fireEvent.click(screen.getByTestId('remove-orphan-node-orphan-3-button'));

    expect(mockDeleteMutate).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

describe('ClusterNodes — the node CLI version (ADR-064)', () => {
  it('shows each node\'s insula CLI, and says when it is behind the cluster', () => {
    role = 'super_admin';
    mockNodes.mockReturnValue({ data: { data: [makeNode({ name: 'sv1' }), makeNode({ name: 'sv2' })] }, isLoading: false, error: null });
    mockSubsystem.mockReturnValue({ data: undefined });
    hostStatus = [
      { node: 'sv1', cliVersion: '2026.10.7-rc.3', cliBehind: false },
      { node: 'sv2', cliVersion: '2026.10.7-rc.2', cliBehind: true },
    ];
    renderPage();
    expect(screen.getByTestId('node-cli-version-sv1')).toHaveTextContent('insula 2026.10.7-rc.3');
    expect(screen.getByTestId('node-cli-version-sv1')).not.toHaveTextContent('update pending');
    expect(screen.getByTestId('node-cli-version-sv2')).toHaveTextContent(/insula 2026\.10\.7-rc\.2\s*update pending/);
  });

  it('"update pending" says when the node checks: hourly on a 2026.10.7 CLI, daily (up to a day) before it', () => {
    role = 'super_admin';
    mockNodes.mockReturnValue({ data: { data: [makeNode({ name: 'sv1' }), makeNode({ name: 'sv2' })] }, isLoading: false, error: null });
    mockSubsystem.mockReturnValue({ data: undefined });
    hostStatus = [
      { node: 'sv1', cliVersion: '2026.10.7', cliBehind: true },
      { node: 'sv2', cliVersion: null, cliBehind: true },
    ];
    renderPage();
    const hint = (node: string) => screen.getByTestId(`node-cli-version-${node}`).querySelector('[title]')?.getAttribute('title') ?? '';
    expect(hint('sv1')).toMatch(/on its own hourly check\.$/);
    expect(hint('sv2')).toMatch(/on its own daily check \(a CLI from before 2026\.10\.7\) — up to a day\.$/);
  });

  it('a role without the upgrade API sees the page without the CLI column (no 403 request)', () => {
    role = 'admin';
    hostStatusEnabled.length = 0;
    mockNodes.mockReturnValue({ data: { data: [makeNode({ name: 'sv1' })] }, isLoading: false, error: null });
    mockSubsystem.mockReturnValue({ data: undefined });
    hostStatus = [{ node: 'sv1', cliVersion: '2026.10.7-rc.3', cliBehind: false }];
    renderPage();
    expect(hostStatusEnabled.every((e) => e === false)).toBe(true);
    expect(screen.queryByTestId('node-cli-version-sv1')).toBeNull();
  });
});


describe('ClusterNodes — in use, committed, free', () => {
  const triad = (inUse: number | null, committed: number, total: number, unit: string) => ({ inUse, committed, total, unit, kind: 'reserve' as const });

  function withUsage(usage: unknown) {
    mockNodes.mockReturnValue({ data: { data: [makeNode({ name: 'n1' })] }, isLoading: false, error: null });
    mockSubsystem.mockReturnValue({ data: { data: { nodes: [] } } });
    mockUsage.mockReturnValue({ data: usage });
    renderPage();
    fireEvent.click(screen.getByTestId('node-card-header-n1'));
  }

  it('shows CPU, memory and disk in the same three words, free being neither in use nor committed', () => {
    // and no "unavailable" note while the reader answers
    withUsage({ data: [{
      name: 'n1', pods: 31,
      cpu: triad(0.9, 3, 4, 'cores'), memory: triad(6, 2, 8, 'GiB'), disk: triad(101, 160, 540, 'GB'),
    }] });
    expect(screen.getByTestId('node-cpu-n1').textContent).toContain('In use 0.90 cores · Committed 3.00 cores · Free 1.00 cores of 4.00 cores');
    // Memory in use above its commitment: free is what is left of the larger.
    expect(screen.getByTestId('node-memory-n1').textContent).toContain('In use 6.0 GiB · Committed 2.0 GiB · Free 2.0 GiB of 8.0 GiB');
    // In GiB, like the Longhorn disk rows: 101 / 160 / 380 / 540 GB.
    expect(screen.getByTestId('node-disk-n1').textContent).toContain('In use 94.1 GiB · Committed 149.0 GiB · Free 353.9 GiB of 502.9 GiB');
    const body = screen.getByTestId('node-card-body-n1').textContent ?? '';
    for (const word of ['requests', 'allocatable', 'Allocatable', 'scheduled', 'Scheduled', 'reserved', 'Ephemeral']) {
      expect(body).not.toContain(word);
    }
    expect(screen.getByTestId('node-summary-n1').textContent).toMatch(/committed.*CPU 75%.*Mem 25%.*Disk 30%.*31 pods/);
    expect(screen.queryByTestId('node-usage-unavailable')).toBeNull();
  });

  it('shows memory in use as process memory and the cache inside free, drawn as its own band', () => {
    withUsage({ data: [{
      name: 'n1', pods: 12,
      cpu: triad(0.7, 2, 4, 'cores'), memory: { ...triad(4.9, 3.5, 14.4, 'GiB'), cache: 3.2 }, disk: null,
    }] });
    const row = screen.getByTestId('node-memory-n1');
    expect(row.textContent).toContain('In use 4.9 GiB · Committed 3.5 GiB · Free 9.5 GiB (cache 3.2 GiB) of 14.4 GiB');
    const band = row.querySelector('[data-band="cache"]') as HTMLElement | null;
    expect(band).not.toBeNull();
    expect(band!.style.width).toBe(`${((3.2 / 14.4) * 100).toFixed(1)}%`);
    // CPU has no cache: no band, no word.
    expect(screen.getByTestId('node-cpu-n1').querySelector('[data-band="cache"]')).toBeNull();
    expect(screen.getByTestId('node-cpu-n1').textContent).not.toContain('cache');
  });

  it('says so when the usage reader failed, and falls back to the inventory: committed known, in use and disk not', () => {
    mockUsage.mockReturnValue({ data: undefined, isError: true } as never);
    mockNodes.mockReturnValue({ data: { data: [makeNode({ name: 'n1' })] }, isLoading: false, error: null });
    mockSubsystem.mockReturnValue({ data: { data: { nodes: [] } } });
    renderPage();
    fireEvent.click(screen.getByTestId('node-card-header-n1'));
    expect(screen.getByTestId('node-usage-unavailable').textContent).toMatch(/Live usage could not be read/);
    expect(screen.getByTestId('node-cpu-n1').textContent).toContain('In use — · Committed 1.00 cores · Free 3.00 cores of 4.00 cores');
    expect(screen.getByTestId('node-disk-n1').textContent).toContain('Disk: not measured');
  });
});
