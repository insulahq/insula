import { render as rtlRender, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CpuMigrationPreview } from '@insula/api-contracts';
import type React from 'react';
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
  proposedTier: 'high' as const,
  appliedCeilingCores: null,
  appliedTier: null,
  pendingCpuChange: false,
  observedP95Millis: 65,
  tenantBlocker: null,
  migratesCleanly: true,
  schedulingMode: 'legacy' as const,
  migrationRunning: false,
  deployments: [
    { id: 'd1', name: 'moodle', currentMillis: 500, proposedMillis: 30, proposedTier: 'high' as const, blocker: null },
    { id: 'd2', name: 'my-mariadb', currentMillis: 250, proposedMillis: 30, proposedTier: 'high' as const, blocker: null },
  ],
  ...o,
});

/**
 * The expanded row carries real mutation hooks (migrate / revert / stop), so
 * the page needs a live QueryClient. Wrapping rather than mocking them keeps
 * the controls genuinely exercised — a mocked hook would let the buttons
 * render even if they were wired to nothing.
 */
const render = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

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

  /**
   * The header must describe what the page actually does. It claimed "dry run
   * — changes nothing" for as long as that was true; now that each row can
   * migrate a tenant, the label says the figures are a preview and names what
   * makes something happen. A page asserting its own inertness while carrying
   * an apply button is worse than no label.
   */
  it('describes itself honestly now that it can act', () => {
    ok(preview());
    render(<CpuSchedulingPage />);
    expect(screen.getByText(/nothing changes until you migrate a tenant/i)).toBeInTheDocument();
    expect(screen.queryByText(/dry run — changes nothing/i)).toBeNull();
  });

  // ─── R2 controls ───────────────────────────────────────────────────────

  /**
   * ★ There is no bulk control, and there must not be one. Migration
   * recreates pods; doing that for every tenant from a single click is the
   * flag day ADR-062 exists to avoid. The action lives inside one tenant's
   * own expanded row.
   */
  it('offers migration per tenant and nowhere globally', async () => {
    ok(preview({ tenants: [tenant()] }));
    render(<CpuSchedulingPage />);
    expect(screen.queryByText(/migrate all/i)).toBeNull();
    expect(screen.queryByTestId('cpu-migrate-t1')).toBeNull(); // collapsed
    await userEvent.click(screen.getByTestId('cpu-migration-tenant-t1'));
    expect(screen.getByTestId('cpu-migrate-t1')).toBeInTheDocument();
  });

  // A tenant already tiered must be offered the way BACK, not a second run.
  it('offers revert instead of migrate once a tenant is tiered', async () => {
    ok(preview({ tenants: [tenant({ schedulingMode: 'tiered' })] }));
    render(<CpuSchedulingPage />);
    await userEvent.click(screen.getByTestId('cpu-migration-tenant-t1'));
    expect(screen.getByTestId('cpu-revert-t1')).toBeInTheDocument();
    expect(screen.queryByTestId('cpu-migrate-t1')).toBeNull();
  });

  /**
   * ★ A flagged tenant must be BLOCKED by the flag, not merely warned about.
   * The server refuses one without an explicit acknowledgement, so a caption
   * beside a still-clickable button would only produce a 409 the operator
   * cannot get past — and an enabled button implies approval was not needed.
   */
  it('disables migration for a flagged tenant until it is acknowledged', async () => {
    ok(preview({
      tenants: [tenant({ migratesCleanly: false, tenantBlocker: 'no_usage_data', observedP95Millis: null })],
    }));
    render(<CpuSchedulingPage />);
    await userEvent.click(screen.getByTestId('cpu-migration-tenant-t1'));
    expect(screen.getByTestId('cpu-migrate-t1')).toBeDisabled();

    await userEvent.click(screen.getByTestId('cpu-ack-t1'));
    expect(screen.getByTestId('cpu-migrate-t1')).toBeEnabled();
  });

  // A clean tenant needs no ceremony — the checkbox must not appear for it.
  it('asks for no acknowledgement when the tenant migrates cleanly', async () => {
    ok(preview({ tenants: [tenant()] }));
    render(<CpuSchedulingPage />);
    await userEvent.click(screen.getByTestId('cpu-migration-tenant-t1'));
    expect(screen.queryByTestId('cpu-ack-t1')).toBeNull();
    expect(screen.getByTestId('cpu-migrate-t1')).toBeEnabled();
  });

  /**
   * ★ Stop must be reachable from any tab, not only the one that started the
   * run. The button used to render on the local mutation's pending flag, so
   * a reload, a second admin, or a dropped connection made the one safety
   * valve vanish while the migration carried on server-side.
   */
  it('offers Stop for a run this tab did not start', async () => {
    ok(preview({ tenants: [tenant({ migrationRunning: true })] }));
    render(<CpuSchedulingPage />);
    await userEvent.click(screen.getByTestId('cpu-migration-tenant-t1'));
    expect(screen.getByTestId('cpu-stop-t1')).toBeInTheDocument();
    // …and it must not invite a second, concurrent run.
    expect(screen.getByTestId('cpu-migrate-t1')).toBeDisabled();
  });

  it('shows no Stop when nothing is running', async () => {
    ok(preview({ tenants: [tenant()] }));
    render(<CpuSchedulingPage />);
    await userEvent.click(screen.getByTestId('cpu-migration-tenant-t1'));
    expect(screen.queryByTestId('cpu-stop-t1')).toBeNull();
  });

  /**
   * ★ The control that did not exist for the whole of R2.
   *
   * An already-tiered tenant was refused outright, so a changed tier or
   * ceiling wrote a database column and reached nothing in the cluster. The
   * page now offers to apply it, and — more importantly — SAYS that the
   * saved settings and the running ones disagree, which was invisible.
   */
  describe('an already-tiered tenant', () => {
    // ★ TYPED. An untyped `o = {}` widens every literal passed through it,
    // so a field could be given a value that is not in its enum and
    // nothing would say so — `tenantBlocker: 'usage_exceeds_ceiling'` sat
    // here for exactly that reason, naming a blocker that does not exist.
    const tiered = (o: Partial<CpuMigrationPreview['tenants'][number]> = {}) => tenant({
      schedulingMode: 'tiered' as const,
      appliedCeilingCores: 2,
      appliedTier: 'high' as const,
      ...o,
    });

    it('offers Re-apply, and Migrate is gone', async () => {
      ok(preview({ tenants: [tiered()] }));
      render(<CpuSchedulingPage />);
      await userEvent.click(screen.getByTestId('cpu-migration-tenant-t1'));
      expect(screen.getByTestId('cpu-reapply-t1')).toBeInTheDocument();
      expect(screen.queryByTestId('cpu-migrate-t1')).toBeNull();
      expect(screen.getByTestId('cpu-reapply-t1')).toHaveTextContent('Re-apply settings');
    });

    it('names the pending change instead of only flagging one', async () => {
      ok(preview({
        tenants: [tiered({ pendingCpuChange: true, proposedCeilingCores: 4, proposedTier: 'highest' as const })],
      }));
      render(<CpuSchedulingPage />);
      expect(screen.getByTestId('cpu-pending-t1')).toHaveTextContent('change not applied');
      // Both numbers, so the operator can see WHAT would change.
      expect(screen.getByTestId('cpu-applied-t1')).toHaveTextContent('now 2.00');
      await userEvent.click(screen.getByTestId('cpu-migration-tenant-t1'));
      const detail = screen.getByTestId('cpu-pending-detail-t1');
      expect(detail).toHaveTextContent('High');
      expect(detail).toHaveTextContent('Highest');
      expect(detail).toHaveTextContent('replaces');
      expect(screen.getByTestId('cpu-reapply-t1')).toHaveTextContent('Apply pending change');
    });

    // A tier-only change moves no pod: the tier governs containers that
    // declare no CPU, and every running one declares its own. Saying
    // "replaces your pods" there would deter a free change.
    it('says a tier-only change replaces nothing', async () => {
      ok(preview({
        tenants: [tiered({ pendingCpuChange: true, proposedTier: 'normal' as const, proposedCeilingCores: 2 })],
      }));
      render(<CpuSchedulingPage />);
      await userEvent.click(screen.getByTestId('cpu-migration-tenant-t1'));
      expect(screen.getByTestId('cpu-pending-detail-t1')).toHaveTextContent('changes no running application');
    });

    it('still gates a flagged tenant behind the acknowledgement', async () => {
      ok(preview({ tenants: [tiered({ migratesCleanly: false, tenantBlocker: 'usage_exceeds_ceiling' })] }));
      render(<CpuSchedulingPage />);
      await userEvent.click(screen.getByTestId('cpu-migration-tenant-t1'));
      expect(screen.getByTestId('cpu-reapply-t1')).toBeDisabled();
      await userEvent.click(screen.getByTestId('cpu-ack-t1'));
      expect(screen.getByTestId('cpu-reapply-t1')).toBeEnabled();
    });
  });
});
