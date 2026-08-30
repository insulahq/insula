/**
 * Per-application disk-usage bar.
 *
 * The reported bug: an app holding ~6 GB rendered a 60% AMBER bar on a tenant
 * whose volume had been enlarged from 10 GB to 100 GB. The denominator was a
 * hardcoded `10` ("relative to 10GB reference") that never tracked the volume —
 * it merely happened to equal the old default size — and the thresholds warned
 * from 50%. Correct reading on a 100 GB limit is 6%, and normal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const mockDeploymentMetrics = vi.fn();
const mockResourceMetrics = vi.fn();

vi.mock('@/hooks/use-tenant-context', () => ({
  useTenantContext: () => ({ tenantId: 't1' }),
}));
vi.mock('@/hooks/use-deployments', () => ({
  useDeploymentLiveMetrics: (...a: unknown[]) => mockDeploymentMetrics(...a),
}));
vi.mock('@/hooks/use-resource-metrics', () => ({
  useResourceMetrics: (...a: unknown[]) => mockResourceMetrics(...a),
}));

const { DeploymentStorageDisplay } = await import('@/pages/Applications');

function setup(usedBytes: number, storageAvailableGi: number) {
  mockDeploymentMetrics.mockReturnValue({
    data: { data: { storageUsedBytes: usedBytes, storageUsedFormatted: `${(usedBytes / 2 ** 30).toFixed(1)} GB` } },
  });
  mockResourceMetrics.mockReturnValue({
    data: {
      data: {
        tenantId: 't1',
        cpu: { inUse: 0, reserved: 0, available: 2 },
        memory: { inUse: 0, reserved: 0, available: 4 },
        storage: { inUse: 6, reserved: 6, available: storageAvailableGi },
        lastUpdatedAt: '2026-08-30T00:00:00.000Z',
      },
    },
  });
  return render(<DeploymentStorageDisplay deploymentId="d1" enabled />);
}

const barClasses = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('div[style*="width"]')).map((d) => d.className).join(' ');

describe('DeploymentStorageDisplay', () => {
  beforeEach(() => vi.clearAllMocks());

  it('measures against the tenant storage limit, not a hardcoded 10 GB', () => {
    // 6 GiB of a 100 GiB limit = 6%, and normal. The old code showed 60% amber.
    const { container } = setup(6 * 2 ** 30, 100);
    const width = (container.querySelector('div[style*="width"]') as HTMLElement).style.width;
    expect(parseFloat(width)).toBeCloseTo(6, 0);
    expect(barClasses(container)).toContain('bg-brand-500');
    expect(barClasses(container)).not.toContain('bg-amber');
  });

  it('shows the limit alongside the used figure so the ratio is checkable', () => {
    setup(6 * 2 ** 30, 100);
    expect(screen.getByText(/of 100 GB/)).toBeInTheDocument();
  });

  it('still warns when genuinely near the limit', () => {
    const { container } = setup(9 * 2 ** 30, 10);
    expect(barClasses(container)).toContain('bg-amber');
  });

  it('goes critical at the limit', () => {
    const { container } = setup(10 * 2 ** 30, 10);
    expect(barClasses(container)).toContain('bg-red');
  });

  it('renders 0% rather than a full red bar when the limit is unknown', () => {
    // limit 0 would be x/0 = Infinity; that must not read as "critical".
    const { container } = setup(6 * 2 ** 30, 0);
    const width = (container.querySelector('div[style*="width"]') as HTMLElement).style.width;
    expect(parseFloat(width)).toBe(0);
    expect(barClasses(container)).not.toContain('bg-red');
  });

  it('renders nothing when the deployment reports no storage', () => {
    const { container } = setup(0, 100);
    expect(container.firstChild).toBeNull();
  });
});
