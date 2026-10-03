/**
 * Move a tenant's data to the node it is pinned to.
 *
 * "Move back" (migrate-to-worker) re-pins a tenant and restarts its
 * Deployments. For a running tenant that is enough: the restarted pod attaches
 * the volume on the new node, and Longhorn's best-effort data locality builds a
 * replica there and drops the remote one. A tenant with NOTHING running — its
 * file manager idle at 0, no app — attaches nothing. The re-pin moves no data,
 * the placement stays "misplaced", and every further click does the same
 * nothing (seen on production: three stopped tenants, data on the second
 * server, Move back pressed several times).
 *
 * So for a DETACHED volume with no copy on the target, the platform attaches it
 * there itself — a Longhorn attachment ticket, as the fsck does — and data
 * locality has its attached volume. The file manager cannot do this job: a file
 * manager starting from 0 is placed where the data already is.
 *
 * The placement reconciler drops the ticket once the copy is local, or after
 * RELOCATE_MAX_MS. The ticket and its start time live on the Longhorn
 * VolumeAttachment, not in this process, so a platform-api restart mid-copy
 * never leaves a volume attached for good, and any replica finishes what
 * another started.
 *
 * A held ticket keeps the volume attached, and every storage operation that
 * needs it DETACHED (resize, archive, restore, fsck) and the tenant delete
 * would wait on it. Those call `releaseRelocationsInNamespace` first: the
 * operator's storage operation wins, and the copy simply stops where it is.
 */
import type { DataRelocationSkipReason, MigrateToWorkerResult } from '@insula/api-contracts';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import type { ReplicaFact } from '../tenant-health/service.js';

export const RELOCATE_TICKET = 'insula-relocate';
export const RELOCATE_STARTED_ANNOTATION = 'insula.host/relocate-started-at';
/** A copy that has not finished by then is released anyway; the data stays where it is. */
export const RELOCATE_MAX_MS = 4 * 60 * 60_000;

const LH = { group: 'longhorn.io', version: 'v1beta2', namespace: 'longhorn-system' } as const;

type Plan = MigrateToWorkerResult['dataRelocation'];

/** What relocation needs to know about one of the tenant's volumes. */
export interface RelocationVolume {
  readonly volumeName: string;
  readonly namespace: string | null;
  /** Leftover volume: no live PVC references it any more. */
  readonly pvcRefLostAt: string | null;
  /** Attached (or attaching/detaching) somewhere — by anyone. */
  readonly inUse: boolean;
  /** Longhorn `spec.numberOfReplicas`. */
  readonly replicaCount: number;
  /** The node our own relocation ticket points at, if one is held. */
  readonly relocatingTo: string | null;
  /** Any attachment ticket other than ours (a workload's CSI attach, the fsck). */
  readonly otherTickets: boolean;
}

/**
 * Which of a tenant's volumes to attach on `target`. Pure.
 * Only live volumes (still referenced by a PVC) in the tenant's namespace.
 * A volume held ONLY by our own earlier relocation (to another node) is
 * re-targeted, not skipped as in use — or a second "Move back" to a different
 * node would leave the data following the first one.
 */
export function planRelocation(
  volumes: readonly RelocationVolume[],
  replicas: readonly ReplicaFact[],
  namespace: string,
  target: string,
  storageTier: string | null,
): { attach: string[]; skipped: Array<{ volumeName: string; reason: DataRelocationSkipReason }> } {
  const attach: string[] = [];
  const skipped: Array<{ volumeName: string; reason: DataRelocationSkipReason }> = [];
  for (const v of volumes) {
    if (v.namespace !== namespace || v.pvcRefLostAt) continue;
    // Replicated across nodes by design (HA tier, or a local-tier volume that
    // really carries more than one replica): there is no single copy to move,
    // and "done" — one copy, on the target — could never be reached.
    if (storageTier === 'ha' || v.replicaCount > 1) { skipped.push({ volumeName: v.volumeName, reason: 'ha-tier' }); continue; }
    const copies = replicas.filter((r) => r.volumeName === v.volumeName && !r.failed);
    if (copies.some((r) => r.nodeId === target) && v.relocatingTo === null) {
      skipped.push({ volumeName: v.volumeName, reason: 'already-local' });
      continue;
    }
    const ownTicketOnly = v.relocatingTo !== null && !v.otherTickets;
    if (v.inUse && !ownTicketOnly) { skipped.push({ volumeName: v.volumeName, reason: 'in-use' }); continue; }
    attach.push(v.volumeName);
  }
  return { attach, skipped };
}

export type RelocationVerdict = 'done' | 'waiting' | 'timed-out';

/**
 * Whether a relocation ticket can go. Pure.
 * Done = a RUNNING copy on the target and no other copy left: data locality has
 * rebuilt locally and dropped the remote replica. A replica that merely exists
 * on the target is still being rebuilt into, not a copy.
 */
export function relocationVerdict(
  replicas: readonly ReplicaFact[],
  volumeName: string,
  target: string,
  startedAt: Date | null,
  now: Date,
): RelocationVerdict {
  const copies = replicas.filter((r) => r.volumeName === volumeName && !r.failed);
  const local = copies.some((r) => r.nodeId === target && r.running);
  const remote = copies.some((r) => r.nodeId !== target);
  if (local && !remote) return 'done';
  // No start time (written by hand, or the annotation patch was lost) counts
  // as expired: an attachment nobody can date must not live forever.
  if (!startedAt || now.getTime() - startedAt.getTime() > RELOCATE_MAX_MS) return 'timed-out';
  return 'waiting';
}

interface LhList<T> { readonly items?: readonly T[] }
interface LhVolumeRaw {
  readonly metadata?: { readonly name?: string };
  readonly spec?: { readonly numberOfReplicas?: number };
  readonly status?: {
    readonly state?: string;
    readonly currentNodeID?: string;
    readonly kubernetesStatus?: { readonly namespace?: string; readonly lastPVCRefAt?: string };
  };
}
interface LhReplicaRaw {
  readonly spec?: { readonly volumeName?: string; readonly nodeID?: string; readonly failedAt?: string };
  readonly status?: { readonly currentState?: string };
}
interface LhAttachmentRaw {
  readonly metadata?: { readonly name?: string; readonly annotations?: Record<string, string> };
  readonly spec?: { readonly attachmentTickets?: Record<string, { readonly nodeID?: string } | null> };
}

function lhList<T>(k8s: K8sClients, plural: string): Promise<LhList<T>> {
  return k8s.custom.listNamespacedCustomObject(
    { ...LH, plural } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0],
  ) as Promise<LhList<T>>;
}

function lhMergePatch(k8s: K8sClients, plural: string, name: string, body: unknown): Promise<unknown> {
  return (k8s.custom as unknown as {
    patchNamespacedCustomObject: (
      a: { group: string; version: string; namespace: string; plural: string; name: string; body: unknown },
      mw: typeof MERGE_PATCH,
    ) => Promise<unknown>;
  }).patchNamespacedCustomObject({ ...LH, plural, name, body }, MERGE_PATCH);
}

/** Drop our ticket (and its start time) from one volume. Idempotent. */
function releaseTicket(k8s: K8sClients, volumeName: string): Promise<unknown> {
  return lhMergePatch(k8s, 'volumeattachments', volumeName, {
    metadata: { annotations: { [RELOCATE_STARTED_ANNOTATION]: null } },
    spec: { attachmentTickets: { [RELOCATE_TICKET]: null } },
  });
}

/** The namespace's live volumes, their replicas and attachment tickets, read fresh. */
async function readVolumes(k8s: K8sClients, namespace: string): Promise<{ volumes: RelocationVolume[]; replicas: ReplicaFact[] }> {
  const [vols, reps, vas] = await Promise.all([
    lhList<LhVolumeRaw>(k8s, 'volumes'),
    lhList<LhReplicaRaw>(k8s, 'replicas'),
    lhList<LhAttachmentRaw>(k8s, 'volumeattachments'),
  ]);
  const tickets = new Map((vas.items ?? []).map((va) => [va.metadata?.name ?? '', va.spec?.attachmentTickets ?? {}]));
  const volumes: RelocationVolume[] = (vols.items ?? [])
    .filter((v) => v.status?.kubernetesStatus?.namespace === namespace && v.metadata?.name)
    .map((v): RelocationVolume => {
      const name = v.metadata!.name!;
      const t = tickets.get(name) ?? {};
      const live = Object.entries(t).filter(([, ticket]) => ticket);
      return {
        volumeName: name,
        namespace,
        pvcRefLostAt: v.status?.kubernetesStatus?.lastPVCRefAt || null,
        // A transitional state (attaching/detaching) is not free to take either.
        inUse: Boolean(v.status?.currentNodeID) || (v.status?.state !== undefined && v.status.state !== 'detached'),
        replicaCount: v.spec?.numberOfReplicas ?? 1,
        relocatingTo: t[RELOCATE_TICKET]?.nodeID ?? null,
        otherTickets: live.some(([key]) => key !== RELOCATE_TICKET),
      };
    });
  const names = new Set(volumes.map((v) => v.volumeName));
  const replicas: ReplicaFact[] = (reps.items ?? [])
    .filter((r) => r.spec?.volumeName && names.has(r.spec.volumeName))
    .map((r) => ({
      volumeName: r.spec!.volumeName!,
      nodeId: r.spec?.nodeID || null,
      running: r.status?.currentState === 'running',
      failed: Boolean(r.spec?.failedAt) || r.status?.currentState === 'error',
    }));
  return { volumes, replicas };
}

/**
 * Attach the tenant's detached volumes on `target` so their data moves there.
 * Never throws: the re-pin has already happened, and a failure here is reported
 * in the result for the operator rather than undoing it. One volume failing
 * does not stop the others.
 */
export async function startDataRelocation(
  k8s: K8sClients,
  namespace: string,
  target: string,
  storageTier: string | null,
  now: Date = new Date(),
): Promise<Plan> {
  let plan: ReturnType<typeof planRelocation>;
  try {
    const { volumes, replicas } = await readVolumes(k8s, namespace);
    plan = planRelocation(volumes, replicas, namespace, target, storageTier);
  } catch (err) {
    return { started: [], skipped: [], error: err instanceof Error ? err.message : String(err) };
  }
  const started: string[] = [];
  const errors: string[] = [];
  for (const volumeName of plan.attach) {
    try {
      // Writing the ticket under the same key replaces an earlier relocation's
      // node: the data now follows the newest pin.
      await lhMergePatch(k8s, 'volumeattachments', volumeName, {
        metadata: { annotations: { [RELOCATE_STARTED_ANNOTATION]: now.toISOString() } },
        spec: {
          attachmentTickets: {
            [RELOCATE_TICKET]: {
              id: RELOCATE_TICKET,
              type: 'longhorn-api',
              nodeID: target,
              parameters: { disableFrontend: 'false', lastAttachedBy: '' },
            },
          },
        },
      });
      started.push(volumeName);
    } catch (err) {
      errors.push(`${volumeName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { started, skipped: plan.skipped, error: errors.length > 0 ? errors.join('; ') : null };
}

/**
 * Release every relocation ticket whose copy has finished or run out of time.
 * Judged from the reconciler's replica facts; returns what it released.
 */
export async function finishDataRelocations(
  k8s: K8sClients,
  replicas: readonly ReplicaFact[],
  now: Date,
): Promise<Array<{ volumeName: string; node: string; verdict: Exclude<RelocationVerdict, 'waiting'> }>> {
  const list = await lhList<LhAttachmentRaw>(k8s, 'volumeattachments');
  const released: Array<{ volumeName: string; node: string; verdict: Exclude<RelocationVerdict, 'waiting'> }> = [];
  for (const va of list.items ?? []) {
    const volumeName = va.metadata?.name;
    const ticket = va.spec?.attachmentTickets?.[RELOCATE_TICKET];
    if (!volumeName || !ticket?.nodeID) continue;
    const startedRaw = va.metadata?.annotations?.[RELOCATE_STARTED_ANNOTATION];
    const startedAt = startedRaw && !Number.isNaN(Date.parse(startedRaw)) ? new Date(startedRaw) : null;
    const verdict = relocationVerdict(replicas, volumeName, ticket.nodeID, startedAt, now);
    if (verdict === 'waiting') continue;
    await releaseTicket(k8s, volumeName);
    released.push({ volumeName, node: ticket.nodeID, verdict });
  }
  return released;
}

/**
 * Drop every relocation ticket on the namespace's volumes — before a storage
 * operation that needs them detached, and before the tenant's namespace is
 * deleted. The copy stops where it is; the operator's operation wins.
 * Never throws: a ticket that could not be read or released leaves that
 * operation to fail on its own detach wait, which it reports.
 */
export async function releaseRelocationsInNamespace(k8s: K8sClients, namespace: string): Promise<string[]> {
  try {
    const [vols, vas] = await Promise.all([
      lhList<LhVolumeRaw>(k8s, 'volumes'),
      lhList<LhAttachmentRaw>(k8s, 'volumeattachments'),
    ]);
    const mine = new Set((vols.items ?? [])
      .filter((v) => v.status?.kubernetesStatus?.namespace === namespace)
      .map((v) => v.metadata?.name)
      .filter((n): n is string => Boolean(n)));
    const released: string[] = [];
    for (const va of vas.items ?? []) {
      const name = va.metadata?.name;
      if (!name || !mine.has(name) || !va.spec?.attachmentTickets?.[RELOCATE_TICKET]) continue;
      await releaseTicket(k8s, name);
      released.push(name);
    }
    return released;
  } catch (err) {
    console.warn(`[tenant-placement] could not release data relocations in ${namespace}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
