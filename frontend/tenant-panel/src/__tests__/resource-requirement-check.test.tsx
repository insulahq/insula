import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ResourceRequirementCheck from '../components/ResourceRequirementCheck';

// Production report, 2026-09-08: a tenant saw
//   "CPU: 0.10 cores available (0.10 cores required) — Insufficient"
// and the Deploy button stayed disabled (DeployWorkloadModal gates on
// `!resourcesFit`). The panel asserted there was exactly enough and refused
// in the same sentence.
//
// Root cause was float accumulation upstream, fixed in resource-quotas
// service. This component is the second line of defence: it must compare in
// whole milli-cores so a value a few ulps low can never read as a shortfall,
// and it must never print two identical numbers next to "Insufficient".

const mockAvailability = vi.fn();
vi.mock('@/hooks/use-resource-availability', () => ({
  useResourceAvailability: () => mockAvailability(),
}));
vi.mock('@/hooks/use-tenant-context', () => ({
  useTenantContext: () => ({ tenantId: 'c1' }),
}));

function withAvailability(cpuAvailable: number, memoryAvailableGi = 8, storageAvailableGi = 50) {
  mockAvailability.mockReturnValue({
    data: { data: { cpuAvailable, memoryAvailableGi, storageAvailableGi } },
    isLoading: false,
    isError: false,
  });
}

describe('ResourceRequirementCheck', () => {
  beforeEach(() => {
    mockAvailability.mockReset();
  });

  it('treats a float-drifted exact fit as sufficient', () => {
    // 2 cores minus 19x100m through the old float path.
    withAvailability(0.09999999999999942);
    const onFitsChange = vi.fn();
    render(<ResourceRequirementCheck minimumCpu="100m" onFitsChange={onFitsChange} />);

    expect(screen.queryByText(/Insufficient/)).toBeNull();
    expect(onFitsChange).toHaveBeenCalledWith(true);
  });

  it('treats an exact fit as sufficient', () => {
    withAvailability(0.1);
    const onFitsChange = vi.fn();
    render(<ResourceRequirementCheck minimumCpu="100m" onFitsChange={onFitsChange} />);

    expect(screen.queryByText(/Insufficient/)).toBeNull();
    expect(onFitsChange).toHaveBeenCalledWith(true);
  });

  it('still blocks a genuine shortfall', () => {
    withAvailability(0.05);
    const onFitsChange = vi.fn();
    render(<ResourceRequirementCheck minimumCpu="100m" onFitsChange={onFitsChange} />);

    expect(screen.getByText(/Insufficient/)).toBeTruthy();
    expect(onFitsChange).toHaveBeenCalledWith(false);
  });

  it('never renders "Insufficient" beside two identical numbers', () => {
    // A sub-0.01 shortfall used to print "0.10 available (0.10 required)".
    withAvailability(0.095);
    render(<ResourceRequirementCheck minimumCpu="100m" />);

    const row = screen.getByText(/cores available/);
    const text = row.textContent ?? '';
    expect(text).toContain('Insufficient');
    const nums = [...text.matchAll(/([\d.]+) cores/g)].map(m => m[1]);
    expect(nums).toHaveLength(2);
    expect(nums[0]).not.toBe(nums[1]);
  });
});
