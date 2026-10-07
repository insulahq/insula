/**
 * The migration scan imports each tenant's NEWEST bundle. It once picked
 * whichever the source listed first (a field-name mismatch) and the table gave
 * the operator no way to notice: it showed a bundle-id prefix but not when that
 * bundle was captured. The row must say how old the copy is.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MigrationTenant } from '@insula/api-contracts';
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
  useMigrationImport: () => idle,
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
