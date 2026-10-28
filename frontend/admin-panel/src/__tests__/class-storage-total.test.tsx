/**
 * The headline of each backup class page: the storage the class takes, on
 * every target.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { BackupUsageClass, TargetUsageRow } from '@insula/api-contracts';

let targets: TargetUsageRow[] = [];
vi.mock('@/hooks/use-backup-config', () => ({
  useBackupTargetUsage: () => ({ data: { data: { targets } }, isLoading: false }),
}));
const ClassStorageTotal = (await import('@/components/backups/ClassStorageTotal')).default;

const GB = 1e9;
const t = (id: string, bytes: number | null, bound: boolean, cls: BackupUsageClass = 'tenant'): TargetUsageRow => ({
  targetId: id, name: id, storageType: 'cifs', enabled: true, readOnly: false,
  boundClasses: bound ? [cls] : [], measuringSince: null,
  usage: {
    measuredAt: new Date(Date.now() - 3_600_000).toISOString(), durationMs: 1,
    classes: { system: null, tenant: null, mail: null, [cls]: bytes === null ? null : { bytes, objects: 1 } },
    usedByBackupsBytes: bytes ?? 0, capacity: null, capacityNote: null, errors: {},
  },
});

const renderIt = (cls: BackupUsageClass = 'tenant') => render(<MemoryRouter><ClassStorageTotal cls={cls} /></MemoryRouter>);
beforeEach(() => { targets = []; });

describe('ClassStorageTotal', () => {
  it('shows the folder the way the target counts it: decimal GB', () => {
    // Production's tenant folder. It read "190.3 GB" when the page divided by 1024.
    targets = [t('Box', 204_376_364_099, true)];
    renderIt();
    expect(screen.getByTestId('tenant-storage-total-bytes')).toHaveTextContent('204.4 GB');
  });

  it('sums the class over every target that holds any', () => {
    targets = [t('Box', 500 * GB, true), t('OldBox', 20 * GB, false), t('Empty', 0, false)];
    renderIt();
    expect(screen.getByTestId('tenant-storage-total-bytes')).toHaveTextContent('520.0 GB');
    expect(screen.getByTestId('tenant-storage-total')).toHaveTextContent('500.0 GB on Box · 20.0 GB on OldBox');
  });

  it('one target: names it', () => {
    targets = [t('Box', 500 * GB, true)];
    renderIt();
    expect(screen.getByTestId('tenant-storage-total')).toHaveTextContent('on Box · measured 1 h ago');
  });

  it('mail and system say what their folder holds', () => {
    targets = [t('Box', 63_739_157_939, true, 'mail')];
    renderIt('mail');
    expect(screen.getByTestId('mail-storage-total-bytes')).toHaveTextContent('63.7 GB');
    expect(screen.getByTestId('mail-storage-total')).toHaveTextContent('Storage used by mail backups');
    expect(screen.getByTestId('mail-storage-total')).toHaveTextContent('the mail store’s restic repository');

    targets = [t('Box', 5_987_344_884, true, 'system')];
    renderIt('system');
    expect(screen.getByTestId('system-storage-total-bytes')).toHaveTextContent('6.0 GB');
    expect(screen.getByTestId('system-storage-total')).toHaveTextContent('write-ahead log, etcd snapshots, DR bundles');
  });

  it('counts only its own class', () => {
    targets = [t('Box', 63 * GB, true, 'mail')];
    renderIt('tenant');
    expect(screen.getByTestId('tenant-storage-total-none')).toHaveTextContent('Not measured yet');
  });

  it('says which bound target is missing from the sum when it has not been measured yet', () => {
    const fresh = { ...t('NewBox', 0, true), usage: null };
    targets = [fresh, t('OldBox', 20 * GB, false)];
    renderIt();
    expect(screen.getByTestId('tenant-storage-total-bytes')).toHaveTextContent('20.0 GB');
    expect(screen.getByTestId('tenant-storage-total-unmeasured')).toHaveTextContent('NewBox not measured yet');
  });

  it('says when it has not been measured, instead of 0', () => {
    renderIt();
    expect(screen.getByTestId('tenant-storage-total-none')).toHaveTextContent('Not measured yet');
  });

  it('flags a bound target whose class folder could not be listed', () => {
    targets = [t('Box', 500 * GB, true), t('Broken', null, true)];
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
