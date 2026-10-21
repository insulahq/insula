/**
 * The automatic archive/delete sweep: what it does, in what order, and what
 * it writes down — with everything it touches behind `SweepIo`, so the
 * decisions can be tested without a cluster (real.ts binds it).
 *
 *   - a tenant suspended for longer than the archive limit is archived;
 *   - a tenant archived for longer than the delete limit is deleted;
 *   - with a notice period set, each is told that many days ahead and given
 *     a date, and nothing is done to it before that date;
 *   - a tenant an admin keeps out is never in line at all.
 *
 * What happens to one tenant at one moment is `tenantAutomationPlan`, shared
 * with the admin panel's preview.
 *
 * One tenant at a time, oldest first: an archive scales a tenant down and
 * copies its files off-site, and the day the sweep is switched on there may
 * be a whole backlog due. So a sweep can last hours, and two things it read
 * at its start go stale on the way:
 *
 *   - the tenants. The list is read once; each action re-checks, under the
 *     tenant's lock, that its tenant is still due — an operator may have
 *     resumed or restored it since.
 *   - the settings. They are read again before every tenant something is
 *     done to: a step switched off stops there, and a limit or notice period
 *     that was raised is the one applied. What an admin sees on the card is
 *     what the next tenant gets, not what was stored when the sweep began.
 */
import {
  tenantAutomationArchiveRetentionDays,
  tenantAutomationPlan,
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

/** A tenant a step looks at: suspended (archive) or archived (delete), and not kept out. */
export interface InLineTenant extends DueTenant {
  /** When it was suspended, or archived. Null when that was never recorded. */
  readonly since: Date | null;
  /** What it was told for this step, if anything. `reached: false` — the message reached nobody, and does not count. */
  readonly notice: { readonly toldAt: Date; readonly date: Date; readonly reached: boolean } | null;
}

/** What one archive or delete came to. */
export type ActionOutcome =
  | { readonly kind: 'done' }
  /** No longer due, or another change owns the tenant: left for a later sweep, not a failure. */
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'failed'; readonly error: string };

/** What telling one tenant came to. */
export type TellOutcome =
  /**
   * Sent and written down. `reached` is false when there was nobody to send
   * it to: that notice does not count, and the tenant is told again at the
   * next sweep.
   */
  | { readonly kind: 'told'; readonly reached: boolean }
  /** The tenant is no longer in line (resumed, restored, kept out, gone). */
  | { readonly kind: 'skipped'; readonly reason: string };

export type Step = 'archive' | 'delete';

export interface SweepIo {
  readonly settings: () => Promise<TenantAutomationSettings>;
  /** The platform's archive retention (Backups settings). */
  readonly archiveRetentionDays: () => Promise<number>;
  /** Every tenant the step looks at, oldest first; tenants kept out are not among them. */
  readonly inLine: (step: Step) => Promise<readonly InLineTenant[]>;
  /**
   * Why no archive can be taken right now (no backup target serves tenant
   * snapshots), or null. Asked only when the archive step has something to do.
   */
  readonly archiveBlockedReason: () => Promise<string | null>;
  /** Archive one tenant and wait for the archive to finish. */
  /** `retentionDays` null: the archive is kept with no end date. */
  readonly archive: (tenant: DueTenant, opts: { readonly retentionDays: number | null; readonly suspendedBefore: Date }) => Promise<ActionOutcome>;
  readonly remove: (tenant: DueTenant, opts: { readonly archivedBefore: Date }) => Promise<ActionOutcome>;
  /** Tell one tenant that it will be archived (or deleted) on `date`, and write that down. */
  readonly tell: (step: Step, tenant: InLineTenant, date: Date) => Promise<TellOutcome>;
  readonly record: (run: TenantAutomationRun) => Promise<void>;
  /** Tell the admins what a sweep did. Called only when it did, or failed at, something. */
  readonly notify: (run: TenantAutomationRun) => Promise<void>;
  readonly now: () => Date;
  readonly log: (line: string) => void;
}

type Told = TenantAutomationRun['told'][number];

const say = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runTenantAutomationSweep(io: SweepIo, trigger: TenantAutomationRun['trigger']): Promise<TenantAutomationRun> {
  const startedAt = io.now();
  const archived: DueTenant[] = [];
  const deleted: DueTenant[] = [];
  const told: Told[] = [];
  const failed: Array<DueTenant & { action: Step; error: string }> = [];
  const errors: string[] = [];
  let archiveSkippedReason: string | null = null;

  const daysOf = (settings: TenantAutomationSettings, step: Step): number =>
    (step === 'archive' ? settings.autoArchiveAfterDays : settings.autoDeleteAfterDays);
  const isOn = (settings: TenantAutomationSettings, step: Step): boolean =>
    (step === 'archive' ? settings.autoArchiveEnabled : settings.autoDeleteEnabled);
  // Counted from the sweep's start: a tenant this sweep has just archived is
  // not past the delete limit, however long the sweep has been running.
  const planOf = (tenant: InLineTenant, settings: TenantAutomationSettings, step: Step) =>
    tenantAutomationPlan(tenant, daysOf(settings, step), settings.noticeDays, startedAt.getTime());
  const hasWork = (tenant: InLineTenant, settings: TenantAutomationSettings, step: Step): boolean => {
    const kind = planOf(tenant, settings, step).kind;
    return kind === 'due' || kind === 'tell';
  };

  /** Work through one step's tenants. */
  const work = async (
    step: Step,
    listedWith: TenantAutomationSettings,
    inLine: readonly InLineTenant[],
    done: DueTenant[],
    act: (tenant: DueTenant, settings: TenantAutomationSettings, before: Date) => Promise<ActionOutcome>,
  ): Promise<void> => {
    let settings = listedWith;
    const todo = inLine.filter((t) => hasWork(t, settings, step));
    for (const tenant of todo) {
      settings = await io.settings();
      if (!isOn(settings, step)) {
        io.log(`the ${step} step was switched off during the sweep: stopped before ${tenant.name}, ${todo.length - todo.indexOf(tenant)} tenant(s) left as they are`);
        return;
      }
      // Decided with what is stored now, not with what the list was read under.
      const plan = planOf(tenant, settings, step);
      if (plan.kind === 'tell') {
        const date = new Date(plan.actAt);
        try {
          const outcome = await io.tell(step, tenant, date);
          if (outcome.kind === 'told') {
            told.push({ tenantId: tenant.tenantId, name: tenant.name, action: step, date: date.toISOString(), reached: outcome.reached });
            io.log(outcome.reached
              ? `told ${tenant.name} (${tenant.tenantId}): ${step} on ${date.toISOString().slice(0, 10)}`
              : `could not tell ${tenant.name} (${tenant.tenantId}): the message reached nobody — it is told again at the next sweep and not ${step}d meanwhile`);
          } else {
            io.log(`did not tell ${tenant.name} (${tenant.tenantId}): ${outcome.reason}`);
          }
        } catch (err) {
          failed.push({ tenantId: tenant.tenantId, name: tenant.name, action: step, error: `It could not be told: ${say(err)}` });
          io.log(`could not tell ${tenant.name} (${tenant.tenantId}): ${say(err)}`);
        }
        continue;
      }
      if (plan.kind !== 'due') continue;
      // The date the action checks again under the tenant's lock. The longer
      // of the limit the list was read under and the one stored now: lowering
      // a limit mid-sweep loosens nothing for a tenant already in the list.
      const heldTo = Math.max(daysOf(listedWith, step), daysOf(settings, step));
      let outcome: ActionOutcome;
      try {
        outcome = await act(tenant, settings, new Date(startedAt.getTime() - heldTo * DAY_MS));
      } catch (err) {
        outcome = { kind: 'failed', error: say(err) };
      }
      if (outcome.kind === 'done') {
        done.push({ tenantId: tenant.tenantId, name: tenant.name });
        io.log(`${step}d ${tenant.name} (${tenant.tenantId})`);
      } else if (outcome.kind === 'skipped') {
        io.log(`left ${tenant.name} (${tenant.tenantId}) alone: ${outcome.reason}`);
      } else {
        failed.push({ tenantId: tenant.tenantId, name: tenant.name, action: step, error: outcome.error });
        io.log(`could not ${step} ${tenant.name} (${tenant.tenantId}): ${outcome.error}`);
      }
    }
  };

  // Each step on its own: one that cannot even list its tenants must not take
  // the other with it, and what was done before it stopped is still recorded.
  try {
    const settings = await io.settings();
    if (settings.autoArchiveEnabled) {
      const inLine = await io.inLine('archive');
      const todo = inLine.filter((t) => hasWork(t, settings, 'archive'));
      if (todo.length > 0) {
        // Nobody is told of an archive that cannot be taken, either.
        archiveSkippedReason = await io.archiveBlockedReason();
        if (archiveSkippedReason) {
          io.log(`archive step skipped, ${todo.length} tenant(s) in line: ${archiveSkippedReason}`);
        } else {
          const platformRetention = await io.archiveRetentionDays();
          await work('archive', settings, inLine, archived, (tenant, now, suspendedBefore) => io.archive(tenant, {
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
      const inLine = await io.inLine('delete');
      await work('delete', settings, inLine, deleted, (tenant, _now, archivedBefore) => io.remove(tenant, { archivedBefore }));
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
    told: told.slice(0, MAX_RECORDED),
    archiveSkippedReason,
    errors,
  };
  // What was done is said even when it cannot be written down: tenants were
  // archived or deleted, and somebody has to hear of it.
  await io.record(run).catch((err: unknown) => { io.log(`could not record the run: ${say(err)}`); });
  if (archived.length + deleted.length + told.length + failed.length + errors.length > 0 || archiveSkippedReason) {
    io.log(`sweep done: archived ${archived.length}, deleted ${deleted.length}, told ${told.length}, failed ${failed.length}${errors.length > 0 ? `, ${errors.length} step(s) stopped` : ''}`);
    await io.notify(run).catch((err: unknown) => { io.log(`could not notify the admins: ${say(err)}`); });
  }
  return run;
}
