/**
 * Node aliases on every admin surface. The operator names a node once (Nodes
 * → Edit → Display name) and every page shows that name instead of whatever
 * the host was called at install; an unaliased node keeps its Kubernetes name.
 * What must not happen: a name rewritten inside something to TYPE (a code
 * span, a typed confirmation), a near-miss name rewritten (`sv10`, `pvc-sv1`),
 * or a page that crashes because the label lookup is unavailable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NodeLabel } from '@insula/api-contracts';

const fetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => fetchMock(...a) }));

const { aliasMap, nodeTextAliaser } = await import('@/hooks/use-node-labels');
const { default: NodeName } = await import('@/components/nodes/NodeName');
const { default: NodeList } = await import('@/components/nodes/NodeList');
const { default: NodeText } = await import('@/components/nodes/NodeText');
const { default: PlacementCell } = await import('@/components/tenants/PlacementCell');

const LABELS: NodeLabel[] = [
  { name: 'sv1', hostname: 'sv1', label: 'Primary' },
  { name: 'sv2.cluster.example.test', hostname: 'sv2', label: 'Secondary' },
  { name: 'worker-3', hostname: 'worker-3', label: 'worker-3' },
];

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/v1/admin/node-labels') return { data: LABELS };
    throw new Error(`unexpected ${url}`);
  });
});

describe('aliasMap', () => {
  it('maps the Kubernetes name and the hostname of aliased nodes only', () => {
    const m = aliasMap(LABELS);
    expect(m.get('sv1')).toBe('Primary');
    expect(m.get('sv2.cluster.example.test')).toBe('Secondary');
    expect(m.get('sv2')).toBe('Secondary');
    expect(m.has('worker-3')).toBe(false);
  });
});

describe('nodeTextAliaser', () => {
  const alias = nodeTextAliaser(aliasMap(LABELS));

  it('replaces whole node names, longest first', () => {
    expect(alias('moved from sv2.cluster.example.test to sv1, sv2 next'))
      .toBe('moved from Secondary to Primary, Secondary next');
  });

  it('leaves near-miss names alone', () => {
    expect(alias('sv10 and pvc-sv1 and sv1.other.test and worker-3'))
      .toBe('sv10 and pvc-sv1 and sv1.other.test and worker-3');
  });

  it('leaves code spans alone — a command must keep the real name', () => {
    expect(alias('sv1 is cordoned; run `kubectl uncordon sv1`'))
      .toBe('Primary is cordoned; run `kubectl uncordon sv1`');
  });

  it('is the identity without aliases', () => {
    expect(nodeTextAliaser(new Map())('sv1')).toBe('sv1');
  });
});

describe('NodeName', () => {
  it('shows the alias with the Kubernetes name on hover', async () => {
    render(<NodeName name="sv2.cluster.example.test" />, { wrapper });
    const el = await screen.findByText('Secondary');
    expect(el).toHaveAttribute('title', 'sv2.cluster.example.test');
  });

  it('shows the Kubernetes name of a node with no alias', async () => {
    render(<NodeName name="worker-3" />, { wrapper });
    expect(await screen.findByText('worker-3')).toBeInTheDocument();
  });

  it('renders the plain name when the labels cannot be read', async () => {
    fetchMock.mockRejectedValue(new Error('403'));
    render(<NodeName name="sv1" />, { wrapper });
    expect(await screen.findByText('sv1')).toBeInTheDocument();
  });

  it('ignores a malformed labels answer instead of crashing the page', async () => {
    fetchMock.mockResolvedValue({ data: { nodes: [] } });
    render(<NodeName name="sv1" />, { wrapper });
    expect(await screen.findByText('sv1')).toBeInTheDocument();
  });

  it('renders outside a query provider, unaliased, without fetching', () => {
    render(<NodeName name="sv1" />);
    expect(screen.getByText('sv1')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('NodeList and NodeText', () => {
  it('lists several nodes by alias', async () => {
    const { container } = render(<NodeList names={['sv1', 'worker-3']} />, { wrapper });
    await screen.findByText('Primary');
    expect(container.textContent).toBe('Primary, worker-3');
  });

  it('aliases server-written text', async () => {
    render(<p data-testid="t"><NodeText text="running on sv2, data on sv1" /></p>, { wrapper });
    expect(await screen.findByText('running on Secondary, data on Primary')).toBeInTheDocument();
  });
});

describe('a tenant page cell', () => {
  it('names the primary node by its alias, keeping the Kubernetes name in the tooltip', async () => {
    render(<PlacementCell nodeName="sv1" placement={null} />, { wrapper });
    const el = await screen.findByText('Primary');
    expect(el).toHaveAttribute('title', 'Pinned to node Primary (sv1)');
  });

  it('names a misplaced tenant’s nodes by alias', async () => {
    render(
      <PlacementCell
        nodeName="sv1"
        placement={{
          status: 'misplaced', primaryNode: 'sv1', actualNodes: ['sv2'], reasons: ['running on sv2'],
          misplacedSince: null, checkedAt: '2026-10-03T09:00:00.000Z',
        }}
      />,
      { wrapper },
    );
    expect(await screen.findByText('Secondary')).toBeInTheDocument();
    expect(screen.getByText('primary Primary')).toBeInTheDocument();
    expect(screen.getByTestId('placement-misplaced'))
      .toHaveAttribute('title', 'Not on its primary node Primary — running on Secondary');
  });
});
