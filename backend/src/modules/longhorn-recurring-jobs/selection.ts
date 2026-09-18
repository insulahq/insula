/**
 * Which volumes a Longhorn RecurringJob still covers — and therefore which of
 * its snapshots have become orphans.
 *
 * Longhorn records recurring-job membership as LABELS ON THE VOLUME CR (not in
 * the job, and not in the PVC the volume was provisioned from):
 *
 *   recurring-job-group.longhorn.io/<group>: enabled   → volume is in <group>
 *   recurring-job.longhorn.io/<job>: enabled           → volume is bound to <job>
 *
 * …plus one special case: a volume carrying NEITHER kind of label is implicitly
 * in the group named `default`. That implicit membership is why tenant volumes
 * were silently swept into every job the `default` group held.
 *
 * A snapshot Longhorn took on a schedule carries `spec.labels.RecurringJob:
 * <job>`. When a job's group list changes so it no longer covers that volume,
 * the snapshots it already took stay behind AND stop being pruned — the job's
 * own `retain` only trims volumes it still selects. Nothing else reaps them:
 * they are bare `Snapshot.longhorn.io` objects with no VolumeSnapshot CR and no
 * `tenant_volume_snapshots` row, so neither panel lists them and the
 * tenant-snapshot reaper cannot see them.
 *
 * The orphan test below is deliberately phrased against the LIVE job list
 * rather than against a hard-coded job name. That makes the sweep incapable of
 * fighting the job that creates them: the moment a job covers a volume again,
 * its snapshots there stop being orphans, so there is no create/delete duel.
 */

export const GROUP_LABEL_PREFIX = 'recurring-job-group.longhorn.io/';
export const JOB_LABEL_PREFIX = 'recurring-job.longhorn.io/';
/** Longhorn's implicit group: a volume with no membership labels lands here. */
export const DEFAULT_GROUP = 'default';
const ENABLED = 'enabled';

export interface RecurringJobRef {
  readonly name: string;
  readonly groups: readonly string[];
}

export interface VolumeRef {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface SnapshotRef {
  readonly name: string;
  readonly volume: string;
  /** `spec.labels.RecurringJob` — absent on a snapshot a human/CSI asked for. */
  readonly recurringJob: string | null;
  /**
   * Already asked to go, finalizer not yet released.
   *
   * On an ATTACHED volume a deletion completes in seconds. On a DETACHED one
   * the object sits in Terminating until the volume next attaches and Longhorn
   * can purge it — measured on both, and the reason this field exists: a sweep
   * that counted "delete accepted" as "snapshot gone" would report a converged
   * cluster while the objects were still there.
   */
  readonly terminating: boolean;
}

/** The groups this volume is an explicit member of. */
function explicitGroups(labels: Readonly<Record<string, string>>): string[] {
  return Object.entries(labels)
    .filter(([k, v]) => k.startsWith(GROUP_LABEL_PREFIX) && v === ENABLED)
    .map(([k]) => k.slice(GROUP_LABEL_PREFIX.length));
}

/** The jobs this volume is bound to directly, bypassing groups. */
function explicitJobs(labels: Readonly<Record<string, string>>): string[] {
  return Object.entries(labels)
    .filter(([k, v]) => k.startsWith(JOB_LABEL_PREFIX) && v === ENABLED)
    .map(([k]) => k.slice(JOB_LABEL_PREFIX.length));
}

/**
 * True when `volume` carries no recurring-job membership label of either kind.
 * Longhorn then treats it as a member of `default`.
 *
 * Deliberately keyed on the KEY only, ignoring the value: a volume labelled
 * `…/default: ignored` has been spoken about explicitly, so reading it as
 * "never configured" would be wrong.
 */
function hasNoMembershipLabels(labels: Readonly<Record<string, string>>): boolean {
  return !Object.keys(labels).some(
    (k) => k.startsWith(GROUP_LABEL_PREFIX) || k.startsWith(JOB_LABEL_PREFIX),
  );
}

/** Does `job` still cover `volume`? */
export function jobCoversVolume(job: RecurringJobRef, volume: VolumeRef): boolean {
  const labels = volume.labels ?? {};
  if (explicitJobs(labels).includes(job.name)) return true;
  const groups = explicitGroups(labels);
  if (job.groups.some((g) => groups.includes(g))) return true;
  return job.groups.includes(DEFAULT_GROUP) && hasNoMembershipLabels(labels);
}

export interface SweepPlan {
  /** Snapshots to delete, grouped so one volume's chain is purged together. */
  readonly byVolume: ReadonlyArray<{ readonly volume: string; readonly snapshots: readonly string[] }>;
  /** Orphans found but deferred to a later tick by `maxVolumesPerTick`. */
  readonly deferredVolumes: number;
  /** Snapshots left alone because their volume could not be read. */
  readonly skippedUnknownVolume: number;
  /** Snapshots left alone because their volume is on the protected list. */
  readonly skippedProtected: number;
  /** Deletion already requested, waiting on the volume to attach and purge. */
  readonly pendingPurge: number;
  /** The volumes those pending snapshots belong to. */
  readonly pendingPurgeVolumes: readonly string[];
}

export interface SweepInput {
  readonly snapshots: readonly SnapshotRef[];
  readonly jobs: readonly RecurringJobRef[];
  readonly volumes: readonly VolumeRef[];
  /**
   * Volumes whose snapshots are never touched, whatever their labels say.
   * The platform database's volumes go here: the label that keeps it covered is
   * applied by the same tick, and a tick that failed to apply it must not then
   * read the database's own hourly chain as garbage.
   */
  readonly protectedVolumes: readonly string[];
  /** Volumes purged per tick. Bounds the block-coalescing I/O one tick starts. */
  readonly maxVolumesPerTick: number;
}

/**
 * Plan a sweep: every snapshot whose creating job no longer covers its volume
 * (or whose job is gone entirely), minus the protected set, minus the volumes
 * this tick has no budget for.
 *
 * Purely a plan — no I/O — so the interesting cases are unit-testable without a
 * cluster, and so the caller can log exactly what it is about to delete.
 */
export function planSnapshotSweep(input: SweepInput): SweepPlan {
  const jobByName = new Map(input.jobs.map((j) => [j.name, j]));
  const volumeByName = new Map(input.volumes.map((v) => [v.name, v]));
  const protectedSet = new Set(input.protectedVolumes);

  const orphansByVolume = new Map<string, string[]>();
  const pendingVolumes = new Set<string>();
  let skippedUnknownVolume = 0;
  let skippedProtected = 0;
  let pendingPurge = 0;

  for (const snap of input.snapshots) {
    if (!snap.recurringJob) continue; // human/CSI snapshot — not ours to judge
    if (protectedSet.has(snap.volume)) {
      skippedProtected += 1;
      continue;
    }
    if (snap.terminating) {
      // Re-issuing the delete would change nothing. Counted so the caller can
      // say "waiting on a detached volume" instead of "nothing left to do".
      pendingPurge += 1;
      pendingVolumes.add(snap.volume);
      continue;
    }
    const volume = volumeByName.get(snap.volume);
    if (!volume) {
      // Cannot prove orphan-hood without the volume's labels. Leave it.
      skippedUnknownVolume += 1;
      continue;
    }
    const job = jobByName.get(snap.recurringJob);
    if (job && jobCoversVolume(job, volume)) continue; // still covered, still pruned
    const list = orphansByVolume.get(snap.volume) ?? [];
    list.push(snap.name);
    orphansByVolume.set(snap.volume, list);
  }

  // Sorted so a capped tick walks the same volumes in the same order on every
  // replica, instead of three replicas each picking a different three.
  const volumes = [...orphansByVolume.keys()].sort();
  const budgeted = volumes.slice(0, Math.max(0, input.maxVolumesPerTick));

  return {
    byVolume: budgeted.map((volume) => ({
      volume,
      snapshots: [...(orphansByVolume.get(volume) ?? [])].sort(),
    })),
    deferredVolumes: volumes.length - budgeted.length,
    skippedUnknownVolume,
    skippedProtected,
    pendingPurge,
    pendingPurgeVolumes: [...pendingVolumes].sort(),
  };
}

/**
 * Volumes that should be in `group` but are not yet labelled for it.
 *
 * Longhorn copies a PVC's membership labels onto the Volume CR when the volume
 * is PROVISIONED and never again — verified against Longhorn v1.12.0 by
 * labelling a live PVC and watching the Volume CR stay unchanged for minutes.
 * So a group change that arrives via the PVC (CNPG `inheritedMetadata`, in this
 * case) reaches new volumes only; existing ones need the label written to the
 * Volume CR directly, which is what the Longhorn UI does when you assign a job
 * to a volume that already exists.
 */
export function planGroupLabelling(
  volumes: readonly VolumeRef[],
  shouldBeMembers: readonly string[],
  group: string,
): string[] {
  const key = `${GROUP_LABEL_PREFIX}${group}`;
  const wanted = new Set(shouldBeMembers);
  return volumes
    .filter((v) => wanted.has(v.name) && (v.labels ?? {})[key] !== ENABLED)
    .map((v) => v.name)
    .sort();
}
