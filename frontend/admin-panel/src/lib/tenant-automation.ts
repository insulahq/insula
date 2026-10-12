import {
  tenantAutomationPlan,
  type TenantAutomationCandidate,
  type TenantAutomationSettings,
  type TenantAutomationSettingsUpdate,
  type TenantAutomationStatus,
} from '@insula/api-contracts';

const DAY_MS = 86_400_000;

export interface DatedCandidate extends TenantAutomationCandidate {
  /** When the sweep acts on the tenant at the earliest — or, once it is due, the limit it passed. Epoch ms. */
  readonly dueAt: number;
}

export interface LaterCandidate extends DatedCandidate {
  /** It has been given `dueAt` as its date already. */
  readonly told: boolean;
  /** When it will be told; null when it has been, or when nobody is told. */
  readonly tellAt: number | null;
}

export interface DueSplit {
  /** Acted on at the next run. Oldest first. */
  readonly dueNow: readonly DatedCandidate[];
  /** Told at the next run, acted on at `dueAt`. Oldest first. */
  readonly toTell: readonly DatedCandidate[];
  /** Nothing at the next run. Soonest first. */
  readonly later: readonly LaterCandidate[];
  /** No date recorded: the sweep never touches these. */
  readonly undated: readonly TenantAutomationCandidate[];
}

/**
 * Sort the tenants in line by what a limit of `afterDays` and a notice period
 * of `noticeDays` do with them. The same decision the sweep takes
 * (`tenantAutomationPlan`), so the card says what the next run will do — for
 * the saved settings and for ones being typed.
 */
export function splitByDue(
  candidates: readonly TenantAutomationCandidate[],
  afterDays: number,
  noticeDays: number,
  nowMs: number,
): DueSplit {
  const dueNow: DatedCandidate[] = [];
  const toTell: DatedCandidate[] = [];
  const later: LaterCandidate[] = [];
  const undated: TenantAutomationCandidate[] = [];
  for (const c of candidates) {
    const plan = tenantAutomationPlan(c, afterDays, noticeDays, nowMs);
    if (plan.kind === 'never') undated.push(c);
    // Its limit, which it is past: the tenant longest past it comes first.
    else if (plan.kind === 'due') dueNow.push({ ...c, dueAt: new Date(c.since ?? 0).getTime() + afterDays * DAY_MS });
    else if (plan.kind === 'tell') toTell.push({ ...c, dueAt: plan.actAt });
    else later.push({ ...c, dueAt: plan.actAt, told: plan.told, tellAt: plan.tellAt });
  }
  dueNow.sort((a, b) => a.dueAt - b.dueAt);
  toTell.sort((a, b) => a.dueAt - b.dueAt);
  later.sort((a, b) => a.dueAt - b.dueAt);
  return { dueNow, toTell, later, undated };
}

/** The tenants one step reaches at the next run. */
export interface StepReach {
  /** Archived (or deleted) at the next run. */
  readonly now: readonly DatedCandidate[];
  /** Told at the next run, and archived (or deleted) on the date each is given — with nobody asked again. */
  readonly tell: readonly DatedCandidate[];
}

export interface NewlyDue {
  readonly archive: StepReach;
  readonly remove: StepReach;
}

const NOBODY: StepReach = { now: [], tell: [] };

/** How many tenants a change reaches, in both steps and both ways. */
export function reachCount(due: NewlyDue): number {
  return due.archive.now.length + due.archive.tell.length + due.remove.now.length + due.remove.tell.length;
}

/** Everything the next run reaches under `settings`: the answer "Run now" is asked with. */
export function reachedNow(
  status: Pick<TenantAutomationStatus, 'suspended' | 'archived' | 'archiveBlockedReason'>,
  settings: TenantAutomationSettings,
  nowMs: number,
): NewlyDue {
  const step = (candidates: readonly TenantAutomationCandidate[], on: boolean, days: number): StepReach => {
    if (!on) return NOBODY;
    const split = splitByDue(candidates, days, settings.noticeDays, nowMs);
    return { now: split.dueNow, tell: split.toTell };
  };
  return {
    // Nothing is archived, and nobody told of it, while no archive can be taken.
    archive: status.archiveBlockedReason ? NOBODY : step(status.suspended, settings.autoArchiveEnabled, settings.autoArchiveAfterDays),
    remove: step(status.archived, settings.autoDeleteEnabled, settings.autoDeleteAfterDays),
  };
}

/**
 * The tenants a change of settings puts in front of the next run: reached
 * under the settings about to be saved, and not — or not that way — under the
 * saved ones. Switching a step on, shortening its limit or its notice period
 * can reach tenants suspended or archived long ago — the save asks before it
 * does. A tenant that is told is asked about here too: its archive or delete
 * follows on the date it is given, with no further question.
 */
export function newlyDue(
  status: Pick<TenantAutomationStatus, 'settings' | 'suspended' | 'archived'>,
  draft: TenantAutomationSettings,
  nowMs: number,
): NewlyDue {
  const open = { ...status, archiveBlockedReason: null };
  const before = reachedNow(open, status.settings, nowMs);
  const after = reachedNow(open, draft, nowMs);
  const fresh = (was: StepReach, is: StepReach): StepReach => {
    const wasNow = new Set(was.now.map((c) => c.tenantId));
    const wasAny = new Set([...was.now, ...was.tell].map((c) => c.tenantId));
    return {
      now: is.now.filter((c) => !wasNow.has(c.tenantId)),
      tell: is.tell.filter((c) => !wasAny.has(c.tenantId)),
    };
  };
  return { archive: fresh(before.archive, after.archive), remove: fresh(before.remove, after.remove) };
}

const FIELDS = ['autoArchiveEnabled', 'autoArchiveAfterDays', 'autoDeleteEnabled', 'autoDeleteAfterDays', 'noticeDays'] as const;

/**
 * The settings in `next` that differ from the stored ones — what a save
 * sends. Empty when there is nothing to save.
 */
export function changedSettings(saved: TenantAutomationSettings, next: TenantAutomationSettings): TenantAutomationSettingsUpdate {
  return Object.fromEntries(FIELDS.filter((f) => saved[f] !== next[f]).map((f) => [f, next[f]])) as TenantAutomationSettingsUpdate;
}

/**
 * Why a tenant that is past its limit is not acted on at the next run, in
 * words to put after its name; null when nothing stands in the way.
 */
export function whyNotYet(busy: string | null): string | null {
  if (busy === null) return null;
  return busy === 'failed'
    ? 'not until its failed storage operation is cleared'
    : `not until its ${busy} operation has ended`;
}

/** "3 tenants" / "1 tenant". */
export function tenantCount(n: number): string {
  return `${n} tenant${n === 1 ? '' : 's'}`;
}

/** Whole days between an instant and now, never negative. */
export function daysSince(iso: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 86_400_000));
}
