/**
 * Cross-replica serialisation for `restic init`.
 *
 * Why this exists — production incident 2026-09-23. ADR-061 merged the
 * per-component repositories into one per tenant, so `files` and
 * `mailboxes` now resolve to the SAME repo URI. The orchestrator runs
 * those two components in parallel (`Promise.allSettled`), and each one
 * calls `ensureResticRepoInitialised` for itself. On a tenant's FIRST
 * merged bundle the repo is empty, so both branches saw "no config" and
 * both ran `restic init`.
 *
 * `restic init` is not safe to run concurrently: each run mints its own
 * random master key, writes `keys/<id>`, then writes `config`. Two runs
 * leave TWO key files and a `config` belonging to whichever wrote last.
 * `deriveResticPassword` is keyed on the tenant alone, so the one
 * password opens BOTH keys — restic's `SearchKey` takes the first key it
 * can open, then fails to decrypt a `config` sealed with the other
 * master key:
 *
 *     Fatal: config or key <id> is damaged: ciphertext verification failed
 *
 * That is permanent for the repo and deterministic on every later run.
 * Six of 27 production tenants hit it in a single night (the sixth lost
 * the race one step earlier and hit restic's own `repository already
 * contains keys` guard).
 *
 * The fix is to let exactly one initialiser run per repository at a
 * time. A Postgres advisory lock — not an in-process mutex — because
 * platform-api runs 2–3 replicas in HA mode and a concurrent bundle for
 * the same tenant can land on a different pod.
 *
 * Fail-open, deliberately: if the lock cannot be taken (database
 * unreachable, lock held past the timeout) the init still runs, just
 * unserialised. A backup that refuses to start because a lock was
 * unavailable is worse than the race this guards against, and
 * `execResticInit`'s lost-race retry covers the remaining window.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { RepoInitSerialiser } from './restic-driver.js';

/**
 * How long to wait for the advisory lock before giving up and
 * initialising unserialised. `restic init` against an empty repo takes
 * ~5s, so 60s covers a long queue without wedging a bundle.
 */
const LOCK_TIMEOUT = '60s';

/**
 * Build the serialiser used by the bundle components.
 *
 * The lock is keyed on the repo URI — NOT the tenant id — because that
 * is what `restic init` actually contends on. Two layouts for the same
 * tenant (`restic/<id>` and `restic-files/<id>`) are different
 * repositories and must not block each other.
 */
export function makeRepoInitSerialiser(
  db: Database,
  log?: { warn: (msg: string) => void },
): RepoInitSerialiser {
  return async <T>(repoUri: string, run: () => Promise<T>): Promise<T> => {
    // `entered` flips only once the lock is held, so a failure BEFORE it
    // means "never got the lock" (retry unserialised) and a failure
    // AFTER it means `run()` itself threw (propagate, never re-run).
    let entered = false;
    // Set once `run()` resolves. If the surrounding transaction then
    // fails to commit, the init has still happened — returning the value
    // beats failing a component over bookkeeping on an empty tx.
    let done: { readonly value: T } | undefined;
    try {
      await db.transaction(async (tx) => {
        // lock_timeout applies to advisory locks (they are heavyweight
        // locks), so this bounds the wait instead of blocking forever.
        // Literal, not a bind parameter — SET does not take one.
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`));
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`restic-init:${repoUri}`}, 0))`,
        );
        entered = true;
        done = { value: await run() };
      });
    } catch (err) {
      if (done) return done.value;
      if (entered) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      log?.warn(
        `restic init: could not acquire the repo-init lock (${detail}) — initialising without cross-replica serialisation`,
      );
      return run();
    }
    // Unreachable unless the transaction resolved without running the
    // body, which drizzle does not do; keep the type total regardless.
    if (!done) throw new Error('repo-init lock: transaction completed without running the initialiser');
    return done.value;
  };
}
