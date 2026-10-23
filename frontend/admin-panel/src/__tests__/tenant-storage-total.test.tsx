/**
 * /backups/tenants: the storage all tenant backups take, on every target.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TargetUsageRow } from '@insula/api-contracts';

let targets: TargetUsageRow[] = [];
vi.mock('@/hooks/use-backup-config', () => ({
  useBackupTargetUsage: () => ({ data: { data: { targets } }, isLoading: false }),
}));
const TenantStorageTotal = (await import('@/components/backups/TenantStorageTotal')).default;

const GiB = 1024 ** 3;
const t = (id: string, tenantBytes: number | null, bound: boolean): TargetUsageRow => ({
  targetId: id, name: id, storageType: 'cifs', enabled: true, readOnly: false,
  boundClasses: bound ? ['tenant'] : [], measuringSince: null,
  usage: {
    measuredAt: new Date(Date.now() - 3_600_000).toISOString(), durationMs: 1,
    classes: { system: null, tenant: tenantBytes === null ? null : { bytes: tenantBytes, objects: 1 }, mail: null },
    usedByBackupsBytes: tenantBytes ?? 0, capacity: null, capacityNote: null, errors: {},
  },
});

const renderIt = () => render(<MemoryRouter><TenantStorageTotal /></MemoryRouter>);
beforeEach(() => { targets = []; });

describe('TenantStorageTotal', () => {
  it('sums the tenant class over every target that holds any', () => {
    targets = [t('Box', 500 * GiB, true), t('OldBox', 20 * GiB, false), t('Empty', 0, false)];
    renderIt();
    expect(screen.getByTestId('tenant-storage-total-bytes')).toHaveTextContent('520.0 GB');
    expect(screen.getByTestId('tenant-storage-total')).toHaveTextContent('500.0 GB on Box · 20.0 GB on OldBox');
  });

  it('one target: names it', () => {
    targets = [t('Box', 500 * GiB, true)];
    renderIt();
    expect(screen.getByTestId('tenant-storage-total')).toHaveTextContent('on Box · measured 1 h ago');
  });

  it('says when it has not been measured, instead of 0', () => {
    renderIt();
    expect(screen.getByTestId('tenant-storage-total-none')).toHaveTextContent('Not measured yet');
  });

  it('flags a bound target whose tenant folder could not be listed', () => {
    targets = [t('Box', 500 * GiB, true), t('Broken', null, true)];
    renderIt();
    expect(screen.getByTestId('tenant-storage-total')).toHaveTextContent('Broken could not be listed');
  });

  it('the only target could not be listed: says so with the reason — neither 0 nor "not measured"', () => {
    const broken = t('Box', null, true);
    targets = [{ ...broken, usage: { ...broken.usage!, errors: { tenant: 'restic/r7/locks: error listing: directory not found' } } }];
    renderIt();
    expect(screen.getByTestId('tenant-storage-total-unlisted'))
      .toHaveTextContent('Could not be listed on Box: restic/r7/locks: error listing: directory not found — measure again');
    expect(screen.queryByTestId('tenant-storage-total-bytes')).toBeNull();
    expect(screen.queryByTestId('tenant-storage-total-none')).toBeNull();
  });
});
