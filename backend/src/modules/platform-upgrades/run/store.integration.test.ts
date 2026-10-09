/**
 * Upgrade runs against a real Postgres: at most one in flight (the partial unique
 * index → 409), the initiating user's foreign key, and the conditional step
 * changes that keep an operator's Cancel and the reconciler from both winning.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { getTestDb, isDbAvailable, runMigrations } from '../../../test-helpers/db.js';
import { platformUpgradeRuns, users } from '../../../db/schema.js';
import { createRun, getActiveRun, getRun, transitionRun } from './store.js';

const skipIntegration = !await isDbAvailable();

describe.skipIf(skipIntegration)('upgrade runs (integration)', () => {
  const userId = crypto.randomUUID();
  let db: ReturnType<typeof getTestDb>;

  beforeAll(async () => {
    await runMigrations();
    db = getTestDb();
    await db.delete(platformUpgradeRuns);
    await db.insert(users).values({
      id: userId, email: `${userId}@test.local`, passwordHash: 'unused', fullName: 'T',
      roleName: 'super_admin', panel: 'admin', status: 'active',
    });
  });

  afterAll(async () => {
    await db.delete(platformUpgradeRuns);
  });

  const input = { fromVersion: '2026.10.7-rc.3', toVersion: '2026.10.7-rc.4', mode: 'manual' as const, excludedNodes: ['sv3'], initiatedBy: userId };

  it('records a run with its initiator and exclusions, and allows only one in flight', async () => {
    const run = await createRun(db, input);
    expect(run.status).toBe('running');
    expect(run.step).toBe('prepare-nodes');
    expect(run.initiatedBy).toBe(userId);
    expect(run.excludedNodes).toEqual(['sv3']);
    expect((await getActiveRun(db))?.id).toBe(run.id);
    await expect(createRun(db, input)).rejects.toMatchObject({ code: 'UPGRADE_ALREADY_RUNNING', status: 409 });
  });

  it('a step change happens once: Cancel and the reconciler cannot both win', async () => {
    const run = (await getActiveRun(db))!;
    // The reconciler claims update-services…
    expect(await transitionRun(db, run.id, 'prepare-nodes', { step: 'update-services', stepStartedAt: new Date() })).toBe(true);
    // …so a Cancel conditional on prepare-nodes finds nothing to change.
    expect(await transitionRun(db, run.id, 'prepare-nodes', { status: 'cancelled', finishedAt: new Date() })).toBe(false);
    expect((await getRun(db, run.id))?.status).toBe('running');
    // Ending it from any step works once; afterwards nothing moves it.
    expect(await transitionRun(db, run.id, null, { status: 'rolled-back', finishedAt: new Date() })).toBe(true);
    expect(await transitionRun(db, run.id, null, { status: 'failed' })).toBe(false);
    expect((await getRun(db, run.id))?.status).toBe('rolled-back');
  });

  it('a finished run frees the slot for the next one', async () => {
    expect(await getActiveRun(db)).toBeNull();
    const next = await createRun(db, { ...input, initiatedBy: null });
    expect(next.status).toBe('running');
  });

  it('rejects a status or step outside the contract', async () => {
    const run = (await getActiveRun(db))!;
    await expect(transitionRun(db, run.id, null, { status: 'bogus' })).rejects.toThrow();
    await expect(transitionRun(db, run.id, null, { step: 'nope' })).rejects.toThrow();
  });

  it('records a Kubernetes target and allows the Kubernetes step (migration 0155)', async () => {
    const active = await getActiveRun(db);
    if (active) await transitionRun(db, active.id, null, { status: 'cancelled', finishedAt: new Date() });
    const run = await createRun(db, { ...input, initiatedBy: null, kubernetesVersion: 'v1.36.5+k3s1' });
    expect(run.kubernetesVersion).toBe('v1.36.5+k3s1');
    expect(await transitionRun(db, run.id, 'prepare-nodes', { step: 'upgrade-kubernetes' })).toBe(true);
    expect((await getRun(db, run.id))?.step).toBe('upgrade-kubernetes');
  });
});

