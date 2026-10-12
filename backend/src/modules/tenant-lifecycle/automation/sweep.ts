/**
 * The automatic archive/delete sweep: what it does, in what order, and what
 * it writes down — with everything it touches behind `SweepIo`, so the
 * decisions can be tested without a cluster (real.ts binds it).
 *
 *   - a tenant suspended for longer than the archive limit is archived;
 *   - a tenant archived for longer than the delete limit is deleted.
 *
 * One tenant at a time, oldest first: an archive scales a tenant down and
 * copies its files off-site, and the day the sweep is switched on there may
 * be a whole backlog due. So a sweep can last hours, and two things it read
 * at its start go stale on the way:
 *
 *   - the tenants. The list is read once; each action re-checks, under the
 *     tenant's lock, that its tenant is still due — an operator may have
 *     resumed or restored it since.
 *   - the settings. They are read again before every tenant: a step switched
 *     off stops there, and a limit that was raised is the one applied. What
 *     an admin sees on the card is what the next tenant gets, not what was
 *     stored when the sweep began.
 */
import {
  tenantAutomationArchiveRetentionDays,
  type TenantAutomationRun,
  type TenantAutomationSettings,
} from '@insula/api-contracts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** At most this many names per list in the stored record; the rest is counted in the log. */
const MAX_RECORDED = 50;

export interface DueTenant {
  readonly tenantId: string;
  readonly name: string;
}

/** What one archive or delete came to. */
export type ActionOutcome =
  | { readonly kind: 'done' }
  /** No longer due, or another change owns the tenant: left for a later sweep, not a failure. */
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'failed'; readonly error: string };

export interface SweepIo {
  readonly settings: () => Promise<TenantAutomationSettings>;
  /** The platform's archive retention (Backups settings). */
  readonly archiveRetentionDays: () => Promise<number>;
  /** Suspended before `before`, oldest first. */
  readonly dueForArchive: (before: Date) => Promise<readonly DueTenant[]>;
  /** Archived before `before`, oldest first. */
  readonly dueForDelete: (before: Date) => Promise<readonly DueTenant[]>;
  /**
   * Why no archive can be taken right now (no backup target serves tenant
   * snapshots), or null. Asked only when something is due.
   */
  readonly archiveBlockedReason: () => Promise<string | null>;
  /** Archive one tenant and wait for the archive to finish. */
  readonly archive: (tenant: DueTenant, opts: { readonly retentionDays: number; readonly suspendedBefore: Date }) => Promise<ActionOutcome>;
  readonly remove: (tenant: DueTenant, opts: { readonly archivedBefore: Date }) => Promise<ActionOutcome>;
  readonly record: (run: TenantAutomationRun) => Promise<void>;
  /** Tell the admins what a sweep did. Called only when it did, or failed at, something. */
  readonly notify: (run: TenantAutomationRun) => Promise<void>;
  readonly now: () => Date;
  readonly log: (line: string) => void;
}

type Step = 'archive' | 'delete';

const say = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runTenantAutomationSweep(io: SweepIo, trigger: TenantAutomationRun['trigger']): Promise<TenantAutomationRun> {
  const startedAt = io.now();
  const archived: DueTenant[] = [];
  const deleted: DueTenant[] = [];
  const failed: Array<DueTenant & { action: Step; error: string }> = [];
  const errors: string[] = [];
  let archiveSkippedReason: string | null = null;

  const limitOf = (settings: TenantAutomationSettings, step: Step): Date => new Date(
    startedAt.getTime() - (step === 'archive' ? settings.autoArchiveAfterDays : settings.autoDeleteAfterDays) * DAY_MS,
  );
  const isOn = (settings: TenantAutomationSettings, step: Step): boolean =>
    (step === 'archive' ? settings.autoArchiveEnabled : settings.autoDeleteEnabled);

  /**
   * Work through one step's tenants. `listed` is the limit the list was read
   * with; each tenant gets the stricter of that and the limit stored now.
   */
  const work = async (
    step: Step,
    due: readonly DueTenant[],
    listed: Date,
    done: DueTenant[],
    act: (tenant: DueTenant, settings: TenantAutomationSettings, before: Date) => Promise<ActionOutcome>,
  ): Promise<void> => {
    for (const tenant of due) {
      const settings = await io.settings();
      if (!isOn(settings, step)) {
        io.log(`the ${step} step was switched off during the sweep: stopped before ${tenant.name}, ${due.length - due.indexOf(tenant)} tenant(s) left as they are`);
        return;
      }
      const stored = limitOf(settings, step);
      const before = stored < listed ? stored : listed;
      let outcome: ActionOutcome;
      try {
        outcome = await act(tenant, settings, before);
      } catch (err) {
        outcome = { kind: 'failed', error: say(err) };
      }
      if (outcome.kind === 'done') {
        done.push(tenant);
        io.log(`${step}d ${tenant.name} (${tenant.tenantId})`);
      } else if (outcome.kind === 'skipped') {
        io.log(`left ${tenant.name} (${tenant.tenantId}) alone: ${outcome.reason}`);
      } else {
        failed.push({ ...tenant, action: step, error: outcome.error });
        io.log(`could not ${step} ${tenant.name} (${tenant.tenantId}): ${outcome.error}`);
      }
    }
  };

  // Each step on its own: one that cannot even list its tenants must not take
  // the other with it, and what was done before it stopped is still recorded.
  try {
    const settings = await io.settings();
    if (settings.autoArchiveEnabled) {
      const listed = limitOf(settings, 'archive');
      const due = await io.dueForArchive(listed);
      if (due.length > 0) {
        archiveSkippedReason = await io.archiveBlockedReason();
        if (archiveSkippedReason) {
          io.log(`archive step skipped, ${due.length} tenant(s) due: ${archiveSkippedReason}`);
        } else {
          const platformRetention = await io.archiveRetentionDays();
          await work('archive', due, listed, archived, (tenant, now, suspendedBefore) => io.archive(tenant, {
            retentionDays: tenantAutomationArchiveRetentionDays(now, platformRetention),
            suspendedBefore,
          }));
        }
      }
    }
  } catch (err) {
    errors.push(`The archive step stopped: ${say(err)}`);
    io.log(`archive step stopped: ${say(err)}`);
  }

  try {
    const settings = await io.settings();
    if (settings.autoDeleteEnabled) {
      // Counted back from the sweep's start, like the archive limit: a tenant
      // this sweep has just archived is not past it.
      const listed = limitOf(settings, 'delete');
      const due = await io.dueForDelete(listed);
      await work('delete', due, listed, deleted, (tenant, _now, archivedBefore) => io.remove(tenant, { archivedBefore }));
    }
  } catch (err) {
    errors.push(`The delete step stopped: ${say(err)}`);
    io.log(`delete step stopped: ${say(err)}`);
  }

  const run: TenantAutomationRun = {
    startedAt: startedAt.toISOString(),
    finishedAt: io.now().toISOString(),
    trigger,
    archived: archived.slice(0, MAX_RECORDED),
    deleted: deleted.slice(0, MAX_RECORDED),
    failed: failed.slice(0, MAX_RECORDED),
    archiveSkippedReason,
    errors,
  };
  // What was done is said even when it cannot be written down: tenants were
  // archived or deleted, and somebody has to hear of it.
  await io.record(run).catch((err: unknown) => { io.log(`could not record the run: ${say(err)}`); });
  if (archived.length + deleted.length + failed.length + errors.length > 0 || archiveSkippedReason) {
    io.log(`sweep done: archived ${archived.length}, deleted ${deleted.length}, failed ${failed.length}${errors.length > 0 ? `, ${errors.length} step(s) stopped` : ''}`);
    await io.notify(run).catch((err: unknown) => { io.log(`could not notify the admins: ${say(err)}`); });
  }
  return run;
}
