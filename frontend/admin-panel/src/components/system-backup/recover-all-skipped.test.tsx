/**
 * Batch DR recover — tenants that will NOT be recovered (ROADMAP R25 §3).
 *
 * The behaviour worth pinning is the EMPTY STATE. With no targets, this tab
 * rendered a green "No lost tenants to recover — every tenant with a bundle is
 * accounted for." The tenants without a usable bundle are exactly the ones it
 * was not counting, so the most alarming case produced the most reassuring
 * screen.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const preview = { data: undefined as unknown, isPending: false, isError: false, error: null, mutate: vi.fn(), reset: vi.fn() };
const recover = { data: undefined as unknown, isPending: false, isError: false, error: null, mutate: vi.fn(), reset: vi.fn() };

vi.mock('@/hooks/use-dr-recover', () => ({
  useDrRecoverAllPreview: () => preview,
  useStartRecoverAll: () => recover,
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

  // After a run, "recovered N/N" is true but incomplete: the run's progress
  // modal repeats the passed-over tenants (dr-recover-all-progress.test.tsx).

  it('shows bundle age and components on a target', () => {
    preview.data = {
      data: { dryRun: true, scope: 'missing', total: 1, recovered: 0, failed: 0, targets: [target({ bundleAgeDays: 30 })], skipped: [] },
    };
    render(<RecoverAllTab />);
    expect(screen.getByText('30d old')).toBeTruthy();
    expect(screen.getByText('config, files')).toBeTruthy();
  });
});

describe('RecoverAllTab — newest bundle time', () => {
  it('reads in the browser\'s zone and names the offset, with UTC on hover', async () => {
    const { MemoryRouter } = await import('react-router-dom');
    vi.stubEnv('TZ', 'Asia/Tokyo');
    try {
      preview.data = { data: { dryRun: true, scope: 'missing', total: 0, recovered: 0, failed: 0, targets: [],
        skipped: [skipped({ tenantId: 'gone-1', tenantName: 'ACME LEARNING', reason: 'deleted', latestBundleStatus: 'completed', latestBundleAt: '2026-10-03T01:36:57.662Z' })] } };
      render(<MemoryRouter><RecoverAllTab /></MemoryRouter>);
      const time = within(screen.getByTestId('dr-deleted-skips')).getByText('2026-10-03 10:36 UTC+9');
      expect(time).toHaveAttribute('title', '2026-10-03 01:36 UTC');
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('RecoverAllTab — tenants deleted on purpose', () => {
  it('does not call it an all-clear, and lists each with a way to recover it on its own', async () => {
    const { MemoryRouter } = await import('react-router-dom');
    preview.data = { data: { dryRun: true, scope: 'missing', total: 0, recovered: 0, failed: 0, targets: [],
      skipped: [skipped({ tenantId: 'gone-1', tenantName: 'ACME LEARNING', reason: 'deleted', latestBundleStatus: 'completed', latestBundleAt: '2026-10-03T01:36:57.662Z' })] } };
    render(<MemoryRouter><RecoverAllTab /></MemoryRouter>);
    // Not "every tenant with a bundle has a live namespace" — a deleted one has none.
    expect(screen.queryByText(/every tenant with a bundle/i)).toBeNull();
    expect(screen.getByText(/1 tenant\(s\) deleted on purpose are not recovered here/i)).toBeTruthy();
    const table = screen.getByTestId('dr-deleted-skips');
    expect(table.textContent).toContain('ACME LEARNING');

    expect(screen.getByRole('link', { name: 'Recover this tenant…' }).getAttribute('href'))
      .toBe('/backups/disaster-recovery?section=recover&tenant=gone-1');
  });
});

describe('RecoverAllTab — column sorting', () => {
  const firstCells = (table: HTMLElement) => Array.from(table.querySelectorAll('tbody tr')).map((r) => r.querySelector('td')?.textContent);

  it('lists the targets by tenant name, and sorts them by bundle age both ways', () => {
    preview.data = {
      data: {
        dryRun: true, scope: 'missing', total: 3, recovered: 0, failed: 0, skipped: [],
        targets: [
          target({ tenantId: 't-1', tenantName: 'Charlie', bundleAgeDays: 2 }),
          target({ tenantId: 't-2', tenantName: 'Alpha', bundleAgeDays: 9 }),
          target({ tenantId: 't-3', tenantName: 'Bravo', bundleAgeDays: 0 }),
        ],
      },
    };
    render(<RecoverAllTab />);
    const table = screen.getByRole('table');
    expect(firstCells(table)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    fireEvent.click(within(table).getByTestId('sort-bundleAgeDays'));
    expect(firstCells(table)).toEqual(['Bravo', 'Charlie', 'Alpha']);
    fireEvent.click(within(table).getByTestId('sort-bundleAgeDays'));
    expect(firstCells(table)).toEqual(['Alpha', 'Charlie', 'Bravo']);
  });

  it('sorts the unrecoverable tenants by tenant, both ways', () => {
    preview.data = {
      data: {
        dryRun: true, scope: 'missing', total: 0, recovered: 0, failed: 0, targets: [],
        skipped: [skipped({ tenantId: 't-1', tenantName: 'Bravo' }), skipped({ tenantId: 't-2', tenantName: 'Alpha' }), skipped({ tenantId: 't-3', tenantName: 'Charlie' })],
      },
    };
    render(<RecoverAllTab />);
    const panel = screen.getByTestId('dr-unrecoverable');
    expect(firstCells(panel)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    fireEvent.click(within(panel).getByTestId('sort-tenant'));
    expect(firstCells(panel)).toEqual(['Charlie', 'Bravo', 'Alpha']);
    fireEvent.click(within(panel).getByTestId('sort-tenant'));
    expect(firstCells(panel)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('sorts the tenants deleted on purpose by their newest bundle, both ways', async () => {
    const { MemoryRouter } = await import('react-router-dom');
    const gone = (id: string, name: string, at: string) => skipped({ tenantId: id, tenantName: name, reason: 'deleted', latestBundleStatus: 'completed', latestBundleAt: at });
    preview.data = {
      data: {
        dryRun: true, scope: 'missing', total: 0, recovered: 0, failed: 0, targets: [],
        skipped: [gone('g-1', 'Alpha', '2026-10-03T00:00:00.000Z'), gone('g-2', 'Bravo', '2026-09-01T00:00:00.000Z'), gone('g-3', 'Charlie', '2026-10-20T00:00:00.000Z')],
      },
    };
    render(<MemoryRouter><RecoverAllTab /></MemoryRouter>);
    const table = screen.getByTestId('dr-deleted-skips');
    expect(firstCells(table)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    fireEvent.click(within(table).getByTestId('sort-latestBundleAt'));
    expect(firstCells(table)).toEqual(['Bravo', 'Alpha', 'Charlie']);
    fireEvent.click(within(table).getByTestId('sort-latestBundleAt'));
    expect(firstCells(table)).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });
});
