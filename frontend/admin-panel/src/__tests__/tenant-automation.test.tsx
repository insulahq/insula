import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { TenantAutomationSettings, TenantAutomationStatus } from '@insula/api-contracts';
import { ApiError } from '@/lib/api-client';
import { newlyDue, splitByDue } from '@/lib/tenant-automation';

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

const OFF: TenantAutomationSettings = {
  autoArchiveEnabled: false, autoArchiveAfterDays: 30, autoDeleteEnabled: false, autoDeleteAfterDays: 90,
};

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
      { tenantId: 't-old', name: 'Old Mill', since: ago(45), busy: null },
      { tenantId: 't-new', name: 'New Forge', since: ago(10), busy: null },
    ],
    archived: [
      { tenantId: 't-gone', name: 'Gone Quiet', since: ago(120), busy: null },
      { tenantId: 't-recent', name: 'Recent Rest', since: ago(20), busy: null },
    ],
    ...over,
  };
}

/**
 * A stand-in for the API that keeps state the way the real one does: GET
 * answers the status, a PATCH merges what it was sent into the stored
 * settings and answers them, a POST starts a run. `onWrite` may answer a
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

  it('puts a tenant past the limit in "due now", the others in order of when they pass it', () => {
    const split = splitByDue(s.suspended, 30, now);
    expect(split.dueNow.map((c) => c.tenantId)).toEqual(['t-old']);
    expect(split.later.map((c) => c.tenantId)).toEqual(['t-new']);
    expect(Math.round((split.later[0].dueAt - now) / DAY)).toBe(20);
  });

  it('a tenant with no recorded date is never due, whatever the limit', () => {
    const split = splitByDue([{ tenantId: 'x', name: 'X', since: null, busy: null }], 1, now);
    expect(split.dueNow).toEqual([]);
    expect(split.later).toEqual([]);
    expect(split.undated.map((c) => c.tenantId)).toEqual(['x']);
  });

  it('switching a step on puts every tenant already past its limit in front of the next run', () => {
    const due = newlyDue(s, { ...OFF, autoArchiveEnabled: true, autoDeleteEnabled: true }, now);
    expect(due.archive.map((c) => c.tenantId)).toEqual(['t-old']);
    expect(due.remove.map((c) => c.tenantId)).toEqual(['t-gone']);
  });

  it('shortening a limit names only the tenants it newly reaches', () => {
    const on = { ...s, settings: { ...OFF, autoArchiveEnabled: true } };
    expect(newlyDue(on, { ...on.settings, autoArchiveAfterDays: 5 }, now).archive.map((c) => c.tenantId)).toEqual(['t-new']);
  });

  it('a change that reaches nobody new asks about nobody: lengthening a limit, or switching a step off', () => {
    const on = { ...s, settings: { ...OFF, autoArchiveEnabled: true, autoDeleteEnabled: true } };
    expect(newlyDue(on, { ...on.settings, autoArchiveAfterDays: 60 }, now)).toEqual({ archive: [], remove: [] });
    expect(newlyDue(on, OFF, now)).toEqual({ archive: [], remove: [] });
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
    expect(screen.getByTestId('tenant-automation-archive-due-now')).toHaveTextContent('2 tenants suspended, none past this limit.');
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
        { tenantId: 't-old', name: 'Old Mill', since: ago(45), busy: 'failed' },
        { tenantId: 't-mid', name: 'Mid Way', since: ago(40), busy: 'restoring' },
        { tenantId: 't-none', name: 'No Date', since: null, busy: null },
      ],
    }));
    renderCard();
    expect(await screen.findByTestId('tenant-automation-archive-due-now')).toHaveTextContent('2 tenants past this limit — archived at the next run:');
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
    expect(screen.getByTestId('tenant-automation-archive-due-now')).toHaveTextContent('1 tenant past this limit — not archived while no archive can be taken:');
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
    server.status = { ...server.status, suspended: [{ tenantId: 't-late', name: 'Late Comer', since: ago(31), busy: null }] };
    fireEvent.click(screen.getByTestId('tenant-automation-save'));
    const dialog = await screen.findByTestId('tenant-automation-confirm');
    expect(within(dialog).getByTestId('tenant-automation-confirm-archive')).toHaveTextContent('Late Comer');
    expect(writes()).toEqual([]);
  });

  it('a tenant past the limit but busy is named with what it waits for', async () => {
    serve(status({
      archived: [
        { tenantId: 't-gone', name: 'Gone Quiet', since: ago(120), busy: null },
        { tenantId: 't-rest', name: 'Being Restored', since: ago(200), busy: 'restoring' },
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
});
