/**
 * Cadence control for the DR artefacts.
 *
 * Context (2026-09-18): the System Backups page rendered NO schedule cards —
 * `scheduleSubsystems={[]}` — so the cadence of the etcd snapshot upload, the
 * secrets bundle and the cluster-state dump could only be changed by editing
 * manifests. Worse, two rows an operator COULD edit drove nothing at all:
 * `system_pitr` and `longhorn_recurring` both sat enabled=false with
 * last_fired_at NULL while the real work ran from a CNPG ScheduledBackup and a
 * Longhorn RecurringJob.
 *
 * The properties that matter are about not lying to the operator:
 *   - a schedule left at the manifest default changes nothing;
 *   - a schedule the operator moves is actually honoured;
 *   - a schedule the platform cannot honour is not offered as editable;
 *   - disabling stops the work, whatever the mechanism.
 */
import { describe, it, expect, vi } from 'vitest';

import { reconcileCadenceTarget, resolveFiringPlan, type CadenceClients } from './reconciler.js';
import { targetFor, toCnpgCron, fromCnpgCron, CADENCE_TARGETS } from './targets.js';
import { fireIfDue, firedJobName } from './firing.js';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/**
 * A db serving two different queries: the schedule row, and the
 * `systemClassBound` probe (select → from → innerJoin → where → orderBy →
 * limit). The reconciler gates on the SAME binding predicate the dr-cronjobs
 * bridge uses, so the fake has to answer both or every test throws on a
 * missing `innerJoin`.
 */
const dbWith = (
  row: { enabled: boolean; cronExpression: string | null } | null,
  opts: { bound?: boolean } = {},
) => {
  const bound = opts.bound ?? true;
  return {
    select: () => ({
      from: () => ({
        // schedule row
        where: () => Promise.resolve(row ? [row] : []),
        // systemClassBound
        innerJoin: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => Promise.resolve(bound ? [{ enabled: 1 }] : []) }),
          }),
        }),
      }),
    }),
  } as never;
};

function cronJobClients(live: { schedule?: string; suspend?: boolean } | 'missing') {
  const patch = vi.fn(async () => ({}));
  const read = vi.fn(async () => {
    if (live === 'missing') throw Object.assign(new Error('not found'), { statusCode: 404 });
    return { spec: live };
  });
  return {
    clients: {
      batch: { readNamespacedCronJob: read, patchNamespacedCronJob: patch },
      custom: { getNamespacedCustomObject: vi.fn(), patchNamespacedCustomObject: vi.fn() },
    } as unknown as CadenceClients,
    patch,
  };
}

describe('a schedule left at the manifest default', () => {
  it('does not move a Flux-owned CronJob onto platform firing', async () => {
    // The pivot: equal to the manifest → the CronJob keeps firing itself, and
    // nothing about the cluster changes when these rows are first seeded.
    const target = targetFor('secrets_bundle')!;
    const { clients, patch } = cronJobClients({ schedule: target.manifestDefault, suspend: false });
    const out = await reconcileCadenceTarget(
      dbWith({ enabled: true, cronExpression: target.manifestDefault }), clients, target, log,
    );
    expect(out.platformFired).toBe(false);
    expect(out.desiredSuspend).toBe(false);
    expect(patch).not.toHaveBeenCalled();
  });

  it('never patches a Flux-owned schedule, even when the live value drifts', async () => {
    // Flux reconciles every minute on production; patching spec.schedule is a
    // fight the platform loses, which is why it must not try.
    const target = targetFor('cluster_state')!;
    const { clients, patch } = cronJobClients({ schedule: 'garbage from somewhere', suspend: false });
    await reconcileCadenceTarget(
      dbWith({ enabled: true, cronExpression: target.manifestDefault }), clients, target, log,
    );
    const paths = patch.mock.calls.flatMap((c) => ((c[0] as { body: Array<{ path: string }> }).body ?? []).map((o) => o.path));
    expect(paths).not.toContain('/spec/schedule');
  });
});

describe('a schedule the operator moved', () => {
  it('suspends the Flux-owned CronJob so the platform can fire it instead', async () => {
    const target = targetFor('secrets_bundle')!;
    const { clients, patch } = cronJobClients({ schedule: target.manifestDefault, suspend: false });
    const out = await reconcileCadenceTarget(
      dbWith({ enabled: true, cronExpression: '30 4 * * *' }), clients, target, log,
    );
    expect(out.platformFired).toBe(true);
    expect(out.desiredSuspend).toBe(true);
    const body = (patch.mock.calls[0][0] as { body: Array<{ path: string; value: unknown }> }).body;
    expect(body).toEqual([{ op: 'replace', path: '/spec/suspend', value: true }]);
  });

  it('patches the schedule directly when the platform owns the CronJob', async () => {
    // etcd-snap-via-shim is Flux-skipped, so there is no one to fight.
    const target = targetFor('etcd_snapshot')!;
    const { clients, patch } = cronJobClients({ schedule: '0 * * * *', suspend: false });
    const out = await reconcileCadenceTarget(
      dbWith({ enabled: true, cronExpression: '*/15 * * * *' }), clients, target, log,
    );
    expect(out.platformFired).toBe(false);
    const body = (patch.mock.calls[0][0] as { body: Array<{ path: string; value: unknown }> }).body;
    expect(body).toContainEqual({ op: 'replace', path: '/spec/schedule', value: '*/15 * * * *' });
  });
});

describe('disabling a schedule', () => {
  it('suspends the job whatever the mechanism', async () => {
    for (const subsystem of ['etcd_snapshot', 'secrets_bundle', 'cluster_state']) {
      const target = targetFor(subsystem)!;
      const { clients, patch } = cronJobClients({ schedule: target.manifestDefault, suspend: false });
      const out = await reconcileCadenceTarget(
        dbWith({ enabled: false, cronExpression: target.manifestDefault }), clients, target, log,
      );
      expect(out.desiredSuspend, subsystem).toBe(true);
      const body = (patch.mock.calls[0][0] as { body: Array<{ path: string; value: unknown }> }).body;
      expect(body, subsystem).toContainEqual({ op: 'replace', path: '/spec/suspend', value: true });
    }
  });
});

describe('with no SYSTEM target bound', () => {
  it('suspends even an enabled schedule, matching the dr-cronjobs bridge', async () => {
    // Both writers must reach the same answer for the unbound case. If they
    // disagree, they flip /spec/suspend against each other every tick and the
    // job ends up firing natively AND via platform firing — two backups a
    // period. The shared predicate is what prevents that.
    const target = targetFor('secrets_bundle')!;
    const { clients, patch } = cronJobClients({ schedule: target.manifestDefault, suspend: false });
    const out = await reconcileCadenceTarget(
      dbWith({ enabled: true, cronExpression: target.manifestDefault }, { bound: false }),
      clients, target, log,
    );
    expect(out.desiredSuspend).toBe(true);
    const body = (patch.mock.calls[0][0] as { body: Array<{ path: string; value: unknown }> }).body;
    expect(body).toContainEqual({ op: 'replace', path: '/spec/suspend', value: true });
  });
});

describe('the firing plan — what the platform will actually run', () => {
  // These cover the review finding that mattered most: `platformFired` used to
  // mean only "the cron differs from the manifest", so DISABLING a schedule
  // that had been moved off its default suspended the CronJob (looked right)
  // while the firing engine went on creating Jobs on the old cron. The switch
  // stopped nothing.
  const planDb = (rows: Record<string, { enabled: boolean; cronExpression: string | null }>, bound = true) => ({
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          // Recover the bound subsystem from Drizzle's condition tree by
          // walking it. JSON.stringify cannot be used: the tree is circular
          // (a column references its table, which references the column).
          const seen = new WeakSet<object>();
          const strings: string[] = [];
          const walk = (n: unknown, depth = 0): void => {
            if (depth > 8 || n === null || n === undefined) return;
            if (typeof n === 'string') { strings.push(n); return; }
            if (typeof n !== 'object') return;
            if (seen.has(n as object)) return;
            seen.add(n as object);
            for (const v of Object.values(n as Record<string, unknown>)) walk(v, depth + 1);
          };
          walk(cond);
          const found = Object.keys(rows).find((k) => strings.includes(k));
          const row = found ? rows[found] : undefined;
          return Promise.resolve(row ? [row] : []);
        },
        innerJoin: () => ({
          where: () => ({ orderBy: () => ({ limit: () => Promise.resolve(bound ? [{ enabled: 1 }] : []) }) }),
        }),
      }),
    }),
  }) as never;

  it('does NOT fire a schedule the operator disabled, even on a custom cron', async () => {
    const plan = await resolveFiringPlan(
      planDb({ secrets_bundle: { enabled: false, cronExpression: '30 4 * * *' } }), log,
    );
    expect(plan.map((p) => p.target.subsystem)).not.toContain('secrets_bundle');
  });

  it('fires a schedule the operator moved and left enabled', async () => {
    const plan = await resolveFiringPlan(
      planDb({ secrets_bundle: { enabled: true, cronExpression: '30 4 * * *' } }), log,
    );
    const mine = plan.find((p) => p.target.subsystem === 'secrets_bundle');
    expect(mine?.cron).toBe('30 4 * * *');
  });

  it('does NOT fire a schedule still on its manifest default — the CronJob does that itself', async () => {
    const target = targetFor('secrets_bundle')!;
    const plan = await resolveFiringPlan(
      planDb({ secrets_bundle: { enabled: true, cronExpression: target.manifestDefault } }), log,
    );
    expect(plan.map((p) => p.target.subsystem)).not.toContain('secrets_bundle');
  });

  it('fires nothing at all when no SYSTEM target is bound', async () => {
    const plan = await resolveFiringPlan(
      planDb({ secrets_bundle: { enabled: true, cronExpression: '30 4 * * *' } }, false), log,
    );
    expect(plan).toHaveLength(0);
  });

  it('never fires a platform-owned or read-only target', async () => {
    // etcd-snap-via-shim gets its schedule patched directly, so firing it here
    // would double every upload; longhorn has no Job template at all.
    const plan = await resolveFiringPlan(
      planDb({
        etcd_snapshot: { enabled: true, cronExpression: '*/5 * * * *' },
        longhorn_recurring: { enabled: true, cronExpression: '*/5 * * * *' },
      }),
      log,
    );
    expect(plan).toHaveLength(0);
  });
});

describe('a disabled schedule that was moved off its default', () => {
  it('reports platformFired=false so nothing fires it', async () => {
    const target = targetFor('cluster_state')!;
    const { clients } = cronJobClients({ schedule: target.manifestDefault, suspend: false });
    const out = await reconcileCadenceTarget(
      dbWith({ enabled: false, cronExpression: '7 7 * * *' }), clients, target, log,
    );
    expect(out.desiredSuspend).toBe(true);
    expect(out.platformFired).toBe(false);
  });
});

describe('the Postgres base backup', () => {
  it('converts the operator 5-field cron to CNPG six-field form', async () => {
    const target = targetFor('system_pitr')!;
    const patchCustom = vi.fn(async () => ({}));
    const clients = {
      batch: { readNamespacedCronJob: vi.fn(), patchNamespacedCronJob: vi.fn() },
      custom: {
        getNamespacedCustomObject: vi.fn(async () => ({ spec: { schedule: '0 0 3 * * *' } })),
        patchNamespacedCustomObject: patchCustom,
      },
    } as unknown as CadenceClients;
    const out = await reconcileCadenceTarget(
      dbWith({ enabled: true, cronExpression: '45 2 * * *' }), clients, target, log,
    );
    expect(out.state).toBe('STATE_OK');
    const body = (patchCustom.mock.calls[0][0] as { body: { spec: { schedule: string } } }).body;
    expect(body.spec.schedule).toBe('0 45 2 * * *');
  });

  it('refuses to write a malformed cron rather than wedging on a webhook rejection', async () => {
    const target = targetFor('system_pitr')!;
    const patchCustom = vi.fn();
    const clients = {
      batch: { readNamespacedCronJob: vi.fn(), patchNamespacedCronJob: vi.fn() },
      custom: { getNamespacedCustomObject: vi.fn(), patchNamespacedCustomObject: patchCustom },
    } as unknown as CadenceClients;
    const out = await reconcileCadenceTarget(
      dbWith({ enabled: true, cronExpression: 'every tuesday' }), clients, target, log,
    );
    expect(out.state).toBe('STATE_INVALID_CRON');
    expect(patchCustom).not.toHaveBeenCalled();
  });

  it('round-trips the cron form', () => {
    expect(toCnpgCron('45 2 * * *')).toBe('0 45 2 * * *');
    expect(fromCnpgCron('0 45 2 * * *')).toBe('45 2 * * *');
    expect(toCnpgCron('nonsense')).toBeNull();
  });
});

describe('a schedule the platform cannot honour', () => {
  it('is reported read-only rather than silently ignored', async () => {
    // Longhorn's RecurringJob is Flux-managed, has no suspend field, and
    // platform-api holds no RBAC for it. Offering an edit would look like it
    // worked and be reverted within the minute.
    const target = targetFor('longhorn_recurring')!;
    const { clients, patch } = cronJobClients({ schedule: '5 * * * *', suspend: false });
    const out = await reconcileCadenceTarget(
      dbWith({ enabled: true, cronExpression: '*/5 * * * *' }), clients, target, log,
    );
    expect(out.state).toBe('STATE_READ_ONLY');
    expect(patch).not.toHaveBeenCalled();
  });
});

describe('missing state', () => {
  it('skips a target whose row has not been seeded yet', async () => {
    const target = targetFor('etcd_snapshot')!;
    const { clients, patch } = cronJobClients({ schedule: '0 * * * *' });
    const out = await reconcileCadenceTarget(dbWith(null), clients, target, log);
    expect(out.state).toBe('STATE_NO_ROW');
    expect(patch).not.toHaveBeenCalled();
  });

  it('skips a CronJob that is not installed yet instead of erroring', async () => {
    const target = targetFor('cluster_state')!;
    const { clients } = cronJobClients('missing');
    const out = await reconcileCadenceTarget(
      dbWith({ enabled: true, cronExpression: null }), clients, target, log,
    );
    expect(out.state).toBe('STATE_NOT_INSTALLED');
  });

  it('treats an absent suspend field as suspended, never as running', async () => {
    const target = targetFor('etcd_snapshot')!;
    const { clients, patch } = cronJobClients({ schedule: '0 * * * *' });
    await reconcileCadenceTarget(dbWith({ enabled: true, cronExpression: '0 * * * *' }), clients, target, log);
    const body = (patch.mock.calls[0][0] as { body: Array<{ path: string; value: unknown }> }).body;
    expect(body).toContainEqual({ op: 'replace', path: '/spec/suspend', value: false });
  });
});

describe('the firing engine', () => {
  const fireClients = (create = vi.fn(async () => ({}))) => ({
    clients: {
      batch: {
        readNamespacedCronJob: vi.fn(async () => ({
          spec: { jobTemplate: { metadata: { labels: { a: 'b' } }, spec: { template: {} } } },
        })),
        createNamespacedJob: create,
      },
    },
    create,
  });

  it('fires only on a minute the cron matches', async () => {
    const { clients, create } = fireClients();
    const args = { namespace: 'platform', cronJobName: 'platform-secrets-backup', cron: '30 4 * * *' };
    const miss = await fireIfDue(clients, { ...args, at: new Date('2026-09-18T04:29:00Z') }, log);
    expect(miss.fired).toBe(false);
    expect(create).not.toHaveBeenCalled();

    const hit = await fireIfDue(clients, { ...args, at: new Date('2026-09-18T04:30:00Z') }, log);
    expect(hit.fired).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('names the Job after the minute, so a repeat is a 409 and not a second run', async () => {
    // Two API replicas can both decide to fire the same minute. Bookkeeping
    // would let both pass; a deterministic name lets the apiserver arbitrate.
    const conflict = vi.fn(async () => { throw Object.assign(new Error('exists'), { statusCode: 409 }); });
    const { clients } = fireClients(conflict);
    const res = await fireIfDue(
      clients,
      { namespace: 'platform', cronJobName: 'platform-secrets-backup', cron: '30 4 * * *', at: new Date('2026-09-18T04:30:00Z') },
      log,
    );
    expect(res.duplicate).toBe(true);
    expect(res.fired).toBe(false);
    expect(res.errorMessage).toBe('');
  });

  it('keeps the Job name inside the 63-character limit', () => {
    const name = firedJobName('a'.repeat(80), new Date('2026-09-18T04:30:00Z'));
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/-202609180430$/);
  });

  it('copies the CronJob template so the fired Job runs the same container', async () => {
    const { clients, create } = fireClients();
    await fireIfDue(
      clients,
      { namespace: 'platform', cronJobName: 'platform-secrets-backup', cron: '* * * * *', at: new Date('2026-09-18T04:30:00Z') },
      log,
    );
    const body = (create.mock.calls[0][0] as {
      body: { spec: Record<string, unknown>; metadata: { labels: Record<string, string> } };
    }).body;
    // The template is copied verbatim...
    expect(body.spec.template).toEqual({});
    // ...plus a TTL, because a Job the platform creates directly is outside the
    // CronJob controller's history limits and would otherwise accumulate one
    // object per fire forever.
    expect(body.spec.ttlSecondsAfterFinished).toBe(604800);
    expect(body.metadata.labels['insula.host/fired-by']).toBe('platform-cadence');
    // The template's own labels survive — the backup-health watcher selects on them.
    expect(body.metadata.labels.a).toBe('b');
  });
});

describe('the target table', () => {
  it('covers every subsystem the UI offers, with no duplicates', () => {
    const subsystems = CADENCE_TARGETS.map((t) => t.subsystem);
    expect(new Set(subsystems).size).toBe(subsystems.length);
    for (const s of ['etcd_snapshot', 'secrets_bundle', 'cluster_state', 'system_pitr', 'longhorn_recurring']) {
      expect(subsystems, `${s} has no cadence target`).toContain(s);
    }
  });
});
