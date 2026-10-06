import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/hooks/use-storage', () => ({
  useStorageOverview: () => ({
    isLoading: false,
    data: { data: {
      node: { name: 'n1', totalBytes: 100, usedBytes: 50, availableBytes: 50 },
      system: { platformDatabase: { usedBytes: 1024 }, dockerImages: { totalBytes: 2048, count: 3 } },
      tenants: [
        { tenantId: 't1', name: 'Alpha', namespace: 'tenant-alpha', usedBytes: 5 * 1024 * 1024, approximate: false },
        { tenantId: 't2', name: 'Beta', namespace: 'tenant-beta', usedBytes: 7 * 1024 * 1024, approximate: true },
      ],
      total: { systemBytes: 3072, tenantBytes: 12 * 1024 * 1024 },
    } },
  }),
  useImageInventory: () => ({ isLoading: false, data: { data: { images: [], purgeable: [] } } }),
  usePurgeImages: () => ({ mutate: vi.fn(), isPending: false }),
}));

const { default: StorageUsageTab } = await import('../StorageUsageTab');

describe('StorageUsageTab', () => {
  it('has no Redis tile (Redis was removed from the platform)', () => {
    render(<StorageUsageTab />);
    expect(screen.queryByText('Redis')).not.toBeInTheDocument();
    expect(screen.getByText('Total Tenant Data')).toBeInTheDocument();
  });

  it('marks a tenant whose volume is not mounted as approximate', () => {
    render(<StorageUsageTab />);
    expect(screen.getByTestId('tenant-storage-t2').textContent).toMatch(/^≈/);
    expect(screen.getByTestId('tenant-storage-t1').textContent).not.toMatch(/≈/);
  });
});
