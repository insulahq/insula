/**
 * Column sorting on the admin tables that list records (group 2).
 *
 * One test per converted table: it renders in the order it had before the
 * change, a header click sorts by that column, and a second click reverses.
 * Tables of components that already had a test file are covered there
 * (ProvidersTable, ApiTokensSection, CpuSchedulingPage, RecoverAllTab,
 * MigrationTab, DatabaseIsolationTable, the catalog versions table).
 *
 * Reads go through a path-routed `apiFetch` mock, so each component runs its
 * real hooks against canned answers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { DrRecoveryBundle, TrafficFrame } from '@insula/api-contracts';
import type { Tenant } from '@/types/api';
import { apiFetch } from '@/lib/api-client';
import DrDrillRunsSection from '@/components/system-backup/DrDrillRunsSection';
import { BundleChooser } from '@/components/system-backup/RecoverTenantPickers';
import SecretsBundleTab from '@/components/system-backup/SecretsBundleTab';
import StorageTab from '@/components/tenant-detail/StorageTab';
import TenantEmailTab from '@/components/tenant-detail/EmailTab';
import TrafficSummaryTable from '@/components/traffic/TrafficSummaryTable';
import TemplatesTable from '@/features/notifications/TemplatesTable';
import NetworkTrustPage from '@/pages/NetworkTrustPage';
import PosturePage from '@/pages/PosturePage';
import LifecycleHooksPage from '@/pages/platform/LifecycleHooksPage';
import PleskMigrationPage from '@/pages/platform/PleskMigrationPage';

vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

// Siblings of the tables under test that read endpoints of their own.
vi.mock('@/components/tenant-detail/PlacementSection', () => ({ default: () => null }));
vi.mock('@/components/tenant-detail/StorageLifecycleCard', () => ({ StorageLifecycleCard: () => null }));
vi.mock('@/components/tenant-detail/PvcPlacementSection', () => ({ PvcPlacementSection: () => null }));
vi.mock('@/components/tenant-detail/TenantBackups', () => ({ TenantBundlesSummary: () => null, BackupsTab: () => null }));
vi.mock('@/components/RetainedVolumesCard', () => ({ default: () => null }));
vi.mock('@/components/OrphanedVolumesAlert', () => ({ default: () => null }));
vi.mock('@/components/tenant-detail/MailDailyChart', () => ({ default: () => null }));
vi.mock('@/components/lifecycle/TenantAutomationCard', () => ({ default: () => null }));

/** Answers by path: the first entry whose fragment the path contains. */
let routes: ReadonlyArray<readonly [string, unknown]> = [];

beforeEach(() => {
  routes = [];
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(((path: string) => {
    const hit = routes.find(([fragment]) => path.includes(fragment));
    return Promise.resolve(hit ? hit[1] : { data: [], pagination: { has_more: false, next_cursor: null } });
  }) as never);
});

function renderUi(ui: ReactElement, path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** This table's own body rows — `:scope` so a table nested in another's body is not mixed in. */
const bodyRows = (table: Element): Element[] => Array.from(table.querySelectorAll(':scope > tbody > tr'));
const column = (table: Element, index = 0): Array<string | undefined> =>
  bodyRows(table).map((r) => r.querySelectorAll(':scope > td')[index]?.textContent?.trim());
const testIds = (prefix: string): Array<string | null> =>
  Array.from(document.querySelectorAll(`[data-testid^="${prefix}"]`)).map((el) => el.getAttribute('data-testid'));

// ─── System backup ──────────────────────────────────────────────────────

describe('DR drill history', () => {
  it('lists the newest run first, and sorts by duration both ways', async () => {
    const run = (id: string, startedAt: string, durationSeconds: number) => ({
      id, startedAt, status: 'success', trigger: 'schedule', durationSeconds, secretsRestoredCount: 4,
      failureReason: null, runner: `gh-${id}`, finishedAt: startedAt, reportUrl: null,
    });
    routes = [
      ['/dr-drill/runs', { data: [run('r1', '2026-10-20T04:00:00.000Z', 300), run('r2', '2026-10-27T04:00:00.000Z', 120), run('r3', '2026-10-13T04:00:00.000Z', 30)] }],
      ['/dr-drill/summary', { data: null }],
    ];
    renderUi(<DrDrillRunsSection />);
    const table = await screen.findByTestId('dr-drill-runs-table');
    expect(column(table, 3)).toEqual(['120s', '300s', '30s']);
    fireEvent.click(within(table).getByTestId('sort-durationSeconds'));
    expect(column(table, 3)).toEqual(['30s', '120s', '300s']);
    fireEvent.click(within(table).getByTestId('sort-durationSeconds'));
    expect(column(table, 3)).toEqual(['300s', '120s', '30s']);
  });
});

describe('Recover tenant — bundle chooser', () => {
  it('lists the newest bundle first, and sorts by size both ways', () => {
    const bundle = (id: string, createdAt: string, sizeBytes: number): DrRecoveryBundle => ({
      id, createdAt, sizeBytes, status: 'completed', trigger: 'scheduled', label: null, components: [], expiresAt: null,
    } as unknown as DrRecoveryBundle);
    renderUi(
      <BundleChooser
        bundles={[bundle('b1', '2026-10-30T00:00:00.000Z', 5_000), bundle('b2', '2026-10-29T00:00:00.000Z', 9_000), bundle('b3', '2026-10-28T00:00:00.000Z', 1_000)]}
        value=""
        onChange={vi.fn()}
      />,
    );
    expect(testIds('dr-bundle-')).toEqual(['dr-bundle-b1', 'dr-bundle-b2', 'dr-bundle-b3']);
    fireEvent.click(screen.getByTestId('sort-sizeBytes'));
    expect(testIds('dr-bundle-')).toEqual(['dr-bundle-b3', 'dr-bundle-b1', 'dr-bundle-b2']);
    fireEvent.click(screen.getByTestId('sort-sizeBytes'));
    expect(testIds('dr-bundle-')).toEqual(['dr-bundle-b2', 'dr-bundle-b1', 'dr-bundle-b3']);
  });
});

describe('Secrets bundle tab', () => {
  const secret = (category: string, namespace: string, name: string) => ({ category, namespace, name, type: 'Opaque', reason: `${category} reason` });

  beforeEach(() => {
    routes = [
      ['/secrets/manifest', { data: { items: [], operatorRecipient: null } }],
      ['/secrets/runs', {
        data: [
          { id: 'run-1', status: 'succeeded', startedAt: '2026-10-20T00:00:00.000Z', finishedAt: null, sizeBytes: 300, sha256: null, operatorUserId: null, downloadedAt: null },
          { id: 'run-2', status: 'succeeded', startedAt: '2026-10-25T00:00:00.000Z', finishedAt: null, sizeBytes: 100, sha256: null, operatorUserId: null, downloadedAt: null },
          { id: 'run-3', status: 'failed', startedAt: '2026-10-10T00:00:00.000Z', finishedAt: null, sizeBytes: 200, sha256: null, operatorUserId: null, downloadedAt: null },
        ],
      }],
      ['/secrets-audit/allowlist', {
        data: {
          entries: [
            { namespace: 'platform', name: 'first', reason: 'rotate on restore', addedBy: 'u1', addedAt: '2026-10-01T00:00:00.000Z' },
            { namespace: 'platform', name: 'second', reason: 'rotate on restore', addedBy: 'u2', addedAt: '2026-10-05T00:00:00.000Z' },
          ],
        },
      }],
      ['/secrets-audit', {
        data: {
          generatedAt: '2026-10-31T00:00:00.000Z', totalSecretsCount: 3, healthy: true, skipAtRestoreSecrets: [],
          byCategory: { denied: 1, tier1Platform: 1, tier2Tenant: 1, unclassified: 0, skipAtRestore: 0 },
          // As the server orders them: category, then namespace/name.
          allSecrets: [secret('denied', 'zeta', 'a'), secret('tier-1-platform', 'platform', 'jwt'), secret('tier-2-tenant', 'alpha', 'db')],
        },
      }],
      ['/admin/users', { data: [{ id: 'u1', email: 'zed@example.test', fullName: 'Zed' }, { id: 'u2', email: 'amy@example.test', fullName: 'Amy' }] }],
    ];
  });

  it('lists recent exports newest first, and sorts them by size both ways', async () => {
    renderUi(<SecretsBundleTab />);
    const table = await screen.findByTestId('runs-history-table');
    expect(column(table, 2)).toEqual(['100 B', '300 B', '200 B']);
    fireEvent.click(within(table).getByTestId('sort-sizeBytes'));
    expect(column(table, 2)).toEqual(['100 B', '200 B', '300 B']);
    fireEvent.click(within(table).getByTestId('sort-sizeBytes'));
    expect(column(table, 2)).toEqual(['300 B', '200 B', '100 B']);
  });

  it('keeps the audit\'s category order, and sorts the secrets by namespace both ways', async () => {
    renderUi(<SecretsBundleTab />);
    const table = await screen.findByTestId('audit-table');
    expect(column(table, 0)).toEqual(['zeta', 'platform', 'alpha']);
    fireEvent.click(within(table).getByTestId('sort-namespace'));
    expect(column(table, 0)).toEqual(['alpha', 'platform', 'zeta']);
    fireEvent.click(within(table).getByTestId('sort-namespace'));
    expect(column(table, 0)).toEqual(['zeta', 'platform', 'alpha']);
  });

  it('sorts skip-at-restore entries by the person shown, not the user id', async () => {
    renderUi(<SecretsBundleTab />);
    const table = await screen.findByTestId('allowlist-table');
    await within(table).findByText('Amy (amy@example.test)');
    // In the order they were added.
    expect(column(table, 0)).toEqual(['platform/first', 'platform/second']);
    fireEvent.click(within(table).getByTestId('sort-addedBy'));
    expect(column(table, 0)).toEqual(['platform/second', 'platform/first']);
    fireEvent.click(within(table).getByTestId('sort-addedBy'));
    expect(column(table, 0)).toEqual(['platform/first', 'platform/second']);
  });
});

// ─── Tenant detail ──────────────────────────────────────────────────────

const TENANT = {
  id: 'tenant-001', name: 'Acme', planId: null, kubernetesNamespace: null, nodeName: null,
  emailOutboundSuspended: false, emailSendRateLimit: null, emailSendRateLimitDaily: null,
} as unknown as Tenant;

describe('Tenant → Storage & backups → volume snapshots', () => {
  it('lists the newest snapshot first, and sorts by label both ways', async () => {
    const snap = (id: string, createdAt: string, label: string) => ({
      id, tenantId: 'tenant-001', label, status: 'ready', sizeBytes: 0, dataSizeBytes: 1e9, createdAt, expiresAt: '2026-11-03T00:00:00.000Z',
    });
    routes = [
      ['/snapshots', { data: { snapshots: [snap('s1', '2026-10-29T00:00:00.000Z', 'before-upgrade'), snap('s2', '2026-10-30T00:00:00.000Z', 'nightly'), snap('s3', '2026-10-28T00:00:00.000Z', 'after-import')], expiryHours: 72 } }],
      ['/placement', { data: { placement: null, failovers: [] } }],
    ];
    renderUi(<StorageTab tenant={TENANT} tenantId="tenant-001" />);
    const card = await screen.findByTestId('tenant-snapshots');
    const table = await within(card).findByRole('table');
    expect(column(table, 1)).toEqual(['nightly', 'before-upgrade', 'after-import']);
    fireEvent.click(within(table).getByTestId('sort-label'));
    expect(column(table, 1)).toEqual(['after-import', 'before-upgrade', 'nightly']);
    fireEvent.click(within(table).getByTestId('sort-label'));
    expect(column(table, 1)).toEqual(['nightly', 'before-upgrade', 'after-import']);
  });
});

describe('Tenant → Email', () => {
  const domain = (id: string, domainName: string) => ({
    id, domainId: `d-${id}`, tenantId: 'tenant-001', domainName, enabled: 1,
    mxProvisioned: 1, spfProvisioned: 1, dkimProvisioned: 1, dmarcProvisioned: 1, createdAt: '2026-01-10T00:00:00Z',
  });
  const mailbox = (id: string, fullAddress: string, usedMb: number) => ({
    id, emailDomainId: 'ed1', tenantId: 'tenant-001', localPart: fullAddress.split('@')[0], fullAddress, displayName: null,
    quotaMb: 1024, usedMb, status: 'active', mailboxType: 'mailbox', aliases: [], forwardingAddresses: [], autoReply: 0, autoReplySubject: null, createdAt: '2026-01-10T00:00:00Z',
  });
  const list = (id: string, sourceAddress: string, recipients: number) => ({
    id, emailDomainId: 'ed1', tenantId: 'tenant-001', sourceAddress, enabled: 1, createdAt: '2026-01-10T00:00:00Z',
    destinationAddresses: Array.from({ length: recipients }, (_, i) => `r${i}@alpha.test`),
  });
  const stat = (d: string, sent24h: number) => ({ domain: d, emailHosted: true, sent24h, sent7d: sent24h, recipients7d: sent24h, rateLimited7d: 0, quotaRejected7d: 0 });

  beforeEach(() => {
    routes = [
      ['/mail/domain-stats', { data: { windowDays: 7, domains: [stat('beta.test', 2), stat('alpha.test', 9)] } }],
      ['/send-limits/live', { data: { checkedAt: '2026-10-31T00:00:00Z', reachable: false, domains: [] } }],
      ['/mail/usage', { data: {} }],
      ['/mail/dmarc', { data: { windowDays: 30, domains: [] } }],
      ['/mail/tls-reports', { data: { windowDays: 30, reports: [], total: 0, totalSuccessfulSessions: 0, totalFailedSessions: 0, successRate: null } }],
      ['/mail/abuse-reports', { data: { windowDays: 30, reports: [], total: 0 } }],
      ['/mail/imapsync', { data: [] }],
      ['/email/aliases', { data: [list('l1', 'team@alpha.test', 2), list('l2', 'all@alpha.test', 5)] }],
      ['/mailboxes', { data: [mailbox('m1', 'zed@alpha.test', 10), mailbox('m2', 'amy@alpha.test', 900)] }],
      ['/email/domains', { data: [domain('ed2', 'beta.test'), domain('ed1', 'alpha.test')] }],
      ['/plans', { data: [] }],
    ];
  });

  it('lists mail domains by name, and sorts by mail sent in 24 h both ways', async () => {
    renderUi(<TenantEmailTab tenant={TENANT} tenantId="tenant-001" />);
    const card = await screen.findByTestId('mail-domains');
    const table = within(card).getByRole('table');
    await within(table).findByText('alpha.test');
    expect(column(table, 0)).toEqual(['alpha.test', 'beta.test']);
    await within(table).findAllByText('9');
    fireEvent.click(within(table).getByTestId('sort-sent24h'));
    expect(column(table, 0)).toEqual(['beta.test', 'alpha.test']);
    fireEvent.click(within(table).getByTestId('sort-sent24h'));
    expect(column(table, 0)).toEqual(['alpha.test', 'beta.test']);
  });

  it('lists mailboxes by address, and sorts by storage used both ways', async () => {
    renderUi(<TenantEmailTab tenant={TENANT} tenantId="tenant-001" />);
    const card = await screen.findByTestId('mailboxes-card');
    await within(card).findByTestId('mailbox-m1');
    expect(testIds('mailbox-')).toEqual(['mailbox-m2', 'mailbox-m1']);
    fireEvent.click(within(card).getByTestId('sort-storage'));
    expect(testIds('mailbox-')).toEqual(['mailbox-m1', 'mailbox-m2']);
    fireEvent.click(within(card).getByTestId('sort-storage'));
    expect(testIds('mailbox-')).toEqual(['mailbox-m2', 'mailbox-m1']);
  });

  it('lists mailing lists by address, and sorts by recipient count both ways', async () => {
    renderUi(<TenantEmailTab tenant={TENANT} tenantId="tenant-001" />);
    const card = await screen.findByTestId('mailing-lists-card');
    await within(card).findByTestId('mailing-list-l1');
    expect(testIds('mailing-list-')).toEqual(['mailing-list-l2', 'mailing-list-l1']);
    fireEvent.click(within(card).getByTestId('sort-recipients'));
    expect(testIds('mailing-list-')).toEqual(['mailing-list-l1', 'mailing-list-l2']);
    fireEvent.click(within(card).getByTestId('sort-recipients'));
    expect(testIds('mailing-list-')).toEqual(['mailing-list-l2', 'mailing-list-l1']);
  });
});

// ─── Traffic ────────────────────────────────────────────────────────────

describe('Traffic summary table', () => {
  const series = (key: string, name: string, v: number, kind: 'subject' | 'other' = 'subject') => ({ key, name, kind, points: [v, v] });
  // As the server ranks them: biggest first, the folded rest last.
  const frame = {
    from: '2026-10-30T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z', stepSeconds: 3600,
    times: ['2026-10-30T00:00:00.000Z', '2026-10-30T01:00:00.000Z'], unit: 'bytes', resolution: 'fine', othersFolded: 4, clamped: false,
    series: [series('c', 'Charlie', 10), series('b', 'Bravo', 5), series('a', 'Alpha', 1), series('__other__', 'Other (4)', 100, 'other')],
  } as unknown as TrafficFrame;
  const order = () => Array.from(document.querySelectorAll('tr[data-series]')).map((r) => r.getAttribute('data-series'));

  it('keeps the frame\'s ranking, sorts by name, and keeps "Other" last whatever the column', () => {
    render(<TrafficSummaryTable frame={frame} hidden={new Set()} onToggle={vi.fn()} subjectLabel="Tenant" />);
    expect(order()).toEqual(['c', 'b', 'a', '__other__']);
    fireEvent.click(screen.getByTestId('sort-name'));
    expect(order()).toEqual(['a', 'b', 'c', '__other__']);
    fireEvent.click(screen.getByTestId('sort-total'));
    expect(order()).toEqual(['a', 'b', 'c', '__other__']);
    // Descending by total: "Other" holds the most, and still is not a subject to rank.
    fireEvent.click(screen.getByTestId('sort-total'));
    expect(order()).toEqual(['c', 'b', 'a', '__other__']);
  });
});

// ─── Notifications ──────────────────────────────────────────────────────

describe('Notification templates table', () => {
  it('keeps the category order, and sorts by version both ways', async () => {
    const template = (id: string, categoryId: string, channel: string, version: number) => ({
      id, categoryId, channel, locale: 'en', bodyFormat: 'markdown', version, isSeed: true, updatedAt: '2026-10-01T00:00:00.000Z',
    });
    routes = [
      ['/notifications/templates', { data: [template('t2', 'backup.failed', 'email', 3), template('t3', 'backup.failed', 'ntfy', 1), template('t1', 'tenant.suspended', 'email', 2)] }],
      ['/notifications/categories', { data: [] }],
    ];
    renderUi(<TemplatesTable />);
    await screen.findByTestId('template-row-t1');
    expect(testIds('template-row-')).toEqual(['template-row-t2', 'template-row-t3', 'template-row-t1']);
    fireEvent.click(screen.getByTestId('sort-version'));
    expect(testIds('template-row-')).toEqual(['template-row-t3', 'template-row-t1', 'template-row-t2']);
    fireEvent.click(screen.getByTestId('sort-version'));
    expect(testIds('template-row-')).toEqual(['template-row-t2', 'template-row-t1', 'template-row-t3']);
  });
});

// ─── Security → Network trust ───────────────────────────────────────────

describe('Network trust tables', () => {
  const ready = { ready: 'True', readyReason: null, readyMessage: null };

  it('lists trusted ranges by name, and sorts by CIDR both ways', async () => {
    const range = (name: string, cidr: string) => ({ name, cidr, family: 'v4', description: '', addedBy: '', ...ready });
    routes = [['/cluster/trusted-ranges', { data: { data: [range('office', '10.0.0.0/8'), range('home', '192.0.2.1/32'), range('lab', '172.16.0.0/12')] } }]];
    renderUi(<NetworkTrustPage />, '/security/network-trust/trusted-ranges');
    await screen.findByText('office');
    const table = screen.getByRole('table');
    expect(column(table, 0)).toEqual(['home', 'lab', 'office']);
    fireEvent.click(within(table).getByTestId('sort-cidr'));
    expect(column(table, 0)).toEqual(['office', 'lab', 'home']);
    fireEvent.click(within(table).getByTestId('sort-cidr'));
    expect(column(table, 0)).toEqual(['home', 'lab', 'office']);
  });

  it('lists pending peers by name, and sorts by expiry both ways', async () => {
    const peer = (name: string, expiresAt: string) => ({ name, ip: '10.0.0.5', role: 'worker', hostname: '', expiresAt, claimedAt: null });
    routes = [['/cluster/pending-peers', { data: { data: [peer('w2', '2026-10-31T10:00:00.000Z'), peer('w1', '2026-10-31T12:00:00.000Z'), peer('w3', '2026-10-31T08:00:00.000Z')] } }]];
    renderUi(<NetworkTrustPage />, '/security/network-trust/pending-peers');
    await screen.findByText('w1');
    const table = screen.getByRole('table');
    expect(column(table, 0)).toEqual(['w1', 'w2', 'w3']);
    fireEvent.click(within(table).getByTestId('sort-expiresAt'));
    expect(column(table, 0)).toEqual(['w3', 'w2', 'w1']);
    fireEvent.click(within(table).getByTestId('sort-expiresAt'));
    expect(column(table, 0)).toEqual(['w1', 'w2', 'w3']);
  });

  it('lists blacklisted ranges by CIDR (numerically), and sorts by reason both ways', async () => {
    const entry = (cidr: string, description: string) => ({ name: cidr.replace(/[./]/g, '-'), cidr, family: 'v4', description, source: 'manual', addedBy: '', ...ready });
    routes = [['/cluster/firewall-blacklist', { data: { data: [entry('203.0.113.9/32', 'spam relay'), entry('198.51.100.7/32', 'brute force'), entry('45.148.0.0/16', 'scanner farm')] } }]];
    renderUi(<NetworkTrustPage />, '/security/network-trust/blacklist');
    await screen.findByText('45.148.0.0/16');
    const table = screen.getByRole('table');
    expect(column(table, 0)).toEqual(['45.148.0.0/16', '198.51.100.7/32', '203.0.113.9/32']);
    fireEvent.click(within(table).getByTestId('sort-description'));
    expect(column(table, 0)).toEqual(['198.51.100.7/32', '45.148.0.0/16', '203.0.113.9/32']);
    fireEvent.click(within(table).getByTestId('sort-description'));
    expect(column(table, 0)).toEqual(['203.0.113.9/32', '45.148.0.0/16', '198.51.100.7/32']);
  });
});

// ─── Security → Posture ─────────────────────────────────────────────────

describe('Posture tables', () => {
  const node = (name: string, o: { critical?: number; port?: number; peers?: number; banned?: number } = {}) => ({
    name,
    stale: false,
    lastUpdatedAt: '2026-10-31T00:00:00.000Z',
    ssh: {
      nodeName: name, restrictionMode: 'mesh-only', sshViaMeshFlag: true, enforcedInterface: 'wt0', parseSucceeded: true, parseError: null,
      sshdFlags: { port: o.port ?? 22, permitRootLogin: 'no', passwordAuthentication: 'no', allowUsers: [] },
    },
    mesh: { provider: 'netbird', interfaceName: 'wt0', interfaceIp: '100.64.0.1', peerCount: o.peers ?? 2, lastHandshakeAgeSeconds: 5 },
    hardening: {
      osPretty: 'Debian 13', kernelVersion: '6.12',
      cisFindings: Array.from({ length: o.critical ?? 0 }, (_, i) => ({ id: `c${i}`, title: 'x', passing: false, severity: 'critical', detail: '' })),
    },
    fail2ban: {
      dbPresent: true, readError: null, bannedNowCount: o.banned ?? 0, bansLast24h: o.banned ?? 0, bansTotal: o.banned ?? 0,
      currentlyBanned: o.banned
        ? [
          { ip: '203.0.113.1', jail: 'sshd', bannedAt: '2026-10-31T10:00:00.000Z', expiresAt: null, banCount: 1 },
          { ip: '203.0.113.2', jail: 'sshd', bannedAt: '2026-10-31T09:00:00.000Z', expiresAt: null, banCount: 7 },
          { ip: '203.0.113.3', jail: 'sshd', bannedAt: '2026-10-31T08:00:00.000Z', expiresAt: null, banCount: 3 },
        ]
        : [],
    },
  });

  const snapshot = {
    nodes: [node('sv-a', { critical: 2, port: 2222, peers: 5, banned: 3 }), node('sv-m', { critical: 0, port: 22, peers: 1 }), node('sv-z', { critical: 1, port: 1022, peers: 3 })],
    certExpiries: [], backupTargets: [], reservedHostnameCollisions: [], databaseIsolation: null, calicoWg: null, auditLogHealth: null, authPosture: null,
    firewall: {
      mode: 'set', trustedRangesV4Count: 1, trustedRangesV6Count: 0, clusterPeersV4Count: 3, clusterPeersV6Count: 0,
      deniedCountWindow: { available: false, denies: null },
      publicPortsPerNode: [{ nodeName: 'sv-a', tcp: [80, 443], udp: [] }, { nodeName: 'sv-m', tcp: [25, 80, 443], udp: [] }, { nodeName: 'sv-z', tcp: [443], udp: [] }],
    },
    k8sPosture: {
      totalPodCount: 10, hostPathPods: [], hostNetworkPods: [],
      privilegedPods: [{ namespace: 'kube-system', name: 'calico-node', reasons: ['privileged'] }, { namespace: 'kube-system', name: 'agent', reasons: ['privileged'] }],
      namespacePss: [
        { namespace: 'tenant-b', enforceLevel: 'restricted', warnLevel: 'restricted', auditLevel: 'restricted' },
        { namespace: 'tenant-a', enforceLevel: 'baseline', warnLevel: 'restricted', auditLevel: 'restricted' },
        { namespace: 'kube-system', enforceLevel: 'privileged', warnLevel: 'unset', auditLevel: 'unset' },
      ],
    },
    recentEvents: [
      { occurredAt: '2026-10-31T10:00:00.000Z', resourceType: 'trusted_range', resourceName: 'office', action: 'delete', userId: 'u1', outcome: 'success' },
      { occurredAt: '2026-10-31T09:00:00.000Z', resourceType: 'firewall', resourceName: null, action: 'apply', userId: 'u1', outcome: 'success' },
      { occurredAt: '2026-10-31T08:00:00.000Z', resourceType: 'ssh', resourceName: 'sv-a', action: 'lockdown', userId: null, outcome: 'failure' },
    ],
  };

  beforeEach(() => {
    routes = [
      ['/admin/security-hardening', { data: snapshot }],
      // sv-z is called "alpha" by its operator — the name the tables show.
      ['/admin/node-labels', { data: [{ name: 'sv-z', label: 'alpha', hostname: null }] }],
      ['/security/operator-trust', { isTrusted: true, ip: null, source: 'header', canAdd: false }],
    ];
  });

  const nodeColumn = async (testId?: string) => {
    await screen.findAllByText('alpha');
    return testId ? screen.getByTestId(testId) : screen.getAllByRole('table')[0];
  };

  it('Overview: lists nodes by the name shown, and sorts by critical findings both ways', async () => {
    renderUi(<PosturePage />, '/security/posture/overview');
    const table = await nodeColumn('overview-nodes-table');
    expect(column(table, 0)).toEqual(['alpha', 'sv-a', 'sv-m']);
    fireEvent.click(within(table).getByTestId('sort-critical'));
    expect(column(table, 0)).toEqual(['sv-m', 'alpha', 'sv-a']);
    fireEvent.click(within(table).getByTestId('sort-critical'));
    expect(column(table, 0)).toEqual(['sv-a', 'alpha', 'sv-m']);
  });

  it('SSH: sorts nodes by sshd port both ways', async () => {
    renderUi(<PosturePage />, '/security/posture/ssh');
    const table = await nodeColumn('ssh-table');
    fireEvent.click(within(table).getByTestId('sort-port'));
    expect(column(table, 0)).toEqual(['sv-m', 'alpha', 'sv-a']);
    fireEvent.click(within(table).getByTestId('sort-port'));
    expect(column(table, 0)).toEqual(['sv-a', 'alpha', 'sv-m']);
  });

  it('SSH → fail2ban bans: newest ban first, and sorts by ban count both ways', async () => {
    renderUi(<PosturePage />, '/security/posture/ssh');
    await nodeColumn('ssh-table');
    fireEvent.click(screen.getByTestId('fail2ban-open-sv-a'));
    const table = screen.getByTestId('fail2ban-banned-table');
    expect(column(table, 0)).toEqual(['203.0.113.1', '203.0.113.2', '203.0.113.3']);
    fireEvent.click(within(table).getByTestId('sort-banCount'));
    expect(column(table, 0)).toEqual(['203.0.113.1', '203.0.113.3', '203.0.113.2']);
    fireEvent.click(within(table).getByTestId('sort-banCount'));
    expect(column(table, 0)).toEqual(['203.0.113.2', '203.0.113.3', '203.0.113.1']);
  });

  it('Mesh: sorts nodes by peer count both ways', async () => {
    renderUi(<PosturePage />, '/security/posture/mesh');
    const table = await nodeColumn('mesh-table');
    fireEvent.click(within(table).getByTestId('sort-peerCount'));
    expect(column(table, 0)).toEqual(['sv-m', 'alpha', 'sv-a']);
    fireEvent.click(within(table).getByTestId('sort-peerCount'));
    expect(column(table, 0)).toEqual(['sv-a', 'alpha', 'sv-m']);
  });

  it('Firewall: sorts public ports per node by the TCP ports shown, both ways', async () => {
    renderUi(<PosturePage />, '/security/posture/firewall');
    const table = await nodeColumn();
    expect(column(table, 0)).toEqual(['alpha', 'sv-a', 'sv-m']);
    fireEvent.click(within(table).getByTestId('sort-tcp'));
    expect(column(table, 0)).toEqual(['sv-m', 'sv-a', 'alpha']);
    fireEvent.click(within(table).getByTestId('sort-tcp'));
    expect(column(table, 0)).toEqual(['alpha', 'sv-a', 'sv-m']);
  });

  it('K8s: sorts namespaces by enforce level, and privileged pods by name, both ways', async () => {
    renderUi(<PosturePage />, '/security/posture/k8s');
    const pss = await screen.findByTestId('pss-table');
    expect(column(pss, 0)).toEqual(['kube-system', 'tenant-a', 'tenant-b']);
    fireEvent.click(within(pss).getByTestId('sort-enforceLevel'));
    expect(column(pss, 0)).toEqual(['tenant-a', 'kube-system', 'tenant-b']);
    fireEvent.click(within(pss).getByTestId('sort-enforceLevel'));
    expect(column(pss, 0)).toEqual(['tenant-b', 'kube-system', 'tenant-a']);

    const pods = screen.getByTestId('privileged-pods-table');
    fireEvent.click(within(pods).getByTestId('sort-name'));
    expect(column(pods, 1)).toEqual(['agent', 'calico-node']);
    fireEvent.click(within(pods).getByTestId('sort-name'));
    expect(column(pods, 1)).toEqual(['calico-node', 'agent']);
  });

  it('Events: newest first, and sorts by action both ways', async () => {
    renderUi(<PosturePage />, '/security/posture/events');
    const table = await screen.findByTestId('events-table');
    await within(table).findByText('delete');
    expect(column(table, 2)).toEqual(['delete', 'apply', 'lockdown']);
    fireEvent.click(within(table).getByTestId('sort-action'));
    expect(column(table, 2)).toEqual(['apply', 'delete', 'lockdown']);
    fireEvent.click(within(table).getByTestId('sort-action'));
    expect(column(table, 2)).toEqual(['lockdown', 'delete', 'apply']);
  });
});

// ─── Platform ───────────────────────────────────────────────────────────

describe('Lifecycle hooks → hook performance', () => {
  it('lists hooks by name, and sorts by run count both ways', async () => {
    const run = (hookName: string, state: string, i: number) => ({ id: `${hookName}-${i}`, hookName, state, hookOrder: i, blocking: 'abort', attempts: 1, maxAttempts: 3, lastError: null });
    routes = [['/lifecycle/transitions', {
      data: {
        transitions: [],
        hookRuns: { tr1: [run('dns', 'ok', 1), run('dns', 'failed', 2), run('mail', 'ok', 3), run('backup', 'ok', 4), run('backup', 'ok', 5), run('backup', 'failed', 6)] },
      },
    }]];
    renderUi(<LifecycleHooksPage />);
    await screen.findByText('backup');
    const table = screen.getAllByRole('table')[0];
    expect(column(table, 0)).toEqual(['backup', 'dns', 'mail']);
    fireEvent.click(within(table).getByTestId('sort-total'));
    expect(column(table, 0)).toEqual(['mail', 'dns', 'backup']);
    fireEvent.click(within(table).getByTestId('sort-total'));
    expect(column(table, 0)).toEqual(['backup', 'dns', 'mail']);
  });
});

describe('Plesk migration → subscription inventory', () => {
  it('lists subscriptions by name, and sorts by mailbox count both ways', async () => {
    const sub = (name: string, mailboxes: number) => ({
      name, sysUser: null, domains: [], databases: [], cronCount: 0, cronLines: [], mailBytes: null,
      mailboxes: Array.from({ length: mailboxes }, (_, i) => ({ address: `m${i}@${name}` })),
    });
    routes = [
      ['/discoveries', { data: [{ id: 'disc-1', sourceId: 'src-1', status: 'completed', error: null, inventory: { pleskVersion: null, subscriptions: [sub('charlie.test', 1), sub('alpha.test', 4), sub('bravo.test', 0)] } }] }],
      ['/plesk/migrations', { data: [] }],
      ['/plesk/sources', { data: [{ id: 'src-1', name: 'Old Plesk', hostname: 'plesk.example.test', sshPort: 22, sshUser: 'root', authMethod: 'key', pleskVersion: null, passwordStorage: null, lastDiscoveredAt: null, status: 'active' }] }],
    ];
    renderUi(<PleskMigrationPage />);
    await screen.findByTestId('inventory-table');
    expect(testIds('sub-row-')).toEqual(['sub-row-alpha.test', 'sub-row-bravo.test', 'sub-row-charlie.test']);
    fireEvent.click(screen.getByTestId('sort-mailboxes'));
    expect(testIds('sub-row-')).toEqual(['sub-row-bravo.test', 'sub-row-charlie.test', 'sub-row-alpha.test']);
    fireEvent.click(screen.getByTestId('sort-mailboxes'));
    expect(testIds('sub-row-')).toEqual(['sub-row-alpha.test', 'sub-row-charlie.test', 'sub-row-bravo.test']);
  });
});
