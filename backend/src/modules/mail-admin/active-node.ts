/**
 * Which node is the active mail node — ONE answer for every caller.
 *
 * `system_settings.mail_active_node` is written only by a mail migration and by
 * the placement page's lazy self-heal (getMailPlacement). A cluster that was
 * installed on several nodes and never opened that page has it NULL, and every
 * caller used to fill the gap differently: the placement page read the live
 * Stalwart pod, the port-exposure switch the mail PVC, the switch's VALIDATION
 * nothing at all — so `assignedMailNodes` was refused ("no active mail node is
 * set") through the API while Stalwart was plainly running on an assigned node.
 *
 * Order, first hit wins, each candidate only if it is a node of this cluster:
 *   1. pod      — the node a Running, not-terminating Stalwart pod is on. The
 *                 live truth; it is what serves mail on hostPort 25.
 *   2. settings — the stored column (Stalwart not running right now).
 *   3. pvc      — the node the mail PVC is bound to (local-path RWO, so the only
 *                 node Stalwart CAN run on) — a fresh install before the pod
 *                 ever came up.
 *
 * `persist: true` writes a pod-derived answer back to the column when it
 * differs (debounced per process), so later readers that only look at the DB —
 * the DR watcher, migration source checks — see the same node. Only the pod is
 * persisted, and only when it is safe to treat it as settled:
 *   - the pod is READY, not merely Running — a migration's target pod is
 *     Running (and binds hostPort 25) long before it is Ready, and the
 *     migration may still time out and roll back to the source node;
 *   - no mail migration is in flight (a non-terminal mail_migration_runs row,
 *     operator- or DR-triggered). A migration records the new active node
 *     itself, on success only; recording it earlier would leave the DR watcher
 *     watching the wrong node after a rollback.
 * The ANSWER is still the Running pod's node either way: that is where
 * hostPort 25 is bound, which is what haproxy placement must avoid.
 */
import { eq, sql } from 'drizzle-orm';
import type { CoreV1Api } from '@kubernetes/client-node';
import type { Database } from '../../db/index.js';
import { systemSettings } from '../../db/schema.js';
import { isNotFound } from '../../shared/k8s-errors.js';

const SETTINGS_ID = 'system';
const MAIL_NAMESPACE = 'mail';
const STALWART_POD_SELECTOR = 'app=stalwart-mail';
export const MAIL_PVC_NAME = 'mail-stack-data';

export type ActiveMailNodeSource = 'pod' | 'settings' | 'pvc';

export interface ActiveMailNode {
  readonly node: string | null;
  readonly source: ActiveMailNodeSource | null;
}

export type ActiveNodeCore = Pick<CoreV1Api,
  'listNamespacedPod' | 'readNamespacedPersistentVolumeClaim' | 'readPersistentVolume'>;

export interface ResolveActiveMailNodeOptions {
  /** Node names of this cluster; a candidate outside it is skipped. Omitted → not filtered. */
  readonly knownNodes?: ReadonlySet<string>;
  /** Write a pod-derived node back to system_settings when it differs. */
  readonly persist?: boolean;
  readonly logger?: { warn: (msg: string) => void };
}

/** Terminal mail_migration_runs states (same set the migration orphan reaper uses). */
const MIGRATION_TERMINAL_STATES = sql`('done', 'failed', 'rolled-back', 'cancelled')`;

/**
 * The id of a mail migration that is still in flight (operator migration or the
 * DR watcher's automatic failover — the latter writes only this row, no task),
 * or null.
 */
export async function mailMigrationInFlight(db: Database): Promise<string | null> {
  const res = await db.execute<{ id: string }>(sql`
    SELECT id FROM mail_migration_runs
     WHERE state NOT IN ${MIGRATION_TERMINAL_STATES}
     LIMIT 1
  `);
  return ((res as unknown as { rows?: Array<{ id: string }> }).rows ?? [])[0]?.id ?? null;
}

export interface LiveStalwartPod {
  readonly node: string;
  /** The pod's Ready condition — Running alone is not settled (see header). */
  readonly ready: boolean;
}

/** The node a Running, not-terminating Stalwart pod is scheduled on, or null. */
export async function readLiveStalwartNode(
  core: Pick<CoreV1Api, 'listNamespacedPod'>,
): Promise<string | null> {
  return (await readLiveStalwartPod(core))?.node ?? null;
}

export async function readLiveStalwartPod(
  core: Pick<CoreV1Api, 'listNamespacedPod'>,
): Promise<LiveStalwartPod | null> {
  const pods = (await core.listNamespacedPod({
    namespace: MAIL_NAMESPACE,
    labelSelector: STALWART_POD_SELECTOR,
  } as Parameters<CoreV1Api['listNamespacedPod']>[0])) as {
    items?: ReadonlyArray<{
      metadata?: { deletionTimestamp?: unknown };
      spec?: { nodeName?: string };
      status?: { phase?: string; conditions?: ReadonlyArray<{ type?: string; status?: string }> };
    }>;
  };
  const running = (pods.items ?? []).filter(
    (p) => p.status?.phase === 'Running' && !p.metadata?.deletionTimestamp && p.spec?.nodeName,
  );
  const isReady = (p: (typeof running)[number]): boolean =>
    (p.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
  const pick = running.find(isReady) ?? running[0];
  return pick?.spec?.nodeName ? { node: pick.spec.nodeName, ready: isReady(pick) } : null;
}

/**
 * The node the mail PVC is bound to: the provisioner's selected-node annotation,
 * else the bound PV's kubernetes.io/hostname affinity. Null when unbound or
 * unreadable — callers fall through, never guess.
 */
export async function deriveActiveNodeFromMailPvc(
  core: Pick<CoreV1Api, 'readNamespacedPersistentVolumeClaim' | 'readPersistentVolume'>,
): Promise<string | null> {
  try {
    const pvc = await core.readNamespacedPersistentVolumeClaim({
      name: MAIL_PVC_NAME,
      namespace: MAIL_NAMESPACE,
    }) as { metadata?: { annotations?: Record<string, string> }; spec?: { volumeName?: string } };
    const selectedNode = pvc.metadata?.annotations?.['volume.kubernetes.io/selected-node'];
    if (selectedNode) return selectedNode;
    const pvName = pvc.spec?.volumeName;
    if (!pvName) return null;
    const pv = await core.readPersistentVolume({ name: pvName }) as {
      spec?: { nodeAffinity?: { required?: { nodeSelectorTerms?: ReadonlyArray<{
        matchExpressions?: ReadonlyArray<{ key?: string; values?: string[] }>;
      }> } } };
    };
    for (const term of pv.spec?.nodeAffinity?.required?.nodeSelectorTerms ?? []) {
      for (const expr of term.matchExpressions ?? []) {
        if (expr.key === 'kubernetes.io/hostname' && expr.values && expr.values.length > 0) {
          return expr.values[0];
        }
      }
    }
    return null;
  } catch (err) {
    if (isNotFound(err)) return null;
    return null;
  }
}

const PERSIST_DEBOUNCE_MS = 10_000;
let lastPersisted: { node: string; at: number } | null = null;

/** Test-only reset of the persist debounce. */
export function __resetActiveNodePersistForTest(): void {
  lastPersisted = null;
}

export async function resolveActiveMailNode(
  db: Database,
  core: ActiveNodeCore,
  opts: ResolveActiveMailNodeOptions = {},
): Promise<ActiveMailNode> {
  const usable = (n: string | null): n is string => !!n && (!opts.knownNodes || opts.knownNodes.has(n));

  const [row] = await db.select({ activeNode: systemSettings.mailActiveNode })
    .from(systemSettings)
    .where(eq(systemSettings.id, SETTINGS_ID));
  const stored = (row?.activeNode ?? null) as string | null;

  let livePod: LiveStalwartPod | null = null;
  try {
    livePod = await readLiveStalwartPod(core);
  } catch (err) {
    opts.logger?.warn(`active mail node: live Stalwart pod lookup failed (${(err as Error).message}) — using the stored value`);
  }

  const live = livePod?.node ?? null;
  if (usable(live)) {
    if (opts.persist && live !== stored && livePod?.ready && !(await migrationInFlightSafe(db, opts))) {
      await persist(db, live);
    }
    return { node: live, source: 'pod' };
  }
  if (usable(stored)) return { node: stored, source: 'settings' };
  const fromPvc = await deriveActiveNodeFromMailPvc(core);
  if (usable(fromPvc)) return { node: fromPvc, source: 'pvc' };
  return { node: null, source: null };
}

/** In-flight check for the persist gate; an unreadable table counts as in flight (do not write). */
async function migrationInFlightSafe(db: Database, opts: ResolveActiveMailNodeOptions): Promise<boolean> {
  try {
    return (await mailMigrationInFlight(db)) !== null;
  } catch (err) {
    opts.logger?.warn(`active mail node: migration check failed (${(err as Error).message}) — not recording`);
    return true;
  }
}

async function persist(db: Database, node: string): Promise<void> {
  const now = Date.now();
  if (lastPersisted && lastPersisted.node === node && now - lastPersisted.at < PERSIST_DEBOUNCE_MS) return;
  lastPersisted = { node, at: now };
  await db.update(systemSettings)
    .set({ mailActiveNode: node })
    .where(eq(systemSettings.id, SETTINGS_ID))
    .catch(() => { /* best-effort: the answer is still returned */ });
}
