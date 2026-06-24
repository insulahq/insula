import { describe, it, expect } from 'vitest';
import { runSystemBackupSweeperTick } from './sweeper.js';
import type { Database } from '../../db/index.js';

interface RecordedUpdate {
  readonly setPayload: Record<string, unknown>;
  readonly where: unknown;
}

/**
 * Minimal drizzle-shaped fake. The sweeper issues exactly two
 * `update(...).set(...).where(...).returning(...)` chains (orphan-pending,
 * then orphan-running) and one `execute(sql\`DELETE…\`)`. We record each
 * update's `.set()` payload + `.where()` arg and return canned row lists
 * by call order so we can assert the orphan-RUNNING flip is wired with the
 * right terminal status + envelope. (Semantic WHERE coverage lives in the
 * integration suite against a real DB.)
 */
function makeFakeDb(returns: { pending: string[]; running: string[]; purgedRowCount: number }) {
  const updates: RecordedUpdate[] = [];
  let updateCall = 0;
  const db = {
    update() {
      const call = updateCall++;
      let setPayload: Record<string, unknown> = {};
      const chain = {
        set(payload: Record<string, unknown>) { setPayload = payload; return chain; },
        where(cond: unknown) {
          updates.push({ setPayload, where: cond });
          return chain;
        },
        returning() {
          const ids = call === 0 ? returns.pending : returns.running;
          return Promise.resolve(ids.map((id) => ({ id })));
        },
      };
      return chain;
    },
    execute() {
      return Promise.resolve({ rowCount: returns.purgedRowCount });
    },
  };
  return { db: db as unknown as Database, updates };
}

describe('runSystemBackupSweeperTick', () => {
  it('reports separate orphaned-pending / orphaned-running / purged counts', async () => {
    const { db } = makeFakeDb({ pending: ['p1', 'p2'], running: ['r1'], purgedRowCount: 3 });
    const r = await runSystemBackupSweeperTick(db);
    expect(r).toEqual({ orphanedPending: 2, orphanedRunning: 1, purgedFailed: 3 });
  });

  it('issues a distinct orphan-RUNNING flip → failed with SYSTEM_BACKUP_JOB_ORPHANED', async () => {
    const { db, updates } = makeFakeDb({ pending: [], running: ['r1'], purgedRowCount: 0 });
    await runSystemBackupSweeperTick(db);

    // Two update chains: [0] orphan-pending, [1] orphan-running.
    expect(updates).toHaveLength(2);
    const running = updates[1];
    expect(running.setPayload.status).toBe('failed');
    expect(running.setPayload.finishedAt).toBeInstanceOf(Date);
    const env = running.setPayload.errorEnvelope as { code: string; message: string };
    expect(env.code).toBe('SYSTEM_BACKUP_JOB_ORPHANED');
    expect(env.message).toContain('running');
    // The two flips must carry different messages (pending vs running).
    const pending = updates[0].setPayload.errorEnvelope as { message: string };
    expect(pending.message).not.toBe(env.message);
    expect(pending.message).toContain('pending');
  });

  it('is a no-op (all-zero) when nothing is orphaned or purgeable', async () => {
    const { db } = makeFakeDb({ pending: [], running: [], purgedRowCount: 0 });
    const r = await runSystemBackupSweeperTick(db);
    expect(r).toEqual({ orphanedPending: 0, orphanedRunning: 0, purgedFailed: 0 });
  });
});
