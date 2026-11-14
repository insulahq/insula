/**
 * One DKIM change per email domain at a time.
 *
 * Rotation, drift repair, DR recover and the staff restore all create keys
 * under a selector, keep a copy and publish a record. Two of them at once on
 * one domain could both mint `dkim-1`, leaving Stalwart, the kept copy and DNS
 * on three different keys. Each runs under this lock.
 *
 * The lock is a transaction-scoped advisory lock (pg_advisory_xact_lock, as
 * mail-dns-repair.ts takes one) on a connection that holds nothing else: the
 * work commits through the ordinary connection pool, so a failure late in it
 * never rolls back a copy whose key Stalwart already signs with.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';

export class DkimDomainBusyError extends Error {
  constructor(readonly emailDomainId: string) {
    super('Another DKIM change for this domain is running; try again in a moment.');
    this.name = 'DkimDomainBusyError';
  }
}

/** Runs `work` holding the domain's lock. `wait: false` throws DkimDomainBusyError instead of waiting. */
export type DkimDomainLock = <T>(emailDomainId: string, opts: { wait: boolean }, work: () => Promise<T>) => Promise<T>;

function rowsOf(res: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? []) as Array<Record<string, unknown>>;
}

export function dkimDomainLock(db: Database): DkimDomainLock {
  return (emailDomainId, opts, work) => db.transaction(async (tx) => {
    const key = sql`hashtextextended(${`email-dkim/${emailDomainId}`}, 0)`;
    if (opts.wait) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${key})`);
    } else {
      const [row] = rowsOf(await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${key}) AS ok`));
      if (row?.ok !== true) throw new DkimDomainBusyError(emailDomainId);
    }
    return work();
  });
}
