import {
  tenantAutomationDueAt,
  type TenantAutomationCandidate,
  type TenantAutomationSettings,
  type TenantAutomationSettingsUpdate,
  type TenantAutomationStatus,
} from '@insula/api-contracts';

export interface DatedCandidate extends TenantAutomationCandidate {
  /** When the tenant comes due under the limit asked about, epoch ms. */
  readonly dueAt: number;
}

export interface DueSplit {
  /** Past the limit: acted on at the next run. Oldest first. */
  readonly dueNow: readonly DatedCandidate[];
  /** Not past it yet. Soonest first. */
  readonly later: readonly DatedCandidate[];
  /** No date recorded: the sweep never touches these. */
  readonly undated: readonly TenantAutomationCandidate[];
}

/**
 * Sort the tenants in line by when a limit of `afterDays` makes them due. The
 * same arithmetic the sweep uses (`tenantAutomationDueAt`), so the card says
 * what the next run will do — for the saved limit and for one being typed.
 */
export function splitByDue(
  candidates: readonly TenantAutomationCandidate[],
  afterDays: number,
  nowMs: number,
): DueSplit {
  const dated: DatedCandidate[] = [];
  const undated: TenantAutomationCandidate[] = [];
  for (const c of candidates) {
    if (c.since === null) undated.push(c);
    else dated.push({ ...c, dueAt: tenantAutomationDueAt(c.since, afterDays) });
  }
  dated.sort((a, b) => a.dueAt - b.dueAt);
  return {
    dueNow: dated.filter((c) => c.dueAt < nowMs),
    later: dated.filter((c) => c.dueAt >= nowMs),
    undated,
  };
}

export interface NewlyDue {
  readonly archive: readonly DatedCandidate[];
  readonly remove: readonly DatedCandidate[];
}

/**
 * The tenants a change of settings puts in front of the next run: due under
 * the settings about to be saved, and not due under the saved ones. Switching
 * a step on, or shortening its limit, can reach tenants suspended or archived
 * long ago — the save asks before it does.
 */
export function newlyDue(
  status: Pick<TenantAutomationStatus, 'settings' | 'suspended' | 'archived'>,
  draft: TenantAutomationSettings,
  nowMs: number,
): NewlyDue {
  const step = (
    candidates: readonly TenantAutomationCandidate[],
    wasOn: boolean,
    wasDays: number,
    isOn: boolean,
    isDays: number,
  ): readonly DatedCandidate[] => {
    if (!isOn) return [];
    const before = new Set(wasOn ? splitByDue(candidates, wasDays, nowMs).dueNow.map((c) => c.tenantId) : []);
    return splitByDue(candidates, isDays, nowMs).dueNow.filter((c) => !before.has(c.tenantId));
  };
  const saved = status.settings;
  return {
    archive: step(status.suspended, saved.autoArchiveEnabled, saved.autoArchiveAfterDays, draft.autoArchiveEnabled, draft.autoArchiveAfterDays),
    remove: step(status.archived, saved.autoDeleteEnabled, saved.autoDeleteAfterDays, draft.autoDeleteEnabled, draft.autoDeleteAfterDays),
  };
}

const FIELDS = ['autoArchiveEnabled', 'autoArchiveAfterDays', 'autoDeleteEnabled', 'autoDeleteAfterDays'] as const;

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
