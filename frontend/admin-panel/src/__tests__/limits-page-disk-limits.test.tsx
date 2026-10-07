/**
 * Platform → Limits & Regional: the tenant node-disk limits (R37). The values
 * the deployers render into every tenant pod come from here; a typo here
 * would be a limit every workload exceeds, so the inputs clamp to the
 * contract's bounds before they are ever sent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MIN_TENANT_DISK_LIMIT_MB } from '@insula/api-contracts';
import LimitsPage from '@/pages/platform/LimitsPage';

const mutate = vi.fn();
// Stable across renders, as React Query's cached data is: a fresh object each
// render would re-run the page's "load stored values" effect and wipe edits.
const SETTINGS = vi.hoisted(() => ({
  isLoading: false,
  isError: false,
  error: null,
  data: {
    data: {
      apiRateLimit: 100,
      snapshotExpiryHours: 48,
      deletedTenantBundleRetentionDays: 30,
      fileTrashRetentionDays: 14,
      tenantAppDiskLimitMb: 3072,
      tenantDatabaseDiskLimitMb: 8192,
      timezone: 'UTC',
      currency: 'USD',
    },
  },
}));
vi.mock('@/hooks/use-system-settings', () => ({
  useSystemSettings: () => SETTINGS,
  useUpdateSystemSettings: () => ({ mutate, isPending: false }),
}));
vi.mock('@/components/TimezoneSelect', () => ({ default: () => null }));
vi.mock('@/components/CurrencySelect', () => ({ default: () => null }));

describe('LimitsPage — tenant disk limits', () => {
  beforeEach(() => mutate.mockClear());

  it('shows the stored values, with the GiB equivalent', () => {
    render(<LimitsPage />);
    expect(screen.getByTestId('tenant-app-disk-limit-input')).toHaveValue(3072);
    expect(screen.getByTestId('tenant-database-disk-limit-input')).toHaveValue(8192);
    expect(screen.getByTestId('tenant-app-disk-limit-input-gib')).toHaveTextContent('3 GiB');
    expect(screen.getByTestId('tenant-database-disk-limit-input-gib')).toHaveTextContent('8 GiB');
  });

  it('sends both values on save', () => {
    render(<LimitsPage />);
    fireEvent.change(screen.getByTestId('tenant-app-disk-limit-input'), { target: { value: '4096' } });
    fireEvent.click(screen.getByTestId('save-limits'));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({ tenantAppDiskLimitMb: 4096, tenantDatabaseDiskLimitMb: 8192 });
  });

  it('never lets a value below the minimum through — 0 would evict every workload', () => {
    render(<LimitsPage />);
    for (const v of ['0', '-5', '12', '']) {
      fireEvent.change(screen.getByTestId('tenant-app-disk-limit-input'), { target: { value: v } });
      expect(screen.getByTestId('tenant-app-disk-limit-input')).toHaveValue(MIN_TENANT_DISK_LIMIT_MB);
    }
    fireEvent.click(screen.getByTestId('save-limits'));
    expect(mutate.mock.calls[0][0].tenantAppDiskLimitMb).toBe(MIN_TENANT_DISK_LIMIT_MB);
  });
});
