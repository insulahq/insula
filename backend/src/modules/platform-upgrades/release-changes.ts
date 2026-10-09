/**
 * ADR-064 §6 — what an upgrade to the available release changes, for the review:
 * the release's contents (from its signed manifest, stored by the version poller)
 * diffed against this cluster's own ledgers and each node's reported host state.
 */
import { sql } from 'drizzle-orm';
import type { HostMigrationNodeStatus, ReleaseContents, UpgradeChangesResponse } from '@insula/api-contracts';
import { releaseContentsSchema } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { dbSettings } from './orchestrate.js';
import { listMigrationStatus } from './index.js';
import { readHostMigrationStatus } from './host-migration-status.js';
import { listNodeFacts } from './run/k8s.js';
import { kubernetesOffer, lowestKubelet } from './run/k8s-step.js';

/** A node has this host change behind it — run, already present, or skipped by an operator. */
const DONE = new Set(['applied', 'already-applied', 'skipped']);

export interface ChangesInput {
  readonly fromVersion: string | null;
  readonly toVersion: string | null;
  readonly contents: ReleaseContents | null;
  /** The cluster's lowest kubelet (k3s) version, for the opt-in Kubernetes step. */
  readonly kubelet?: string | null;
  readonly sqlApplied: ReadonlySet<string>;
  readonly platformApplied: ReadonlySet<string>;
  readonly nodes: readonly HostMigrationNodeStatus[];
}

/**
 * Pure. A host change is still to run on a node unless the node reports it done.
 * A script the node does not list at all is one its CLI has not seen yet (it
 * arrives with the release's CLI), so it counts as to-run. A node with no report
 * is listed apart: unknown is not "nothing to do".
 */
export function computeUpgradeChanges(input: ChangesInput): UpgradeChangesResponse {
  const target = input.contents?.k3sVersion ?? null;
  const kubernetes = { current: input.kubelet ?? null, target, ...kubernetesOffer(input.kubelet ?? null, target) };
  const base = { fromVersion: input.fromVersion, toVersion: input.toVersion, kubernetes };
  if (!input.contents) {
    return { ...base, known: false, databaseMigrations: 0, platformMigrations: 0, hostChanges: [], unreportedNodes: [] };
  }
  const reported = input.nodes.filter((n) => n.collectedAt !== null);
  const unreportedNodes = input.nodes.filter((n) => n.collectedAt === null).map((n) => n.node).sort();
  const doneOn = new Map(reported.map((n) => [n.node, new Set(n.items.filter((i) => DONE.has(i.state)).map((i) => i.key))]));
  const hostChanges = input.contents.hostMigrations
    .map((m) => ({ ...m, nodes: reported.filter((n) => !doneOn.get(n.node)?.has(m.key)).map((n) => n.node).sort() }))
    .filter((m) => m.nodes.length > 0);
  return {
    ...base,
    known: true,
    databaseMigrations: input.contents.migrations.sql.filter((f) => !input.sqlApplied.has(f)).length,
    platformMigrations: input.contents.migrations.platform.filter((id) => !input.platformApplied.has(id)).length,
    hostChanges,
    unreportedNodes,
  };
}

function parseContents(raw: string | null): ReleaseContents | null {
  if (!raw) return null;
  try {
    const r = releaseContentsSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export async function readUpgradeChanges(
  db: Database,
  k8s: K8sClients,
  runningVersion: string | null,
  /** Nodes the operator leaves out: not judged for the Kubernetes offer. */
  excluded: readonly string[] = [],
): Promise<UpgradeChangesResponse> {
  const settings = dbSettings(db);
  const [available, installed, rawContents] = await Promise.all([
    settings.get('available_version'),
    settings.get('installed_platform_version'),
    settings.get('available_release_contents'),
  ]);
  const [ledger, platform, hosts, nodes] = await Promise.all([
    db.execute(sql`SELECT filename FROM public.__platform_migrations`) as Promise<{ rows?: Array<{ filename: string }> }>,
    listMigrationStatus(db),
    readHostMigrationStatus(k8s, runningVersion),
    listNodeFacts(k8s).catch(() => []),
  ]);
  const rows = ledger.rows ?? [];
  return computeUpgradeChanges({
    fromVersion: installed?.trim() || null,
    toVersion: available?.trim() || null,
    contents: parseContents(rawContents),
    sqlApplied: new Set(rows.map((r) => r.filename)),
    platformApplied: new Set(platform.filter((m) => m.status !== 'pending').map((m) => m.id)),
    nodes: hosts.nodes,
    kubelet: lowestKubelet(nodes.filter((n) => !excluded.includes(n.name))),
  });
}
