/**
 * One change to a tenant at a time.
 *
 * A storage operation claims its tenant by writing `storage_lifecycle_state`,
 * after checking that the state is idle — two steps, so two starts could both
 * pass the check. And a delete claims nothing at all. That left room for an
 * operator and the automatic archive/delete sweep (auto-ops/) to reach one
 * tenant at once: two archives of it, a delete beside a restore, two deletes.
 *
 * Everything that starts an operation on a tenant, and everything that deletes
 * one, therefore holds this lock while it checks and claims — the starters for
 * the moment that takes, a delete for as long as it runs. Inside it a caller
 * sees the tenant as it is, not as it was when a list was read: the sweep
 * checks again, here, that the tenant is still due.
 *
 * The lock is a run lock (shared/exclusive-run.ts), so a process that dies
 * holding it blocks the tenant for two minutes at most.
 *
 * Not reentrant: a function that holds a tenant's lock must not call another
 * that takes it for the same tenant — it would wait for itself and answer 409.
 * Nothing does (the lifecycle hooks and cascades call none of the holders).
 */
import type { OperatorError } from '@insula/api-contracts';
import { ApiError } from '../../shared/errors.js';
import { runExclusive } from '../../shared/exclusive-run.js';
import type { LeaseDb } from '../../shared/scheduler-lease.js';

/** How long a start or a delete waits for another change to the same tenant. */
export const TENANT_LOCK_WAIT_MS = 15_000;

/**
 * The longest the lock is held before its holder is taken for hung and given
 * up (scheduler-lease.ts). Most holders are done in a moment — they check and
 * claim. A delete, a suspend and a resume do their whole work inside, and
 * giving one of those up while it is merely slow would let an archive or a
 * restore start on a tenant that is half deleted; so the hold is hours, not
 * the run lock's usual half hour.
 */
export const TENANT_LOCK_MAX_HOLD_MS = 6 * 60 * 60_000;

/** The run-lock job of one tenant. */
export const tenantLockJob = (tenantId: string): string => `tenant:${tenantId}`;

/**
 * Run `fn` as the only change being started on, or deleting, this tenant.
 * Answers 409 TENANT_BUSY when another one is still at it after the wait.
 */
export async function withTenantLock<T>(
  db: LeaseDb,
  tenantId: string,
  fn: () => Promise<T>,
  opts: { readonly waitMs?: number } = {},
): Promise<T> {
  const run = await runExclusive(db, tenantLockJob(tenantId), fn, {
    waitMs: opts.waitMs ?? TENANT_LOCK_WAIT_MS,
    maxHoldMs: TENANT_LOCK_MAX_HOLD_MS,
  });
  if (!run.ran) throw tenantBusy(tenantId);
  return run.value;
}

export function tenantBusy(tenantId: string): ApiError {
  const detail = 'Another change to this tenant is being started, or the tenant is being deleted.';
  const operatorError: OperatorError = {
    code: 'TENANT_BUSY',
    title: 'Tenant is busy',
    detail,
    remediation: ['Nothing was changed by this request. Reload the tenant, and try again if the change is still wanted.'],
    retryable: true,
  };
  return new ApiError('TENANT_BUSY', `${detail} Try again in a moment.`, 409, { tenantId, operatorError });
}
