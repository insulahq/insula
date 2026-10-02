/**
 * Operator report: in "all server nodes" mail port exposure, a server that
 * joined after the mode was applied got no haproxy (no mail listener) until
 * the mode was re-applied — and the reachability check flagged it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { resolveSpy, inFlightSpy } = vi.hoisted(() => ({
  resolveSpy: vi.fn(),
  inFlightSpy: vi.fn(() => false),
}));
vi.mock('./port-exposure.js', () => ({
  portExposureApplyInFlight: inFlightSpy,
}));
// The active node comes from the shared resolver (active-node.ts, tested on its
// own); here it answers with the stored value unless a test says otherwise.
vi.mock('./active-node.js', () => ({
  resolveActiveMailNode: resolveSpy,
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { systemSettings, tasks } from '../../db/schema.js';
import { MAIL_HAPROXY_LABEL_KEY } from './port-exposure-modes.js';
import {
  HAPROXY_LABEL_SYNC_RELOG_MS,
  __resetHaproxyLabelSyncLogForTest,
  describeHaproxyLabelSync,
  planHaproxyLabelChanges,
  syncMailHaproxyLabels,
  toNodeRefs,
} from './haproxy-label-sync.js';

const ROLE = 'insula.host/node-role';
const server = (name: string, haproxy = false) => ({
  metadata: { name, labels: { [ROLE]: 'server', ...(haproxy ? { [MAIL_HAPROXY_LABEL_KEY]: 'true' } : {}) } },
});
const worker = (name: string, haproxy = false) => ({
  metadata: { name, labels: { [ROLE]: 'worker', ...(haproxy ? { [MAIL_HAPROXY_LABEL_KEY]: 'true' } : {}) } },
});

interface Settings {
  mode: string | null;
  primaryNode?: string | null;
  secondaryNode?: string | null;
  tertiaryNode?: string | null;
  activeNode?: string | null;
}

function dbStub(settings: Settings, runningTaskKinds: string[] = [], inFlightMigrationIds: string[] = []) {
  const stored = settings.activeNode ?? null;
  resolveSpy.mockResolvedValue({ node: stored, source: stored ? 'settings' : null });
  const taskQueries = vi.fn();
  const rawQueries: SQL[] = [];
  const db = {
    execute: (query: SQL) => {
      rawQueries.push(query);
      return Promise.resolve({ rows: inFlightMigrationIds.map((id) => ({ id })) });
    },
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === systemSettings) {
            return Promise.resolve([{
              primaryNode: null, secondaryNode: null, tertiaryNode: null, activeNode: null, ...settings,
            }]);
          }
          if (table === tasks) {
            taskQueries();
            return { limit: () => Promise.resolve(runningTaskKinds.map((kind) => ({ kind }))) };
          }
          throw new Error('unexpected table');
        },
      }),
    }),
  };
  return { db: db as never, taskQueries, rawQueries };
}

const coreStub = () => ({
  patchNode: vi.fn().mockResolvedValue({}),
  readNamespacedPersistentVolumeClaim: vi.fn(),
  readPersistentVolume: vi.fn(),
});

const patchedLabels = (core: ReturnType<typeof coreStub>) => core.patchNode.mock.calls
  .map((c) => [c[0].name, c[0].body.metadata.labels[MAIL_HAPROXY_LABEL_KEY]]);

beforeEach(() => {
  resolveSpy.mockReset();
  inFlightSpy.mockReset().mockReturnValue(false);
  __resetHaproxyLabelSyncLogForTest();
});

describe('syncMailHaproxyLabels — allServerNodes', () => {
  it('labels a server that joined after the mode was applied', async () => {
    const { db } = dbStub({ mode: 'allServerNodes', activeNode: 'sv1' });
    const core = coreStub();
    const result = await syncMailHaproxyLabels(db, core as never, [server('sv1'), server('sv2', true), server('sv3')]);
    expect(result).toEqual({ outcome: 'changed', added: ['sv3'], removed: [] });
    expect(patchedLabels(core)).toEqual([['sv3', 'true']]);
  });

  it('unlabels a server demoted to worker', async () => {
    const { db } = dbStub({ mode: 'allServerNodes', activeNode: 'sv1' });
    const core = coreStub();
    const result = await syncMailHaproxyLabels(db, core as never, [server('sv1'), server('sv2', true), worker('sv3', true)]);
    expect(result).toEqual({ outcome: 'changed', added: [], removed: ['sv3'] });
    expect(patchedLabels(core)).toEqual([['sv3', null]]);
  });

  it('never labels the active node — Stalwart binds hostPort 25 there', async () => {
    const { db } = dbStub({ mode: 'allServerNodes', activeNode: 'sv3' });
    const core = coreStub();
    await syncMailHaproxyLabels(db, core as never, [server('sv1', true), server('sv2', true), server('sv3')]);
    expect(core.patchNode).not.toHaveBeenCalled();
  });

  it('leaves a joining worker alone', async () => {
    const { db } = dbStub({ mode: 'allServerNodes', activeNode: 'sv1' });
    const core = coreStub();
    const result = await syncMailHaproxyLabels(db, core as never, [server('sv1'), server('sv2', true), worker('w1')]);
    expect(result).toEqual({ outcome: 'in-sync' });
    expect(core.patchNode).not.toHaveBeenCalled();
  });

  it('does not even look for a running task when nothing would change', async () => {
    const { db, taskQueries } = dbStub({ mode: 'allServerNodes', activeNode: 'sv1' });
    await syncMailHaproxyLabels(db, coreStub() as never, [server('sv1'), server('sv2', true)]);
    expect(taskQueries).not.toHaveBeenCalled();
  });

  it('takes the active node from the shared resolver when the DB has none (live pod / mail PVC)', async () => {
    const { db } = dbStub({ mode: 'allServerNodes', activeNode: null });
    resolveSpy.mockResolvedValue({ node: 'sv2', source: 'pod' });
    const core = coreStub();
    await syncMailHaproxyLabels(db, core as never, [server('sv1'), server('sv2'), server('sv3')]);
    expect(patchedLabels(core)).toEqual([['sv1', 'true'], ['sv3', 'true']]);
    // Read-only, and limited to this cluster's nodes.
    const [, , opts] = resolveSpy.mock.calls[0];
    expect(opts.persist).toBeFalsy();
    expect([...opts.knownNodes].sort()).toEqual(['sv1', 'sv2', 'sv3']);
  });
});

describe('syncMailHaproxyLabels — stands down', () => {
  const nodes = [server('sv1'), server('sv2'), server('sv3')];

  it.each([['activeNodeOnly'], ['thisNodeOnly'], [null]])('in mode %s (no haproxy)', async (mode) => {
    const { db } = dbStub({ mode, activeNode: 'sv1' });
    const core = coreStub();
    const result = await syncMailHaproxyLabels(db, core as never, [server('sv1'), server('sv2', true)]);
    expect(result.outcome).toBe('skipped');
    expect(core.patchNode).not.toHaveBeenCalled();
  });

  it.each([['mail.migration'], ['mail.port-exposure']])('while a %s task is running', async (kind) => {
    const { db } = dbStub({ mode: 'allServerNodes', activeNode: 'sv1' }, [kind]);
    const core = coreStub();
    const result = await syncMailHaproxyLabels(db, core as never, nodes);
    expect(result).toEqual({ outcome: 'skipped', reason: `a ${kind} task is running` });
    expect(core.patchNode).not.toHaveBeenCalled();
  });

  it('while a DR auto-failover is moving mail — it writes a migration run but no task', async () => {
    const { db, rawQueries } = dbStub({ mode: 'allServerNodes', activeNode: 'sv1' }, [], ['run-7']);
    const core = coreStub();
    const result = await syncMailHaproxyLabels(db, core as never, nodes);
    expect(result).toEqual({ outcome: 'skipped', reason: 'mail migration run-7 is in flight' });
    expect(core.patchNode).not.toHaveBeenCalled();
    // The in-flight test is the orphan reaper's: every state but the terminal ones.
    const { sql: text } = new PgDialect().sqlToQuery(rawQueries[0]);
    expect(text).toContain('FROM mail_migration_runs');
    expect(text.replace(/\s+/g, ' ')).toContain("state NOT IN ('done', 'failed', 'rolled-back', 'cancelled')");
  });

  it('while a mode switch is applying in this process', async () => {
    inFlightSpy.mockReturnValue(true);
    const { db } = dbStub({ mode: 'allServerNodes', activeNode: 'sv1' });
    const core = coreStub();
    expect((await syncMailHaproxyLabels(db, core as never, nodes)).outcome).toBe('skipped');
    expect(core.patchNode).not.toHaveBeenCalled();
  });

  it('when the active mail node cannot be determined', async () => {
    const { db } = dbStub({ mode: 'allServerNodes', activeNode: null });
    const core = coreStub();
    const result = await syncMailHaproxyLabels(db, core as never, nodes);
    expect(result.outcome).toBe('skipped');
    expect(core.patchNode).not.toHaveBeenCalled();
  });

  it('when the resolver finds no active node among this cluster\'s nodes', async () => {
    const { db } = dbStub({ mode: 'allServerNodes', activeNode: null });
    resolveSpy.mockResolvedValue({ node: null, source: null });
    const core = coreStub();
    expect((await syncMailHaproxyLabels(db, core as never, nodes)).outcome).toBe('skipped');
    expect(core.patchNode).not.toHaveBeenCalled();
  });

  it('when placement no longer satisfies assignedMailNodes', async () => {
    const { db } = dbStub({ mode: 'assignedMailNodes', primaryNode: 'sv1', secondaryNode: 'sv2', activeNode: 'sv3' });
    const core = coreStub();
    const result = await syncMailHaproxyLabels(db, core as never, nodes);
    expect(result.outcome).toBe('skipped');
    expect(core.patchNode).not.toHaveBeenCalled();
  });
});

describe('syncMailHaproxyLabels — assignedMailNodes', () => {
  it('follows the assigned set, minus the active node', async () => {
    const { db } = dbStub({ mode: 'assignedMailNodes', primaryNode: 'sv1', secondaryNode: 'sv2', tertiaryNode: 'sv3', activeNode: 'sv1' });
    const core = coreStub();
    const result = await syncMailHaproxyLabels(db, core as never, [server('sv1'), server('sv2', true), server('sv3'), server('sv4', true)]);
    expect(result).toEqual({ outcome: 'changed', added: ['sv3'], removed: ['sv4'] });
  });
});

describe('helpers', () => {
  it('plans only the difference', () => {
    expect(planHaproxyLabelChanges(['b', 'c'], toNodeRefs([
      { metadata: { name: 'a', labels: { [MAIL_HAPROXY_LABEL_KEY]: 'true' } } },
      { metadata: { name: 'b', labels: { [MAIL_HAPROXY_LABEL_KEY]: 'true' } } },
      { metadata: { name: 'c' } },
      { metadata: {} },
    ]))).toEqual({ added: ['c'], removed: ['a'] });
  });

  it('logs an outcome once, not every minute', () => {
    const skip = { outcome: 'skipped', reason: 'a mail.migration task is running' } as const;
    expect(describeHaproxyLabelSync(skip)).toBe('[mail-haproxy-labels] not syncing: a mail.migration task is running');
    expect(describeHaproxyLabelSync(skip)).toBeNull();
    expect(describeHaproxyLabelSync({ outcome: 'changed', added: ['sv3'], removed: [] }))
      .toBe('[mail-haproxy-labels] labelled sv3; unlabelled —');
    expect(describeHaproxyLabelSync({ outcome: 'in-sync' })).toBeNull();
    expect(describeHaproxyLabelSync(skip)).not.toBeNull();
  });

  it('repeats an unchanged line every half hour so a stuck sync does not fall silent', () => {
    const fail = { outcome: 'skipped', reason: 'failed: nodes is forbidden' } as const;
    const t0 = 1_000_000;
    expect(describeHaproxyLabelSync(fail, t0)).not.toBeNull();
    expect(describeHaproxyLabelSync(fail, t0 + HAPROXY_LABEL_SYNC_RELOG_MS - 1)).toBeNull();
    expect(describeHaproxyLabelSync(fail, t0 + HAPROXY_LABEL_SYNC_RELOG_MS)).not.toBeNull();
    // "in-sync" is never logged, however long it stays in sync.
    expect(describeHaproxyLabelSync({ outcome: 'in-sync' }, t0)).toBeNull();
    expect(describeHaproxyLabelSync({ outcome: 'in-sync' }, t0 + 10 * HAPROXY_LABEL_SYNC_RELOG_MS)).toBeNull();
  });
});
