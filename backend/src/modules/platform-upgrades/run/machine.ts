/**
 * ADR-064 §1 — the upgrade run, one step at a time:
 *
 *   prepare-nodes ─▶ update-services ─▶ finish ─▶ done
 *
 * Advanced by the upgrade reconciler on every tick (lease-guarded: one actor).
 * Every step is resumable from the row alone, because the update-services step
 * rolls platform-api itself — the NEW release's pod picks the run up where the old
 * one left it. Step and status change only through `transition` (a conditional
 * update), so an operator's Cancel and the reconciler cannot both win, and a step
 * is claimed BEFORE its side effect: a crash after the claim resumes in the new
 * step, which re-does the side effect only if it never happened.
 *
 * update-services has no timeout of its own: once the services roll, the existing
 * post-flight reconciler judges them and, when they are not converging, raises
 * abort-recommended and notifies the admins. The way out from there is the
 * rollback, which ends the run.
 *
 * Failure semantics follow from the order:
 *  - a failure while preparing nodes stops the run BEFORE the services change: the
 *    nodes that did update hold the new CLI and its before-services host changes,
 *    which by contract work with the release still running;
 *  - once the services rolled, the run cannot fail back — a finish problem leaves
 *    the services on the new release and says which node needs attention.
 */
import type { HostMigrationNodeStatus, UpgradeRunNode } from '@insula/api-contracts';
import type { PlatformUpgradeRunRow } from '../../../db/schema.js';
import { assessRunNode, type NodeFacts, type NodeJobFacts } from './node-state.js';
import { assessKubernetesNode } from './k8s-step.js';
import type { NodePlanKind } from './node-plan.js';
import type { RunPatch } from './store.js';

/** How long nodes may take to fetch, verify and apply before-services changes. */
export const PREPARE_TIMEOUT_MS = 25 * 60 * 1000;
/** How long after-services changes may take once the services run the release. */
export const FINISH_TIMEOUT_MS = 20 * 60 * 1000;
/**
 * How long the opt-in Kubernetes step may take: nodes go one at a time (servers,
 * then agents drained), so the budget grows with them — 20 min a node, 60 at least.
 * It only runs out while no node's job is in flight.
 */
export function kubernetesTimeoutMs(nodeCount: number): number {
  return Math.max(60, 20 * nodeCount) * 60 * 1000;
}

type Band = readonly [number, number];
/** Where each step sits on the run's progress bar: thirds, or quarters with the Kubernetes step. */
export function progressBands(run: { readonly kubernetesVersion?: string | null }): {
  readonly prepare: Band; readonly services: Band; readonly finish: Band; readonly kubernetes: Band;
} {
  return run.kubernetesVersion
    ? { prepare: [0, 25], services: [25, 50], finish: [50, 75], kubernetes: [75, 100] }
    : { prepare: [0, 33], services: [33, 67], finish: [67, 100], kubernetes: [100, 100] };
}
export const atBand = (band: Band, share: number): number => band[0] + Math.round((band[1] - band[0]) * Math.min(Math.max(share, 0), 1));

export interface RunMachineDeps {
  readonly now: () => number;
  readonly nodes: () => Promise<readonly NodeFacts[]>;
  readonly nodeStatuses: () => Promise<ReadonlyMap<string, HostMigrationNodeStatus>>;
  readonly jobs: (kind: NodePlanKind, sinceMs: number) => Promise<ReadonlyMap<string, NodeJobFacts>>;
  /** Create/update the Plan for this run. */
  readonly applyPlan: (kind: NodePlanKind) => Promise<{ readonly ok: boolean; readonly reason?: string }>;
  readonly deletePlan: (kind: NodePlanKind) => Promise<void>;
  /** The Flux re-pin (rescue capture first). `applied` false = nothing changed. */
  readonly startServices: () => Promise<{ readonly applied: boolean; readonly summary: string }>;
  /**
   * Where the services stand: the re-pin's in-flight marker (cleared by the
   * post-flight reconciler on a healthy convergence) and the version the running
   * platform-api records at startup.
   */
  readonly servicesState: () => Promise<{ readonly pending: string | null; readonly installed: string | null }>;
  /** Persist the node view (no state change). */
  readonly update: (patch: RunPatch) => Promise<void>;
  /** Change step/status only if the run is still running (and in `fromStep`). false = someone else did. */
  readonly transition: (fromStep: string | null, patch: RunPatch) => Promise<boolean>;
  readonly finalize: (status: 'succeeded' | 'failed' | 'cancelled', message: string | null) => Promise<void>;
  readonly progress: (pct: number, text: string) => Promise<void>;
  /** ADR-064 §8: start the k3s Plans for the run's Kubernetes target. */
  readonly applyKubernetesPlans: () => Promise<{ readonly ok: boolean; readonly reason?: string }>;
  readonly deleteKubernetesPlans: () => Promise<void>;
  /**
   * Whether both k3s Plans exist (a crash between claiming the step and applying
   * them leaves none), and each Plan's current hash (status.latestHash) — what a
   * node's completion label is compared with.
   */
  readonly kubernetesPlans: () => Promise<{ readonly exist: boolean; readonly latestHash: ReadonlyMap<string, string> }>;
  readonly kubernetesJobs: (sinceMs: number) => Promise<ReadonlyMap<string, NodeJobFacts>>;
}

const names = (ns: readonly UpgradeRunNode[]): string => ns.map((n) => n.node).join(', ');
const sameNodes = (a: readonly unknown[], b: readonly unknown[]): boolean => JSON.stringify(a) === JSON.stringify(b);

async function nodeView(run: PlatformUpgradeRunRow, deps: RunMachineDeps, step: 'prepare-nodes' | 'finish', kind: NodePlanKind) {
  const [nodes, statuses, jobs] = await Promise.all([
    deps.nodes(),
    deps.nodeStatuses(),
    deps.jobs(kind, new Date(run.stepStartedAt).getTime()),
  ]);
  const view = nodes.map((n) => assessRunNode(step, n, statuses.get(n.name), jobs.get(n.name), run.toVersion, run.excludedNodes ?? []));
  if (!sameNodes(view, run.nodes ?? [])) await deps.update({ nodes: view as unknown as Array<Record<string, unknown>> });
  const included = view.filter((v) => v.state !== 'excluded');
  return { view, included, ready: included.filter((v) => v.state === 'ready'), failed: included.filter((v) => v.state === 'failed') };
}

async function fail(deps: RunMachineDeps, message: string): Promise<void> {
  // A cancel may have ended the run meanwhile — then it already said why.
  if (await deps.transition(null, { status: 'failed', message, finishedAt: new Date(deps.now()) })) {
    await deps.finalize('failed', message);
  }
}

/** Re-pin the services; a refusal fails the run (the nodes are fine either way). */
async function startServices(deps: RunMachineDeps): Promise<boolean> {
  const r = await deps.startServices();
  if (!r.applied) await fail(deps, `The nodes are ready, but the services were not changed: ${r.summary}`);
  return r.applied;
}

/** Advance one step if its condition is met. Returns the step the run is in afterwards. */
export async function advanceRun(run: PlatformUpgradeRunRow, deps: RunMachineDeps): Promise<string> {
  if (run.status !== 'running') return run.step;
  const elapsed = deps.now() - new Date(run.stepStartedAt).getTime();
  const target = run.toVersion;

  if (run.step === 'prepare-nodes') {
    const v = await nodeView(run, deps, 'prepare-nodes', 'update');
    const total = Math.max(v.included.length, 1);
    await deps.progress(atBand(progressBands(run).prepare, v.ready.length / total), `Preparing nodes ${v.ready.length}/${v.included.length}`);
    if (v.failed.length > 0) {
      await deps.deletePlan('update');
      await fail(deps, `Stopped before the services changed: ${names(v.failed)} — ${v.failed[0]?.detail ?? 'failed'}. `
        + `The services still run the previous release.`);
      return run.step;
    }
    if (v.ready.length === v.included.length) {
      const s = await deps.servicesState();
      // Claim the step BEFORE touching the services: a concurrent Cancel then
      // either wins (nothing re-pinned) or finds the run already past it.
      if (!(await deps.transition('prepare-nodes', { step: 'update-services', stepStartedAt: new Date(deps.now()), message: null }))) {
        return run.step;
      }
      await deps.deletePlan('update');
      // The services already run the target, or are rolling to it: a release
      // channel (Flux follows the newest tag — "services first", ADR-064 §9) or a
      // break-glass re-pin. Re-pinning again would only take a second rescue snapshot.
      if (s.installed === target || s.pending === target) return 'update-services';
      return (await startServices(deps)) ? 'update-services' : run.step;
    }
    if (elapsed > PREPARE_TIMEOUT_MS) {
      const late = v.included.filter((n) => n.state !== 'ready');
      await deps.deletePlan('update');
      await fail(deps, `Nodes did not finish preparing within ${PREPARE_TIMEOUT_MS / 60000} minutes: ${names(late)}. `
        + `The services still run the previous release.`);
    }
    return run.step;
  }

  if (run.step === 'update-services') {
    // Progress and the not-converging alert stay with the existing reconciler
    // (it owns pending_update_version); this only waits for its verdict.
    const s = await deps.servicesState();
    if (s.pending) return run.step;
    if (s.installed !== target) {
      // No re-pin in flight and the services are not on the target: the process
      // that claimed this step stopped before re-pinning. Do it now.
      await startServices(deps);
      return run.step;
    }
    const p = await deps.applyPlan('finish');
    if (!p.ok) {
      await fail(deps, `The services run ${target}, but the after-services host changes could not be started: ${p.reason ?? 'unknown'}.`);
      return run.step;
    }
    return (await deps.transition('update-services', { step: 'finish', stepStartedAt: new Date(deps.now()), message: null }))
      ? 'finish' : run.step;
  }

  if (run.step === 'finish') {
    const v = await nodeView(run, deps, 'finish', 'finish');
    const total = Math.max(v.included.length, 1);
    await deps.progress(atBand(progressBands(run).finish, v.ready.length / total), `Finishing host changes ${v.ready.length}/${v.included.length}`);
    if (v.failed.length > 0) {
      await deps.deletePlan('finish');
      await fail(deps, `The services run ${target}. Host changes after the services failed on ${names(v.failed)} — `
        + `${v.failed[0]?.detail ?? 'failed'}.`);
      return run.step;
    }
    if (v.ready.length === v.included.length) {
      await deps.deletePlan('finish');
      if (run.kubernetesVersion) {
        // Claim the step first (a rollback may end the run meanwhile), then start it.
        if (!(await deps.transition('finish', { step: 'upgrade-kubernetes', stepStartedAt: new Date(deps.now()), message: null }))) {
          return run.step;
        }
        const p = await deps.applyKubernetesPlans();
        if (!p.ok) {
          await fail(deps, `The services and host changes run ${target}, but the Kubernetes step could not start: ${p.reason ?? 'unknown'}.`);
          return 'upgrade-kubernetes';
        }
        return 'upgrade-kubernetes';
      }
      if (await deps.transition('finish', { status: 'succeeded', step: 'done', finishedAt: new Date(deps.now()), message: null })) {
        await deps.finalize('succeeded', null);
      }
      return 'done';
    }
    if (elapsed > FINISH_TIMEOUT_MS) {
      const late = v.included.filter((n) => n.state !== 'ready');
      await deps.deletePlan('finish');
      await fail(deps, `The services run ${target}, but host changes did not finish within ${FINISH_TIMEOUT_MS / 60000} minutes on `
        + `${names(late)}. They retry on the node's hourly converge.`);
    }
    return run.step;
  }

  if (run.step === 'upgrade-kubernetes' && run.kubernetesVersion) {
    const k8sTarget = run.kubernetesVersion;
    const [nodes, jobs, plans] = await Promise.all([
      deps.nodes(), deps.kubernetesJobs(new Date(run.stepStartedAt).getTime()), deps.kubernetesPlans(),
    ]);
    const view = nodes.map((n) => assessKubernetesNode(n, jobs.get(n.name), k8sTarget, run.excludedNodes ?? [], plans.latestHash));
    if (!sameNodes(view, run.nodes ?? [])) await deps.update({ nodes: view as unknown as Array<Record<string, unknown>> });
    const included = view.filter((n) => n.state !== 'excluded');
    const ready = included.filter((n) => n.state === 'ready');
    const failed = included.filter((n) => n.state === 'failed');
    const total = Math.max(included.length, 1);
    await deps.progress(atBand(progressBands(run).kubernetes, ready.length / total), `Kubernetes ${k8sTarget} ${ready.length}/${included.length}`);
    // Resumable like every step: a crash after the claim, before the Plans were
    // created, finds none here and creates them (applying is create-or-patch).
    if (ready.length < included.length && failed.length === 0 && !plans.exist) {
      const p = await deps.applyKubernetesPlans();
      if (!p.ok) {
        await fail(deps, `The services and host changes run ${target}, but the Kubernetes step could not start: ${p.reason ?? 'unknown'}.`);
      }
      return run.step;
    }
    if (failed.length > 0) {
      await deps.deleteKubernetesPlans();
      await fail(deps, `The services and host changes run ${target}. The Kubernetes upgrade to ${k8sTarget} stopped on `
        + `${names(failed)} — ${failed[0]?.detail ?? 'failed'}`);
      return run.step;
    }
    if (ready.length === included.length) {
      await deps.deleteKubernetesPlans();
      if (await deps.transition('upgrade-kubernetes', { status: 'succeeded', step: 'done', finishedAt: new Date(deps.now()), message: null })) {
        await deps.finalize('succeeded', null);
      }
      return 'done';
    }
    // Never cut a k3s restart off mid-flight: the budget runs out only while no
    // job is running (each is bounded by the controller's own deadline). Judged on
    // the jobs, not on "updating" — a node waiting on a stalled controller must
    // not hold the step open forever.
    const timeoutMs = kubernetesTimeoutMs(included.length);
    if (elapsed > timeoutMs && !included.some((n) => (jobs.get(n.node)?.active ?? 0) > 0)) {
      const late = included.filter((n) => n.state !== 'ready');
      await deps.deleteKubernetesPlans();
      await fail(deps, `The services and host changes run ${target}, but Kubernetes did not reach ${k8sTarget} within `
        + `${timeoutMs / 60000} minutes on ${names(late)}.`);
    }
    return run.step;
  }
  return run.step;
}
