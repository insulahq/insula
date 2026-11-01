import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ImageEntry } from '@insula/api-contracts';

/** The image inventory the mock answers with; empty unless a test sets it. */
let images: ImageEntry[] = [];

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
  useImageInventory: () => ({ isLoading: false, data: { data: { images, purgeable: [] } } }),
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

describe('StorageUsageTab — column sorting', () => {
  afterEach(() => { images = []; });

  it('opens the tenant table largest first, then sorts by tenant name both ways', () => {
    render(<StorageUsageTab />);
    const order = () => screen.getAllByTestId(/^tenant-storage-/).map((c) => c.getAttribute('data-testid'));
    expect(order()).toEqual(['tenant-storage-t2', 'tenant-storage-t1']);

    const table = screen.getByText('Alpha').closest('table') as HTMLElement;
    fireEvent.click(within(table).getByTestId('sort-name'));
    expect(order()).toEqual(['tenant-storage-t1', 'tenant-storage-t2']);
    fireEvent.click(within(table).getByTestId('sort-name'));
    expect(order()).toEqual(['tenant-storage-t2', 'tenant-storage-t1']);
  });

  it('opens the image table largest first, then sorts by the status it shows both ways', () => {
    images = [
      { name: 'nginx:1', sizeBytes: 10, inUse: true, protected: false },
      { name: 'busybox:1', sizeBytes: 30, inUse: false, protected: false },
      { name: 'pause:3', sizeBytes: 20, inUse: false, protected: true },
    ];
    render(<StorageUsageTab />);
    const table = screen.getByText('busybox:1').closest('table') as HTMLElement;
    const names = () => Array.from(table.querySelectorAll('tbody > tr')).map((tr) => tr.querySelector('td')?.textContent);
    expect(names()).toEqual(['busybox:1', 'pause:3', 'nginx:1']);

    fireEvent.click(within(table).getByTestId('sort-status'));
    expect(names()).toEqual(['nginx:1', 'pause:3', 'busybox:1']);
    fireEvent.click(within(table).getByTestId('sort-status'));
    expect(names()).toEqual(['busybox:1', 'pause:3', 'nginx:1']);
  });
});
