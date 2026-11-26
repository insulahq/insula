import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEPLOYMENT_ENTRY, SQLITE_DISCOVERY_ENTRY, SQLITE_SUBJECT } from './recorder.js';
import {
  ALERT_COOLDOWN_MS,
  ITEM_MAX_CHARS,
  episodeKey,
  executeSweep,
  missedRun,
  planSweep,
  recoveredItem,
  staleItem,
  type SweepIo,
  type SweepRow,
} from './sweep.js';

const H = 3_600_000;
// The run judged against, and "now" a few hours after it.
const RUN = new Date('2026-11-26T02:00:00Z');
const NOW = new Date('2026-11-26T06:00:00Z');
const WAVE = new Set(['t1', 't2']);

function row(over: Partial<SweepRow> = {}): SweepRow {
  return {
    tenantId: 't1', tenantName: 'Acme Ltd', instanceState: 'active', subjectKey: 'dep-1', databaseName: 'shop', deploymentId: 'dep-1',
    deploymentName: 'my-mariadb', engine: 'mariadb',
    lastAttemptAt: new Date('2026-11-26T02:05:00Z'), lastAttemptBundleId: 'bkp-9', lastStatus: 'failed',
    lastError: 'Column count of mysql.proc is wrong', lastSuccessAt: new Date('2026-11-25T02:10:00Z'),
    lastSuccessBundleId: 'bkp-1', lastSuccessSizeBytes: 10, staleSince: null, alertedAt: null, lastAlertedAt: null,
    createdAt: new Date('2026-10-01T00:00:00Z'), ...over,
  };
}

describe('missedRun', () => {
  it('overdue: known before the run, no good backup since it', () => {
    expect(missedRun(row(), RUN)).toBe(true);
    expect(missedRun(row({ lastSuccessAt: null }), RUN)).toBe(true);
  });
  it('a backup at or after the run start counts, wherever the tenant fell in the wave', () => {
    expect(missedRun(row({ lastSuccessAt: new Date('2026-11-26T04:58:00Z') }), RUN)).toBe(false);
  });
  it('a database first seen after the run is judged on the next one', () => {
    expect(missedRun(row({ lastSuccessAt: null, createdAt: new Date('2026-11-26T02:30:00Z') }), RUN)).toBe(false);
  });
});

describe('planSweep', () => {
  it('opens and alerts an episode for a database that missed the run', () => {
    const p = planSweep([row()], NOW, RUN, WAVE);
    expect(p.open).toHaveLength(1);
    expect(p.open[0]!.staleSince).toEqual(NOW);
    expect(p.alert).toEqual(p.open);
  });

  it('judges nothing without a run, outside the wave, or for a stopped or removed instance', () => {
    expect(planSweep([row()], NOW, null, WAVE).open).toEqual([]);
    expect(planSweep([row({ tenantId: 'suspended' })], NOW, RUN, WAVE).open).toEqual([]);
    expect(planSweep([row({ instanceState: 'stopped' })], NOW, RUN, WAVE).open).toEqual([]);
    expect(planSweep([row({ instanceState: 'removed' })], NOW, RUN, WAVE).open).toEqual([]);
  });

  it('closes an open episode silently once it is no longer judged', () => {
    const open = { staleSince: new Date(NOW.getTime() - H), alertedAt: new Date(NOW.getTime() - H) };
    for (const r of [
      row({ ...open, tenantId: 'archived-now' }),
      row({ ...open, instanceState: 'stopped' }),
      row({ ...open, instanceState: 'removed' }),
    ]) {
      const p = planSweep([r], NOW, RUN, WAVE);
      expect(p.expired).toHaveLength(1);
      expect(p.recovered).toEqual([]);
    }
    expect(planSweep([row(open)], NOW, null, WAVE).expired).toHaveLength(1);
  });

  it('does not alert an episode twice, but retries one whose alert never went out', () => {
    const since = new Date(NOW.getTime() - H);
    expect(planSweep([row({ staleSince: since, alertedAt: since })], NOW, RUN, WAVE).alert).toEqual([]);
    const retry = planSweep([row({ staleSince: since })], NOW, RUN, WAVE);
    expect(retry.open).toEqual([]);
    expect(retry.alert).toHaveLength(1);
  });

  it('a good backup after the episode opened is a recovery', () => {
    const since = new Date(NOW.getTime() - 3 * H);
    const back = planSweep([row({ staleSince: since, alertedAt: since, lastSuccessAt: new Date(NOW.getTime() - H) })], NOW, RUN, WAVE);
    expect(back.recovered).toHaveLength(1);
  });

  it('a database alerted on within the cooldown opens quietly and is announced once the window has passed', () => {
    const recently = new Date(NOW.getTime() - 2 * H);
    const p = planSweep([row({ lastAlertedAt: recently })], NOW, RUN, WAVE);
    expect(p.open).toHaveLength(1);
    expect(p.alert).toEqual([]);
    const later = new Date(recently.getTime() + ALERT_COOLDOWN_MS + 60_000);
    const q = planSweep([row({ lastAlertedAt: recently, staleSince: NOW })], later, RUN, WAVE);
    expect(q.alert).toHaveLength(1);
  });
});

describe('notification items', () => {
  it('admin items quote the tenant and carry the diagnosis but never pod logs', () => {
    const r = row({ lastError: 'dump failed; diagnosis: pod pinned to node-a; logs: secret challenge' });
    expect(staleItem(r, 'admin')).toBe(
      '"Acme Ltd": my-mariadb (MariaDB), shop: last good backup 2026-11-25 02:10 UTC; last attempt failed: dump failed; diagnosis: pod pinned to node-a',
    );
  });

  it('tenant items carry a category, never the error text', () => {
    const r = row({ lastError: "ERROR 1045 (28000): Access denied for user 'root'@'10.42.3.7'" });
    expect(staleItem(r, 'tenant')).toBe(
      'my-mariadb (MariaDB), shop: last good backup 2026-11-25 02:10 UTC; last attempt failed: The platform could not log in to the database.',
    );
    expect(staleItem(row(), 'tenant')).toMatch(/The database reported an error while it was being dumped\.$/);
  });

  it('spells out never, synthetic entries and SQLite', () => {
    expect(staleItem(row({ lastSuccessAt: null, databaseName: DEPLOYMENT_ENTRY, lastError: 'No running pod found' }), 'tenant'))
      .toBe('my-mariadb (MariaDB), its databases (they could not be listed): never backed up; last attempt failed: The database was not running.');
    expect(staleItem(row({ subjectKey: SQLITE_SUBJECT, engine: 'sqlite', databaseName: SQLITE_DISCOVERY_ENTRY }), 'tenant'))
      .toMatch(/^SQLite files on the volume, its SQLite files \(they could not be searched\)/);
  });

  it('every item is capped', () => {
    const r = row({ databaseName: `/data/${'x'.repeat(500)}.db`, lastError: 'y'.repeat(500) });
    expect(staleItem(r, 'admin').length).toBe(ITEM_MAX_CHARS);
    expect(staleItem(r, 'tenant').length).toBe(ITEM_MAX_CHARS);
    expect(recoveredItem(r, 'admin').length).toBeLessThanOrEqual(ITEM_MAX_CHARS);
  });

  it('a recovery says when it was backed up and since when it was overdue', () => {
    const r = row({ lastSuccessAt: new Date('2026-11-26T05:00:00Z'), staleSince: new Date('2026-11-25T04:00:00Z') });
    expect(recoveredItem(r, 'tenant')).toBe('my-mariadb (MariaDB), shop: backed up 2026-11-26 05:00 UTC, overdue since 2026-11-25 04:00 UTC');
  });

  it('the dedupe key is the episodes, in any order, and changes with a new episode', () => {
    const a = row({ staleSince: NOW });
    const b = row({ databaseName: 'crm', staleSince: NOW });
    expect(episodeKey('k', [a, b])).toBe(episodeKey('k', [b, a]));
    expect(episodeKey('k', [a])).not.toBe(episodeKey('k', [{ ...a, staleSince: new Date(NOW.getTime() + 1) }]));
    expect(episodeKey('k', [a]).length).toBeLessThanOrEqual(128);
  });
});

describe('executeSweep — one alert per episode, and its end', () => {
  let store: Map<string, SweepRow>;
  let sent: Array<{ kind: string; tenantId: string | undefined; databases: string[]; key: string; missedRun?: string }>;
  let adminOk: boolean;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  const k = (r: SweepRow) => `${r.tenantId}|${r.subjectKey}|${r.databaseName}`;
  const io = (): SweepIo => ({
    rows: async () => [...store.values()].map((r) => ({ ...r })),
    openEpisode: async (r, at, judged) => {
      const cur = store.get(k(r))!;
      if (!cur.staleSince && (cur.lastSuccessAt === null || cur.lastSuccessAt < judged)) store.set(k(r), { ...cur, staleSince: at });
    },
    closeEpisode: async (r) => { store.set(k(r), { ...store.get(k(r))!, staleSince: null, alertedAt: null }); },
    markAlerted: async (r, at) => { store.set(k(r), { ...store.get(k(r))!, alertedAt: at, lastAlertedAt: at }); },
    notifyAdminStale: async (tenantId, p, key) => { sent.push({ kind: 'admin-stale', tenantId, databases: p.databases, key, missedRun: p.missedRun }); return adminOk ? { ok: true } : { ok: false, error: 'smtp down' }; },
    notifyTenantStale: async (tenantId, p, key) => { sent.push({ kind: 'tenant-stale', tenantId, databases: p.databases, key, missedRun: p.missedRun }); return { ok: true }; },
    notifyAdminRecovered: async (tenantId, p, key) => { sent.push({ kind: 'admin-recovered', tenantId, databases: p.databases, key }); return { ok: true }; },
    notifyTenantRecovered: async (tenantId, p, key) => { sent.push({ kind: 'tenant-recovered', tenantId, databases: p.databases, key }); return { ok: true }; },
  });
  const put = (r: SweepRow) => store.set(k(r), r);

  beforeEach(() => {
    store = new Map(); sent = []; adminOk = true;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { warn.mockRestore(); error.mockRestore(); });

  it('one admin notification for every tenant, one per tenant, then silence until it recovers', async () => {
    put(row());
    put(row({ databaseName: 'crm' }));
    put(row({ tenantId: 't2', tenantName: 'Beta GmbH', subjectKey: 'dep-2', deploymentName: 'pg', engine: 'postgresql' }));

    const first = await executeSweep(io(), NOW, RUN, WAVE);
    expect(first).toMatchObject({ opened: 3, alerted: 3, judgedRun: RUN.toISOString() });
    expect(sent.map((s) => s.kind)).toEqual(['admin-stale', 'tenant-stale', 'tenant-stale']);
    expect(sent[0]!.tenantId).toBeUndefined();
    expect(sent[0]!.missedRun).toBe('2026-11-26 02:00 UTC');
    expect(sent.filter((s) => s.kind === 'tenant-stale').map((s) => [s.tenantId, s.databases.length])).toEqual([['t1', 2], ['t2', 1]]);

    sent = [];
    expect(await executeSweep(io(), new Date(NOW.getTime() + 15 * 60_000), RUN, WAVE)).toMatchObject({ opened: 0, alerted: 0 });
    expect(sent).toEqual([]);

    const later = new Date(NOW.getTime() + 20 * H);
    put({ ...store.get('t1|dep-1|shop')!, lastSuccessAt: later, lastStatus: 'dumped', lastError: null });
    const third = await executeSweep(io(), new Date(later.getTime() + 60_000), RUN, WAVE);
    expect(third.recovered).toBe(1);
    expect(sent.map((s) => [s.kind, s.tenantId])).toEqual([['admin-recovered', 't1'], ['tenant-recovered', 't1']]);
    expect(store.get('t1|dep-1|shop')).toMatchObject({ staleSince: null, alertedAt: null });
  });

  it('an admin alert that did not go out marks nothing, tells no tenant, and is retried with the same key', async () => {
    put(row());
    adminOk = false;
    expect((await executeSweep(io(), NOW, RUN, WAVE)).alerted).toBe(0);
    expect(store.get('t1|dep-1|shop')).toMatchObject({ staleSince: NOW, alertedAt: null, lastAlertedAt: null });
    const firstKey = sent[0]!.key;
    sent = []; adminOk = true;
    const retryAt = new Date(NOW.getTime() + 15 * 60_000);
    expect((await executeSweep(io(), retryAt, RUN, WAVE)).alerted).toBe(1);
    expect(sent.map((s) => s.kind)).toEqual(['admin-stale', 'tenant-stale']);
    expect(sent[0]!.key).toBe(firstKey);
    expect(sent[0]!.tenantId).toBe('t1');
    expect(store.get('t1|dep-1|shop')).toMatchObject({ alertedAt: retryAt, lastAlertedAt: retryAt });
  });

  it('a flapping database is announced once per cooldown window; a quick recovery inside it is silent', async () => {
    // A schedule that runs every six hours: alerted at 06:00, backed up at
    // 07:00, then missing the 08:00 run is a new episode inside the window.
    put(row());
    await executeSweep(io(), NOW, RUN, WAVE);
    const backed = new Date(NOW.getTime() + H);
    put({ ...store.get('t1|dep-1|shop')!, lastSuccessAt: backed });
    await executeSweep(io(), new Date(backed.getTime() + 60_000), RUN, WAVE);
    sent = [];
    const nextRun = new Date('2026-11-26T08:00:00Z');
    const t = new Date('2026-11-26T10:30:00Z');
    expect(await executeSweep(io(), t, nextRun, WAVE)).toMatchObject({ opened: 1, alerted: 0 });
    put({ ...store.get('t1|dep-1|shop')!, lastSuccessAt: new Date(t.getTime() + H) });
    await executeSweep(io(), new Date(t.getTime() + 2 * H), nextRun, WAVE);
    expect(sent).toEqual([]);
  });

  it('a tenant that leaves the wave has its open episode closed without a word', async () => {
    put(row({ staleSince: NOW, alertedAt: NOW, lastAlertedAt: NOW }));
    const r = await executeSweep(io(), new Date(NOW.getTime() + H), RUN, new Set(['t2']));
    expect(r.closed).toBe(1);
    expect(sent).toEqual([]);
    expect(store.get('t1|dep-1|shop')).toMatchObject({ staleSince: null, alertedAt: null, lastAlertedAt: NOW });
  });

  it('a success recorded between the read and the open does not open an episode', async () => {
    put(row());
    const racing = io();
    const rows = racing.rows;
    const inject: SweepIo = { ...racing, rows: async () => { const r = await rows(); put({ ...store.get('t1|dep-1|shop')!, lastSuccessAt: new Date(RUN.getTime() + 60_000) }); return r; } };
    await executeSweep(inject, NOW, RUN, WAVE);
    expect(store.get('t1|dep-1|shop')!.staleSince).toBeNull();
  });
});
