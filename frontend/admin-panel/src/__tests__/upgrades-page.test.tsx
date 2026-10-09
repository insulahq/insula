import { render, screen, fireEvent, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import UpgradesPage from '../pages/platform/UpgradesPage';

let updateAvailable = true;
let role = 'super_admin';
let changelogNotes: string | null = '## Fixed\n- alias drift false positives';
const checkMutate = vi.fn();
let clusterNodes: Array<Record<string, unknown>> = [];
let historyRuns: Array<Record<string, unknown>> = [];
let changes: Record<string, unknown> | null = null;
const preflightCalls: string[][] = [];
const applyMutate = vi.fn(async (vars: { apply: boolean }) => ({ data: { action: 'upgrade', target: '2026.7.0', proceed: true, applied: vars.apply, summary: 'DRY-RUN', interruption: { singleNode: false, nodeCount: 3, tenantWorkloadsAffected: false, summary: 's', services: [] } } }));

vi.mock('../hooks/use-cluster-nodes', () => ({
  useClusterNodes: () => ({ data: { data: clusterNodes }, isLoading: false }),
}));

vi.mock('../hooks/use-platform-updates', () => ({
  usePlatformVersion: () => ({
    data: { data: {
      currentVersion: '2026.6.2', installed: '2026.6.2', running: '2026.6.2',
      latestVersion: null, latestSource: 'releases', available: '2026.7.0', availableVerifyStatus: 'verified',
      updateAvailable, environment: 'production', imageUpdateStrategy: 'manual', autoUpdate: false,
      pendingVersion: null, lastCheckedAt: null,
    } },
    isLoading: false, isFetching: false, refetch: vi.fn(),
  }),
  useCheckForUpdates: () => ({ mutate: checkMutate, isPending: false }),
  useUpdateSettings: () => ({ mutate: vi.fn(), isPending: false }),
  // Used by ChangelogModal, which the review modal can open.
  usePlatformChangelog: (version: string | undefined) => ({
    data: { data: { version: version ?? '', notes: changelogNotes, source: changelogNotes ? 'release' : 'none', url: 'https://example.test/release' } },
    isLoading: false,
    error: null,
  }),
}));

vi.mock('../hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'sa', role } }) }));

vi.mock('../hooks/use-platform-upgrade', () => ({
  useRollback: () => ({ mutateAsync: vi.fn(async () => ({ data: { ok: false, manifest: null, summary: 'nothing to roll back' } })), isPending: false, error: null }),
  // Used by the review modal when it opens
  usePreflight: (_enabled?: boolean, exclude: readonly string[] = []) => {
    preflightCalls.push([...exclude]);
    return { data: { data: { gates: [{ id: 'cnpg-healthy', label: 'Database (CNPG) healthy', status: 'pass', detail: 'ok' }], ok: true, failures: 0, warnings: 0, environment: 'production' } }, isLoading: false, isFetching: false, refetch: vi.fn() };
  },
  useHostMigrationsPreview: () => ({ data: { data: { mode: 'observe', willRun: false, note: 'report-only' } }, isLoading: false }),
  // Like the real mutation: a rejection is kept as `error` for the dialog to show.
  useUpgradeApply: () => {
    const [error, setError] = useState<Error | null>(null);
    return {
      mutateAsync: async (vars: { apply: boolean }) => {
        try { return await applyMutate(vars); } catch (e) { setError(e as Error); throw e; }
      },
      isPending: false,
      error,
    };
  },
  useUpgradeRun: () => ({ data: { data: { run: null } }, failureCount: 0 }),
  useCancelUpgradeRun: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useUpgradeRuns: () => ({ data: { data: historyRuns }, isLoading: false }),
  useUpgradeChanges: () => ({ data: changes ? { data: changes } : undefined, isLoading: false }),
  usePostflight: () => ({ data: undefined, isLoading: false, isError: false, failureCount: 0 }),
  useUpgradeProgress: () => ({ data: undefined, isLoading: false, isError: false, failureCount: 0 }),
}));

function renderPage(path = '/platform/updates') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}><UpgradesPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('UpgradesPage (consolidated)', () => {
  beforeEach(() => { updateAvailable = true; role = 'super_admin'; changelogNotes = '## Fixed\n- alias drift false positives'; });

  it('version card shows installed + verified available (green) + update badge + small images button', () => {
    renderPage();
    expect(screen.getByTestId('current-version')).toHaveTextContent('2026.6.2');
    const avail = screen.getByTestId('latest-version');
    expect(avail).toHaveTextContent('2026.7.0'); // from `available`, not the null latestVersion
    expect(avail.className).toMatch(/text-green/); // highlighted when an update is available
    expect(screen.getByText('update available')).toBeInTheDocument();
    expect(screen.getByTestId('show-deployed-images-button')).toBeInTheDocument();
  });

  it('shows Run upgrade only when an update is available (super_admin) and it opens the review modal', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('run-upgrade-btn'));
    expect(screen.getByTestId('upgrade-review-modal')).toBeInTheDocument();
    expect(screen.getByTestId('approve-upgrade-btn')).toBeInTheDocument();
  });

  it('hides Run upgrade when no update is available', () => {
    updateAvailable = false;
    renderPage();
    expect(screen.queryByTestId('run-upgrade-btn')).toBeNull();
  });

  it('hides Run upgrade for a non-super_admin', () => {
    role = 'admin';
    renderPage();
    expect(screen.queryByTestId('run-upgrade-btn')).toBeNull();
  });
});

/**
 * "Check for updates" used to call refetch() on the version query, which only
 * re-reads what the hourly poller CronJob last wrote to the DB — and with a 60s
 * staleTime, repeated clicks often did not even reach the network. A release
 * published since the last tick was therefore invisible no matter how many
 * times the operator clicked. Reported, ~90s after v2026.8.2 was
 * published: the 23:42 poll ran before the release existed, next tick an hour
 * away, and the button could not close that gap.
 */
describe('UpgradesPage — Check for updates actually polls', () => {
  beforeEach(() => { checkMutate.mockClear(); });

  it('issues a real poll instead of only re-reading cached state', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('check-updates-btn'));
    expect(checkMutate).toHaveBeenCalledTimes(1);
  });

  it('polls again on every click — the gap it closes can be seconds wide', () => {
    renderPage();
    const btn = screen.getByTestId('check-updates-btn');
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(checkMutate).toHaveBeenCalledTimes(2);
  });

  // ── Banner hand-off: ?review=1 opens the review modal on arrival ───────────
});


// Own top-level describe with its own state reset. Nested inside another
// describe these shared module-level fixtures (`role`, `updateAvailable`)
// carried over from whichever test ran last, and the modal silently never
// opened — the negative assertions still passed, which is exactly how that
// kind of leak hides.
describe('UpgradesPage — review hand-off + changelog', () => {
  beforeEach(() => {
    updateAvailable = true;
    role = 'super_admin';
    changelogNotes = '## Fixed\n- alias drift false positives';
  });

  describe('?review=1 hand-off from the update banner', () => {
    it('opens the review modal directly for a super_admin', async () => {
      renderPage('/platform/updates?review=1');
      expect(await screen.findByTestId('approve-upgrade-btn')).toBeInTheDocument();
    });

    it('does NOT open it for a non-super_admin, whose apply would be refused', () => {
      role = 'admin';
      renderPage('/platform/updates?review=1');
      expect(screen.queryByTestId('approve-upgrade-btn')).toBeNull();
    });

    it('does NOT open it when no update is available', () => {
      updateAvailable = false;
      renderPage('/platform/updates?review=1');
      expect(screen.queryByTestId('approve-upgrade-btn')).toBeNull();
    });

    it('stays closed without the param', () => {
      renderPage();
      expect(screen.queryByTestId('approve-upgrade-btn')).toBeNull();
    });
  });

  // ── Changelog step inside the review modal ─────────────────────────────────
  describe('Review changelog', () => {
    it('offers the changelog BEFORE the approve action, in DOM order', async () => {
      renderPage('/platform/updates?review=1');
      const review = await screen.findByTestId('review-changelog-btn');
      const approve = screen.getByTestId('approve-upgrade-btn');
      // Node.compareDocumentPosition: 4 === FOLLOWING, i.e. approve comes after.
      expect(review.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('shows the release notes for the resolved target and can approve from there', async () => {
      renderPage('/platform/updates?review=1');
      fireEvent.click(await screen.findByTestId('review-changelog-btn'));
      expect(await screen.findByTestId('changelog-body')).toHaveTextContent('alias drift false positives');
      // The changelog modal carries its own approve so reading is not a detour.
      expect(screen.getByTestId('changelog-approve-upgrade-btn')).toBeEnabled();
      expect(screen.getByTestId('changelog-cancel-btn')).toBeInTheDocument();
    });

    it('says so plainly when a version has no published notes', async () => {
      changelogNotes = null;
      renderPage('/platform/updates?review=1');
      fireEvent.click(await screen.findByTestId('review-changelog-btn'));
      expect(await screen.findByTestId('changelog-body')).toHaveTextContent(/No release notes/i);
    });
  });
});

describe('UpgradesPage — upgrading without a node that is down (ADR-064)', () => {
  const node = (name: string, ready: string) => ({ name, existsInKubernetes: true, statusConditions: [{ type: 'Ready', status: ready }] });
  beforeEach(() => { updateAvailable = true; role = 'super_admin'; clusterNodes = []; preflightCalls.length = 0; applyMutate.mockClear(); });

  it('no node down → no choice offered', async () => {
    clusterNodes = [node('sv1', 'True'), node('sv2', 'True')];
    renderPage('/platform/updates?review=1');
    await screen.findByTestId('approve-upgrade-btn');
    expect(screen.queryByTestId('upgrade-exclude-nodes')).toBeNull();
  });

  it('offers only the Not Ready node; ticking it re-checks pre-flight and the apply carries it', async () => {
    clusterNodes = [node('sv1', 'True'), node('sv2', 'Unknown')];
    renderPage('/platform/updates?review=1');
    const box = await screen.findByTestId('exclude-node-sv2');
    expect(screen.queryByTestId('exclude-node-sv1')).toBeNull();
    fireEvent.click(box);
    expect(preflightCalls.at(-1)).toEqual(['sv2']);
    const approve = screen.getByTestId('approve-upgrade-btn');
    await vi.waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(approve);
    await vi.waitFor(() => expect(applyMutate).toHaveBeenCalledWith(expect.objectContaining({ apply: true, excludeNodes: ['sv2'] })));
  });
});

describe('UpgradesPage — upgrade history (ADR-064)', () => {
  beforeEach(() => { updateAvailable = false; role = 'super_admin'; historyRuns = []; });
  const run = (over: Record<string, unknown>) => ({
    id: 'r1', fromVersion: '2026.10.7-rc.3', toVersion: '2026.10.7-rc.4', mode: 'manual', status: 'succeeded', step: 'done',
    excludedNodes: [], nodes: [], message: null, startedAt: '2026-10-09T10:00:00Z', stepStartedAt: '2026-10-09T10:20:00Z',
    finishedAt: '2026-10-09T10:24:00Z', ...over,
  });

  it('lists the runs, each linking to its page, with how they ended', () => {
    historyRuns = [
      run({ id: 'r2', status: 'cancelled', message: 'Cancelled by an operator before the services changed.', excludedNodes: ['w1'] }),
      run({}),
    ];
    renderPage();
    const card = screen.getByTestId('upgrade-history');
    expect(card).toHaveTextContent('Upgrade history');
    expect(screen.getByTestId('upgrade-history-r1')).toHaveTextContent(/v2026\.10\.7-rc\.3 → v2026\.10\.7-rc\.4.*Succeeded.*24 min/);
    expect(screen.getByTestId('upgrade-history-r2')).toHaveTextContent(/Cancelled.*without w1.*Cancelled by an operator/);
    expect(within(screen.getByTestId('upgrade-history-r1')).getByRole('link')).toHaveAttribute('href', '/platform/updates/runs/r1');
  });

  it('no runs yet → no card; not shown to a non-super_admin', () => {
    renderPage();
    expect(screen.queryByTestId('upgrade-history')).toBeNull();
    historyRuns = [run({})];
    role = 'admin';
    renderPage();
    expect(screen.queryByTestId('upgrade-history')).toBeNull();
  });
});

describe('UpgradesPage — what the upgrade changes (ADR-064 §6)', () => {
  beforeEach(() => { updateAvailable = true; role = 'super_admin'; clusterNodes = []; changes = null; });
  const base = { fromVersion: '2026.6.2', toVersion: '2026.7.0', known: true, databaseMigrations: 2, platformMigrations: 0, unreportedNodes: [] };

  it('names the services\' versions, the migrations, and each host change with when and where it runs', async () => {
    changes = {
      ...base,
      hostChanges: [
        { key: '2026.7.0/0001-a.sh', phase: 'before-services', description: 'Moves the firewall config.', nodes: ['sv1', 'sv2'] },
        { key: '2026.7.0/0002-b.sh', phase: 'after-services', description: 'Needs the new services.', nodes: ['sv2'] },
      ],
    };
    renderPage('/platform/updates?review=1');
    const section = await screen.findByTestId('upgrade-changes');
    expect(section).toHaveTextContent(/Services v2026\.6\.2 → v2026\.7\.0/);
    expect(screen.getByTestId('upgrade-changes-migrations')).toHaveTextContent('2 database migration(s), 0 platform migration(s)');
    expect(screen.getByTestId('upgrade-change-2026.7.0/0001-a.sh')).toHaveTextContent(/before the services\s*Moves the firewall config\. — every node/);
    expect(screen.getByTestId('upgrade-change-2026.7.0/0002-b.sh')).toHaveTextContent(/after the services\s*Needs the new services\. — sv2/);
  });

  it('a release without listed contents says so, instead of "no changes"', async () => {
    changes = { ...base, known: false, databaseMigrations: 0, hostChanges: [] };
    renderPage('/platform/updates?review=1');
    expect(await screen.findByTestId('upgrade-changes-unknown')).toBeInTheDocument();
    expect(screen.queryByText(/No host changes/)).toBeNull();
  });

  it('a node without a report is named, not counted as done', async () => {
    changes = { ...base, hostChanges: [], unreportedNodes: ['w1'] };
    renderPage('/platform/updates?review=1');
    expect(await screen.findByTestId('upgrade-changes-unreported')).toHaveTextContent(/w1 has not reported host state/);
  });
});

describe('UpgradesPage — a refused Approve says so by the buttons', () => {
  beforeEach(() => { updateAvailable = true; role = 'super_admin'; clusterNodes = []; applyMutate.mockClear(); });

  it('shows the refusal as an error panel next to Approve', async () => {
    applyMutate.mockImplementation(async (vars: { apply: boolean }) => {
      if (vars.apply) throw Object.assign(new Error('pre-flight has 1 blocking failure(s) — Every node can take part: w1 is not Ready'), { status: 409, code: 'UPGRADE_PREFLIGHT_FAILED' });
      return { data: { action: 'upgrade', target: '2026.7.0', proceed: true, applied: false, summary: 'DRY-RUN', interruption: { singleNode: false, nodeCount: 3, tenantWorkloadsAffected: false, summary: 's', services: [] } } };
    });
    renderPage('/platform/updates?review=1');
    const approve = await screen.findByTestId('approve-upgrade-btn');
    await vi.waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(approve);
    expect(await screen.findByTestId('upgrade-apply-error')).toHaveTextContent(/w1 is not Ready/);
  });
});

