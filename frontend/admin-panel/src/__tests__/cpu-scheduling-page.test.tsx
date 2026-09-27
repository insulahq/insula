import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CpuMigrationPreview } from '@insula/api-contracts';
import CpuSchedulingPage from '../pages/cluster/CpuSchedulingPage';

const mockPreview = vi.fn();
vi.mock('@/hooks/use-cpu-migration', () => ({
  useCpuMigrationPreview: () => mockPreview(),
}));

const preview = (o: Partial<CpuMigrationPreview> = {}): CpuMigrationPreview => ({
  allocatableMillis: 7500,
  reservedMillis: 7197,
  usedMillis: 883,
  reclaimableMillis: 4115,
  needsReviewCount: 0,
  tenants: [],
  ...o,
});

const tenant = (o: Partial<CpuMigrationPreview['tenants'][number]> = {}) => ({
  tenantId: 't1',
  tenantName: 'Example Institute',
  planCode: 'premium',
  currentMillis: 750,
  proposedMillis: 65,
  reclaimableMillis: 690,
  increasedMillis: 0,
  proposedCeilingCores: 2,
  observedP95Millis: 65,
  tenantBlocker: null,
  migratesCleanly: true,
  deployments: [
    { id: 'd1', name: 'moodle', currentMillis: 500, proposedMillis: 30, proposedTier: 'high' as const, blocker: null },
    { id: 'd2', name: 'my-mariadb', currentMillis: 250, proposedMillis: 30, proposedTier: 'high' as const, blocker: null },
  ],
  ...o,
});

const ok = (p: CpuMigrationPreview) =>
  mockPreview.mockReturnValue({ data: { data: p }, isLoading: false, error: null });

describe('CpuSchedulingPage', () => {
  beforeEach(() => { mockPreview.mockReset(); });

  it('states reserved and used as separate figures', () => {
    ok(preview());
    render(<CpuSchedulingPage />);
    // 7197/7500 = 96%, 883/7500 = 12% — the pair that makes the gap legible.
    expect(screen.getByText('96%')).toBeInTheDocument();
    expect(screen.getByText('12%')).toBeInTheDocument();
    expect(screen.getByText('4.12')).toBeInTheDocument(); // cores freed
  });

  /**
   * ★ An unmeasured cluster must not render as 0% used. A zero here reads as
   * a totally idle cluster and exaggerates the very gap this page reports —
   * the same trap the backend guards by returning null rather than summing
   * partial data.
   */
  it('renders unknown usage as an em-dash, never as 0%', () => {
    ok(preview({ usedMillis: null }));
    render(<CpuSchedulingPage />);
    expect(screen.getByText('not reported by every node')).toBeInTheDocument();
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('marks a clean tenant and shows what it would free', () => {
    ok(preview({ tenants: [tenant()] }));
    render(<CpuSchedulingPage />);
    expect(screen.getByText('migrates cleanly')).toBeInTheDocument();
    expect(screen.getByText('−0.69')).toBeInTheDocument();
  });

  // "Needs review" is useless without the reason — an operator cannot act on
  // a badge. The cause has to be on screen.
  it('explains WHY a tenant needs review, not just that it does', async () => {
    ok(preview({
      needsReviewCount: 1,
      tenants: [tenant({
        migratesCleanly: false,
        tenantBlocker: 'no_usage_data',
        observedP95Millis: null,
      })],
    }));
    render(<CpuSchedulingPage />);
    expect(screen.getByText('needs review')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('cpu-migration-tenant-t1'));
    expect(screen.getByText(/No usage samples in the last 7 days/i)).toBeInTheDocument();
  });

  it('surfaces a per-deployment blocker alongside the tenant one', async () => {
    ok(preview({
      tenants: [tenant({
        migratesCleanly: false,
        deployments: [{
          id: 'd1', name: 'byo-app', currentMillis: 500, proposedMillis: 30,
          proposedTier: 'high' as const, blocker: 'custom_resources',
        }],
      })],
    }));
    render(<CpuSchedulingPage />);
    await userEvent.click(screen.getByTestId('cpu-migration-tenant-t1'));
    expect(screen.getByText(/pins its own CPU/i)).toBeInTheDocument();
  });

  // A measured zero is a reading, not a missing one — distinguishable from null.
  it('shows a measured p95 of zero as 0.00, not as unsampled', () => {
    ok(preview({ tenants: [tenant({ observedP95Millis: 0 })] }));
    render(<CpuSchedulingPage />);
    expect(screen.getByText('0.00')).toBeInTheDocument();
  });

  /**
   * The row renders the backend's own reclaimableMillis. It must NOT recompute
   * it from the tenant's summed current/proposed: the aggregate floors per
   * DEPLOYMENT and sums, so a tenant with one app freeing 470m and one small
   * app gaining 20m is 470 by the headline's rule and 450 by the summed-then-
   * floored one. The per-tenant column would then not add up to the total on
   * the one page whose whole value is being trustworthy.
   */
  it('shows the backend freed figure, not a re-derivation of it', () => {
    ok(preview({
      tenants: [tenant({
        currentMillis: 510, proposedMillis: 60,   // summed-then-floored = 450
        reclaimableMillis: 470,                   // per-deployment floors = 470
        increasedMillis: 20,
      })],
    }));
    render(<CpuSchedulingPage />);
    expect(screen.getByText('−0.47')).toBeInTheDocument();
    expect(screen.queryByText('−0.45')).toBeNull();
  });

  // A net increase must not render identically to "no change".
  it('distinguishes a reservation increase from no change', () => {
    ok(preview({ tenants: [tenant({ reclaimableMillis: 0, increasedMillis: 20 })] }));
    const { unmount } = render(<CpuSchedulingPage />);
    expect(screen.getByText('+0.02')).toBeInTheDocument();
    unmount();

    ok(preview({ tenants: [tenant({ reclaimableMillis: 0, increasedMillis: 0 })] }));
    render(<CpuSchedulingPage />);
    expect(screen.queryByText('+0.00')).toBeNull();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  /**
   * The blocker reason is reachable ONLY by expanding the row, so if the row
   * cannot be operated from a keyboard the reason cannot be reached at all.
   * A <tr> is not natively focusable or activatable.
   */
  it('expands from the keyboard, not only the mouse', async () => {
    ok(preview({
      tenants: [tenant({ migratesCleanly: false, tenantBlocker: 'no_usage_data', observedP95Millis: null })],
    }));
    render(<CpuSchedulingPage />);
    const row = screen.getByTestId('cpu-migration-tenant-t1');
    expect(row).toHaveAttribute('tabindex', '0');
    expect(row).toHaveAttribute('aria-expanded', 'false');

    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/No usage samples in the last 7 days/i)).toBeInTheDocument();
  });

  // "A custom container pins its own CPU" against a tenant with several apps
  // gives the cause without the subject.
  it('names WHICH application is blocked', async () => {
    ok(preview({
      tenants: [tenant({
        migratesCleanly: false,
        deployments: [
          { id: 'd1', name: 'moodle', currentMillis: 500, proposedMillis: 30, proposedTier: 'high' as const, blocker: null },
          { id: 'd2', name: 'byo-worker', currentMillis: 200, proposedMillis: 30, proposedTier: 'high' as const, blocker: 'custom_resources' },
        ],
      })],
    }));
    render(<CpuSchedulingPage />);
    await userEvent.click(screen.getByTestId('cpu-migration-tenant-t1'));
    expect(screen.getByText('byo-worker:')).toBeInTheDocument();
    // …and the blocked row itself is marked, so the table and the bullet agree.
    expect(screen.getAllByText('needs review').length).toBeGreaterThan(1);
  });

  it('renders the error panel instead of a blank page when the query fails', () => {
    mockPreview.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') });
    render(<CpuSchedulingPage />);
    expect(screen.getByTestId('cpu-scheduling-error')).toBeInTheDocument();
  });

  // The page is a dry run. If it ever grows an apply button that should be a
  // deliberate decision, not something that arrives unnoticed.
  it('says plainly that it changes nothing', () => {
    ok(preview());
    render(<CpuSchedulingPage />);
    expect(screen.getByText(/dry run — changes nothing/i)).toBeInTheDocument();
  });
});
