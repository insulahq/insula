/**
 * Batch DR recover — tenants that will NOT be recovered (ROADMAP R25 §3).
 *
 * The behaviour worth pinning is the EMPTY STATE. With no targets, this tab
 * rendered a green "No lost tenants to recover — every tenant with a bundle is
 * accounted for." The tenants without a usable bundle are exactly the ones it
 * was not counting, so the most alarming case produced the most reassuring
 * screen.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const preview = { data: undefined as unknown, isPending: false, isError: false, error: null, mutate: vi.fn(), reset: vi.fn() };
const recover = { data: undefined as unknown, isPending: false, isError: false, error: null, mutate: vi.fn(), reset: vi.fn() };

vi.mock('@/hooks/use-dr-recover', () => ({
  useDrRecoverAllPreview: () => preview,
  useDrRecoverAll: () => recover,
}));

const { default: RecoverAllTab } = await import('./RecoverAllTab');

const skipped = (over: Record<string, unknown> = {}) => ({
  tenantId: 't-1',
  tenantName: 'Acme',
  reason: 'no_completed_bundle',
  latestBundleStatus: 'partial',
  latestBundleAt: '2026-09-11T00:00:00.000Z',
  ...over,
});

const target = (over: Record<string, unknown> = {}) => ({
  tenantId: 't-9',
  tenantName: 'Live',
  bundleId: 'bundle-abcdef0123456789',
  namespacePresent: false,
  bundleCreatedAt: '2026-09-12T00:00:00.000Z',
  bundleAgeDays: 1,
  components: ['config', 'files'],
  ...over,
});

beforeEach(() => {
  preview.data = undefined;
  recover.data = undefined;
});

describe('RecoverAllTab — unrecoverable tenants', () => {
  it('does NOT show the green all-clear when tenants have no usable bundle', () => {
    preview.data = { data: { dryRun: true, scope: 'missing', total: 0, recovered: 0, failed: 0, targets: [], skipped: [skipped()] } };
    render(<RecoverAllTab />);
    expect(screen.queryByText(/every tenant with a bundle/i)).toBeNull();
    expect(screen.getByText(/Nothing can be recovered/i)).toBeTruthy();
  });

  it('still shows the all-clear when nothing was passed over', () => {
    preview.data = { data: { dryRun: true, scope: 'missing', total: 0, recovered: 0, failed: 0, targets: [], skipped: [] } };
    render(<RecoverAllTab />);
    expect(screen.getByText(/every tenant with a bundle/i)).toBeTruthy();
  });

  it('treats a live-namespace skip under scope=missing as normal, not as a problem', () => {
    // That is the scope doing what was asked; flagging it would train the
    // operator to ignore this panel.
    preview.data = {
      data: {
        dryRun: true, scope: 'missing', total: 0, recovered: 0, failed: 0, targets: [],
        skipped: [skipped({ reason: 'namespace_present', latestBundleStatus: 'completed' })],
      },
    };
    render(<RecoverAllTab />);
    expect(screen.getByText(/every tenant with a bundle/i)).toBeTruthy();
    expect(screen.queryByTestId('dr-unrecoverable')).toBeNull();
  });

  it('lists the unrecoverable tenants alongside a non-empty target set', () => {
    preview.data = {
      data: { dryRun: true, scope: 'missing', total: 1, recovered: 0, failed: 0, targets: [target()], skipped: [skipped()] },
    };
    render(<RecoverAllTab />);
    const panel = screen.getByTestId('dr-unrecoverable');
    expect(panel.textContent).toContain('Acme');
    expect(panel.textContent).toContain('partial');
  });

  it('distinguishes "never backed up" from a partial bundle', () => {
    preview.data = {
      data: {
        dryRun: true, scope: 'all', total: 0, recovered: 0, failed: 0, targets: [],
        skipped: [skipped({ latestBundleStatus: null, latestBundleAt: null })],
      },
    };
    render(<RecoverAllTab />);
    expect(screen.getByText(/never backed up/i)).toBeTruthy();
  });

  it('keeps showing them after a run, where "recovered N/N" is true but incomplete', () => {
    recover.data = {
      data: { dryRun: false, scope: 'missing', total: 1, recovered: 1, failed: 0, results: [], skipped: [skipped()] },
    };
    render(<RecoverAllTab />);
    expect(screen.getByTestId('dr-unrecoverable')).toBeTruthy();
  });

  it('shows bundle age and components on a target', () => {
    preview.data = {
      data: { dryRun: true, scope: 'missing', total: 1, recovered: 0, failed: 0, targets: [target({ bundleAgeDays: 30 })], skipped: [] },
    };
    render(<RecoverAllTab />);
    expect(screen.getByText('30d old')).toBeTruthy();
    expect(screen.getByText('config, files')).toBeTruthy();
  });
});
