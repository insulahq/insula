/**
 * The Backups dashboard's class cards read the backup-health roll-up.
 *
 * The bug: the roll-up had no `tenant` rows (tenant bundles were never part of
 * it), so the Tenants card read "0 · no jobs registered". The backend now adds
 * one row per tenant; these pin how the card reads them — real healthy and
 * failing counts, a never-backed-up tenant is not "healthy", and a tenant row
 * never lands on the Mail card.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { BackupHealthSummary } from '@insula/api-contracts';

let rows: BackupHealthSummary[] | undefined = [];
let healthError: Error | null = null;
const refetch = vi.fn();
vi.mock('@/hooks/use-backup-health', () => ({
  useBackupHealth: () => ({ data: rows, error: healthError, refetch, isFetching: false }),
}));
vi.mock('@/hooks/use-backup-config', () => ({ useBackupConfigs: () => ({ data: { data: [] } }) }));

const BackupsDashboard = (await import('@/pages/backups/BackupsDashboard')).default;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function row(overrides: Partial<BackupHealthSummary>): BackupHealthSummary {
  return {
    groupKey: 'g',
    displayName: 'g',
    namespace: 'platform',
    category: 'dr',
    severity: 'warning',
    tenantId: null,
    state: 'healthy',
    lastSuccessAt: hoursAgo(1),
    lastFailedAt: null,
    lastFailedReason: null,
    recentRuns: 1,
    ...overrides,
  };
}

const tenant = (n: number, overrides: Partial<BackupHealthSummary> = {}) => row({
  groupKey: `tenant-bundles/0000000${n}-0000-4000-8000-000000000000`,
  displayName: `Tenant ${n}`,
  namespace: 'tenant-example-0a1b2c3d',
  category: 'tenant',
  tenantId: `0000000${n}-0000-4000-8000-000000000000`,
  ...overrides,
});

function renderPage() {
  return render(<MemoryRouter><BackupsDashboard /></MemoryRouter>);
}

const card = (label: string) => screen.getByTestId(`backups-dashboard-stat-${label}`);

beforeEach(() => { rows = []; healthError = null; refetch.mockClear(); });

describe('Backups dashboard — Tenants card', () => {
  it('counts healthy tenants and when the newest bundle succeeded', () => {
    rows = [tenant(1, { lastSuccessAt: hoursAgo(3) }), tenant(2, { lastSuccessAt: hoursAgo(5) })];
    renderPage();
    expect(card('tenants')).toHaveTextContent('2 healthy');
    expect(card('tenants')).toHaveTextContent('last success 3h ago');
    expect(card('tenants').className).toContain('border-emerald-200');
  });

  it('a failing tenant turns the card amber and keeps the healthy count in view', () => {
    rows = [
      tenant(1, { state: 'failing', lastSuccessAt: hoursAgo(30), lastFailedAt: hoursAgo(2) }),
      tenant(2, { lastSuccessAt: hoursAgo(4) }),
      tenant(3, { lastSuccessAt: hoursAgo(6) }),
    ];
    renderPage();
    expect(card('tenants')).toHaveTextContent('1 failing');
    expect(card('tenants')).toHaveTextContent('2 healthy · last success 4h ago');
    expect(card('tenants').className).toContain('border-amber-300');
  });

  it('a tenant never backed up is not counted healthy, and the card says so', () => {
    rows = [tenant(1, { lastSuccessAt: hoursAgo(3) }), tenant(2, { state: 'never_run', lastSuccessAt: null, recentRuns: 0 })];
    renderPage();
    expect(card('tenants')).toHaveTextContent('1 healthy');
    expect(card('tenants')).toHaveTextContent('1 never run · last success 3h ago');
    expect(card('tenants').className).toContain('border-amber-300');
  });

  it('turns RED when a failing tenant is critical (a bundle failed outright, or two nightly runs missed)', () => {
    rows = [
      tenant(1, { state: 'failing', severity: 'critical', lastSuccessAt: null, lastFailedAt: hoursAgo(2) }),
      tenant(2, { lastSuccessAt: hoursAgo(4) }),
    ];
    renderPage();
    expect(card('tenants')).toHaveTextContent('1 failing');
    expect(card('tenants').className).toContain('border-red-300');
  });

  it('turns RED when a covered tenant has never been backed up for two days', () => {
    rows = [
      tenant(1, { lastSuccessAt: hoursAgo(3) }),
      tenant(2, { state: 'never_run', severity: 'critical', lastSuccessAt: null, recentRuns: 0 }),
    ];
    renderPage();
    expect(card('tenants')).toHaveTextContent('1 healthy');
    expect(card('tenants').className).toContain('border-red-300');
  });

  it('a critical Job group whose first run is still in flight stays amber, not red', () => {
    rows = [row({ groupKey: 'etcd-snap-via-shim', state: 'never_run', severity: 'critical', lastSuccessAt: null, recentRuns: 1 })];
    renderPage();
    expect(card('system')).toHaveTextContent('0 healthy');
    expect(card('system').className).toContain('border-amber-300');
  });

  it('says on hover what the Tenants card counts — and that opted-out tenants without bundles are not', () => {
    renderPage();
    expect(card('tenants')).toHaveAttribute('title', expect.stringMatching(/opted out of scheduled bundles with no bundle at all is not counted/));
  });

  it('no tenant rows at all still reads "no jobs registered"', () => {
    rows = [row({ groupKey: 'etcd-snap-via-shim', displayName: 'etcd' })];
    renderPage();
    expect(card('tenants')).toHaveTextContent('0');
    expect(card('tenants')).toHaveTextContent('no jobs registered');
  });

  it('a tenant row never counts as Mail, whatever its key says', () => {
    rows = [
      tenant(1, { groupKey: 'tenant-mailbox-export' }),
      row({ groupKey: 'stalwart-snapshot', namespace: 'mail', displayName: 'Mail snapshot' }),
    ];
    renderPage();
    expect(card('tenants')).toHaveTextContent('1 healthy');
    expect(card('mail')).toHaveTextContent('1 healthy');
  });
});

describe('Backups dashboard — recent activity', () => {
  it('lists failures first, then the most recent runs — many tenants cannot crowd out a fresh DR run', () => {
    rows = [
      ...Array.from({ length: 12 }, (_, i) => tenant(i % 10, {
        groupKey: `tenant-bundles/t${i}`, displayName: `Tenant ${String(i).padStart(2, '0')}`, lastSuccessAt: hoursAgo(10 + i),
      })),
      tenant(1, { groupKey: 'tenant-bundles/never', displayName: 'Never', state: 'never_run', lastSuccessAt: null }),
      row({ groupKey: 'etcd-snap-via-shim', displayName: 'etcd snapshot', lastSuccessAt: hoursAgo(0.5) }),
      tenant(1, { groupKey: 'tenant-bundles/bad', displayName: 'Broken', state: 'failing', lastSuccessAt: null, lastFailedAt: hoursAgo(40) }),
    ];
    renderPage();
    const items = within(screen.getByTestId('backups-dashboard-recent')).getAllByRole('listitem');
    expect(items).toHaveLength(10);
    expect(items[0]).toHaveTextContent('Broken');
    expect(items[1]).toHaveTextContent('etcd snapshot');
    expect(items[2]).toHaveTextContent('Tenant 00');
    expect(items.map((li) => li.textContent).join('|')).not.toContain('Never');
  });
});

describe('Backups dashboard — a never-run row in recent activity', () => {
  it('is not drawn as a success: no green check, and it says "never run"', () => {
    rows = [
      tenant(1, { groupKey: 'tenant-bundles/never', displayName: 'Never Co', state: 'never_run', severity: 'critical', lastSuccessAt: null, recentRuns: 0 }),
    ];
    renderPage();
    const item = within(screen.getByTestId('backups-dashboard-recent')).getByRole('listitem');
    expect(item).toHaveTextContent('never run');
    expect(item).not.toHaveTextContent('last success');
    expect(item.querySelector('svg')?.getAttribute('class')).toContain('text-red-600');
  });
});

describe('Backups dashboard — before the roll-up arrives', () => {
  it('while loading, the cards say so — never "no jobs registered"', () => {
    rows = undefined;
    renderPage();
    for (const label of ['tenants', 'system', 'mail']) {
      expect(card(label)).toHaveTextContent('loading…');
      expect(card(label)).not.toHaveTextContent('no jobs registered');
    }
    expect(screen.queryByText(/No backup jobs reporting yet/)).toBeNull();
  });

  it('a failed request renders the error with Retry, and the cards read "unavailable"', () => {
    rows = undefined;
    healthError = new Error('Request failed with status 502');
    renderPage();
    const panel = screen.getByTestId('backup-health-error');
    expect(panel).toHaveTextContent('Request failed with status 502');
    for (const label of ['tenants', 'system', 'mail']) {
      expect(card(label)).toHaveTextContent('unavailable');
      expect(card(label)).not.toHaveTextContent('no jobs registered');
    }
    within(panel).getByRole('button', { name: /retry/i }).click();
    expect(refetch).toHaveBeenCalled();
  });
});
