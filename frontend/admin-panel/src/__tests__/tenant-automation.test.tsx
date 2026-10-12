import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { TenantAutomationSettings, TenantAutomationStatus } from '@insula/api-contracts';
import { ApiError } from '@/lib/api-client';
import { newlyDue, reachCount, reachedNow, splitByDue } from '@/lib/tenant-automation';

/**
 * The automatic archive/delete card. The hooks are the real ones; only the
 * network call is replaced, so what the card sends is what the API receives.
 */

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const { default: TenantAutomationCard } = await import('@/components/lifecycle/TenantAutomationCard');

const DAY = 86_400_000;
const ago = (days: number): string => new Date(Date.now() - days * DAY).toISOString();
const ahead = (days: number): string => new Date(Date.now() + days * DAY).toISOString();
const day = (iso: string): string => new Date(iso).toLocaleDateString();

/** Both steps off and nobody told: a tenant is acted on as soon as it is past its limit. */
const OFF: TenantAutomationSettings = {
  autoArchiveEnabled: false, autoArchiveAfterDays: 30, autoDeleteEnabled: false, autoDeleteAfterDays: 90, noticeDays: 0,
};
/** The same with a week's notice. */
const NOTICE: TenantAutomationSettings = { ...OFF, noticeDays: 7 };

function status(over: Partial<TenantAutomationStatus> = {}): TenantAutomationStatus {
  return {
    settings: OFF,
    intervalHours: 6,
    running: false,
    lastRun: null,
    nextRunAt: null,
    archiveBlockedReason: null,
    archiveRetentionDays: 90,
    suspended: [
      { tenantId: 't-old', name: 'Old Mill', since: ago(45), busy: null, notice: null },
      { tenantId: 't-new', name: 'New Forge', since: ago(10), busy: null, notice: null },
    ],
    archived: [
      { tenantId: 't-gone', name: 'Gone Quiet', since: ago(120), busy: null, notice: null },
      { tenantId: 't-recent', name: 'Recent Rest', since: ago(20), busy: null, notice: null },
    ],
    kept: [],
    ...over,
  };
}

/**
 * A stand-in for the API that keeps state the way the real one does: GET
 * answers the status, a PATCH merges what it was sent into the stored
 * settings and answers them, a POST starts a run, a PUT keeps a tenant out
 * (or puts it back) and moves it between the lists. `onWrite` may answer a
 * write itself (or throw); `server.status` can be changed under the card's
 * feet, as another admin would.
 */
interface Server { status: TenantAutomationStatus }
function serve(initial: TenantAutomationStatus, onWrite?: (path: string, init: RequestInit) => unknown): Server {
  const server: Server = { status: initial };
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') return { data: server.status };
    const own = onWrite?.(path, init);
    if (own !== undefined) return own;
    if (init.method === 'PATCH') {
      server.status = { ...server.status, settings: { ...server.status.settings, ...JSON.parse(init.body as string) } };
      return { data: { settings: server.status.settings } };
    }
    if (init.method === 'PUT') {
      const tenantId = path.split('/').pop() as string;
      const { exempt } = JSON.parse(init.body as string) as { exempt: boolean };
      const st = server.status;
      if (exempt) {
        const from = st.suspended.some((c) => c.tenantId === tenantId) ? 'suspended' : 'archived';
        const found = [...st.suspended, ...st.archived].find((c) => c.tenantId === tenantId);
        server.status = {
          ...st,
          suspended: st.suspended.filter((c) => c.tenantId !== tenantId),
          archived: st.archived.filter((c) => c.tenantId !== tenantId),
          kept: [...st.kept, { tenantId, name: found?.name ?? tenantId, status: from }],
        };
      } else {
        const back = st.kept.find((k) => k.tenantId === tenantId);
        server.status = {
          ...st,
          kept: st.kept.filter((k) => k.tenantId !== tenantId),
          ...(back ? { [back.status as 'suspended' | 'archived']: [...st[back.status as 'suspended' | 'archived'], { tenantId, name: back.name, since: ago(45), busy: null, notice: null }] } : {}),
        };
      }
      return { data: { tenantId, name: tenantId, status: 'suspended', exempt } };
    }
    return { data: { started: true } };
  });
  return server;
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}><TenantAutomationCard /></QueryClientProvider>
    </MemoryRouter>,
  );
}

const writes = (): Array<{ path: string; method: string; body: unknown }> => apiFetchMock.mock.calls
  .filter(([, init]) => init?.method && init.method !== 'GET')
  .map(([path, init]) => ({ path: path as string, method: init.method as string, body: init.body ? JSON.parse(init.body as string) : undefined }));

beforeEach(() => { apiFetchMock.mockReset(); });

describe('splitByDue / newlyDue', () => {
  const now = Date.now();
  const s = status();
  const idsOf = (list: ReadonlyArray<{ tenantId: string }>): string[] => list.map((c) => c.tenantId);

  it('puts a tenant past the limit in "due now", the others in order of when they pass it', () => {
    const split = splitByDue(s.suspended, 30, 0, now);
    expect(idsOf(split.dueNow)).toEqual(['t-old']);
    expect(idsOf(split.later)).toEqual(['t-new']);
    expect(split.toTell).toEqual([]);
    expect(Math.round((split.later[0].dueAt - now) / DAY)).toBe(20);
  });

  it('a tenant with no recorded date is never due, whatever the limit', () => {
    const split = splitByDue([{ tenantId: 'x', name: 'X', since: null, busy: null, notice: null }], 1, 7, now);
    expect(split.dueNow).toEqual([]);
    expect(split.toTell).toEqual([]);
    expect(split.later).toEqual([]);
    expect(idsOf(split.undated)).toEqual(['x']);
  });

  it('with a notice period, a tenant past its limit is told first — due only once the date it was given has come', () => {
    const candidates = [
      { tenantId: 'untold', name: 'Untold', since: ago(45), busy: null, notice: null },
      { tenantId: 'told', name: 'Told', since: ago(45), busy: null, notice: { toldAt: ago(2), date: ahead(5), reached: true } },
      { tenantId: 'ripe', name: 'Ripe', since: ago(45), busy: null, notice: { toldAt: ago(8), date: ago(1), reached: true } },
      { tenantId: 'far', name: 'Far', since: ago(3), busy: null, notice: null },
    ];
    const split = splitByDue(candidates, 30, 7, now);
    expect(idsOf(split.dueNow)).toEqual(['ripe']);
    expect(idsOf(split.toTell)).toEqual(['untold']);
    expect(Math.round((split.toTell[0].dueAt - now) / DAY)).toBe(7);
    expect(split.later.map((c) => [c.tenantId, c.told, c.tellAt === null ? null : Math.round((c.tellAt - now) / DAY)])).toEqual([
      ['told', true, null],          // in 5 days
      ['far', false, 20],            // limit in 27 days, told 7 before
    ]);
  });

  it('switching a step on puts every tenant already past its limit in front of the next run', () => {
    const due = newlyDue(s, { ...OFF, autoArchiveEnabled: true, autoDeleteEnabled: true }, now);
    expect(idsOf(due.archive.now)).toEqual(['t-old']);
    expect(idsOf(due.remove.now)).toEqual(['t-gone']);
    expect(due.archive.tell).toEqual([]);
    expect(reachCount(due)).toBe(2);
  });

  it('with a notice period, switching a step on reaches them as tenants to tell — and still counts them', () => {
    const due = newlyDue({ ...s, settings: NOTICE }, { ...NOTICE, autoArchiveEnabled: true, autoDeleteEnabled: true }, now);
    expect(due.archive.now).toEqual([]);
    expect(idsOf(due.archive.tell)).toEqual(['t-old']);
    expect(idsOf(due.remove.tell)).toEqual(['t-gone']);
    expect(reachCount(due)).toBe(2);
  });

  it('shortening a limit names only the tenants it newly reaches', () => {
    const on = { ...s, settings: { ...OFF, autoArchiveEnabled: true } };
    expect(idsOf(newlyDue(on, { ...on.settings, autoArchiveAfterDays: 5 }, now).archive.now)).toEqual(['t-new']);
  });

  it('taking the notice period away hurries nobody who was given a date; a tenant not yet told is named, as archived at once', () => {
    const promised = { tenantId: 't-old', name: 'Old Mill', since: ago(45), busy: null, notice: { toldAt: ago(2), date: ahead(5), reached: true } };
    const untold = { tenantId: 't-untold', name: 'Untold', since: ago(40), busy: null, notice: null };
    const on = { ...s, suspended: [promised, untold], settings: { ...NOTICE, autoArchiveEnabled: true } };
    const due = newlyDue(on, { ...on.settings, noticeDays: 0 }, now);
    expect(idsOf(due.archive.now)).toEqual(['t-untold']);
    expect(due.archive.tell).toEqual([]);
    // …and the tenant with its date still has it.
    expect(splitByDue(on.suspended, 30, 0, now).later.map((c) => [c.tenantId, c.told])).toEqual([['t-old', true]]);
  });

  it('a tenant whose message reached nobody is not due on that date: it is told again', () => {
    const silent = { tenantId: 't-silent', name: 'Silent', since: ago(45), busy: null, notice: { toldAt: ago(8), date: ago(1), reached: false } };
    const split = splitByDue([silent], 30, 7, now);
    expect(split.dueNow).toEqual([]);
    expect(idsOf(split.toTell)).toEqual(['t-silent']);
  });

  it('a tenant that would be told either way is asked about once, not again on every save', () => {
    const on = { ...s, settings: { ...NOTICE, autoArchiveEnabled: true } };
    expect(reachCount(newlyDue(on, { ...on.settings, noticeDays: 14 }, now))).toBe(0);
  });

  it('a change that reaches nobody new asks about nobody: lengthening a limit, or switching a step off', () => {
    const on = { ...s, settings: { ...OFF, autoArchiveEnabled: true, autoDeleteEnabled: true } };
    expect(reachCount(newlyDue(on, { ...on.settings, autoArchiveAfterDays: 60 }, now))).toBe(0);
    expect(reachCount(newlyDue(on, OFF, now))).toBe(0);
  });

  it('what a run reaches leaves the archive step out while no archive can be taken, and the delete step in', () => {
    const on = { ...OFF, autoArchiveEnabled: true, autoDeleteEnabled: true };
    const reach = reachedNow({ ...s, archiveBlockedReason: 'no target' }, on, now);
    expect(reach.archive).toEqual({ now: [], tell: [] });
    expect(idsOf(reach.remove.now)).toEqual(['t-gone']);
  });
});

describe('TenantAutomationCard', () => {
  it('shows, with both steps off, what switching each on would reach', async () => {
    serve(status());
    renderCard();
    expect(await screen.findByTestId('tenant-automation-archive-due-now')).toHaveTextContent('Off. Switched on, 1 tenant would be archived at the next run:');
    expect(screen.getByTestId('tenant-automation-due-t-old')).toHaveTextContent('Old Mill — suspended 45 days ago');
    expect(screen.getByTestId('tenant-automation-archive-next')).toHaveTextContent('New Forge');
    expect(screen.getByTestId('tenant-automation-delete-due-now')).toHaveTextContent('Off. Switched on, 1 tenant would be deleted at the next run:');
    expect(screen.getByTestId('tenant-automation-archive-toggle')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('tenant-automation-last-run')).toHaveTextContent('It has not run yet.');
    // Nothing to save, and nothing to run while both steps are off.
    expect(screen.queryByTestId('tenant-automation-save')).toBeNull();
    expect(screen.getByTestId('tenant-automation-run-now')).toBeDisabled();
  });

  it('the list follows the limit being typed, before anything is saved', async () => {
    serve(status());
    renderCard();
    await screen.findByTestId('tenant-automation-archive-due-now');
    fireEvent.change(screen.getByTestId('tenant-automation-archive-days'), { target: { value: '5' } });
    expect(screen.getByTestId('tenant-automation-archive-due-now')).toHaveTextContent('2 tenants would be archived');
    fireEvent.change(screen.getByTestId('tenant-automation-archive-days'), { target: { value: '60' } });
    expect(screen.getByTestId('tenant-automation-archive-due-now')).toHaveTextContent('2 tenants suspended, none due.');
    expect(writes()).toEqual([]);
  });

  it('a limit that is not a whole number of days cannot be saved', async () => {
    serve(status());
    renderCard();
    await screen.findByTestId('tenant-automation-archive-due-now');
    for (const bad of ['0', '', '1.5', '4000']) {
      fireEvent.change(screen.getByTestId('tenant-automation-archive-days'), { target: { value: bad } });
      expect(screen.getByTestId('tenant-automation-save')).toBeDisabled();
      expect(screen.getByTestId('tenant-automation-days-invalid')).toBeInTheDocument();
    }
    expect(writes()).toEqual([]);
  });

  it('a save that reaches no tenant goes straight through, and sends only what was changed', async () => {
    serve(status({ suspended: [], archived: [] }));
    renderCard();
    fireEvent.click(await screen.findByTestId('tenant-automation-archive-toggle'));
    fireEvent.change(screen.getByTestId('tenant-automation-archive-days'), { target: { value: '14' } });
    fireEvent.click(screen.getByTestId('tenant-automation-save'));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      path: '/api/v1/admin/lifecycle/automation',
      method: 'PATCH',
      body: { autoArchiveEnabled: true, autoArchiveAfterDays: 14 },
    });
    expect(screen.queryByTestId('tenant-automation-confirm')).toBeNull();
    // Saved: the card shows the stored settings again and offers nothing to save.
    await waitFor(() => expect(screen.queryByTestId('tenant-automation-save')).toBeNull());
    expect(screen.getByTestId('tenant-automation-archive-toggle')).toHaveAttribute('aria-checked', 'true');
  });

  it('switching archive on with a tenant past the limit asks first and names it; Cancel saves nothing', async () => {
    serve(status());
    renderCard();
    fireEvent.click(await screen.findByTestId('tenant-automation-archive-toggle'));
    fireEvent.click(screen.getByTestId('tenant-automation-save'));
    const dialog = await screen.findByTestId('tenant-automation-confirm');
    expect(within(dialog).getByTestId('tenant-automation-confirm-archive')).toHaveTextContent('1 tenant will be archived at the next run, within 6 hours:');
    expect(within(dialog).getByTestId('tenant-automation-confirm-archive')).toHaveTextContent('Old Mill');
    // An archive can be undone, so there is nothing to type.
    expect(within(dialog).queryByTestId('tenant-automation-confirm-input')).toBeNull();
    fireEvent.click(within(dialog).getByTestId('tenant-automation-confirm-cancel'));
    expect(screen.queryByTestId('tenant-automation-confirm')).toBeNull();
    expect(writes()).toEqual([]);
    // The change is still there to be saved or discarded.
    expect(screen.getByTestId('tenant-automation-archive-toggle')).toHaveAttribute('aria-checked', 'true');
  });

  it('switching delete on with a tenant past the limit has to be typed before it saves', async () => {
    serve(status());
    renderCard();
    fireEvent.click(await screen.findByTestId('tenant-automation-delete-toggle'));
    fireEvent.click(screen.getByTestId('tenant-automation-save'));
    const dialog = await screen.findByTestId('tenant-automation-confirm');
    expect(within(dialog).getByTestId('tenant-automation-confirm-delete')).toHaveTextContent('Gone Quiet');
    const ok = within(dialog).getByTestId('tenant-automation-confirm-ok');
    expect(ok).toBeDisabled();
    fireEvent.change(within(dialog).getByTestId('tenant-automation-confirm-input'), { target: { value: 'delete' } });
    expect(ok).toBeDisabled();
    expect(writes()).toEqual([]);
    fireEvent.change(within(dialog).getByTestId('tenant-automation-confirm-input'), { target: { value: 'delete 1 tenant' } });
    fireEvent.click(ok);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ autoDeleteEnabled: true });
    await waitFor(() => expect(screen.queryByTestId('tenant-automation-confirm')).toBeNull());
  });

  it('a save the API refuses keeps the dialog open and says why', async () => {
    serve(status(), () => { throw new ApiError(400, 'VALIDATION_ERROR', 'Number must be at least 1', {}); });
    renderCard();
    fireEvent.click(await screen.findByTestId('tenant-automation-archive-toggle'));
    fireEvent.click(screen.getByTestId('tenant-automation-save'));
    fireEvent.click(within(await screen.findByTestId('tenant-automation-confirm')).getByTestId('tenant-automation-confirm-ok'));
    expect(await screen.findByTestId('tenant-automation-confirm-error')).toHaveTextContent('Number must be at least 1');
    expect(screen.getByTestId('tenant-automation-archive-toggle')).toHaveAttribute('aria-checked', 'true');
  });

  it('Discard puts the stored settings back', async () => {
    serve(status());
    renderCard();
    fireEvent.click(await screen.findByTestId('tenant-automation-archive-toggle'));
    fireEvent.change(screen.getByTestId('tenant-automation-archive-days'), { target: { value: '7' } });
    fireEvent.click(screen.getByTestId('tenant-automation-discard'));
    expect(screen.getByTestId('tenant-automation-archive-toggle')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('tenant-automation-archive-days')).toHaveValue(30);
    expect(writes()).toEqual([]);
  });

  it('with archive on, says who the next run reaches, and who is skipped and why', async () => {
    serve(status({
      settings: { ...OFF, autoArchiveEnabled: true },
      suspended: [
        { tenantId: 't-old', name: 'Old Mill', since: ago(45), busy: 'failed', notice: null },
        { tenantId: 't-mid', name: 'Mid Way', since: ago(40), busy: 'restoring', notice: null },
        { tenantId: 't-none', name: 'No Date', since: null, busy: null, notice: null },
      ],
    }));
    renderCard();
    expect(await screen.findByTestId('tenant-automation-archive-due-now')).toHaveTextContent('2 tenants due — archived at the next run:');
    expect(screen.getByTestId('tenant-automation-due-t-old')).toHaveTextContent('not until its failed storage operation is cleared');
    expect(screen.getByTestId('tenant-automation-due-t-mid')).toHaveTextContent('not until its restoring operation has ended');
    expect(screen.getByTestId('tenant-automation-archive-undated')).toHaveTextContent('1 tenant with no recorded suspension date is never archived automatically.');
  });

  it('says so when no archive can be taken — only once archive is on or being switched on — and promises no archive meanwhile', async () => {
    serve(status({ archiveBlockedReason: 'No backup target is assigned to tenant snapshots.' }));
    renderCard();
    await screen.findByTestId('tenant-automation-archive-due-now');
    expect(screen.queryByTestId('tenant-automation-archive-blocked')).toBeNull();
    fireEvent.click(screen.getByTestId('tenant-automation-archive-toggle'));
    expect(screen.getByTestId('tenant-automation-archive-blocked')).toHaveTextContent('No backup target is assigned to tenant snapshots.');
    expect(screen.getByTestId('tenant-automation-archive-due-now')).toHaveTextContent('1 tenant due — not archived while no archive can be taken:');
  });

  it('Run now names nobody for an archive that cannot be taken', async () => {
    serve(status({ settings: { ...OFF, autoArchiveEnabled: true }, archiveBlockedReason: 'No backup target is assigned to tenant snapshots.' }));
    renderCard();
    fireEvent.click(await screen.findByTestId('tenant-automation-run-now'));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(screen.queryByTestId('tenant-automation-confirm')).toBeNull();
  });

  it('a setting this operator did not touch is not sent — another admin\'s change to it survives the save', async () => {
    // Opened while automatic delete was on. Another admin then switches it off.
    const server = serve(status({ settings: { ...OFF, autoDeleteEnabled: true }, suspended: [], archived: [] }));
    renderCard();
    fireEvent.change(await screen.findByTestId('tenant-automation-archive-days'), { target: { value: '45' } });
    server.status = { ...server.status, settings: { ...server.status.settings, autoDeleteEnabled: false } };
    fireEvent.click(screen.getByTestId('tenant-automation-save'));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ autoArchiveAfterDays: 45 });
    expect(server.status.settings.autoDeleteEnabled).toBe(false);
    // …and the card now shows what is stored, not what it was opened with.
    await waitFor(() => expect(screen.getByTestId('tenant-automation-delete-toggle')).toHaveAttribute('aria-checked', 'false'));
  });

  it('the save asks about the tenants in line NOW, not the ones the card was opened with', async () => {
    const server = serve(status({ suspended: [] }));
    renderCard();
    fireEvent.click(await screen.findByTestId('tenant-automation-archive-toggle'));
    // A tenant passes the limit — or is suspended and backdated — after the card was loaded.
    server.status = { ...server.status, suspended: [{ tenantId: 't-late', name: 'Late Comer', since: ago(31), busy: null, notice: null }] };
    fireEvent.click(screen.getByTestId('tenant-automation-save'));
    const dialog = await screen.findByTestId('tenant-automation-confirm');
    expect(within(dialog).getByTestId('tenant-automation-confirm-archive')).toHaveTextContent('Late Comer');
    expect(writes()).toEqual([]);
  });

  it('a tenant past the limit but busy is named with what it waits for', async () => {
    serve(status({
      archived: [
        { tenantId: 't-gone', name: 'Gone Quiet', since: ago(120), busy: null, notice: null },
        { tenantId: 't-rest', name: 'Being Restored', since: ago(200), busy: 'restoring', notice: null },
      ],
    }));
    renderCard();
    fireEvent.click(await screen.findByTestId('tenant-automation-delete-toggle'));
    fireEvent.click(screen.getByTestId('tenant-automation-save'));
    const list = within(await screen.findByTestId('tenant-automation-confirm')).getByTestId('tenant-automation-confirm-delete');
    expect(list).toHaveTextContent('Being Restored — archived 200 days ago (not until its restoring operation has ended)');
    expect(list).toHaveTextContent('Gone Quiet — archived 120 days ago');
  });

  it('keeps what the last run could not do in view', async () => {
    serve(status({
      settings: { ...OFF, autoArchiveEnabled: true },
      lastRun: {
        startedAt: ago(0.1), finishedAt: ago(0.1), trigger: 'schedule',
        archived: [{ tenantId: 'a', name: 'A' }], deleted: [],
        failed: [{ tenantId: 't-old', name: 'Old Mill', action: 'archive', error: 'the backup target did not answer' }],
        told: [],
        archiveSkippedReason: null,
        errors: ['The delete step stopped: the database did not answer'],
      },
    }));
    renderCard();
    expect(await screen.findByTestId('tenant-automation-last-run')).toHaveTextContent('archived 1, failed on 1');
    expect(screen.getByTestId('tenant-automation-last-run-problems')).toHaveTextContent('Could not archive Old Mill: the backup target did not answer');
    expect(screen.getByTestId('tenant-automation-last-run-problems')).toHaveTextContent('The delete step stopped: the database did not answer');
  });

  it('Run now with nothing due starts a run at once', async () => {
    serve(status({ settings: { ...OFF, autoArchiveEnabled: true }, suspended: [] }));
    renderCard();
    fireEvent.click(await screen.findByTestId('tenant-automation-run-now'));
    await waitFor(() => expect(writes()).toEqual([{ path: '/api/v1/admin/lifecycle/automation/run', method: 'POST', body: undefined }]));
    expect(screen.queryByTestId('tenant-automation-confirm')).toBeNull();
  });

  it('Run now with tenants due names them first, and a delete has to be typed', async () => {
    serve(status({ settings: { ...OFF, autoArchiveEnabled: true, autoDeleteEnabled: true } }));
    renderCard();
    fireEvent.click(await screen.findByTestId('tenant-automation-run-now'));
    const dialog = await screen.findByTestId('tenant-automation-confirm');
    expect(within(dialog).getByTestId('tenant-automation-confirm-archive')).toHaveTextContent('1 tenant will be archived now:');
    expect(within(dialog).getByTestId('tenant-automation-confirm-delete')).toHaveTextContent('1 tenant will be deleted now:');
    expect(within(dialog).getByTestId('tenant-automation-confirm-ok')).toBeDisabled();
    expect(writes()).toEqual([]);
    fireEvent.change(within(dialog).getByTestId('tenant-automation-confirm-input'), { target: { value: 'delete 1 tenant' } });
    fireEvent.click(within(dialog).getByTestId('tenant-automation-confirm-ok'));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].method).toBe('POST');
  });

  it('a run refused because one is under way says that nothing was started', async () => {
    serve(status({ settings: { ...OFF, autoArchiveEnabled: true }, suspended: [] }), () => {
      throw new ApiError(409, 'JOB_ALREADY_RUNNING', 'The automatic archive and delete sweep is already running.', {
        operatorError: {
          code: 'JOB_ALREADY_RUNNING', title: 'Already running',
          detail: 'The automatic archive and delete sweep is already running, started by its schedule or by another request.',
          remediation: ['Nothing was started by this request. Wait for the run under way to finish, then try again.'],
          retryable: true,
        },
      });
    });
    renderCard();
    fireEvent.click(await screen.findByTestId('tenant-automation-run-now'));
    const panel = await screen.findByTestId('tenant-automation-run-error');
    expect(panel).toHaveTextContent('Already running');
    expect(panel).toHaveTextContent('Nothing was started by this request');
  });

  it('Run now is unavailable while a run is under way', async () => {
    serve(status({ settings: { ...OFF, autoArchiveEnabled: true }, running: true }));
    renderCard();
    expect(await screen.findByTestId('tenant-automation-running')).toHaveTextContent('A run is under way.');
    expect(screen.getByTestId('tenant-automation-run-now')).toBeDisabled();
  });

  it('Run now is unavailable while a change is unsaved — it would run the stored limits, not the ones on screen', async () => {
    serve(status({ settings: { ...OFF, autoArchiveEnabled: true } }));
    renderCard();
    const runNow = await screen.findByTestId('tenant-automation-run-now');
    expect(runNow).toBeEnabled();
    fireEvent.change(screen.getByTestId('tenant-automation-archive-days'), { target: { value: '5' } });
    expect(runNow).toBeDisabled();
    expect(runNow).toHaveAttribute('title', 'Save or discard your changes first');
    fireEvent.click(screen.getByTestId('tenant-automation-discard'));
    expect(runNow).toBeEnabled();
  });

  it('a status that cannot be loaded shows the error and a retry, not an empty card', async () => {
    apiFetchMock.mockRejectedValue(new ApiError(500, 'INTERNAL_SERVER_ERROR', 'database unreachable', {}));
    renderCard();
    expect(await screen.findByTestId('tenant-automation-load-error')).toHaveTextContent('database unreachable');
    expect(screen.queryByTestId('tenant-automation-archive-toggle')).toBeNull();
  });

  // ── the notice period ─────────────────────────────────────────────────────

  it('with a notice period, shows who would be told and the date each would be given — not who would be archived', async () => {
    serve(status({ settings: NOTICE }));
    renderCard();
    expect(await screen.findByTestId('tenant-automation-archive-to-tell')).toHaveTextContent(
      'Off. Switched on, 1 tenant would be told at the next run, and archived on the date given:',
    );
    expect(screen.getByTestId('tenant-automation-due-t-old')).toHaveTextContent(`Old Mill — suspended 45 days ago, archive on ${day(ahead(7))}`);
    expect(screen.queryByTestId('tenant-automation-archive-due-now')).toBeNull();
    expect(screen.getByTestId('tenant-automation-notice-days')).toHaveValue(7);
    // New Forge passes its limit in 20 days and is told a week before.
    expect(screen.getByTestId('tenant-automation-archive-next')).toHaveTextContent(`New Forge on ${day(ahead(20))} (it will be told on ${day(ahead(13))})`);
  });

  it('the lists follow the notice period being typed, and say what none at all means', async () => {
    serve(status({ settings: NOTICE }));
    renderCard();
    await screen.findByTestId('tenant-automation-archive-to-tell');
    fireEvent.change(screen.getByTestId('tenant-automation-notice-days'), { target: { value: '0' } });
    expect(screen.getByTestId('tenant-automation-archive-due-now')).toHaveTextContent('1 tenant would be archived at the next run');
    expect(screen.queryByTestId('tenant-automation-archive-to-tell')).toBeNull();
    expect(screen.getByTestId('tenant-automation-notice-explanation')).toHaveTextContent('Nobody is told.');
    expect(screen.getByTestId('tenant-automation-notice-explanation')).toHaveTextContent('one that was given a date already keeps it');
    expect(writes()).toEqual([]);
  });

  it('saves a notice period as the one setting that changed', async () => {
    serve(status({ settings: NOTICE, suspended: [], archived: [] }));
    renderCard();
    fireEvent.change(await screen.findByTestId('tenant-automation-notice-days'), { target: { value: '21' } });
    fireEvent.click(screen.getByTestId('tenant-automation-save'));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ noticeDays: 21 });
  });

  it('a notice period that is not 0 to 90 whole days cannot be saved, and the card says which number is wrong', async () => {
    serve(status({ settings: NOTICE }));
    renderCard();
    await screen.findByTestId('tenant-automation-notice-days');
    for (const bad of ['', '-1', '1.5', '91']) {
      fireEvent.change(screen.getByTestId('tenant-automation-notice-days'), { target: { value: bad } });
      expect(screen.getByTestId('tenant-automation-save')).toBeDisabled();
      expect(screen.getByTestId('tenant-automation-days-invalid')).toHaveTextContent('The notice period is a whole number of days from 0 to 90.');
    }
    expect(writes()).toEqual([]);
  });

  it('switching archive on under a notice period asks first, names who is told and for which date, and needs nothing typed', async () => {
    serve(status({ settings: NOTICE }));
    renderCard();
    fireEvent.click(await screen.findByTestId('tenant-automation-archive-toggle'));
    fireEvent.click(screen.getByTestId('tenant-automation-save'));
    const dialog = await screen.findByTestId('tenant-automation-confirm');
    const list = within(dialog).getByTestId('tenant-automation-confirm-archive-tell');
    expect(list).toHaveTextContent('1 tenant will be told at the next run, within 6 hours, and archived on the date given:');
    expect(list).toHaveTextContent(`Old Mill — suspended 45 days ago, archive on ${day(ahead(7))}`);
    expect(within(dialog).queryByTestId('tenant-automation-confirm-archive')).toBeNull();
    expect(within(dialog).getByTestId('tenant-automation-confirm-told-note')).toHaveTextContent('without another question');
    expect(within(dialog).queryByTestId('tenant-automation-confirm-input')).toBeNull();
    fireEvent.click(within(dialog).getByTestId('tenant-automation-confirm-ok'));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ autoArchiveEnabled: true });
  });

  it('switching delete on under a notice period still has to be typed: the delete follows on its date with nobody asked again', async () => {
    serve(status({ settings: NOTICE }));
    renderCard();
    fireEvent.click(await screen.findByTestId('tenant-automation-delete-toggle'));
    fireEvent.click(screen.getByTestId('tenant-automation-save'));
    const dialog = await screen.findByTestId('tenant-automation-confirm');
    expect(within(dialog).getByTestId('tenant-automation-confirm-delete-tell')).toHaveTextContent(`Gone Quiet — archived 120 days ago, delete on ${day(ahead(7))}`);
    const ok = within(dialog).getByTestId('tenant-automation-confirm-ok');
    expect(ok).toBeDisabled();
    fireEvent.change(within(dialog).getByTestId('tenant-automation-confirm-input'), { target: { value: 'delete 1 tenant' } });
    expect(ok).toBeEnabled();
    expect(writes()).toEqual([]);
  });

  it('a tenant whose date has come is due, and the card says when it was told; one still waiting is next', async () => {
    serve(status({
      settings: { ...NOTICE, autoArchiveEnabled: true },
      suspended: [
        { tenantId: 't-ripe', name: 'Ripe Field', since: ago(45), busy: null, notice: { toldAt: ago(8), date: ago(1), reached: true } },
        { tenantId: 't-wait', name: 'Waiting Room', since: ago(44), busy: null, notice: { toldAt: ago(2), date: ahead(5), reached: true } },
      ],
    }));
    renderCard();
    expect(await screen.findByTestId('tenant-automation-archive-due-now')).toHaveTextContent('1 tenant due — archived at the next run:');
    expect(screen.getByTestId('tenant-automation-due-t-ripe')).toHaveTextContent('Ripe Field — suspended 45 days ago, told');
    expect(screen.getByTestId('tenant-automation-archive-next')).toHaveTextContent(`Waiting Room on ${day(ahead(5))} (it has been told)`);
    expect(screen.queryByTestId('tenant-automation-archive-to-tell')).toBeNull();
  });

  it('a tenant nobody could be told stays under "told at the next run", marked — its old date is not used', async () => {
    serve(status({
      settings: { ...NOTICE, autoArchiveEnabled: true },
      suspended: [{ tenantId: 't-silent', name: 'Silent Hall', since: ago(45), busy: null, notice: { toldAt: ago(8), date: ago(1), reached: false } }],
    }));
    renderCard();
    expect(await screen.findByTestId('tenant-automation-archive-to-tell')).toHaveTextContent('1 tenant told at the next run');
    const line = screen.getByTestId('tenant-automation-due-t-silent');
    expect(line).toHaveTextContent(`archive on ${day(ahead(7))}`);
    expect(line).toHaveTextContent('(the last message reached nobody)');
    expect(screen.queryByTestId('tenant-automation-archive-due-now')).toBeNull();
  });

  it('setting the notice period to nothing while a tenant waits for its date asks about nobody and leaves that tenant its date', async () => {
    const server = serve(status({
      settings: { ...NOTICE, autoArchiveEnabled: true },
      suspended: [{ tenantId: 't-wait', name: 'Waiting Room', since: ago(44), busy: null, notice: { toldAt: ago(2), date: ahead(5), reached: true } }],
      archived: [],
    }));
    renderCard();
    fireEvent.change(await screen.findByTestId('tenant-automation-notice-days'), { target: { value: '0' } });
    // The preview, before saving: still waiting for its date, not due.
    expect(screen.getByTestId('tenant-automation-archive-next')).toHaveTextContent(`Waiting Room on ${day(ahead(5))} (it has been told)`);
    fireEvent.click(screen.getByTestId('tenant-automation-save'));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ noticeDays: 0 });
    expect(screen.queryByTestId('tenant-automation-confirm')).toBeNull();
    expect(server.status.settings.noticeDays).toBe(0);
  });

  it('Run now under a notice period names who it will tell, and runs when confirmed', async () => {
    serve(status({ settings: { ...NOTICE, autoArchiveEnabled: true } }));
    renderCard();
    fireEvent.click(await screen.findByTestId('tenant-automation-run-now'));
    const dialog = await screen.findByTestId('tenant-automation-confirm');
    expect(within(dialog).getByTestId('tenant-automation-confirm-archive-tell')).toHaveTextContent('1 tenant will be told now, and archived on the date given:');
    fireEvent.click(within(dialog).getByTestId('tenant-automation-confirm-ok'));
    await waitFor(() => expect(writes()).toEqual([{ path: '/api/v1/admin/lifecycle/automation/run', method: 'POST', body: undefined }]));
  });

  it('says how many the last run told, and keeps in view those its message did not reach', async () => {
    serve(status({
      settings: { ...NOTICE, autoArchiveEnabled: true },
      lastRun: {
        startedAt: ago(0.1), finishedAt: ago(0.1), trigger: 'schedule', archived: [], deleted: [], failed: [],
        told: [
          { tenantId: 'a', name: 'Alpha', action: 'archive', date: ahead(7), reached: true },
          { tenantId: 'b', name: 'Beta', action: 'delete', date: ahead(7), reached: false },
        ],
        archiveSkippedReason: null, errors: [],
      },
    }));
    renderCard();
    // One of the two messages reached nobody: that is not "told 2".
    expect(await screen.findByTestId('tenant-automation-last-run')).toHaveTextContent('told 1, could not tell 1.');
    const problems = screen.getByTestId('tenant-automation-last-run-problems');
    expect(problems).toHaveTextContent('The last run could not tell everybody it had to.');
    expect(within(problems).getByTestId('tenant-automation-unreached')).toHaveTextContent('Nobody could be told at Beta');
    expect(within(problems).getByTestId('tenant-automation-unreached')).toHaveTextContent('not deleted until the message reaches somebody');
    expect(problems).not.toHaveTextContent('Alpha');
  });

  it('a last run that told everybody shows no problem', async () => {
    serve(status({
      settings: { ...NOTICE, autoArchiveEnabled: true },
      lastRun: {
        startedAt: ago(0.1), finishedAt: ago(0.1), trigger: 'schedule', archived: [], deleted: [], failed: [],
        told: [{ tenantId: 'a', name: 'Alpha', action: 'archive', date: ahead(7), reached: true }],
        archiveSkippedReason: null, errors: [],
      },
    }));
    renderCard();
    expect(await screen.findByTestId('tenant-automation-last-run')).toHaveTextContent('told 1.');
    expect(screen.queryByTestId('tenant-automation-last-run-problems')).toBeNull();
  });

  // ── keeping a tenant out ──────────────────────────────────────────────────

  it('"Keep out" takes a tenant out of both steps at once, and it is listed as kept out with the way back', async () => {
    serve(status());
    renderCard();
    expect(await screen.findByTestId('tenant-automation-kept')).toHaveTextContent('No tenant is kept out.');
    fireEvent.click(screen.getByTestId('tenant-automation-keep-out-t-old'));
    await waitFor(() => expect(writes()).toEqual([
      { path: '/api/v1/admin/lifecycle/automation/tenants/t-old', method: 'PUT', body: { exempt: true } },
    ]));
    const kept = await screen.findByTestId('tenant-automation-kept-t-old');
    expect(kept).toHaveTextContent('Old Mill — suspended');
    expect(screen.queryByTestId('tenant-automation-due-t-old')).toBeNull();
    expect(screen.getByTestId('tenant-automation-archive-due-now')).toHaveTextContent('1 tenant suspended, none due.');

    fireEvent.click(screen.getByTestId('tenant-automation-put-back-t-old'));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toEqual({ path: '/api/v1/admin/lifecycle/automation/tenants/t-old', method: 'PUT', body: { exempt: false } });
    await waitFor(() => expect(screen.queryByTestId('tenant-automation-kept-t-old')).toBeNull());
    expect(await screen.findByTestId('tenant-automation-due-t-old')).toBeInTheDocument();
  });

  it('the tenant that comes due next can be kept out too, before it is ever told', async () => {
    serve(status({ settings: { ...NOTICE, autoArchiveEnabled: true } }));
    renderCard();
    await screen.findByTestId('tenant-automation-archive-next');
    fireEvent.click(screen.getByTestId('tenant-automation-keep-out-t-new'));
    await waitFor(() => expect(writes()[0]).toEqual({ path: '/api/v1/admin/lifecycle/automation/tenants/t-new', method: 'PUT', body: { exempt: true } }));
  });

  it('keeping a tenant out does not touch unsaved settings, and needs no save', async () => {
    serve(status());
    renderCard();
    fireEvent.change(await screen.findByTestId('tenant-automation-archive-days'), { target: { value: '40' } });
    fireEvent.click(screen.getByTestId('tenant-automation-keep-out-t-old'));
    await screen.findByTestId('tenant-automation-kept-t-old');
    expect(screen.getByTestId('tenant-automation-archive-days')).toHaveValue(40);
    expect(screen.getByTestId('tenant-automation-save')).toBeEnabled();
    expect(writes().map((w) => w.method)).toEqual(['PUT']);
  });

  it('a "Keep out" the API refuses says why, and the tenant stays in line', async () => {
    serve(status(), (_path, init) => {
      if (init.method === 'PUT') throw new ApiError(404, 'TENANT_NOT_FOUND', 'Tenant t-old not found', {});
      return undefined;
    });
    renderCard();
    fireEvent.click(await screen.findByTestId('tenant-automation-keep-out-t-old'));
    expect(await screen.findByTestId('tenant-automation-keep-error')).toHaveTextContent('Tenant t-old not found');
    expect(screen.getByTestId('tenant-automation-due-t-old')).toBeInTheDocument();
  });

  it('lists tenants kept out whatever their status — an active one kept out ahead of time too', async () => {
    serve(status({ kept: [{ tenantId: 't-own', name: 'Our Own Site', status: 'active' }, { tenantId: 't-held', name: 'Held Back', status: 'archived' }] }));
    renderCard();
    const kept = await screen.findByTestId('tenant-automation-kept');
    expect(kept).toHaveTextContent('Kept out — never archived or deleted automatically (2):');
    expect(within(kept).getByTestId('tenant-automation-kept-t-own')).toHaveTextContent('Our Own Site — active');
    expect(within(kept).getByTestId('tenant-automation-kept-t-held')).toHaveTextContent('Held Back — archived');
  });
});
