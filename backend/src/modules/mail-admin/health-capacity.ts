/**
 * Mail capacity health — two checks that keep a failover, and the mail store's
 * own rewrites, safe on any install:
 *
 *   standby — every standby node holds a complete copy young enough for the
 *             restore fast path. The limit is the Stalwart Deployment's
 *             `FAST_PATH_MAX_AGE_SECONDS` (read live, so an overlay override is
 *             honoured); past it a failover restores from the backup instead.
 *             A sync clears the copy's completeness marker while it runs, so a
 *             long sync — a big import, or the store rewriting its files — is
 *             exactly the window this catches.
 *
 *   storage — every mail node has free space ≥ its mail data. Stalwart's
 *             RocksDB store periodically rewrites its message files and deletes
 *             the old ones only when the rewrite finishes; measured on v0.16.x,
 *             a node then briefly holds about twice the store. Less headroom
 *             than the store itself can fill the disk mid-rewrite.
 *
 * Pure evaluators plus one reader that gathers their inputs. The reader's
 * failure becomes a `fail` carrying the reason: "could not determine" is not
 * "nothing to check".
 */

import * as k8sClient from '@kubernetes/client-node';
import type {
  MailHealthStandbyComponent,
  MailHealthStandbyNode,
  MailHealthStorageComponent,
  MailHealthStorageNode,
} from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { getMailNodeStorage, type MailNodeStorage } from './mail-node-storage.js';
import { getStandbyReports, type NodeStandbyReport } from './standby-reports.js';
import { getMailPlacement } from './placement.js';

/** Default of `FAST_PATH_MAX_AGE_SECONDS` in the Stalwart restore-state init container. */
export const DEFAULT_STANDBY_MAX_AGE_SECONDS = 1800;

/**
 * Free space a node needs, as a multiple of its mail data: a rewrite holds the
 * old and the new files at once, so up to one extra store.
 */
export const REWRITE_HEADROOM_RATIO = 1;

const MAIL_NAMESPACE = 'mail';
const STALWART_DEPLOYMENT = 'stalwart-mail';
const RESTORE_INIT_CONTAINER = 'restore-state';
const MAX_AGE_ENV = 'FAST_PATH_MAX_AGE_SECONDS';
const READ_TIMEOUT_MS = 20_000;

export interface MailCapacityInput {
  readonly nodes: ReadonlyArray<MailNodeStorage>;
  readonly reports: ReadonlyArray<NodeStandbyReport>;
  readonly maxAgeSeconds: number;
}

export interface MailCapacityComponents {
  readonly standby: MailHealthStandbyComponent;
  readonly storage: MailHealthStorageComponent;
}

function minutes(seconds: number): string {
  return `${Math.round(seconds / 60)} min`;
}

function gib(bytes: number): string {
  return `${(bytes / 2 ** 30).toFixed(1)} GiB`;
}

/**
 * How fresh the standby copies are. A copy's data dates from when its sync
 * started, so its age is the report's age plus how long that sync took. Pure.
 */
export function evaluateStandby(input: MailCapacityInput): MailHealthStandbyComponent {
  const { maxAgeSeconds } = input;
  // The active node serves mail; a copy on it is no failover target.
  const standbyNodes = input.nodes.filter((n) => n.isStandby && !n.isActive);
  if (standbyNodes.length === 0) {
    return { status: 'not_implemented', healthy: true, error: null, maxAgeSeconds, nodes: [] };
  }
  const reports = new Map(input.reports.map((r) => [r.node, r]));
  const nodes: MailHealthStandbyNode[] = standbyNodes.map((n) => {
    const report = reports.get(n.nodeName);
    const ageSeconds = report ? report.ageSeconds + Math.round(report.durationSeconds) : null;
    return {
      node: n.nodeName,
      ageSeconds,
      durationSeconds: report?.durationSeconds ?? null,
      sizeBytes: report?.sizeBytes ?? null,
      fresh: ageSeconds !== null && ageSeconds <= maxAgeSeconds,
    };
  });
  const stale = nodes.filter((n) => !n.fresh).length;
  if (stale === 0) {
    return { status: 'ok', healthy: true, error: null, maxAgeSeconds, nodes };
  }
  const subject = stale === 1 ? '1 standby node has' : `${stale} standby nodes have`;
  const error = `${subject} no copy younger than ${minutes(maxAgeSeconds)}. A failover restores the `
    + 'newest complete copy (or the backup, if that is newer), so mail received since would be lost.';
  return { status: 'fail', healthy: false, error, maxAgeSeconds, nodes };
}

/**
 * The mail data a node must have room for. The active node's is measured live.
 * A standby's own figure is its last COMPLETE copy, which is stale exactly while
 * a rewrite is being copied over, and its next sync will receive the active
 * store, so it needs room for the larger of the two.
 */
function mailBytesToHold(n: MailNodeStorage, activeLive: number | null): number | null {
  if (n.isActive) return n.mailUsedBytes;
  if (n.mailUsedBytes === null) return activeLive;
  return activeLive === null ? n.mailUsedBytes : Math.max(n.mailUsedBytes, activeLive);
}

/** Free space vs mail data on the active and standby nodes. Pure. */
export function evaluateStorage(input: Pick<MailCapacityInput, 'nodes'>): MailHealthStorageComponent {
  const activeLive = input.nodes.find((n) => n.isActive)?.mailUsedBytes ?? null;
  const nodes: MailHealthStorageNode[] = input.nodes
    .filter((n) => n.isActive || n.isStandby)
    .map((n) => {
      const free = n.freeBytes;
      const mail = mailBytesToHold(n, activeLive);
      return {
        node: n.nodeName,
        role: n.isActive ? 'active' : 'standby',
        freeBytes: free,
        mailBytes: mail,
        enough: free === null || mail === null ? null : free >= mail * REWRITE_HEADROOM_RATIO,
      };
    });
  if (!nodes.some((n) => n.enough !== null)) {
    return { status: 'not_implemented', healthy: true, error: null, nodes };
  }
  const short = nodes.filter((n) => n.enough === false).length;
  if (short === 0) {
    return { status: 'ok', healthy: true, error: null, nodes };
  }
  const subject = short === 1 ? '1 mail node has' : `${short} mail nodes have`;
  const error = `${subject} less free space than its mail data. The mail store periodically rewrites `
    + 'its message files and keeps the old ones until it finishes, so a node needs free space at least '
    + 'the size of its mail.';
  return { status: 'fail', healthy: false, error, nodes };
}

/**
 * One line per node behind a failing standby / storage component — the
 * alert's list items (a notification about several things lists each).
 */
export function capacityItems(key: string, component: unknown): string[] {
  const c = component as { healthy?: boolean; nodes?: unknown } | null;
  if (!c || c.healthy !== false || !Array.isArray(c.nodes)) return [];
  if (key === 'standby') {
    return (c.nodes as MailHealthStandbyNode[])
      .filter((n) => !n.fresh)
      .map((n) => (n.ageSeconds === null
        ? `${n.node}: has never finished a copy`
        : `${n.node}: newest complete copy ${minutes(n.ageSeconds)} old`));
  }
  if (key === 'storage') {
    return (c.nodes as MailHealthStorageNode[])
      .filter((n) => n.enough === false)
      .map((n) => `${n.node}: ${gib(n.freeBytes ?? 0)} free for ${gib(n.mailBytes ?? 0)} of mail`);
  }
  return [];
}

/** Both components; a failed read fails both with the reason. Never throws. */
export async function probeCapacity(
  read: (() => Promise<MailCapacityInput>) | undefined,
): Promise<MailCapacityComponents> {
  if (!read) {
    return {
      standby: { status: 'not_implemented', healthy: true, error: null, maxAgeSeconds: DEFAULT_STANDBY_MAX_AGE_SECONDS, nodes: [] },
      storage: { status: 'not_implemented', healthy: true, error: null, nodes: [] },
    };
  }
  try {
    const input = await withTimeout(read(), READ_TIMEOUT_MS, 'reading mail node capacity timed out');
    return { standby: evaluateStandby(input), storage: evaluateStorage(input) };
  } catch (err) {
    const error = `Could not read mail node capacity: ${err instanceof Error ? err.message : String(err)}`;
    return {
      standby: { status: 'fail', healthy: false, error, maxAgeSeconds: DEFAULT_STANDBY_MAX_AGE_SECONDS, nodes: [] },
      storage: { status: 'fail', healthy: false, error, nodes: [] },
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The fast-path age limit the Stalwart Deployment actually runs with. A missing
 * or unparsable value is the script default, exactly as the init container
 * reads it.
 */
export async function readStandbyMaxAgeSeconds(apps: K8sClients['apps']): Promise<number> {
  const deployment = await apps.readNamespacedDeployment({ name: STALWART_DEPLOYMENT, namespace: MAIL_NAMESPACE });
  const init = deployment.spec?.template?.spec?.initContainers?.find((c) => c.name === RESTORE_INIT_CONTAINER);
  const raw = init?.env?.find((e) => e.name === MAX_AGE_ENV)?.value;
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_STANDBY_MAX_AGE_SECONDS;
}

/**
 * Re-key standby reports to the card key. The DaemonSet reports under the Node
 * object's name; cards use the kubernetes.io/hostname label (see
 * mail-node-storage.ts). Unknown names pass through unchanged. Pure.
 */
export function rekeyReports(
  reports: ReadonlyArray<NodeStandbyReport>,
  hostnameByNodeName: ReadonlyMap<string, string>,
): NodeStandbyReport[] {
  return reports.map((r) => ({ ...r, node: hostnameByNodeName.get(r.node) ?? r.node }));
}

/**
 * Run at most one `fn` at a time: callers arriving while one is in flight share
 * its result. A read that outlives its caller's timeout keeps running (the kube
 * client has no cancellation here), so this keeps a slow kube-API from piling
 * up one more set of calls per health request.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inflight: Promise<T> | null = null;
  return () => {
    if (!inflight) {
      inflight = fn().finally(() => { inflight = null; });
    }
    return inflight;
  };
}

export interface MailCapacityReaderDeps {
  readonly k8s: K8sClients;
  readonly db: Database;
  readonly kubeconfigPath: string | undefined;
  readonly log?: { warn: (...args: unknown[]) => void };
}

// The deps of the latest caller; every caller passes equivalent clients for the same cluster.
let latestDeps: MailCapacityReaderDeps | null = null;
const sharedRead = singleFlight(async () => {
  if (!latestDeps) throw new Error('mail capacity reader used before it was configured');
  return readCapacity(latestDeps);
});

/**
 * The reader both callers of getMailHealth (route + scheduler) pass in. One
 * read at a time per process, whichever caller started it.
 */
export function mailCapacityReader(deps: MailCapacityReaderDeps): () => Promise<MailCapacityInput> {
  return () => {
    latestDeps = deps;
    return sharedRead();
  };
}

async function readCapacity(deps: MailCapacityReaderDeps): Promise<MailCapacityInput> {
  const kc = deps.k8s.kubeConfig ?? loadKubeConfig(deps.kubeconfigPath);
  const placement = await getMailPlacement(deps.db, { kubeconfigPath: deps.kubeconfigPath });
  const [nodes, reports, maxAgeSeconds] = await Promise.all([
    getMailNodeStorage({
      core: deps.k8s.core,
      exec: new k8sClient.Exec(kc),
      db: deps.db,
      placement: {
        activeNode: placement.activeNode,
        primaryNode: placement.primaryNode,
        secondaryNode: placement.secondaryNode,
        tertiaryNode: placement.tertiaryNode,
      },
      logger: deps.log,
    }),
    getStandbyReports(deps.db),
    readStandbyMaxAgeSeconds(deps.k8s.apps).catch((err: unknown) => {
      deps.log?.warn('mail-health: could not read the restore fast-path age limit; using the default:', err);
      return DEFAULT_STANDBY_MAX_AGE_SECONDS;
    }),
  ]);
  return { nodes, reports: rekeyReports(reports, await hostnameByNodeName(deps)), maxAgeSeconds };
}

/** Node object name → kubernetes.io/hostname label. Empty on a listNode failure (reports pass through). */
async function hostnameByNodeName(deps: MailCapacityReaderDeps): Promise<Map<string, string>> {
  try {
    const list = await deps.k8s.core.listNode({}) as { items?: Array<{ metadata?: { name?: string; labels?: Record<string, string> } }> };
    const map = new Map<string, string>();
    for (const n of list.items ?? []) {
      const name = n.metadata?.name;
      const hostname = n.metadata?.labels?.['kubernetes.io/hostname'];
      if (name && hostname) map.set(name, hostname);
    }
    return map;
  } catch (err) {
    deps.log?.warn('mail-health: listNode failed; standby reports keyed by Node name as-is:', err);
    return new Map();
  }
}

function loadKubeConfig(kubeconfigPath: string | undefined): k8sClient.KubeConfig {
  const kc = new k8sClient.KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  return kc;
}
