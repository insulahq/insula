/**
 * The migration scan imports each tenant's NEWEST bundle. It once picked
 * whichever the source listed first (a field-name mismatch) and the table gave
 * the operator no way to notice: it showed a bundle-id prefix but not when that
 * bundle was captured. The row must say how old the copy is.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { MigrationImportResult, MigrationTenant } from '@insula/api-contracts';
import MigrationTab from '@/components/system-backup/MigrationTab';

const tenant = (over: Partial<MigrationTenant>): MigrationTenant => ({
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantName: 'Acme',
  primaryEmail: 'ops@example.test',
  latestBundleId: 'bkp-0000aaaa-bbbb',
  latestCreatedAt: '2026-10-05T02:00:00.000Z',
  bundleCount: 3,
  totalSizeBytes: 1024,
  components: ['files'],
  platformVersion: '2026.10.5',
  alreadyPresent: false,
  effectiveResources: null,
  ...over,
});

const idle = { data: undefined, isPending: false, error: null, reset: vi.fn(), mutate: vi.fn() };
/** What the import mutations hold; idle unless a test sets a finished import. */
const importState: { current: unknown } = { current: undefined };

vi.mock('@/hooks/use-backup-config', () => ({
  useBackupConfigs: () => ({ data: { data: [{ id: 'cfg-1', name: 'Source' }] }, isLoading: false, error: null }),
}));
vi.mock('@/hooks/use-migration', () => ({
  useMigrationListTenants: () => ({
    ...idle,
    data: {
      data: {
        scanned: 4,
        skipped: 0,
        tenants: [
          tenant({}),
          tenant({ tenantId: '22222222-2222-4222-8222-222222222222', tenantName: 'Legacy', latestCreatedAt: '' }),
        ],
      },
    },
  }),
  useMigrationImport: () => importState.current ?? idle,
}));

describe('MigrationTab — capture time of the bundle it will import', () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-07T02:00:00.000Z')); });
  afterAll(() => { vi.useRealTimers(); });

  it('shows when each tenant\'s latest bundle was captured, with the exact time on hover', () => {
    render(<MigrationTab />);
    const captured = screen.getByTestId('migration-captured-11111111-1111-4111-8111-111111111111');
    expect(captured).toHaveTextContent(new Date('2026-10-05T02:00:00.000Z').toLocaleDateString());
    expect(captured).toHaveAttribute('title', expect.stringContaining('2026'));
  });

  it('says nothing rather than "Invalid Date" when a source reports no capture time', () => {
    render(<MigrationTab />);
    expect(screen.queryByTestId('migration-captured-22222222-2222-4222-8222-222222222222')).toBeNull();
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
  });
});

describe('MigrationTab — column sorting', () => {
  afterEach(() => { importState.current = undefined; });

  const rowNames = (table: HTMLElement) => Array.from(table.querySelectorAll('tbody tr'))
    .map((r) => r.querySelectorAll('td')[1]?.querySelector('div')?.textContent);

  it('lists discovered tenants by name, and reverses on a click', () => {
    render(<MigrationTab />);
    const [table] = screen.getAllByRole('table');
    expect(rowNames(table)).toEqual(['Acme', 'Legacy']);
    fireEvent.click(screen.getByTestId('sort-tenantName'));
    expect(rowNames(table)).toEqual(['Legacy', 'Acme']);
  });

  it('sorts a tenant with no capture time after every captured one', () => {
    render(<MigrationTab />);
    const [table] = screen.getAllByRole('table');
    fireEvent.click(screen.getByTestId('sort-latestCreatedAt'));
    expect(rowNames(table)).toEqual(['Acme', 'Legacy']);
  });

  it('sorts the import results by their outcome, both ways', () => {
    const result = (over: Partial<MigrationImportResult>): MigrationImportResult => ({
      tenantId: 'x', tenantName: 'X', bundleId: 'b', ok: true, status: 'completed', recreated: false,
      alreadyPresent: false, cartId: null, residualGaps: [], error: null, ...over,
    });
    importState.current = {
      ...idle,
      data: {
        data: {
          targetConfigId: 'cfg-1', total: 3, imported: 2, failed: 1, skipped: 0, dryRun: false,
          results: [
            result({ tenantId: 'r1', tenantName: 'Acme', status: 'completed' }),
            result({ tenantId: 'r2', tenantName: 'Bravo', ok: false, status: 'failed', error: 'restore failed' }),
            result({ tenantId: 'r3', tenantName: 'Charlie', status: 'awaiting_dns' }),
          ],
        },
      },
    };
    render(<MigrationTab />);
    const results = screen.getAllByRole('table')[1];
    const names = () => Array.from(results.querySelectorAll('tbody tr')).map((r) => r.querySelector('td')?.textContent);
    expect(names()).toEqual(['Acme', 'Bravo', 'Charlie']);
    fireEvent.click(screen.getByTestId('sort-result'));
    expect(names()).toEqual(['Charlie', 'Acme', 'Bravo']);
    fireEvent.click(screen.getByTestId('sort-result'));
    expect(names()).toEqual(['Bravo', 'Acme', 'Charlie']);
  });
});
