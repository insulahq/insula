/**
 * Saving a CPU setting and applying it are different acts.
 *
 * A changed burst ceiling replaces every pod in the namespace — a
 * LimitRange stamps its default at admission — so it must not happen as a
 * side effect of pressing Save on a form that also edits memory and
 * mailboxes. This panel is the second act, and its whole job is to say
 * which of the two it is about to do.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CpuMigrationPreview } from '@insula/api-contracts';
import ApplyCpuLimitsPanel from '@/components/ApplyCpuLimitsPanel';

const mockPreview = vi.fn();
const mockApply = vi.fn();
vi.mock('@/hooks/use-cpu-migration', () => ({ useCpuMigrationPreview: () => mockPreview() }));
vi.mock('@/hooks/use-cpu-migration-actions', () => ({ useApplyCpuMigration: () => mockApply() }));

const tenant = (o: Partial<CpuMigrationPreview['tenants'][number]> = {}) => ({
  tenantId: 't1', tenantName: 'Example', planCode: 'starter',
  currentMillis: 60, proposedMillis: 60, reclaimableMillis: 0, increasedMillis: 0,
  proposedCeilingCores: 1, proposedTier: 'normal' as const,
  appliedCeilingCores: 1, appliedTier: 'normal' as const, pendingCpuChange: false,
  observedP95Millis: 10, tenantBlocker: null, migratesCleanly: true,
  schedulingMode: 'tiered' as const, migrationRunning: false, deployments: [],
  ...o,
});

const ok = (t = tenant()) => mockPreview.mockReturnValue({
  data: { data: { allocatableMillis: 8000, reservedMillis: 1000, usedMillis: 500, reclaimableMillis: 0, needsReviewCount: 0, tenants: [t] } },
});
const apply = (over: Record<string, unknown> = {}) => {
  const mutate = vi.fn();
  mockApply.mockReturnValue({ mutate, isPending: false, isError: false, data: undefined, error: null, ...over });
  return mutate;
};
const show = (mode: string | null = 'tiered') =>
  render(<MemoryRouter><ApplyCpuLimitsPanel tenantId="t1" schedulingMode={mode} /></MemoryRouter>);

describe('ApplyCpuLimitsPanel', () => {
  beforeEach(() => { mockPreview.mockReset(); mockApply.mockReset(); });

  it('is absent for a legacy tenant — that is a migration, not an apply', () => {
    ok(); apply();
    show('legacy');
    expect(screen.queryByTestId('apply-cpu-limits')).toBeNull();
  });

  it('names both sides when the saved settings have not been applied', () => {
    ok(tenant({
      pendingCpuChange: true, proposedTier: 'highest', proposedCeilingCores: 4,
      appliedTier: 'normal', appliedCeilingCores: 1,
    }));
    apply();
    show();
    const d = screen.getByTestId('apply-cpu-limits-detail');
    expect(d).toHaveTextContent('Highest');
    expect(d).toHaveTextContent('4.00');
    expect(d).toHaveTextContent('Normal');
    expect(d).toHaveTextContent('1.00');
  });

  it('warns that a CEILING change replaces applications', () => {
    ok(tenant({ pendingCpuChange: true, proposedCeilingCores: 4, appliedCeilingCores: 1 }));
    apply();
    show();
    expect(screen.getByTestId('apply-cpu-limits-detail')).toHaveTextContent('replaces this tenant’s applications');
  });

  it('says a TIER-only change replaces nothing', () => {
    // The tier rewrites requests, which roll normally. Telling an operator
    // their applications will be replaced would deter a free change.
    ok(tenant({
      pendingCpuChange: true, proposedTier: 'highest', appliedTier: 'normal',
      proposedCeilingCores: 1, appliedCeilingCores: 1,
    }));
    apply();
    show();
    expect(screen.getByTestId('apply-cpu-limits-detail')).toHaveTextContent('replaces no running application');
  });

  it('still offers to re-apply when nothing is pending, and says it is a no-op', () => {
    ok(); apply();
    show();
    expect(screen.getByTestId('apply-cpu-limits-button')).toBeEnabled();
    expect(screen.getByTestId('apply-cpu-limits-detail')).toHaveTextContent('changes nothing');
  });

  it('sends the apply when pressed', () => {
    ok(); const mutate = apply();
    show();
    fireEvent.click(screen.getByTestId('apply-cpu-limits-button'));
    expect(mutate).toHaveBeenCalledWith({ tenantId: 't1', acknowledgeBlockers: false });
  });

  /**
   * ★ The flag must BIND the button. The server refuses a flagged tenant
   * without an acknowledgement (409), so a caption beside a clickable
   * button would only produce an error the operator cannot get past.
   */
  it('disables the button for a flagged tenant until it is acknowledged', () => {
    ok(tenant({ migratesCleanly: false, tenantBlocker: 'usage_exceeds_ceiling' }));
    const mutate = apply();
    show();
    expect(screen.getByTestId('apply-cpu-limits-button')).toBeDisabled();
    fireEvent.click(screen.getByTestId('apply-cpu-limits-ack'));
    expect(screen.getByTestId('apply-cpu-limits-button')).toBeEnabled();
    fireEvent.click(screen.getByTestId('apply-cpu-limits-button'));
    expect(mutate).toHaveBeenCalledWith({ tenantId: 't1', acknowledgeBlockers: true });
  });

  it('shows a run that did not complete as a failure, not a tick', () => {
    // A mutation that "succeeded" can still have stopped at step 4.
    ok();
    apply({ data: { data: { status: 'failed', reason: 'workload did not settle', step: null } } });
    show();
    const o = screen.getByTestId('apply-cpu-limits-outcome');
    expect(o).toHaveTextContent('workload did not settle');
    expect(o.className).toMatch(/red/);
  });

  it('reports a run started elsewhere, not just one this tab launched', () => {
    ok(tenant({ migrationRunning: true }));
    apply();
    show();
    expect(screen.getByTestId('apply-cpu-limits-button')).toBeDisabled();
    expect(screen.getByTestId('apply-cpu-limits-button')).toHaveTextContent('Applying');
  });
});
