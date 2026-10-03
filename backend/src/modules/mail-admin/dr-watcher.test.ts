/**
 * DR watcher — the cases a 3-server VM failover drill exposed (v2026.10.3-rc.1):
 * the node that died also held the database primary; one progress write failed
 * during the promotion, the failover was abandoned with mail already serving
 * from the standby, and the watcher never acted again ('failing-over' forever,
 * active node still the dead source).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const trigger = vi.fn();
vi.mock('./migration.js', () => ({ triggerRestoreBasedFailover: (...a: unknown[]) => trigger(...a) }));
vi.mock('../../shared/db-retry.js', async (orig) => {
  const m = await orig<typeof import('../../shared/db-retry.js')>();
  return { ...m, withDbRetry: <T>(fn: () => Promise<T>) => m.withDbRetry(fn, { sleep: async () => undefined }) };
});

import { runDrWatcherTick } from './dr-watcher.js';
import { __resetActiveNodePersistForTest } from './active-node.js';

type Settings = Record<string, unknown>;
const baseSettings: Settings = {
  id: 'system',
  mailAutoFailoverEnabled: true,
  mailActiveNode: 'source',
  mailSecondaryNode: 'standby',
  mailTertiaryNode: null,
  mailDrState: 'healthy',
  mailFailoverThresholdSeconds: 120,
  mailLastFailoverAt: null,
};

/** The text of a drizzle `sql` template, for routing execute() calls. */
const sqlText = (q: unknown): string => JSON.stringify(q);

function harness(opts: {
  settings?: Settings;
  ready?: Record<string, boolean>;
  pods?: Array<{ node: string; ready?: boolean }>;
  migrationInFlight?: boolean;
  releaseMatches?: boolean;
  failUpdatesTransiently?: number;
  selfNode?: string;
}) {
  const settings = { ...baseSettings, ...opts.settings };
  const executed: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  let transientLeft = opts.failUpdatesTransiently ?? 0;
  const db = {
    select: () => ({ from: () => ({ where: async () => [settings] }) }),
    execute: vi.fn(async (q: unknown) => {
      const t = sqlText(q);
      executed.push(t);
      if (t.includes('SELECT id FROM mail_migration_runs')) return { rows: opts.migrationInFlight ? [{ id: 'run-1' }] : [] };
      if (t.includes('NOT EXISTS')) return { rows: opts.releaseMatches ? [{ id: 'system' }] : [] };
      return { rows: [{ id: 'system' }] }; // CAS updates succeed
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          if (transientLeft > 0) {
            transientLeft--;
            throw Object.assign(new Error('Failed query: update system_settings'), {
              cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
            });
          }
          updates.push(v);
        },
      }),
    }),
  };
  const ready = opts.ready ?? {};
  const core = {
    readNode: vi.fn(async ({ name }: { name: string }) => ({
      status: { conditions: [{ type: 'Ready', status: ready[name] === false ? 'False' : 'True' }] },
    })),
    listNamespacedPod: vi.fn(async () => ({
      items: (opts.pods ?? []).map((p) => ({
        metadata: {}, spec: { nodeName: p.node },
        status: { phase: 'Running', conditions: [{ type: 'Ready', status: p.ready === false ? 'False' : 'True' }] },
      })),
    })),
    readNamespacedPersistentVolumeClaim: vi.fn(async () => { throw Object.assign(new Error('nf'), { code: 404 }); }),
    readPersistentVolume: vi.fn(),
  };
  const log = { warn: vi.fn(), info: vi.fn() };
  const deps = { db, core, apps: {}, batch: {}, logger: log, selfNodeName: opts.selfNode ?? null } as never;
  return { deps, executed, updates, log, core };
}

beforeEach(() => {
  trigger.mockReset();
  __resetActiveNodePersistForTest();
});

describe('dr-watcher — an abandoned failover is released', () => {
  it("'failing-over' with no run in flight → released to 'degraded' (CAS, grace for a run still stamping)", async () => {
    const h = harness({ settings: { mailDrState: 'failing-over' }, releaseMatches: true });
    await runDrWatcherTick(h.deps);
    const release = h.executed.find((t) => t.includes('NOT EXISTS'));
    expect(release).toBeDefined();
    expect(release).toContain("mail_dr_state = 'degraded'");
    expect(release).toContain("mail_dr_state = 'failing-over'");
    expect(release).toContain('finished_at >');
    expect(h.log.warn).toHaveBeenCalledWith(expect.stringContaining('released to degraded'));
    expect(trigger).not.toHaveBeenCalled();
  });

  it('released even with auto-failover switched OFF (manual control must not freeze the state)', async () => {
    const h = harness({ settings: { mailDrState: 'failing-over', mailAutoFailoverEnabled: false }, releaseMatches: true });
    await runDrWatcherTick(h.deps);
    expect(h.executed.some((t) => t.includes('NOT EXISTS'))).toBe(true);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('auto-failover OFF and not stuck → the watcher does nothing at all', async () => {
    const h = harness({ settings: { mailAutoFailoverEnabled: false }, ready: { source: false } });
    await runDrWatcherTick(h.deps);
    expect(h.executed).toEqual([]);
    expect(h.core.readNode).not.toHaveBeenCalled();
  });

  it("'failing-over' while a run is still in flight → left alone (the release matches nothing)", async () => {
    const h = harness({ settings: { mailDrState: 'failing-over' }, releaseMatches: false });
    await runDrWatcherTick(h.deps);
    expect(h.log.warn).not.toHaveBeenCalledWith(expect.stringContaining('released'));
    expect(h.core.readNode).not.toHaveBeenCalled();
  });
});

describe('dr-watcher — the active node is where mail IS', () => {
  it('stored active is the dead source, Stalwart is Ready on the standby → records the standby, no new failover', async () => {
    const h = harness({
      settings: { mailDrState: 'degraded', mailLastFailoverAt: new Date(Date.now() - 600_000) },
      ready: { source: false, standby: true },
      pods: [{ node: 'standby' }],
    });
    await runDrWatcherTick(h.deps);
    expect(h.updates).toContainEqual({ mailActiveNode: 'standby' });
    expect(trigger).not.toHaveBeenCalled();
    expect(h.updates).toContainEqual({ mailDrState: 'healthy' });
  });

  it('the dead source is still the active node (no pod elsewhere) → failover proceeds to the standby', async () => {
    const h = harness({
      settings: { mailDrState: 'degraded', mailLastFailoverAt: new Date(Date.now() - 600_000) },
      ready: { source: false, standby: true },
      pods: [],
    });
    trigger.mockResolvedValue(undefined);
    await runDrWatcherTick(h.deps);
    expect(trigger).toHaveBeenCalledWith('standby', expect.anything());
  });
});

describe('dr-watcher — a failed failover hands back to degraded, across a DB outage', () => {
  it('the reset write is retried through a transient error', async () => {
    const h = harness({
      settings: { mailDrState: 'degraded', mailLastFailoverAt: new Date(Date.now() - 600_000) },
      ready: { source: false, standby: true },
      failUpdatesTransiently: 2,
    });
    trigger.mockRejectedValue(new Error('Failed query: UPDATE mail_migration_runs'));
    await runDrWatcherTick(h.deps);
    expect(h.updates).toContainEqual({ mailDrState: 'degraded' });
  });
});

// The replica on the node that died keeps running when only k3s stops: it
// still reaches the database (and can win the claim) but not the Kubernetes
// API. v2026.10.3-rc.4 drill: its attempt burned the full 300 s target wait.
describe('dr-watcher — a replica on a NotReady node stays out of the failover', () => {
  const due = { mailDrState: 'degraded', mailLastFailoverAt: new Date(Date.now() - 600_000) };

  it('a replica running ON the failed mail node does not claim', async () => {
    const h = harness({ settings: due, ready: { source: false, standby: true }, selfNode: 'source' });
    await runDrWatcherTick(h.deps);
    expect(trigger).not.toHaveBeenCalled();
    expect(h.executed.some((t) => t.includes("'failing-over'"))).toBe(false);
  });

  it('a replica whose own node is NotReady does not claim', async () => {
    const h = harness({ settings: due, ready: { source: false, standby: true, bastion: false }, selfNode: 'bastion' });
    await runDrWatcherTick(h.deps);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('a replica on a healthy node claims and fails over as before', async () => {
    const h = harness({ settings: due, ready: { source: false, standby: true, bastion: true }, selfNode: 'bastion' });
    trigger.mockResolvedValue(undefined);
    await runDrWatcherTick(h.deps);
    expect(trigger).toHaveBeenCalledWith('standby', expect.anything());
  });
});
