/**
 * Keep the mail-haproxy node labels in step with the node set BETWEEN mode
 * switches.
 *
 * The `insula.host/mail-haproxy` label decides where the stalwart-haproxy
 * DaemonSet runs. It used to be written only by a port-exposure mode switch,
 * by Recover Mail and once at platform-api startup — so a server that joined
 * later in `allServerNodes` mode (or a node promoted/demoted in the Edit Node
 * modal) got no haproxy until the operator re-applied the mode, and the mail
 * reachability check, which expects listeners where the same resolver says,
 * reported that node failing.
 *
 * This pass computes the label set with that same resolver
 * (`resolveHaproxyNodes`) and patches only the difference. It never touches
 * the DaemonSet, the Stalwart Deployment or the Service — switching modes stays
 * with `applyModeToCluster`. Run from the 60s node sync on every replica: it is
 * a pure function of the Node list and the DB, so replicas converge on the same
 * labels and a second patch of the same label is a no-op.
 *
 * It stands down, and says why, when:
 *   - the mode is `activeNodeOnly` — there is no haproxy; the switch into that
 *     mode already cleared the labels;
 *   - a port-exposure switch is running (task row, any replica) or applying in
 *     this process, or a mail migration is in flight (a `mail_migration_runs`
 *     row in a non-terminal state — the DR watcher's automatic failover writes
 *     only that row, no task). Both move labels in a deliberate order: a
 *     migration strips the TARGET node's label so Stalwart can bind hostPort 25
 *     there and records the new active node only afterwards — re-adding it
 *     would put haproxy back under the moving Stalwart pod;
 *   - the active mail node is unknown on a multi-node cluster — the resolver
 *     could not exclude Stalwart's node and would label haproxy onto it;
 *   - placement no longer satisfies the mode (the same check a switch runs).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { CoreV1Api } from '@kubernetes/client-node';
import type { MailPortExposureMode } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import { systemSettings, tasks } from '../../db/schema.js';
import {
  MAIL_HAPROXY_LABEL_KEY,
  reconcileMailHaproxyLabels,
  resolveHaproxyNodes,
  validateModeSwitch,
  type NodeRef,
  type PlacementSettings,
} from './port-exposure-modes.js';
import { portExposureApplyInFlight } from './port-exposure.js';
import { resolveActiveMailNode } from './active-node.js';

/** Task kinds whose own orchestration owns the labels while they run. */
export const LABEL_OWNING_TASK_KINDS = ['mail.port-exposure', 'mail.migration'] as const;

/** Same terminal set the migration orphan reaper uses (migration.ts). */
const MIGRATION_TERMINAL_STATES = sql`('done', 'failed', 'rolled-back', 'cancelled')`;

/** How often an unchanged "not syncing" line is repeated, so a stuck sync stays visible. */
export const HAPROXY_LABEL_SYNC_RELOG_MS = 30 * 60_000;

export type HaproxyLabelSync =
  | { readonly outcome: 'in-sync' }
  | { readonly outcome: 'changed'; readonly added: readonly string[]; readonly removed: readonly string[] }
  | { readonly outcome: 'skipped'; readonly reason: string };

type LabelSyncCore = Pick<CoreV1Api,
  'patchNode' | 'listNamespacedPod' | 'readNamespacedPersistentVolumeClaim' | 'readPersistentVolume'>;

/** Which nodes gain and which lose the label to reach `desired`. Pure. */
export function planHaproxyLabelChanges(
  desired: readonly string[],
  nodes: readonly NodeRef[],
): { readonly added: string[]; readonly removed: string[] } {
  const want = new Set(desired);
  const added: string[] = [];
  const removed: string[] = [];
  for (const node of nodes) {
    const has = node.metadata.labels[MAIL_HAPROXY_LABEL_KEY] === 'true';
    if (want.has(node.metadata.name) && !has) added.push(node.metadata.name);
    if (!want.has(node.metadata.name) && has) removed.push(node.metadata.name);
  }
  return { added: added.sort(), removed: removed.sort() };
}

/** Pre-0034 rows can still say 'thisNodeOnly'; NULL is the column default. */
function normaliseMode(stored: string | null | undefined): MailPortExposureMode {
  if (!stored || stored === 'thisNodeOnly') return 'activeNodeOnly';
  return stored as MailPortExposureMode;
}

async function readModeAndPlacement(
  db: Database,
): Promise<{ mode: MailPortExposureMode; settings: PlacementSettings }> {
  const [row] = await db.select({
    mode: systemSettings.mailPortExposureMode,
    primaryNode: systemSettings.mailPrimaryNode,
    secondaryNode: systemSettings.mailSecondaryNode,
    tertiaryNode: systemSettings.mailTertiaryNode,
    activeNode: systemSettings.mailActiveNode,
  })
    .from(systemSettings)
    .where(eq(systemSettings.id, 'system'));
  return {
    mode: normaliseMode(row?.mode),
    settings: {
      primaryNode: row?.primaryNode ?? null,
      secondaryNode: row?.secondaryNode ?? null,
      tertiaryNode: row?.tertiaryNode ?? null,
      activeNode: row?.activeNode ?? null,
    },
  };
}

const skipped = (reason: string): HaproxyLabelSync => ({ outcome: 'skipped', reason });

/** One pass. Throws only on an API/DB failure; the caller logs it. */
export async function syncMailHaproxyLabels(
  db: Database,
  core: LabelSyncCore,
  nodes: readonly NodeRef[],
): Promise<HaproxyLabelSync> {
  const { mode, settings: stored } = await readModeAndPlacement(db);
  if (mode === 'activeNodeOnly') return skipped('port exposure is activeNodeOnly — no haproxy');

  // Same answer the mode switch uses (active-node.ts). Read-only here: this
  // runs every minute on every replica.
  const active = await resolveActiveMailNode(db, core, {
    knownNodes: new Set(nodes.map((n) => n.metadata.name)),
  });
  if (!active.node && nodes.length > 1) {
    return skipped('the active mail node is unknown — haproxy could land on the Stalwart node');
  }
  const settings = { ...stored, activeNode: active.node };
  const invalid = validateModeSwitch(mode, settings);
  if (invalid) return skipped(invalid);

  const desired = resolveHaproxyNodes(mode, settings, nodes);
  const plan = planHaproxyLabelChanges(desired, nodes);
  if (plan.added.length === 0 && plan.removed.length === 0) return { outcome: 'in-sync' };

  // Only now — with something to change — look for an owner of the labels.
  if (portExposureApplyInFlight()) return skipped('a port-exposure switch is applying in this process');
  const [running] = await db.select({ kind: tasks.kind })
    .from(tasks)
    .where(and(inArray(tasks.kind, [...LABEL_OWNING_TASK_KINDS]), eq(tasks.status, 'running')))
    .limit(1);
  if (running) return skipped(`a ${running.kind} task is running`);
  const migrations = await db.execute<{ id: string }>(sql`
    SELECT id FROM mail_migration_runs
     WHERE state NOT IN ${MIGRATION_TERMINAL_STATES}
     LIMIT 1
  `);
  const migration = ((migrations as unknown as { rows?: Array<{ id: string }> }).rows ?? [])[0];
  if (migration) return skipped(`mail migration ${migration.id} is in flight`);

  await reconcileMailHaproxyLabels(core, desired, nodes);
  return { outcome: 'changed', ...plan };
}

/** Raw Node subset the node sync already holds. */
export interface RawLabelledNode {
  readonly metadata?: { readonly name?: string; readonly labels?: Record<string, string> };
}

export function toNodeRefs(items: readonly RawLabelledNode[]): NodeRef[] {
  return items
    .filter((n) => Boolean(n.metadata?.name))
    .map((n) => ({ metadata: { name: n.metadata!.name!, labels: n.metadata?.labels ?? {} } }));
}

let lastLogged = { line: '', at: 0 };

/**
 * The log line for a pass, or null when it would only repeat the previous one.
 * The sync runs every minute on every replica; a long migration would
 * otherwise print the same "not syncing" line hundreds of times. An unchanged
 * line is still repeated every HAPROXY_LABEL_SYNC_RELOG_MS, so a sync that
 * keeps failing (a forbidden patch, a stuck migration row) does not fall
 * silent after its first message.
 */
export function describeHaproxyLabelSync(result: HaproxyLabelSync, now: number = Date.now()): string | null {
  const line = result.outcome === 'changed'
    ? `[mail-haproxy-labels] labelled ${result.added.join(', ') || '—'}; unlabelled ${result.removed.join(', ') || '—'}`
    : result.outcome === 'skipped'
      ? `[mail-haproxy-labels] not syncing: ${result.reason}`
      : '';
  const repeat = line === lastLogged.line;
  if (repeat && (line === '' || now - lastLogged.at < HAPROXY_LABEL_SYNC_RELOG_MS)) return null;
  lastLogged = { line, at: now };
  return line || null;
}

/** Test-only reset of the log de-duplication. */
export function __resetHaproxyLabelSyncLogForTest(): void {
  lastLogged = { line: '', at: 0 };
}
