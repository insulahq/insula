/**
 * A standing notice must not become wallpaper.
 *
 * It exists because the migration is opt-in and always will be for an
 * existing cluster: the failure mode is a change nobody ever applies. So it
 * carries the operator's own figures — and it has to disappear on its own,
 * or it becomes the region people learn to skip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CpuMigrationPreview } from '@insula/api-contracts';
import LegacyCpuNotice from '@/components/LegacyCpuNotice';

const mockPreview = vi.fn();
vi.mock('@/hooks/use-cpu-migration', () => ({
  useCpuMigrationPreview: () => mockPreview(),
}));

const tenant = (o: Partial<CpuMigrationPreview['tenants'][number]> = {}) => ({
  tenantId: 't1', tenantName: 'Example', planCode: 'starter',
  currentMillis: 750, proposedMillis: 60, reclaimableMillis: 690, increasedMillis: 0,
  proposedCeilingCores: 1, proposedTier: 'high' as const,
  appliedCeilingCores: null, appliedTier: null, pendingCpuChange: false,
  observedP95Millis: 60, tenantBlocker: null, migratesCleanly: true,
  schedulingMode: 'legacy' as const, migrationRunning: false, deployments: [],
  ...o,
});

const preview = (o: Partial<CpuMigrationPreview> = {}): CpuMigrationPreview => ({
  allocatableMillis: 7500, reservedMillis: 7200, usedMillis: 900,
  reclaimableMillis: 690, needsReviewCount: 0, tenants: [tenant()], ...o,
});

const ok = (p: CpuMigrationPreview) => mockPreview.mockReturnValue({ data: { data: p } });
const show = () => render(<MemoryRouter><LegacyCpuNotice /></MemoryRouter>);

describe('LegacyCpuNotice', () => {
  beforeEach(() => { mockPreview.mockReset(); });

  it('states the cluster’s OWN reserved and used figures', () => {
    ok(preview());
    show();
    expect(screen.getByTestId('legacy-cpu-notice')).toBeInTheDocument();
    expect(screen.getByText('96%')).toBeInTheDocument(); // 7200/7500 reserved
    expect(screen.getByText('12%')).toBeInTheDocument(); // 900/7500 used
    expect(screen.getByText('0.69')).toBeInTheDocument(); // cores reclaimable
  });

  it('disappears once every tenant is migrated', () => {
    ok(preview({ tenants: [tenant({ schedulingMode: 'tiered' })] }));
    show();
    expect(screen.queryByTestId('legacy-cpu-notice')).toBeNull();
  });

  /**
   * ★ Counts only what the LEGACY tenants would hand back.
   *
   * The cluster-wide `reclaimableMillis` includes tenants that have already
   * migrated and already delivered their saving, so quoting it would
   * promise the same cores twice.
   */
  it('does not count a migrated tenant’s saving as still available', () => {
    ok(preview({
      reclaimableMillis: 5000,
      tenants: [
        tenant({ tenantId: 'done', schedulingMode: 'tiered', reclaimableMillis: 4900 }),
        tenant({ tenantId: 'todo', schedulingMode: 'legacy', reclaimableMillis: 100 }),
      ],
    }));
    show();
    // 100m is below the threshold, so nothing is claimed at all.
    expect(screen.queryByTestId('legacy-cpu-notice')).toBeNull();
  });

  it('stays quiet when the saving would be trivial', () => {
    // A banner that appears for a tenth of a core is one people learn to skip.
    ok(preview({ reclaimableMillis: 30, tenants: [tenant({ reclaimableMillis: 30 })] }));
    show();
    expect(screen.queryByTestId('legacy-cpu-notice')).toBeNull();
  });

  it('renders without a usage reading rather than printing 0%', () => {
    // An unmeasured cluster is not an idle one.
    ok(preview({ usedMillis: null }));
    show();
    expect(screen.getByTestId('legacy-cpu-notice')).toBeInTheDocument();
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('links to the page that acts on it', () => {
    ok(preview());
    show();
    expect(screen.getByTestId('legacy-cpu-notice-link')).toHaveAttribute('href', '/cluster/cpu-scheduling');
  });

  // Read it aloud. "1 tenant still reserve CPU" shipped to a live console.
  it.each([
    [1, /1 tenant still reserves CPU it does not use/],
    [2, /2 tenants still reserve CPU they do not use/],
  ])('agrees in number for %i legacy tenant(s)', (n, re) => {
    ok(preview({
      tenants: Array.from({ length: n }, (_, i) => tenant({ tenantId: `t${i}` })),
      reclaimableMillis: 690 * n,
    }));
    show();
    expect(screen.getByTestId('legacy-cpu-notice')).toHaveTextContent(re);
  });
});
