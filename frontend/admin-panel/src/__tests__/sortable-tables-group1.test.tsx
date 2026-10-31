/**
 * Column sorting on the admin tables that had none (group 1): each table opens
 * in the order it always showed, a header click sorts by what that column
 * shows, and a second click reverses it.
 *
 * Only components without a test file of their own are here; the rest are
 * covered next to their existing tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  BackupHealthSummary,
  MailEndpointSet,
  OrphanedVolumeEntry,
  TrustedProxyRange,
} from '@insula/api-contracts';

const routes = new Map<string, unknown>();
const fetchMock = vi.fn(async (url: string) => {
  for (const [prefix, body] of routes) if (url.startsWith(prefix)) return body;
  return { data: [] };
});
vi.mock('@/lib/api-client', () => ({ apiFetch: (url: string) => fetchMock(url) }));

const { default: BackupHealthTable } = await import('@/components/BackupHealthTable');
const { default: MailEndpointsSection } = await import('@/components/MailEndpointsSection');
const { default: MailSslStatusModal } = await import('@/components/MailSslStatusModal');
const { default: StuckDeprovisionsPanel } = await import('@/components/StuckDeprovisionsPanel');
const { default: TrustedProxiesCard } = await import('@/components/TrustedProxiesCard');
const { default: OrphanedVolumesModal } = await import('@/components/OrphanedVolumesModal');
const { default: ActiveSessionsPanel } = await import('@/components/security/ActiveSessionsPanel');
const { default: DeployedImagesModal } = await import('@/components/platform/DeployedImagesModal');
const { default: NodeTerminalSessionsPanel } = await import('@/components/security/NodeTerminalSessionsPanel');

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** The text of column `col` in every body row of `table`, top to bottom. */
function column(table: HTMLElement, col = 0): string[] {
  return Array.from(table.querySelectorAll('tbody > tr'))
    .map((tr) => (tr.querySelectorAll('td')[col]?.textContent ?? '').trim());
}

const testIds = (pattern: RegExp): string[] =>
  screen.getAllByTestId(pattern).map((el) => el.getAttribute('data-testid') ?? '');

beforeEach(() => {
  routes.clear();
  fetchMock.mockClear();
});

describe('BackupHealthTable', () => {
  const row = (displayName: string, state: BackupHealthSummary['state'], lastSuccessAt: string | null): BackupHealthSummary => ({
    groupKey: displayName.toLowerCase(), displayName, namespace: 'platform', category: 'dr', severity: 'critical',
    tenantId: null, state, lastSuccessAt, lastFailedAt: null, lastFailedReason: null, recentRuns: 1,
  });
  const summaries = [
    row('Mike', 'healthy', '2026-10-30T10:00:00.000Z'),
    row('Alpha', 'failing', '2026-10-01T10:00:00.000Z'),
    row('Zulu', 'never_run', null),
  ];

  it('opens worst state first, then sorts by name both ways', () => {
    render(<BackupHealthTable summaries={summaries} />);
    const table = screen.getByRole('table');
    expect(column(table, 1).map((t) => t.split('platform/')[0])).toEqual(['Alpha', 'Zulu', 'Mike']);

    fireEvent.click(screen.getByTestId('sort-displayName'));
    expect(column(table, 1).map((t) => t.split('platform/')[0])).toEqual(['Alpha', 'Mike', 'Zulu']);
    fireEvent.click(screen.getByTestId('sort-displayName'));
    expect(column(table, 1).map((t) => t.split('platform/')[0])).toEqual(['Zulu', 'Mike', 'Alpha']);
  });

  it('sorts "Last success" by the instant, "never" after every date', () => {
    render(<BackupHealthTable summaries={summaries} />);
    fireEvent.click(screen.getByTestId('sort-lastSuccessAt'));
    expect(column(screen.getByRole('table'), 1).map((t) => t.split('platform/')[0])).toEqual(['Alpha', 'Mike', 'Zulu']);
  });
});

describe('MailEndpointsSection', () => {
  const endpoint = (node: string, exposure: 'hostPort' | 'haproxy', active: boolean) => ({
    node, roles: [], active, exposure, addresses: [{ address: `192.0.2.${node.slice(2)}`, family: 'ipv4' as const, source: 'ExternalIP' as const }],
  });
  const endpoints: MailEndpointSet = {
    mode: 'allServerNodes', activeNode: 'sv1', activeNodeSource: 'pod', ports: [25],
    endpoints: [endpoint('sv1', 'hostPort', true), endpoint('sv3', 'haproxy', false), endpoint('sv2', 'haproxy', false)],
    untested: [{ node: 'sv0', roles: ['secondary'], reason: 'standby', detail: 'standby' }],
  };
  const order = () => testIds(/^mail-(endpoint|untested)-sv/);

  it('opens in the server order — active node first — and keeps the untested nodes last', () => {
    render(<MailEndpointsSection endpoints={endpoints} exposure={undefined} />);
    expect(order()).toEqual(['mail-endpoint-sv1', 'mail-endpoint-sv3', 'mail-endpoint-sv2', 'mail-untested-sv0']);

    fireEvent.click(screen.getByTestId('sort-node'));
    expect(order()).toEqual(['mail-endpoint-sv1', 'mail-endpoint-sv2', 'mail-endpoint-sv3', 'mail-untested-sv0']);
    fireEvent.click(screen.getByTestId('sort-node'));
    expect(order()).toEqual(['mail-endpoint-sv3', 'mail-endpoint-sv2', 'mail-endpoint-sv1', 'mail-untested-sv0']);
  });
});

describe('MailSslStatusModal', () => {
  const listener = (name: string, port: number, notAfter: string) => ({
    listener: name, port, host: 'mail.example.test', tlsMode: 'implicit', connected: true, tlsProtocol: 'TLSv1.3',
    cipher: null, error: null, durationMs: 5,
    cert: { subject: 'CN=mail', issuer: 'R11', subjectAlternativeNames: [], notBefore: '2026-08-01T00:00:00.000Z',
      notAfter, daysUntilExpiry: 30, serialNumber: '1', fingerprintSha256: 'aa' },
  });

  it('lists the listeners in probe order, then by expiry both ways', async () => {
    routes.set('/api/v1/admin/email-settings/ssl-status', { data: {
      host: 'mail.example.test', webmailHost: null, cachedTtlMs: 30_000,
      // Out of probe order on purpose: the Listener column restores it.
      listeners: [
        listener('webmail-https', 443, '2027-01-10T00:00:00.000Z'),
        listener('smtp', 25, '2026-12-01T00:00:00.000Z'),
        listener('imaps', 993, '2026-11-15T00:00:00.000Z'),
      ],
    } });
    renderWithClient(<MailSslStatusModal onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('mail-ssl-status-refresh'));
    await screen.findByTestId('mail-ssl-status-table');
    const order = () => testIds(/^mail-ssl-row-/);
    expect(order()).toEqual(['mail-ssl-row-smtp', 'mail-ssl-row-imaps', 'mail-ssl-row-webmail-https']);

    fireEvent.click(screen.getByTestId('sort-expires'));
    expect(order()).toEqual(['mail-ssl-row-imaps', 'mail-ssl-row-smtp', 'mail-ssl-row-webmail-https']);
    fireEvent.click(screen.getByTestId('sort-expires'));
    expect(order()).toEqual(['mail-ssl-row-webmail-https', 'mail-ssl-row-smtp', 'mail-ssl-row-imaps']);
  });
});

describe('StuckDeprovisionsPanel', () => {
  it('opens longest-stuck first, then sorts by namespace both ways', async () => {
    const ns = (name: string, hours: number) => ({ name, deletionTimestamp: null, finalizers: [], tenantId: null, stuckForMs: hours * 3_600_000 });
    routes.set('/api/v1/admin/stuck-deprovisions', { data: [ns('tenant-b', 5), ns('tenant-a', 2), ns('tenant-c', 1)] });
    renderWithClient(<StuckDeprovisionsPanel />);
    const panel = await screen.findByTestId('stuck-deprovisions-panel');
    const table = within(panel).getByRole('table');
    expect(column(table)).toEqual(['tenant-b', 'tenant-a', 'tenant-c']);

    fireEvent.click(screen.getByTestId('sort-name'));
    expect(column(table)).toEqual(['tenant-a', 'tenant-b', 'tenant-c']);
    fireEvent.click(screen.getByTestId('sort-name'));
    expect(column(table)).toEqual(['tenant-c', 'tenant-b', 'tenant-a']);
  });
});

describe('TrustedProxiesCard', () => {
  it('opens system → bootstrap → operator, then sorts by CIDR both ways', async () => {
    const range = (cidr: string, source: TrustedProxyRange['source']): TrustedProxyRange => ({
      id: null, cidr, description: `${source} range`, source, createdAt: null, createdByEmail: null,
    });
    routes.set('/api/v1/admin/cluster-network/trusted-proxies', { data: {
      ranges: [range('192.0.2.0/24', 'operator'), range('172.16.0.0/12', 'system'), range('10.42.0.0/16', 'bootstrap')],
      lastReconciledAt: null, lastReconcileError: null, panelPodsRolled: 0, panelPodsTotal: 0,
    } });
    renderWithClient(<TrustedProxiesCard />);
    const table = await screen.findByTestId('trusted-proxies-table');
    expect(column(table)).toEqual(['172.16.0.0/12', '10.42.0.0/16', '192.0.2.0/24']);

    fireEvent.click(screen.getByTestId('sort-cidr'));
    expect(column(table)).toEqual(['10.42.0.0/16', '172.16.0.0/12', '192.0.2.0/24']);
    fireEvent.click(screen.getByTestId('sort-cidr'));
    expect(column(table)).toEqual(['192.0.2.0/24', '172.16.0.0/12', '10.42.0.0/16']);
  });
});

describe('OrphanedVolumesModal', () => {
  it('opens largest first, then sorts by owner both ways', async () => {
    const orphan = (name: string, ownerLabel: string, gib: number): OrphanedVolumeEntry => ({
      pvName: `pv-${name}`, longhornVolumeName: name, namespace: 'tenant-x', pvcName: `data-${name}`,
      sizeBytes: gib * 1024 ** 3, nodes: [], reason: 'namespace_deleted', ageDays: 3, ownerLabel,
      canonicalRole: null, canonicalOwner: null,
    });
    routes.set('/api/v1/admin/orphaned-volumes', { data: {
      orphans: [orphan('vol-c', 'Zeta', 10), orphan('vol-a', 'Alpha', 5), orphan('vol-b', 'Mid', 1)],
      totalCount: 3, totalBytes: 16 * 1024 ** 3, stalePvThresholdDays: 7,
    } });
    renderWithClient(<OrphanedVolumesModal onClose={() => {}} />);
    await screen.findByTestId('orphans-table');
    const order = () => testIds(/^orphan-row-/);
    expect(order()).toEqual(['orphan-row-vol-c', 'orphan-row-vol-a', 'orphan-row-vol-b']);

    fireEvent.click(screen.getByTestId('sort-ownerLabel'));
    expect(order()).toEqual(['orphan-row-vol-a', 'orphan-row-vol-b', 'orphan-row-vol-c']);
    fireEvent.click(screen.getByTestId('sort-ownerLabel'));
    expect(order()).toEqual(['orphan-row-vol-c', 'orphan-row-vol-b', 'orphan-row-vol-a']);
  });
});

describe('ActiveSessionsPanel', () => {
  it('opens oldest first, then sorts by IP both ways', async () => {
    const session = (id: string, issuedAt: string, ipAddress: string) => ({
      id, userId: 'u1', panel: 'admin', tenantId: null, userAgent: 'Firefox', ipAddress, issuedAt,
      expiresAt: '2026-11-30T00:00:00.000Z', lastUsedAt: null,
    });
    routes.set('/api/v1/admin/users/u1/sessions', { data: { sessions: [
      session('s1', '2026-10-01T08:00:00.000Z', '203.0.113.9'),
      session('s3', '2026-10-03T08:00:00.000Z', '192.0.2.5'),
      session('s2', '2026-10-05T08:00:00.000Z', '198.51.100.1'),
    ] } });
    routes.set('/api/v1/auth/me/sessions', { data: { sessions: [], currentSessionId: null } });
    renderWithClient(<ActiveSessionsPanel userId="u1" userEmail="ops@example.test" isSelf={false} callerRole="super_admin" />);
    await screen.findByTestId('active-sessions-table');
    const order = () => testIds(/^session-row-/);
    expect(order()).toEqual(['session-row-s1', 'session-row-s3', 'session-row-s2']);

    fireEvent.click(screen.getByTestId('sort-ipAddress'));
    expect(order()).toEqual(['session-row-s3', 'session-row-s2', 'session-row-s1']);
    fireEvent.click(screen.getByTestId('sort-ipAddress'));
    expect(order()).toEqual(['session-row-s1', 'session-row-s2', 'session-row-s3']);
  });
});

describe('DeployedImagesModal', () => {
  it('groups by namespace, then sorts by component both ways', async () => {
    const image = (component: string, namespace: string, running = 1) => ({
      component, namespace, image: `ghcr.io/example/${component}`, tag: '1.0', running, desired: 1, healthy: running === 1,
    });
    routes.set('/api/v1/admin/platform/images', { data: [
      image('platform-api', 'platform'), image('admin-panel', 'platform'), image('stalwart', 'mail'),
    ] });
    renderWithClient(<DeployedImagesModal onClose={() => {}} />);
    const table = await screen.findByTestId('platform-images-table');
    expect(column(table)).toEqual(['stalwart', 'platform-api', 'admin-panel']);

    fireEvent.click(screen.getByTestId('sort-component'));
    expect(column(table)).toEqual(['admin-panel', 'platform-api', 'stalwart']);
    fireEvent.click(screen.getByTestId('sort-component'));
    expect(column(table)).toEqual(['stalwart', 'platform-api', 'admin-panel']);
  });
});

describe('NodeTerminalSessionsPanel', () => {
  it('sorts the Node column by the alias it shows', async () => {
    const session = (sessionId: string, userEmail: string, nodeName: string) => ({
      sessionId, nodeName, podName: `term-${sessionId}`, userId: 'u', userEmail, ownerReplica: 'api-0',
      createdAt: '2026-10-31T08:00:00.000Z', expiresAt: '2026-10-31T09:00:00.000Z', lastActivityAt: '2026-10-31T08:30:00.000Z',
    });
    routes.set('/api/v1/admin/node-terminal/sessions', { data: [
      session('t1', 'bob@example.test', 'sv1.example.test'),
      session('t2', 'alice@example.test', 'sv2.example.test'),
    ] });
    routes.set('/api/v1/admin/node-labels', { data: [
      { name: 'sv1.example.test', hostname: null, label: 'Alpha' },
      { name: 'sv2.example.test', hostname: null, label: 'Zulu' },
    ] });
    renderWithClient(<NodeTerminalSessionsPanel />);
    await screen.findByText('Zulu');
    const table = within(screen.getByTestId('node-terminal-sessions-panel')).getByRole('table');
    expect(column(table)).toEqual(['alice@example.test', 'bob@example.test']);

    // By Kubernetes name sv2 would sort after sv1; by alias, Alpha (sv1) leads.
    fireEvent.click(screen.getByTestId('sort-nodeName'));
    expect(column(table, 1)).toEqual(['Alpha', 'Zulu']);
    fireEvent.click(screen.getByTestId('sort-nodeName'));
    expect(column(table, 1)).toEqual(['Zulu', 'Alpha']);
  });
});
