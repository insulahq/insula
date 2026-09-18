/**
 * Committing a Stalwart settings group so the write actually lands.
 *
 * Stalwart's `x:<Type>/set` answers `{updated: {singleton: null}}` with an
 * empty `notUpdated` whether it stored the patch or silently discarded it, and
 * two rules decide which happened. Both were measured on a FRESH, bootstrapped
 * Stalwart v0.16.20 (2026-09-18, throwaway cluster, this client's exact call
 * shape), against `x:DmarcReportSettings` and re-confirmed on `x:ReportSettings`:
 *
 *     complete patch x4, identical   -> accepted every time, NEVER stored
 *     1-field primer, then complete  -> primer stores nothing, COMPLETE LANDS
 *     warm group, single complete    -> lands immediately, both directions
 *
 *  1. The first `/set` against a never-written singleton PRIMES it and stores
 *     nothing. The next one persists — and it must state EVERY field, since a
 *     partial commit leaves the group unwritten.
 *  2. Stalwart DEDUPES an identical repeat, so re-sending the same patch is not
 *     "the next write".
 *
 * Together those are why a 5-minute reconciler can rewrite the same patch for
 * weeks and never converge while logging success: every tick is deduped, the
 * group stays cold, and Stalwart's built-in defaults stay live. That is exactly
 * what outbound DMARC reporting did on production — 47 aggregate reports a day
 * under a log line that said DISABLED.
 *
 * The singleton cannot be created or destroyed ("Singletons cannot be created
 * or destroyed"), so an environment whose group already exists — DEV, staging —
 * CANNOT reproduce any of this. Reproducing it needs a cluster bootstrapped
 * from empty. Two previous fixes were validated warm and shipped broken.
 *
 * So: prime when cold, always commit the COMPLETE group, then READ IT BACK.
 * An accepted `/set` is not evidence.
 */

/**
 * Minimal shape of a JMAP `/set` response this helper needs.
 *
 * `notUpdated` is nullable, not just optional: the wire format sends an
 * explicit `null` when nothing was refused, and `JmapSetResponse` models that.
 */
export interface SettingsSetResponse {
  readonly notUpdated?: Record<string, unknown> | null;
}

export type SettingsCommitState = 'committed' | 'rejected' | 'not-stored';

export interface SettingsCommitResult<T> {
  readonly state: SettingsCommitState;
  /** The group as it read back after the commit — null when still unwritten. */
  readonly after: T | null;
  /** Whether the group was unwritten before this commit (the primed path). */
  readonly wasCold: boolean;
  readonly reason?: string;
}

export interface SettingsCommitParams<T> {
  /** Read the singleton. `null` means the group has never been written. */
  read: () => Promise<T | null>;
  /** Send one `/set` update for the singleton. */
  write: (patch: Record<string, unknown>) => Promise<SettingsSetResponse>;
  /** The COMPLETE group — every field, or the commit does not persist. */
  patch: Record<string, unknown>;
  /**
   * Sent alone first when the group is cold, to absorb the priming write. It
   * MUST differ in shape from `patch` or Stalwart dedupes the two and the
   * commit never happens — pick one field rather than a subset that could
   * coincide.
   */
  primer: Record<string, unknown>;
  /** Did the values we care about actually land? Receives the read-back row. */
  verify: (row: T) => boolean;
  /** Already-read current value, when the caller has one (saves a round trip). */
  current?: T | null;
}

/**
 * Prime (when cold) → commit the complete group → read back and verify.
 *
 * Never throws for a Stalwart-side refusal; the caller decides how loud to be.
 * Transport errors DO propagate, because "could not reach Stalwart" is not the
 * same as "Stalwart discarded the write" and must not be reported as one.
 */
export async function commitSettingsGroup<T>(
  params: SettingsCommitParams<T>,
): Promise<SettingsCommitResult<T>> {
  const { read, write, patch, primer, verify } = params;

  const before = params.current !== undefined ? params.current : await read();
  const wasCold = before === null || before === undefined;

  if (wasCold) {
    // Absorbs the priming write. Its result is deliberately ignored: it is
    // EXPECTED to store nothing, and Stalwart reports that as success.
    await write(primer);
  }

  const res = await write(patch);
  if (res.notUpdated && Object.keys(res.notUpdated).length > 0) {
    return {
      state: 'rejected',
      after: null,
      wasCold,
      reason: `stalwart rejected the update: ${JSON.stringify(res.notUpdated)}`,
    };
  }

  const after = await read();
  if (after === null || after === undefined || !verify(after)) {
    return {
      state: 'not-stored',
      after: after ?? null,
      wasCold,
      reason: after
        ? 'stalwart accepted the update but the values did not land'
        : 'stalwart accepted the update and the group is still unwritten — its built-in defaults are LIVE',
    };
  }

  return { state: 'committed', after, wasCold };
}
