import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEPLOYMENT_ENTRY, SQLITE_DISCOVERY_ENTRY, SQLITE_SUBJECT } from './recorder.js';
import {
  describeThreshold,
  episodeKey,
  executeSweep,
  planSweep,
  recoveredItem,
  staleItem,
  type SweepIo,
  type SweepRow,
} from './sweep.js';

const H = 3_600_000;
const THRESHOLD = 26 * H;
const NOW = new Date('2026-11-26T06:00:00Z');
const WAVE = new Set(['t1', 't2']);

function row(over: Partial<SweepRow> = {}): SweepRow {
  return {
    tenantId: 't1', tenantName: 'Acme Ltd', subjectKey: 'dep-1', databaseName: 'shop', deploymentId: 'dep-1',
    deploymentName: 'my-mariadb', engine: 'mariadb',
    lastAttemptAt: new Date(NOW.getTime() - 4 * H), lastAttemptBundleId: 'bkp-9', lastStatus: 'failed',
    lastError: 'Column count of mysql.proc is wrong', lastSuccessAt: new Date(NOW.getTime() - 30 * H),
    lastSuccessBundleId: 'bkp-1', lastSuccessSizeBytes: 10, staleSince: null, alertedAt: null,
    createdAt: new Date('2026-10-01T00:00:00Z'), ...over,
  };
}

describe('planSweep', () => {
  it('opens and alerts an episode for a database past the threshold', () => {
    const p = planSweep([row()], NOW, THRESHOLD, WAVE);
    expect(p.open).toHaveLength(1);
    expect(p.open[0]!.staleSince).toEqual(NOW);
    expect(p.alert).toEqual(p.open);
  });

  it('leaves a recent backup alone, and judges a never-backed-up database from when it was first seen', () => {
    expect(planSweep([row({ lastSuccessAt: new Date(NOW.getTime() - 25 * H) })], NOW, THRESHOLD, WAVE).open).toEqual([]);
    expect(planSweep([row({ lastSuccessAt: null, createdAt: new Date(NOW.getTime() - 2 * H) })], NOW, THRESHOLD, WAVE).open).toEqual([]);
    expect(planSweep([row({ lastSuccessAt: null, createdAt: new Date(NOW.getTime() - 27 * H) })], NOW, THRESHOLD, WAVE).open).toHaveLength(1);
  });

  it('opens nothing for a tenant the wave does not back up, or when the schedule never fires', () => {
    expect(planSweep([row({ tenantId: 'suspended' })], NOW, THRESHOLD, WAVE).open).toEqual([]);
    expect(planSweep([row()], NOW, null, WAVE).open).toEqual([]);
  });

  it('does not alert an episode twice, but retries one whose alert never went out', () => {
    const since = new Date(NOW.getTime() - H);
    expect(planSweep([row({ staleSince: since, alertedAt: since })], NOW, THRESHOLD, WAVE).alert).toEqual([]);
    const retry = planSweep([row({ staleSince: since })], NOW, THRESHOLD, WAVE);
    expect(retry.open).toEqual([]);
    expect(retry.alert).toHaveLength(1);
    expect(retry.alert[0]!.staleSince).toEqual(since);
  });

  it('a good backup after the episode opened is a recovery; the threshold moving away is a silent close', () => {
    const since = new Date(NOW.getTime() - 3 * H);
    const back = planSweep([row({ staleSince: since, alertedAt: since, lastSuccessAt: new Date(NOW.getTime() - H) })], NOW, THRESHOLD, WAVE);
    expect(back.recovered).toHaveLength(1);
    const moved = planSweep([row({ staleSince: since })], NOW, 7 * 24 * H, WAVE);
    expect(moved.expired).toHaveLength(1);
    expect(moved.recovered).toEqual([]);
  });
});

describe('notification items', () => {
  it('admin items name the tenant and carry the whole error; tenant items cut operator-only text', () => {
    const r = row({ lastError: 'dump failed; diagnosis: pod pinned to sv4' });
    expect(staleItem(r, 'admin')).toBe(
      'Acme Ltd: my-mariadb (MariaDB), shop: last good backup 2026-11-25 00:00 UTC; last attempt failed: dump failed; diagnosis: pod pinned to sv4',
    );
    expect(staleItem(r, 'tenant')).toBe('my-mariadb (MariaDB), shop: last good backup 2026-11-25 00:00 UTC; last attempt failed: dump failed');
  });

  it('spells out never, synthetic entries and SQLite', () => {
    expect(staleItem(row({ lastSuccessAt: null, databaseName: DEPLOYMENT_ENTRY }), 'tenant'))
      .toMatch(/^my-mariadb \(MariaDB\), its databases \(they could not be listed\): never backed up; last attempt failed/);
    expect(staleItem(row({ subjectKey: SQLITE_SUBJECT, engine: 'sqlite', databaseName: SQLITE_DISCOVERY_ENTRY }), 'tenant'))
      .toMatch(/^SQLite files on the volume, its SQLite files \(they could not be searched\)/);
  });

  it('a recovery says when it was backed up and since when it was overdue', () => {
    const r = row({ lastSuccessAt: new Date('2026-11-26T05:00:00Z'), staleSince: new Date('2026-11-25T04:00:00Z') });
    expect(recoveredItem(r, 'tenant')).toBe('my-mariadb (MariaDB), shop: backed up 2026-11-26 05:00 UTC, overdue since 2026-11-25 04:00 UTC');
  });

  it('describes the threshold in words', () => {
    expect(describeThreshold(26 * H)).toBe('26 hours');
    expect(describeThreshold(7 * 24 * H + 2 * H)).toBe('7 days and 2 hours');
    expect(describeThreshold(3 * 24 * H)).toBe('3 days');
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
  let sent: Array<{ kind: string; tenantId: string | undefined; databases: string[]; key: string }>;
  let adminOk: boolean;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  const k = (r: SweepRow) => `${r.tenantId}|${r.subjectKey}|${r.databaseName}`;
  const io = (): SweepIo => ({
    rows: async () => [...store.values()].map((r) => ({ ...r })),
    openEpisode: async (r, at) => { const cur = store.get(k(r))!; if (!cur.staleSince) store.set(k(r), { ...cur, staleSince: at }); },
    closeEpisode: async (r) => { store.set(k(r), { ...store.get(k(r))!, staleSince: null, alertedAt: null }); },
    markAlerted: async (r, at) => { store.set(k(r), { ...store.get(k(r))!, alertedAt: at }); },
    notifyAdminStale: async (tenantId, p, key) => { sent.push({ kind: 'admin-stale', tenantId, databases: p.databases, key }); return adminOk ? { ok: true } : { ok: false, error: 'smtp down' }; },
    notifyTenantStale: async (tenantId, p, key) => { sent.push({ kind: 'tenant-stale', tenantId, databases: p.databases, key }); return { ok: true }; },
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

    const first = await executeSweep(io(), NOW, THRESHOLD, WAVE);
    expect(first).toMatchObject({ opened: 3, alerted: 3 });
    expect(sent.map((s) => s.kind)).toEqual(['admin-stale', 'tenant-stale', 'tenant-stale']);
    expect(sent[0]!.tenantId).toBeUndefined(); // two tenants → the fleet page
    expect(sent[0]!.databases).toHaveLength(3);
    expect(sent.filter((s) => s.kind === 'tenant-stale').map((s) => [s.tenantId, s.databases.length])).toEqual([['t1', 2], ['t2', 1]]);

    sent = [];
    const second = await executeSweep(io(), new Date(NOW.getTime() + 15 * 60_000), THRESHOLD, WAVE);
    expect(second).toMatchObject({ opened: 0, alerted: 0 });
    expect(sent).toEqual([]);

    // t1/shop is backed up again → recovery for it alone, to both audiences.
    const later = new Date(NOW.getTime() + 20 * H);
    put({ ...store.get('t1|dep-1|shop')!, lastSuccessAt: later, lastStatus: 'dumped', lastError: null });
    const third = await executeSweep(io(), new Date(later.getTime() + 60_000), THRESHOLD, WAVE);
    expect(third.recovered).toBe(1);
    expect(sent.map((s) => [s.kind, s.tenantId])).toEqual([['admin-recovered', 't1'], ['tenant-recovered', 't1']]);
    expect(store.get('t1|dep-1|shop')).toMatchObject({ staleSince: null, alertedAt: null });
  });

  it('an admin alert that did not go out marks nothing, tells no tenant, and is retried with the same key', async () => {
    put(row());
    adminOk = false;
    expect((await executeSweep(io(), NOW, THRESHOLD, WAVE)).alerted).toBe(0);
    expect(sent.map((s) => s.kind)).toEqual(['admin-stale']);
    expect(store.get('t1|dep-1|shop')).toMatchObject({ staleSince: NOW, alertedAt: null });
    const firstKey = sent[0]!.key;

    sent = []; adminOk = true;
    const retryAt = new Date(NOW.getTime() + 15 * 60_000);
    expect((await executeSweep(io(), retryAt, THRESHOLD, WAVE)).alerted).toBe(1);
    expect(sent.map((s) => s.kind)).toEqual(['admin-stale', 'tenant-stale']);
    expect(sent[0]!.key).toBe(firstKey);
    expect(sent[0]!.tenantId).toBe('t1'); // one tenant → its own page
    expect(store.get('t1|dep-1|shop')!.alertedAt).toEqual(retryAt);
  });

  it('an episode that recovers before its alert went out ends silently', async () => {
    put(row({ staleSince: new Date(NOW.getTime() - H), lastSuccessAt: new Date(NOW.getTime() - 10 * 60_000) }));
    const r = await executeSweep(io(), NOW, THRESHOLD, WAVE);
    expect(r.recovered).toBe(1);
    expect(sent).toEqual([]);
  });
});
