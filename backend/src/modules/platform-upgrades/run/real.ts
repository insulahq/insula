/**
 * ADR-064 — wiring of the run machine to the cluster and the database, and the
 * start of a run. Kept apart from the pure modules so those stay testable.
 */
import type { HostMigrationNodeStatus } from '@insula/api-contracts';
import { toSafeText } from '@insula/api-contracts';
import type { Database } from '../../../db/index.js';
import type { PlatformUpgradeRunRow } from '../../../db/schema.js';
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import { resolvePlatformImage } from '../../../shared/platform-images.js';
import { finalizeByRef, progressByRef, start as startTask } from '../../tasks/service.js';
import { dbSettings, runUpgrade } from '../orchestrate.js';
import { captureUpgradeRescue, realRollbackDeps } from '../rollback.js';
import { readHostMigrationStatus } from '../host-migration-status.js';
import { buildNodePlan, NODE_PLAN_KINDS, type NodePlanKind } from './node-plan.js';
import { applyNodePlan, deleteNodePlan, deletePlanNamed, listJobsForPlans, listNodeFacts, listPlanJobs, planExists } from './k8s.js';
import { K3S_PLAN_NAMES, buildRunK3sPlans, lowestKubelet } from './k8s-step.js';
import { updateRun, createRun, getActiveRun, transitionRun, type NewRunInput } from './store.js';
import { ApiError } from '../../../shared/errors.js';
import type { RunMachineDeps } from './machine.js';

/**
 * How the services step re-pins: exactly the run's version, as an already-decided
 * upgrade. Never the 'auto' decision — that re-derives the target from whatever
 * release is available NOW, so a newer release verified while the nodes prepared
 * would roll the services to a version the nodes never took. Automatic updates
 * decided (stable, not BREAKING, in the window, pre-flight) when they started the run.
 */
export function servicesRepinFor(run: Pick<PlatformUpgradeRunRow, 'toVersion'>): { readonly mode: 'manual'; readonly requestedVersion: string } {
  return { mode: 'manual', requestedVersion: run.toVersion };
}

export function nodeUpdateImage(env: NodeJS.ProcessEnv = process.env): string {
  return resolvePlatformImage('node-terminal', env);
}

async function applyPlanFor(k8s: K8sClients, run: PlatformUpgradeRunRow, kind: NodePlanKind): Promise<{ ok: boolean; reason?: string }> {
  const built = buildNodePlan(kind, run.toVersion, nodeUpdateImage(), run.excludedNodes ?? [], run.id);
  if (!built.ok) return { ok: false, reason: built.reason };
  try {
    await applyNodePlan(k8s, built.plan);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message.split('\n')[0]?.slice(0, 200) };
  }
}

export function realRunMachineDeps(db: Database, k8s: K8sClients, run: PlatformUpgradeRunRow): RunMachineDeps {
  const settings = dbSettings(db);
  return {
    now: () => Date.now(),
    nodes: () => listNodeFacts(k8s),
    nodeStatuses: async () => {
      const s = await readHostMigrationStatus(k8s, run.toVersion);
      return new Map<string, HostMigrationNodeStatus>(s.nodes.map((n) => [n.node, n]));
    },
    jobs: (kind, sinceMs) => listPlanJobs(k8s, kind, sinceMs),
    applyPlan: (kind) => applyPlanFor(k8s, run, kind),
    deletePlan: (kind) => deleteNodePlan(k8s, kind),
    startServices: async () => {
      const r = await runUpgrade(settings, k8s, {
        ...servicesRepinFor(run),
        apply: true,
        rollback: { capture: (input) => captureUpgradeRescue(realRollbackDeps(db, k8s), input).then((c) => ({ ok: c.ok, reason: c.reason })) },
      });
      return { applied: r.applied, summary: r.summary };
    },
    // The existing reconciler clears pending_update_version on a healthy
    // post-flight; the new platform-api records its version at startup.
    servicesState: async () => ({
      pending: ((await settings.get('pending_update_version')) ?? '').trim() || null,
      installed: ((await settings.get('installed_platform_version')) ?? '').trim().replace(/^v/, '') || null,
    }),
    update: (patch) => updateRun(db, run.id, patch),
    transition: (fromStep, patch) => transitionRun(db, run.id, fromStep, patch),
    finalize: async (status, message) => {
      await finalizeByRef(db, 'platform.upgrade', run.toVersion, {
        status,
        error: message,
        detailsPatch: { runId: run.id, toVersion: run.toVersion, finishedAtIso: new Date().toISOString() },
        recreate: {
          scope: 'system',
          userId: null,
          label: toSafeText(`Platform upgrade → ${run.toVersion}`),
          target: { type: 'modal', modal: 'platform-upgrade', modalProps: { version: run.toVersion } },
        },
      }).catch((err) => console.error('[upgrade-run] task finalize failed:', (err as Error).message));
    },
    progress: (pct, text) => progressByRef(db, 'platform.upgrade', run.toVersion, { pct, text: toSafeText(text) })
      .catch(() => { /* best-effort */ }),
    applyKubernetesPlans: async () => {
      if (!run.kubernetesVersion) return { ok: false, reason: 'no Kubernetes target' };
      const excluded = run.excludedNodes ?? [];
      const current = lowestKubelet((await listNodeFacts(k8s)).filter((n) => !excluded.includes(n.name)));
      if (!current) return { ok: false, reason: 'the nodes\' Kubernetes version could not be read' };
      const built = buildRunK3sPlans(run.kubernetesVersion, current, excluded);
      if (!built.ok) return { ok: false, reason: built.reason };
      try {
        for (const plan of built.plans) await applyNodePlan(k8s, plan);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: (err as Error).message.split('\n')[0]?.slice(0, 200) };
      }
    },
    deleteKubernetesPlans: async () => {
      for (const name of K3S_PLAN_NAMES) await deletePlanNamed(k8s, name);
    },
    kubernetesJobs: (sinceMs) => listJobsForPlans(k8s, K3S_PLAN_NAMES, sinceMs),
    kubernetesPlansExist: async () => (await Promise.all(K3S_PLAN_NAMES.map((n) => planExists(k8s, n)))).every(Boolean),
  };
}

/**
 * Start a run: record it, then push the release to the nodes. A Plan that cannot
 * be created fails the run on the spot — nothing has changed yet.
 */
export async function startUpgradeRun(db: Database, k8s: K8sClients, input: NewRunInput): Promise<PlatformUpgradeRunRow> {
  const run = await createRun(db, input);
  const p = await applyPlanFor(k8s, run, 'update');
  if (!p.ok) {
    const message = `Could not start the node update: ${p.reason ?? 'unknown'}. Nothing was changed.`;
    await transitionRun(db, run.id, null, { status: 'failed', message, finishedAt: new Date() });
    return { ...run, status: 'failed', message };
  }
  return run;
}

/**
 * Start a run and the re-openable Task Center task that tracks it (refId = the
 * target; the run finalizes it). The task is best-effort: a task-center failure
 * must never fail an upgrade that already started. Used by the API's Apply, by
 * automatic updates and by `insula upgrade --apply`.
 */
export async function startRunWithTask(db: Database, k8s: K8sClients, input: NewRunInput): Promise<PlatformUpgradeRunRow> {
  const run = await startUpgradeRun(db, k8s, input);
  if (run.status === 'running') {
    await startTask(db, {
      kind: 'platform.upgrade',
      refId: input.toVersion,
      scope: 'system',
      userId: null,
      label: toSafeText(`${input.mode === 'auto' ? 'Automatic upgrade' : 'Platform upgrade'} → ${input.toVersion}`),
      target: { type: 'modal', modal: 'platform-upgrade', modalProps: { version: input.toVersion } },
      progressPct: 0,
      progressText: toSafeText('Preparing nodes'),
      details: { toVersion: input.toVersion, runId: run.id, excludedNodes: [...input.excludedNodes], initiatedBy: input.initiatedBy, mode: input.mode },
    }).catch((err) => console.error('[upgrade-run] task-center start failed (upgrade still started):', (err as Error).message));
  }
  return run;
}

/** Automatic updates (ADR-064 §7): the caller already checked the window and the pre-flight. */
export async function startAutoRun(db: Database, k8s: K8sClients, target: string): Promise<{ readonly started: boolean; readonly message: string }> {
  const installed = (await dbSettings(db).get('installed_platform_version'))?.trim() || null;
  try {
    const run = await startRunWithTask(db, k8s, { fromVersion: installed, toVersion: target, mode: 'auto', excludedNodes: [], initiatedBy: null });
    return run.status === 'running' ? { started: true, message: '' } : { started: false, message: run.message ?? 'the upgrade could not be started' };
  } catch (err) {
    return { started: false, message: (err as Error).message.split('\n')[0]?.slice(0, 200) ?? 'the upgrade could not be started' };
  }
}

/** End the run (only if still in `fromStep`, when given), then stop its Plans. null = it had moved on. */
async function endRun(
  db: Database,
  k8s: K8sClients,
  run: PlatformUpgradeRunRow,
  fromStep: string | null,
  status: 'cancelled' | 'rolled-back',
  message: string,
): Promise<PlatformUpgradeRunRow | null> {
  const finishedAt = new Date();
  if (!(await transitionRun(db, run.id, fromStep, { status, message, finishedAt }))) return null;
  for (const kind of NODE_PLAN_KINDS) {
    await deleteNodePlan(k8s, kind).catch((err) => console.error(`[upgrade-run] could not delete the ${kind} plan:`, (err as Error).message));
  }
  // The k3s Plans share their names with `insula cluster upgrade` — only a run in
  // its own Kubernetes step owns them.
  if (run.step === 'upgrade-kubernetes' && run.kubernetesVersion) {
    for (const name of K3S_PLAN_NAMES) {
      await deletePlanNamed(k8s, name).catch((err) => console.error(`[upgrade-run] could not delete ${name}:`, (err as Error).message));
    }
  }
  await realRunMachineDeps(db, k8s, run).finalize('cancelled', message);
  return { ...run, status, message, finishedAt };
}

/**
 * Cancel the run while it still prepares nodes — the services have not changed,
 * so nothing needs undoing. Nodes that already updated keep the new CLI and its
 * before-services host changes, which work with the release still running.
 */
export async function cancelPreparingRun(db: Database, k8s: K8sClients): Promise<PlatformUpgradeRunRow> {
  const run = await getActiveRun(db);
  if (!run) throw new ApiError('UPGRADE_RUN_NOT_FOUND', 'No upgrade is running.', 404);
  const past = new ApiError('UPGRADE_RUN_PAST_PREPARE', 'The services are already updating — use the rollback to go back.', 409);
  if (run.step !== 'prepare-nodes') throw past;
  // Conditional on the step: the reconciler may claim update-services at the same moment.
  const ended = await endRun(db, k8s, run, 'prepare-nodes', 'cancelled',
    'Cancelled by an operator before the services changed. The services still run the previous release.');
  if (!ended) throw past;
  return ended;
}

/** End whatever run is in flight (a rollback took over). No run is fine. */
export async function abortActiveRun(db: Database, k8s: K8sClients, message: string): Promise<void> {
  const run = await getActiveRun(db);
  if (run) await endRun(db, k8s, run, null, 'rolled-back', message);
}
