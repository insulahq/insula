/**
 * pg-mem tests for purgeFullyReclaimedBundles.
 *
 * This statement deletes user-visible backup history, and its gating is the
 * only thing standing between "tidy the list" and "destroy the snapshot id of
 * a backup that still exists". Run against a real SQL engine rather than a
 * mock so the NOT EXISTS correlation is genuinely exercised.
 */

import { describe, it, expect } from 'vitest';
import { newDb, type IMemoryDb } from 'pg-mem';
import { purgeFullyReclaimedBundles } from './restic-retention.js';

/** Render Drizzle sql`` chunks into text+params for pg-mem. */
function pgMemExec(mem: IMemoryDb) {
  const adapter = mem.adapters.createPg() as unknown as {
    Pool: new () => { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> };
  };
  const pool = new adapter.Pool();
  const render = (chunks: unknown[], st: { text: string; params: unknown[] }): void => {
    for (const chunk of chunks) {
      if (chunk && typeof chunk === 'object' && 'queryChunks' in chunk && Array.isArray((chunk as { queryChunks: unknown[] }).queryChunks)) {
        render((chunk as { queryChunks: unknown[] }).queryChunks, st);
        continue;
      }
      if (chunk && typeof chunk === 'object' && 'value' in chunk) {
        const v = (chunk as { value: unknown }).value;
        if (Array.isArray(v) && typeof v[0] === 'string') { st.text += v[0]; continue; }
        if (typeof v === 'string') { st.text += `"${v.replace(/"/g, '""')}"`; continue; }
        st.params.push(v); st.text += `$${st.params.length}`; continue;
      }
      st.params.push(chunk); st.text += `$${st.params.length}`;
    }
  };
  return {
    execute: async (q: { queryChunks: unknown[] }) => {
      const st = { text: '', params: [] as unknown[] };
      render(q.queryChunks, st);
      return pool.query(st.text, st.params);
    },
    raw: (t: string) => pool.query(t),
  };
}

function seed(): { db: ReturnType<typeof pgMemExec> } {
  const mem = newDb();
  mem.public.none(`
    CREATE TABLE backup_jobs (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(36) NOT NULL,
      status VARCHAR(32) NOT NULL
    );
    CREATE TABLE backup_components (
      id VARCHAR(36) PRIMARY KEY,
      backup_job_id VARCHAR(64) NOT NULL,
      component VARCHAR(32) NOT NULL,
      sha256 VARCHAR(64),
      snapshot_reclaimed_at TIMESTAMP
    );
  `);
  return { db: pgMemExec(mem) };
}

const ins = async (db: ReturnType<typeof pgMemExec>, sqlText: string) => { await db.raw(sqlText); };

describe('purgeFullyReclaimedBundles', () => {
  it('purges an expired bundle whose only restic component is reclaimed', async () => {
    const { db } = seed();
    await ins(db, `INSERT INTO backup_jobs VALUES ('b1','t1','expired')`);
    await ins(db, `INSERT INTO backup_components VALUES ('c1','b1','files','aa', now())`);
    expect(await purgeFullyReclaimedBundles(db as never)).toEqual(['b1']);
  });

  it('does NOT purge while a restic component is still unreclaimed', async () => {
    const { db } = seed();
    await ins(db, `INSERT INTO backup_jobs VALUES ('b1','t1','expired')`);
    await ins(db, `INSERT INTO backup_components VALUES ('c1','b1','files','aa', NULL)`);
    expect(await purgeFullyReclaimedBundles(db as never)).toEqual([]);
  });

  it('keeps a two-repo bundle until BOTH components are reclaimed', async () => {
    // The dangerous case: purging after only `files` was swept would cascade
    // away the mailboxes snapshot id while that snapshot still exists.
    const { db } = seed();
    await ins(db, `INSERT INTO backup_jobs VALUES ('b1','t1','expired')`);
    await ins(db, `INSERT INTO backup_components VALUES ('c1','b1','files','aa', now())`);
    await ins(db, `INSERT INTO backup_components VALUES ('c2','b1','mailboxes','bb', NULL)`);
    expect(await purgeFullyReclaimedBundles(db as never)).toEqual([]);

    await ins(db, `UPDATE backup_components SET snapshot_reclaimed_at = now() WHERE id='c2'`);
    expect(await purgeFullyReclaimedBundles(db as never)).toEqual(['b1']);
  });

  it('never purges a bundle that is not yet expired', async () => {
    const { db } = seed();
    await ins(db, `INSERT INTO backup_jobs VALUES ('b1','t1','completed')`);
    await ins(db, `INSERT INTO backup_components VALUES ('c1','b1','files','aa', now())`);
    expect(await purgeFullyReclaimedBundles(db as never)).toEqual([]);
  });

  it('purges an expired bundle that never had restic components at all', async () => {
    // config/secrets-only bundle: its directory is already gone (status
    // 'expired' is set only after the store delete succeeded), so the row
    // describes nothing.
    const { db } = seed();
    await ins(db, `INSERT INTO backup_jobs VALUES ('b1','t1','expired')`);
    await ins(db, `INSERT INTO backup_components VALUES ('c1','b1','config',NULL,NULL)`);
    expect(await purgeFullyReclaimedBundles(db as never)).toEqual(['b1']);
  });

  it('ignores a NULL sha256 restic component rather than blocking forever', async () => {
    // A skipped/failed capture recorded no snapshot id — there is nothing in
    // the repo to reclaim, so it must not pin the row indefinitely.
    const { db } = seed();
    await ins(db, `INSERT INTO backup_jobs VALUES ('b1','t1','expired')`);
    await ins(db, `INSERT INTO backup_components VALUES ('c1','b1','files',NULL,NULL)`);
    expect(await purgeFullyReclaimedBundles(db as never)).toEqual(['b1']);
  });

  it('scopes to one tenant when asked', async () => {
    const { db } = seed();
    await ins(db, `INSERT INTO backup_jobs VALUES ('b1','t1','expired')`);
    await ins(db, `INSERT INTO backup_jobs VALUES ('b2','t2','expired')`);
    expect(await purgeFullyReclaimedBundles(db as never, 't1')).toEqual(['b1']);
    expect(await purgeFullyReclaimedBundles(db as never, 't2')).toEqual(['b2']);
  });
});
