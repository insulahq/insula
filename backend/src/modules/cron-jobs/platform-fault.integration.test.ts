/**
 * explainingOutage's fallback against real Postgres: when the cluster API
 * cannot be asked, a node the node-health detectors recorded going down in
 * the last 15 minutes explains the fault; one down for longer does not.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { isDbAvailable, runMigrations, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { nodeHealthState } from '../../db/schema.js';
import { explainingOutage } from './platform-fault.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('explainingOutage fallback (integration)', () => {
  const db = () => getTestDb();
  const cannotAsk = async () => null;
  const now = new Date();
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => { await db().delete(nodeHealthState); });

  it('is null while every recorded node is Ready', async () => {
    await db().insert(nodeHealthState).values([{ nodeName: 'node-a', ready: true }, { nodeName: 'node-b', ready: true }]);
    expect(await explainingOutage(db(), cannotAsk, now)).toBeNull();
  });

  it('names a node recorded going down in the last 15 minutes', async () => {
    await db().insert(nodeHealthState).values([
      { nodeName: 'node-a', ready: true },
      { nodeName: 'node-b', ready: false, downSince: minutesAgo(5) },
    ]);
    expect(await explainingOutage(db(), cannotAsk, now)).toMatch(/^node-b went down at \d\d:\d\d UTC \(as last recorded\)$/);
  });

  it('does not let a node recorded down for hours explain it — nor a row left for a node with no time', async () => {
    await db().insert(nodeHealthState).values([
      { nodeName: 'node-b', ready: false, downSince: minutesAgo(180) },
      { nodeName: 'node-c', ready: false },
    ]);
    expect(await explainingOutage(db(), cannotAsk, now)).toBeNull();
  });
});
