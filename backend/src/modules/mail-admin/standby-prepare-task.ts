/**
 * A Task Center task for each node that becomes a mail standby, from the moment
 * it is labelled until its first complete copy is in.
 *
 * Choosing a secondary or tertiary, moving the standby to another node, or a
 * migration that leaves a different node as standby, starts that node's
 * replicator on a full copy of the mail store: minutes in one data centre,
 * hours over a slow link. The save returned at once and nothing tracked the
 * copy. The task shows its steps in the progress modal. It finishes when the
 * node reports its first complete copy, and fails with the reason when the
 * copier does not start or the copy runs past the grace — the verdict the
 * standby check gives (standby-since.ts), so the two never disagree.
 *
 * The reconciler that labels the node (placement.ts) returns the nodes it made
 * standbys; whoever ran it enrolls them here. A leased watch (one replica)
 * advances the running tasks; the replicator's report finishes one at once.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { toSafeText, type SafeText } from '@insula/api-contracts';
import { systemSettings, tasks } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import { getStandbyReports, type NodeStandbyReport, type StandbyReport } from './standby-reports.js';
import {
  COPIER_START_SECONDS, FIRST_COPY_GRACE_SECONDS, copierStateByNode, firstCopyState, onFirstCopy, standbySinceFrom,
  type CopierState,
} from './standby-since.js';

export const STANDBY_PREPARE_KIND = 'mail.standby-prepare';

const STANDBY_LABEL = 'insula.host/mail-standby';

/** A node the label reconciler just made a standby, and the time it stamped. */
export interface NewStandby {
  readonly node: string;
  readonly since: string;
}

/** ref_id is varchar(64), and a node name can be a 253-character FQDN. */
export function standbyPrepareRefId(node: string, since: string): string {
  return createHash('sha256').update(`${node}\n${since}`).digest('hex');
}

type StepState = 'pending' | 'running' | 'done' | 'failed';
export interface PrepareStep {
  readonly name: string;
  readonly state: StepState;
  readonly note?: string;
}

function steps(node: string, copier: StepState, copy: StepState, notes: { copier?: string; copy?: string } = {}): PrepareStep[] {
  return [
    { name: `Make ${node} a mail standby`, state: 'done' },
    { name: 'Start the standby copier', state: copier, ...(notes.copier ? { note: notes.copier } : {}) },
    { name: `Copy the mail store to ${node}`, state: copy, ...(notes.copy ? { note: notes.copy } : {}) },
  ];
}

export type StandbyPrepareVerdict =
  | { readonly status: 'running'; readonly pct: number | null; readonly text: string; readonly steps: PrepareStep[] }
  | { readonly status: 'succeeded'; readonly text: string; readonly steps: PrepareStep[] }
  | { readonly status: 'cancelled'; readonly text: string; readonly steps: PrepareStep[]; readonly clear: boolean }
  | { readonly status: 'failed'; readonly text: string; readonly error: string; readonly steps: PrepareStep[] };

export interface StandbyPrepareInput {
  readonly node: string;
  readonly since: string;
  readonly now: number;
  /** The node still carries the standby label, with this same `since`. */
  readonly stillStandby: boolean;
  /** Where mail runs now; null when not known. */
  readonly activeNode: string | null;
  /** The node's newest report, if any. */
  readonly report: StandbyReport | null;
  /** Its copier pod; null when the pods could not be read. */
  readonly copier: CopierState | null;
  /** Node Ready; null when not known. */
  readonly nodeReady: boolean | null;
  /** The newest complete copy on another node — about the size this one will be. */
  readonly expectedBytes: number | null;
  /** How far the copy is, as its copier last posted it; null before the first post (or an older copier). */
  readonly copy?: CopyProgress | null;
}

/** A first copy's progress, as the copier posts it (standby-replicate.sh, every 15 s). */
export interface CopyProgress {
  readonly bytes: number;
  /** Of the whole store: rsync builds the full file list before it copies. */
  readonly percent: number;
  /** When this was posted. */
  readonly at: string;
  /** When the first post of this copy came — what the time left is estimated from. */
  readonly startedAt: string;
}

/** Progress unreported this long while the copier runs is said so (it posts every 15 s). */
const PROGRESS_STALE_SECONDS = 120;

function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m} min`;
  return m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** 44.1 GB; below a gigabyte in MB ("0.0 GB so far" said nothing on a small store). */
function gb(bytes: number): string {
  return bytes < 1e9 ? `${Math.round(bytes / 1e6)} MB` : `${(bytes / 1e9).toFixed(1)} GB`;
}

const COPY_NOTE = 'A first copy moves everything; later ones only what changed';

/**
 * The copy with its reported progress: the percentage, what has been copied,
 * and the time left estimated from the rate so far. Depends only on the post
 * and on `now` past the stale mark, so a watch pass between two posts writes
 * nothing. Pure.
 */
export function copyingVerdict(node: string, copy: CopyProgress, now: number): Extract<StandbyPrepareVerdict, { status: 'running' }> {
  const p = Math.max(0, Math.min(100, Math.floor(copy.percent)));
  const ran = (Date.parse(copy.at) - Date.parse(copy.startedAt)) / 1000;
  const left = p >= 2 && p < 100 && ran >= 60 ? `, about ${duration((ran * (100 - p)) / p)} left` : '';
  const quiet = (now - Date.parse(copy.at)) / 1000;
  const stale = quiet > PROGRESS_STALE_SECONDS ? ` — no progress reported for ${duration(quiet)}` : '';
  return {
    status: 'running',
    // 100% copied is not done: the copy is promoted and reported first.
    pct: Math.min(p, 99),
    text: p >= 100
      ? `Finishing the first copy on ${node}: ${gb(copy.bytes)} copied${stale}`
      : `Copying the mail store to ${node}: ${p}%, ${gb(copy.bytes)} so far${left}${stale}`,
    steps: steps(node, 'done', 'running', { copy: COPY_NOTE }),
  };
}

/** What a task should say now. Pure. */
export function judgeStandbyPrepare(i: StandbyPrepareInput): StandbyPrepareVerdict {
  const { node } = i;
  const elapsed = (i.now - Date.parse(i.since)) / 1000;

  if (i.report && !onFirstCopy(i.since, i.report.reportedAt)) {
    const r = i.report;
    return {
      status: 'succeeded',
      text: `First copy on ${node} finished: ${gb(r.sizeBytes)}, ${r.fileCount.toLocaleString('en-US')} files. `
        + 'It is refreshed every few minutes from now on.',
      steps: steps(node, 'done', 'done', { copy: `Took ${duration(r.durationSeconds)}` }),
    };
  }

  if (!i.stillStandby) {
    // The stack moved onto the node (a "Move now" labels the new primary
    // first): nothing to prepare, nothing to show.
    if (i.activeNode === node) {
      return { status: 'cancelled', text: `Not needed: mail now runs on ${node}`, steps: steps(node, 'done', 'done'), clear: true };
    }
    return { status: 'cancelled', text: `${node} is no longer a mail standby`, steps: steps(node, 'done', 'pending'), clear: false };
  }

  // The copier's own progress, posted in the last two minutes, is better
  // evidence that it runs than a pod list read at another moment.
  const copyFresh = !!i.copy && (i.now - Date.parse(i.copy.at)) / 1000 <= PROGRESS_STALE_SECONDS;
  const running = copyFresh ? true : i.copier ? i.copier.running : null;
  const why = i.nodeReady === false ? 'the node is not ready'
    : i.copier && !i.copier.running ? (i.copier.reason ?? 'its pod is not running')
    : null;
  const state = firstCopyState({ since: i.since, now: i.now, copierRunning: running });

  if (state === 'overdue') {
    const error = `The first copy to ${node} has not finished ${duration(FIRST_COPY_GRACE_SECONDS)} after it became a standby`
      + (running === false ? ` and its copier is not running (${why})` : '')
      + '. The copier log says why: namespace mail, pods app=mail-stack-standby-replicate.';
    return { status: 'failed', text: 'First copy not finished in time', error, steps: steps(node, running === false ? 'failed' : 'done', 'failed') };
  }
  if (state === 'not_running') {
    const error = `The standby copier on ${node} is not running ${duration(elapsed)} after the node became a standby: ${why}.`;
    return { status: 'failed', text: 'The standby copier did not start', error, steps: steps(node, 'failed', 'pending', { copier: why ?? undefined }) };
  }
  if (running === true) {
    if (i.copy) return copyingVerdict(node, i.copy, i.now);
    const size = i.expectedBytes ? `, about ${gb(i.expectedBytes)} in all` : '';
    return {
      status: 'running',
      pct: null,
      text: `Copying the mail store to ${node}: ${duration(elapsed)} so far${size}`,
      steps: steps(node, 'done', 'running', { copy: COPY_NOTE }),
    };
  }
  const waitNote = running === null ? 'Its state could not be read' : `${why} — given ${duration(COPIER_START_SECONDS)} to start`;
  return {
    status: 'running',
    pct: 10,
    text: running === null ? `Preparing the standby on ${node}` : `Waiting for the standby copier on ${node} to start`,
    steps: steps(node, 'running', 'pending', { copier: waitNote }),
  };
}

/** A string a node or Kubernetes produced, branded — never fails the write over its wording. */
function safe(s: string): SafeText {
  try { return toSafeText(s); } catch { return toSafeText('(details withheld)'); }
}

function safeSteps(list: PrepareStep[]): PrepareStep[] {
  return list.map((s) => (s.note ? { ...s, note: safe(s.note) } : s));
}

interface Log {
  warn: (...args: unknown[]) => void;
}

function startArgs(node: string, since: string, who: { readonly userId: string | null }) {
  return {
    kind: STANDBY_PREPARE_KIND,
    refId: standbyPrepareRefId(node, since),
    scope: who.userId ? 'admin' as const : 'system' as const,
    userId: who.userId,
    label: safe(`Prepare the mail standby on ${node}`),
    // The chip adds the task's own id to the props (MailTaskProgressModal reads it).
    target: { type: 'modal' as const, modal: 'mail-operation', modalProps: { node } },
    progressPct: 5,
    progressText: safe(`Starting the standby copier on ${node}`),
    details: { node, since, steps: safeSteps(steps(node, 'running', 'pending')) },
  };
}

/**
 * Start a task per new standby. `userId` puts it in that admin's chip; without
 * one (platform-api start-up, a DR failover) it is a system task every admin
 * sees. Never throws: the standby is set up either way.
 */
export async function enrollStandbyPrepareTasks(
  db: Database,
  added: readonly NewStandby[],
  who: { readonly userId: string | null },
  log?: Log,
): Promise<Array<{ node: string; taskId: string }>> {
  const { start } = await import('../tasks/service.js');
  const out: Array<{ node: string; taskId: string }> = [];
  for (const { node, since } of added) {
    try {
      const { id } = await start(db, startArgs(node, since, who));
      out.push({ node, taskId: id });
    } catch (err) {
      log?.warn({ err, node }, '[mail-standby] could not record the task for a new standby (non-fatal)');
    }
  }
  return out;
}

/**
 * How long a failed task is still looked at. The standby check recomputes
 * every time, so a copier that starts late, or a copy that finishes after the
 * grace, turns it green again — the task follows it back rather than staying
 * red beside a healthy check.
 */
const FAILED_REVISIT_HOURS = 24;

const OPEN = sql`(${tasks.status} IN ('queued','running')
  OR (${tasks.status} = 'failed' AND ${tasks.finishedAt} > NOW() - (${FAILED_REVISIT_HOURS}::int * INTERVAL '1 hour')))`;

interface OpenTask {
  readonly id: string;
  readonly status: string;
  readonly userId: string | null;
  readonly node: string;
  readonly since: string;
  readonly progressText: string | null;
  readonly steps: unknown;
  readonly copy: CopyProgress | null;
}

/** details.copy as written by recordStandbyCopyProgress; anything else is no progress. */
function copyFrom(raw: unknown): CopyProgress | null {
  const c = raw as Partial<CopyProgress> | null | undefined;
  if (!c || typeof c.bytes !== 'number' || typeof c.percent !== 'number'
    || typeof c.at !== 'string' || typeof c.startedAt !== 'string') return null;
  return { bytes: c.bytes, percent: c.percent, at: c.at, startedAt: c.startedAt };
}

async function openTasks(db: Database, node?: string): Promise<OpenTask[]> {
  const rows = await db
    .select({ id: tasks.id, status: tasks.status, userId: tasks.userId, details: tasks.details, progressText: tasks.progressText })
    .from(tasks)
    .where(and(
      eq(tasks.kind, STANDBY_PREPARE_KIND),
      OPEN,
      ...(node ? [sql`${tasks.details}->>'node' = ${node}`] : []),
    ));
  return rows.flatMap((r) => {
    const d = (r.details ?? {}) as { node?: unknown; since?: unknown; steps?: unknown; copy?: unknown };
    if (typeof d.node !== 'string' || typeof d.since !== 'string') return [];
    return [{
      id: r.id, status: r.status, userId: r.userId ?? null,
      node: d.node, since: d.since, progressText: r.progressText, steps: d.steps, copy: copyFrom(d.copy),
    }];
  });
}

/** Is there anything for the watch to do — one indexed read, no lease. */
async function anyOpenTask(db: Database): Promise<boolean> {
  const rows = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.kind, STANDBY_PREPARE_KIND), OPEN)).limit(1);
  return rows.length > 0;
}

/** Steps compared by content: JSONB hands object keys back in its own order. */
function stepsKey(list: unknown): string {
  if (!Array.isArray(list)) return '';
  return list.map((s: { name?: unknown; state?: unknown; note?: unknown }) => `${String(s?.name)}|${String(s?.state)}|${String(s?.note ?? '')}`).join('\n');
}

/**
 * Write a verdict. Every write is guarded on the state it was decided from: the
 * report route can finish the task while a watch pass is between its read and
 * its write, and that pass must not put "Copying…" back over "finished".
 */
async function apply(db: Database, task: OpenTask, v: StandbyPrepareVerdict): Promise<void> {
  const { finish, progress, start } = await import('../tasks/service.js');
  const stepsOut = safeSteps(v.steps);
  const active = task.status === 'queued' || task.status === 'running';

  if (!active) {
    // A failed task: only the copy finishing, or the copier running again, changes it.
    if (v.status === 'succeeded') {
      await finish(db, task.id, { status: 'succeeded', text: safe(v.text), detailsPatch: { steps: stepsOut }, expectStatus: ['failed'] });
    } else if (v.status === 'running') {
      // Re-opened through the same (kind, ref_id): the row keeps its id and owner.
      await start(db, startArgs(task.node, task.since, { userId: task.userId }));
      await progress(db, task.id, { pct: v.pct, text: safe(v.text), detailsPatch: { steps: stepsOut }, expectStatus: ['running'] });
    }
    return;
  }
  if (v.status === 'running') {
    // Only a change is written: every write is a delta pushed to each open chip.
    if (task.progressText === v.text && stepsKey(task.steps) === stepsKey(stepsOut)) return;
    await progress(db, task.id, { pct: v.pct, text: safe(v.text), detailsPatch: { steps: stepsOut }, expectStatus: ['queued', 'running'] });
    return;
  }
  await finish(db, task.id, {
    status: v.status,
    text: safe(v.text),
    error: v.status === 'failed' ? safe(v.error) : null,
    detailsPatch: { steps: stepsOut },
    clearImmediately: v.status === 'cancelled' && v.clear,
    expectStatus: ['queued', 'running'],
  });
}

/** The newest report from a node other than `node`: about the size of the store. */
function expectedBytes(reports: readonly NodeStandbyReport[], node: string): number | null {
  const others = reports.filter((r) => r.node !== node && r.sizeBytes > 0);
  if (others.length === 0) return null;
  return others.reduce((a, b) => (Date.parse(a.reportedAt) >= Date.parse(b.reportedAt) ? a : b)).sizeBytes;
}

type ListedNode = {
  metadata?: { name?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  status?: { conditions?: Array<{ type?: string; status?: string }> };
};

export interface StandbyPrepareCluster {
  readonly listNodes: () => Promise<ReadonlyArray<ListedNode>>;
  /** The replicator's pods (STANDBY_REPLICATOR_SELECTOR in namespace mail). */
  readonly listCopierPods: () => Promise<ReadonlyArray<Parameters<typeof copierStateByNode>[0][number]>>;
}

/**
 * Bring every open task up to date. Without the node list it changes nothing —
 * "no longer a standby" must come from a list that was read.
 */
export async function advanceStandbyPrepareTasks(
  db: Database,
  cluster: StandbyPrepareCluster,
  now: number = Date.now(),
): Promise<number> {
  const open = await openTasks(db);
  if (open.length === 0) return 0;
  const nodes = await cluster.listNodes();
  const copiers = await cluster.listCopierPods().then(copierStateByNode, () => null);
  const reports = await getStandbyReports(db);
  const [settings] = await db.select({ active: systemSettings.mailActiveNode }).from(systemSettings)
    .where(eq(systemSettings.id, 'system'));
  const byName = new Map(nodes.map((n) => [n.metadata?.name ?? '', n]));
  const reportOf = new Map(reports.map((r) => [r.node, r]));

  for (const task of open) {
    const n = byName.get(task.node);
    const stillStandby = !!n
      && n.metadata?.labels?.[STANDBY_LABEL] === 'true'
      && standbySinceFrom(n.metadata?.annotations) === task.since;
    const ready = n?.status?.conditions?.find((c) => c.type === 'Ready');
    // The replicator reports under the Node name; some sources use the hostname
    // (as getCurrentStandbyReports reads it, so the two agree).
    const hostname = n?.metadata?.labels?.['kubernetes.io/hostname'];
    const verdict = judgeStandbyPrepare({
      node: task.node,
      since: task.since,
      now,
      stillStandby,
      activeNode: (settings?.active ?? null) as string | null,
      report: reportOf.get(task.node) ?? (hostname ? reportOf.get(hostname) : undefined) ?? null,
      // No pod for the node in a list that was read: its copier is not running.
      copier: copiers ? (copiers.get(task.node) ?? { running: false, reason: 'no copier pod on the node yet' }) : null,
      nodeReady: ready ? ready.status === 'True' : null,
      expectedBytes: expectedBytes(reports, task.node),
      copy: task.copy,
    });
    // While posts keep coming, the progress route writes the copying text; a
    // pass that read the task just before a post would put the older one back.
    const postsComing = !!task.copy && (now - Date.parse(task.copy.at)) / 1000 <= PROGRESS_STALE_SECONDS;
    if (verdict.status === 'running' && postsComing && (task.status === 'queued' || task.status === 'running')) continue;
    await apply(db, task, verdict);
  }
  return open.length;
}

/**
 * The replicator just reported a complete copy from `node`: finish its task now
 * rather than on the next watch pass — a task that had failed too, since the
 * copy got there after all. Needs no cluster read: the report is newer than any
 * `since`, and the node reported as the standby it is. A report under another
 * name than the task's (the hostname) is matched by the watch instead.
 */
export async function finishStandbyPrepareOnReport(db: Database, node: string, report: StandbyReport): Promise<void> {
  for (const task of await openTasks(db, node)) {
    const verdict = judgeStandbyPrepare({
      node, since: task.since, now: Date.parse(report.reportedAt), stillStandby: true, activeNode: null,
      report, copier: null, nodeReady: null, expectedBytes: null,
    });
    if (verdict.status === 'succeeded') await apply(db, task, verdict);
  }
}

/**
 * The copier's progress post (POST /internal/mail/standby-replicate-progress)
 * goes into the node's running task at once: the percentage and the time left
 * show while the copy runs, not only at its end. The post itself proves the
 * copier runs. A failed task is left for the watch, which re-opens it.
 */
export async function recordStandbyCopyProgress(
  db: Database,
  node: string,
  posted: { readonly bytes: number; readonly percent: number },
  now: number = Date.now(),
): Promise<number> {
  const { progress } = await import('../tasks/service.js');
  let written = 0;
  for (const task of await openTasks(db, node)) {
    if (task.status !== 'queued' && task.status !== 'running') continue;
    const at = new Date(now).toISOString();
    // A copy that went quiet, or started over (its percentage fell), is timed
    // afresh: the idle gap is no rate to estimate the time left from.
    const prev = task.copy;
    const continues = !!prev && posted.percent >= prev.percent
      && (now - Date.parse(prev.at)) / 1000 <= PROGRESS_STALE_SECONDS;
    const copy: CopyProgress = { bytes: posted.bytes, percent: posted.percent, at, startedAt: continues ? prev.startedAt : at };
    const v = copyingVerdict(node, copy, now);
    await progress(db, task.id, {
      pct: v.pct,
      text: safe(v.text),
      detailsPatch: { copy, steps: safeSteps(v.steps) },
      expectStatus: ['queued', 'running'],
    });
    written += 1;
  }
  return written;
}

/**
 * The task of each standby still on its first copy, by node, and how far its
 * copy is — for the page's "View progress" and its preparing row.
 */
export async function standbyPrepareTasksFor(
  db: Database,
  preparing: ReadonlyArray<{ readonly node: string; readonly since: string }>,
): Promise<Map<string, { readonly taskId: string; readonly copyPercent?: number }>> {
  if (preparing.length === 0) return new Map();
  const refs = new Map(preparing.map((p) => [standbyPrepareRefId(p.node, p.since), p.node]));
  const rows = await db
    .select({ id: tasks.id, refId: tasks.refId, details: tasks.details })
    .from(tasks)
    .where(and(eq(tasks.kind, STANDBY_PREPARE_KIND), inArray(tasks.refId, [...refs.keys()])));
  return new Map(rows.flatMap((r) => {
    const node = r.refId ? refs.get(r.refId) : undefined;
    if (!node) return [];
    const copy = copyFrom((r.details as { copy?: unknown } | null)?.copy);
    return [[node, copy ? { taskId: r.id, copyPercent: Math.min(100, Math.max(0, Math.floor(copy.percent))) } : { taskId: r.id }] as const];
  }));
}

/**
 * Advance the open tasks every 20 s on one replica. A pass with none reads one
 * indexed row set and takes no lease.
 */
export function startStandbyPrepareWatch(
  db: Database,
  log: Log,
  opts: { readonly kubeconfigPath?: string; readonly intervalMs?: number } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? 20_000;
  const runOnce = (): void => {
    void (async () => {
      if (!(await anyOpenTask(db))) return;
      const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
      const { STANDBY_REPLICATOR_SELECTOR } = await import('./standby-since.js');
      const { core } = createK8sClients(opts.kubeconfigPath);
      await withSchedulerLease(db, 'mail-standby-prepare-watch', intervalMs * 1.5, () => advanceStandbyPrepareTasks(db, {
        listNodes: async () => ((await core.listNode()) as { items?: ListedNode[] }).items ?? [],
        listCopierPods: async () => ((await core.listNamespacedPod({
          namespace: 'mail', labelSelector: STANDBY_REPLICATOR_SELECTOR,
        })) as { items?: [] }).items ?? [],
      }), { log });
    })().catch((err: unknown) => {
      log.warn({ err }, '[mail-standby] standby task watch pass failed (the next pass retries)');
    });
  };
  const timer = setInterval(runOnce, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
