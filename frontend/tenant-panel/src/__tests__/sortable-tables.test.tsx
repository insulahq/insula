/**
 * Column sorting on tenant tables that had none: each keeps today's order by
 * default, sorts by what a column shows on a click, and reverses on a second.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TrashEntry } from '@insula/api-contracts';
import type { CustomDeploymentRow } from '@/hooks/use-custom-deployments';

const breakdown = vi.hoisted(() => ({
  components: [] as Array<{ name: string; cpu: string; memory: string; weight: number | null; pinned: boolean }>,
}));
const containers = vi.hoisted(() => ({ rows: [] as unknown[] }));
const trash = vi.hoisted(() => ({ entries: [] as unknown[] }));

vi.mock('@/hooks/use-deployments', () => ({
  useResourceBreakdown: () => ({
    data: { data: { total: { cpu: '1', memory: '1Gi' }, components: breakdown.components, warnings: [], qosModel: { cpu: 'burstable', memory: 'guaranteed' } } },
    isLoading: false, isError: false, error: null,
  }),
}));
vi.mock('@/hooks/use-resource-availability', () => ({
  useResourceAvailability: () => ({ data: { data: { cpuModel: 'tiered' } } }),
}));

const idle = { mutate: vi.fn(), isPending: false };
vi.mock('@/hooks/use-custom-deployments', () => ({
  useCustomDeployments: () => ({ data: { data: containers.rows }, isLoading: false, error: null, refetch: vi.fn() }),
  useCheckUpdatesBatch: () => ({ data: undefined, isLoading: false }),
  useForceCheckUpdatesBatch: () => idle,
  useDeleteCustomDeployment: () => idle,
  useUpdateCustomDeployment: () => idle,
  useUpdateNowCustomDeployment: () => idle,
  useStopStartCustomDeployment: () => idle,
  useSetAutoUpdate: () => idle,
}));
vi.mock('@/components/custom-deployments/SimpleContainerWizard', () => ({ SimpleContainerWizard: () => null }));
vi.mock('@/components/custom-deployments/ComposeEditor', () => ({ ComposeEditor: () => null }));
vi.mock('@/components/custom-deployments/PrivateRegistryPanel', () => ({ PrivateRegistryPanel: () => null }));
vi.mock('@/components/custom-deployments/UpdatesPill', () => ({ UpdatesPill: () => null }));
vi.mock('@/components/custom-deployments/UpgradeTagModal', () => ({ UpgradeTagModal: () => null, suggestedUpgradeImage: () => null }));
vi.mock('@/components/AppPreviewModal', () => ({ default: () => null }));

vi.mock('@/hooks/use-trash', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-trash')>()),
  useTrash: () => ({
    data: { entries: trash.entries, usedBytes: 0, usedFormatted: '0 B', retentionDays: 14 },
    isLoading: false, isError: false, error: null,
  }),
  useRestoreFromTrash: () => idle,
  usePurgeTrash: () => idle,
}));

const { ResourceBreakdown } = await import('../components/ResourceBreakdown');
const { CustomContainersTab } = await import('../components/custom-deployments/CustomContainersTab');
const { default: ProvidersTable } = await import('../components/settings/ProvidersTable');
const { default: TrashPanel } = await import('../components/files/TrashPanel');

/** Body rows of a table (not its header or total), in display order. */
function rowOrder(table: HTMLElement, read: (row: HTMLElement) => string | null): Array<string | null> {
  return Array.from(table.querySelectorAll<HTMLElement>('tbody > tr')).map(read);
}
const byTestId = (prefix: string) => (row: HTMLElement) => row.getAttribute('data-testid')?.replace(prefix, '') ?? null;
const firstCell = (row: HTMLElement) => row.querySelector('td')?.textContent?.trim() ?? null;

describe('ResourceBreakdown — per-component allocation', () => {
  it('lists components by name, and sorts CPU and memory by quantity rather than text', () => {
    breakdown.components = [
      { name: 'web', cpu: '450m', memory: '900Mi', weight: 50, pinned: false },
      { name: 'db', cpu: '1', memory: '1Gi', weight: 35, pinned: false },
      { name: 'cron', cpu: '50m', memory: '64Mi', weight: null, pinned: true },
    ];
    render(<ResourceBreakdown tenantId="t1" deploymentId="d1" />);
    const table = screen.getByRole('table');
    expect(rowOrder(table, firstCell)).toEqual(['cron', 'db', 'web']);

    fireEvent.click(screen.getByTestId('sort-memoryValue'));
    expect(rowOrder(table, firstCell)).toEqual(['cron', 'web', 'db']); // 64Mi < 900Mi < 1Gi
    fireEvent.click(screen.getByTestId('sort-memoryValue'));
    expect(rowOrder(table, firstCell)).toEqual(['db', 'web', 'cron']);

    fireEvent.click(screen.getByTestId('sort-cpuValue'));
    expect(rowOrder(table, firstCell)).toEqual(['cron', 'web', 'db']); // 50m < 450m < 1
  });
});

describe('CustomContainersTab — custom containers', () => {
  const row = (id: string, name: string, createdAt: string, status: string, image: string): CustomDeploymentRow => ({
    id, tenantId: 't1', name, status, storagePath: null, currentNodeName: null, statusMessage: null, lastError: null,
    createdAt, updatedAt: createdAt,
    customSpec: { sourceMode: 'simple', services: { app: { image } } } as unknown as CustomDeploymentRow['customSpec'],
  });

  it('keeps the newest-first order, then sorts by name and by status', () => {
    containers.rows = [
      row('c2', 'beta', '2026-10-02T00:00:00Z', 'running', 'nginx:1.27'),
      row('c3', 'gamma', '2026-10-03T00:00:00Z', 'stopped', 'redis:7'),
      row('c1', 'alpha', '2026-10-01T00:00:00Z', 'failed', 'httpd:2'),
    ];
    render(<CustomContainersTab tenantId="t1" canManage={false} />);
    const table = screen.getByTestId('custom-deployments-table');
    const order = () => rowOrder(table, byTestId('custom-row-'));
    expect(order()).toEqual(['c3', 'c2', 'c1']);

    fireEvent.click(screen.getByTestId('sort-name'));
    expect(order()).toEqual(['c1', 'c2', 'c3']);
    fireEvent.click(screen.getByTestId('sort-name'));
    expect(order()).toEqual(['c3', 'c2', 'c1']);

    fireEvent.click(screen.getByTestId('sort-status'));
    expect(order()).toEqual(['c1', 'c2', 'c3']); // failed < running < stopped
  });
});

describe('ProvidersTable — provider lists', () => {
  it('lists providers by name and sorts by how many ingresses use them', () => {
    const rows = [
      { id: 'p1', name: 'Keycloak', consumerCount: 0 },
      { id: 'p2', name: 'authentik', consumerCount: 3 },
      { id: 'p3', name: 'Zitadel', consumerCount: 1 },
    ];
    render(
      <ProvidersTable title="Providers" emptyMessage="none" rows={rows} isLoading={false}
        onCreate={() => {}} onEdit={() => {}} onDelete={() => {}} testIdPrefix="oidc-providers" />,
    );
    const table = screen.getByTestId('oidc-providers-table');
    const order = () => rowOrder(table, byTestId('oidc-providers-row-'));
    expect(order()).toEqual(['p2', 'p1', 'p3']); // case-insensitive by name

    fireEvent.click(screen.getByTestId('sort-consumerCount'));
    expect(order()).toEqual(['p1', 'p3', 'p2']);
    fireEvent.click(screen.getByTestId('sort-consumerCount'));
    expect(order()).toEqual(['p2', 'p3', 'p1']);
  });
});

describe('TrashPanel — recycle bin', () => {
  const entry = (id: string, name: string, deletedAt: string, sizeBytes: number | null): TrashEntry => ({
    id, shard: 's', originalPath: `site/${name}`, name, type: 'file', sizeBytes, deletedAt, deletedBy: null,
  } as TrashEntry);

  it('keeps the most recently deleted first, and sorts sizes by bytes with unknown sizes last', () => {
    const now = Date.now();
    const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
    trash.entries = [
      entry('e1', 'b.txt', ago(1), 2048),
      entry('e2', 'a.txt', ago(3), null),
      entry('e3', 'c.txt', ago(2), 900),
    ];
    render(<TrashPanel />);
    const table = screen.getByRole('table');
    const order = () => rowOrder(table, byTestId('trash-row-'));
    expect(order()).toEqual(['e1', 'e3', 'e2']);

    fireEvent.click(screen.getByTestId('sort-sizeBytes'));
    expect(order()).toEqual(['e3', 'e1', 'e2']);

    fireEvent.click(screen.getByTestId('sort-purgeAtMs'));
    expect(order()).toEqual(['e2', 'e3', 'e1']); // removed soonest first
    fireEvent.click(screen.getByTestId('sort-purgeAtMs'));
    expect(order()).toEqual(['e1', 'e3', 'e2']);
  });
});
