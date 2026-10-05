/**
 * Cluster I/O for the `crowdsec-agent-simulation` ConfigMap, with
 * compare-and-swap writes.
 *
 * WHY COMPARE-AND-SWAP
 *
 * Every change is read-modify-write: toggle ONE scenario, or flip the global
 * switch, on top of whatever the ConfigMap holds. Two overlapping writes — two
 * scenario toggles clicked in quick succession, or the same from two of the
 * three platform-api replicas — would otherwise both compute from the same
 * read, and the later one would silently drop the other's change: a scenario
 * the operator just set to alert-only keeps BANNING while the UI said
 * success. So every write carries the `metadata.resourceVersion` of the read
 * it was computed from. The apiserver answers 409 Conflict when the object
 * changed in between (verified on DEV with a stale resourceVersion on a merge
 * patch, `--dry-run=server`), and the caller re-reads, re-applies its ONE
 * intended change and tries again — at most MAX_CAS_ATTEMPTS times.
 *
 * Every successful write also stamps WRITTEN_AT_ANNOTATION. A merge patch
 * that changes nothing is a no-op the apiserver does not persist, so the
 * resourceVersion would not move — and a writer that must invalidate other
 * writers' reads (the operator's on/off toggle, see convergeDetection) needs
 * it to move.
 */
import * as k8s from '@kubernetes/client-node';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import {
  DEFAULT_SIMULATED_SCENARIOS,
  SIMULATION_CONFIGMAP_NAME,
  agentConfigUnchanged,
  simulationConfigMapData,
  simulationStateFromData,
  type SimulationState,
} from './crowdsec-simulation-config.js';

export const AGENT_NAMESPACE = 'platform-system';
const AGENT_DAEMONSET_NAME = 'crowdsec-agent';
export const MAX_CAS_ATTEMPTS = 5;
export const WRITTEN_AT_ANNOTATION = 'insula.host/simulation-written-at';

/** Thrown when every compare-and-swap attempt lost to a concurrent writer. */
export class SimulationConfigConflictError extends Error {
  constructor(readonly attempts: number) {
    super(
      `the agent's simulation config kept changing while it was being written `
      + `(${attempts} attempts, each beaten by another change) — nothing was overwritten`,
    );
    this.name = 'SimulationConfigConflictError';
  }
}

/** The ConfigMap as read: its state plus the version a write must match. */
export interface SimulationSnapshot {
  /** null when the agent file key is missing from an existing ConfigMap. */
  readonly state: SimulationState | null;
  readonly resourceVersion: string;
}

export interface RollResult {
  readonly rolledPods: number;
  readonly rollError: string | null;
}

function errorCode(err: unknown): number | undefined {
  return (err as { statusCode?: number; code?: number })?.statusCode
    ?? (err as { code?: number })?.code;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** null = the ConfigMap does not exist. */
export async function readSnapshot(kc: k8s.KubeConfig): Promise<SimulationSnapshot | null> {
  const core = kc.makeApiClient(k8s.CoreV1Api);
  try {
    const cm = await core.readNamespacedConfigMap({
      name: SIMULATION_CONFIGMAP_NAME, namespace: AGENT_NAMESPACE,
    }) as { data?: Record<string, string>; metadata?: { resourceVersion?: string } };
    return {
      state: simulationStateFromData(cm.data),
      resourceVersion: String(cm.metadata?.resourceVersion ?? ''),
    };
  } catch (err) {
    if (errorCode(err) === 404) return null;
    throw err;
  }
}

/**
 * Create the ConfigMap. 'conflict' when another writer created it first —
 * HA boots 2-3 replicas together and each runs the startup ensure.
 */
async function createConfigMap(
  kc: k8s.KubeConfig,
  alertOnly: readonly string[],
  detectionEnabled: boolean,
): Promise<'written' | 'conflict'> {
  const core = kc.makeApiClient(k8s.CoreV1Api);
  try {
    await core.createNamespacedConfigMap({
      namespace: AGENT_NAMESPACE,
      body: {
        metadata: {
          name: SIMULATION_CONFIGMAP_NAME,
          namespace: AGENT_NAMESPACE,
          labels: {
            'app.kubernetes.io/name': 'crowdsec-agent',
            'app.kubernetes.io/part-of': 'hosting-platform',
            'app.kubernetes.io/component': 'waf',
          },
          annotations: {
            'kustomize.toolkit.fluxcd.io/reconcile': 'disabled',
            [WRITTEN_AT_ANNOTATION]: new Date().toISOString(),
          },
        },
        data: simulationConfigMapData(alertOnly, detectionEnabled),
      },
    });
    return 'written';
  } catch (err) {
    if (errorCode(err) === 409) return 'conflict';
    throw err;
  }
}

/**
 * Write both keys IF the ConfigMap is still at `resourceVersion`.
 *
 * MERGE_PATCH, never replace: a full PUT would drop the `reconcile: disabled`
 * annotation that stops Flux reverting this very setting. (Also not the SDK
 * default: v1.4 sends `application/json-patch+json` for every PATCH and the
 * apiserver rejects a merge object.) The resourceVersion in the body is the
 * precondition — a stale one is answered with 409.
 */
async function patchIfUnchanged(
  kc: k8s.KubeConfig,
  resourceVersion: string,
  alertOnly: readonly string[],
  detectionEnabled: boolean,
): Promise<'written' | 'conflict'> {
  const core = kc.makeApiClient(k8s.CoreV1Api);
  try {
    await core.patchNamespacedConfigMap(
      {
        name: SIMULATION_CONFIGMAP_NAME,
        namespace: AGENT_NAMESPACE,
        body: {
          metadata: {
            resourceVersion,
            annotations: { [WRITTEN_AT_ANNOTATION]: new Date().toISOString() },
          },
          data: simulationConfigMapData(alertOnly, detectionEnabled),
        },
      },
      MERGE_PATCH,
    );
    return 'written';
  } catch (err) {
    if (errorCode(err) === 409) return 'conflict';
    throw err;
  }
}

/** Create when absent, else compare-and-swap against the snapshot. */
function writeAgainst(
  kc: k8s.KubeConfig,
  snap: SimulationSnapshot | null,
  alertOnly: readonly string[],
  detectionEnabled: boolean,
): Promise<'written' | 'conflict'> {
  return snap
    ? patchIfUnchanged(kc, snap.resourceVersion, alertOnly, detectionEnabled)
    : createConfigMap(kc, alertOnly, detectionEnabled);
}

/**
 * Roll the agent DaemonSet so it re-parses simulation.yaml.
 *
 * Deletes the pods rather than annotating the template: Flux treats a restart
 * annotation as git drift and scales the new generation back down, and the
 * DaemonSet controller recreates a deleted pod from the CURRENT template
 * immediately. A failure is REPORTED, not thrown: the config is already
 * saved, and an operator told "nothing happened" would toggle again.
 */
async function rollAgent(kc: k8s.KubeConfig): Promise<RollResult> {
  const core = kc.makeApiClient(k8s.CoreV1Api);
  try {
    const pods = await (core as unknown as {
      listNamespacedPod: (args: { namespace: string; labelSelector: string }) => Promise<{
        items: { metadata?: { name?: string } }[];
      }>;
    }).listNamespacedPod({
      namespace: AGENT_NAMESPACE,
      labelSelector: `app.kubernetes.io/name=${AGENT_DAEMONSET_NAME}`,
    });
    let deleted = 0;
    for (const pod of pods.items ?? []) {
      const name = pod.metadata?.name;
      if (!name) continue;
      try {
        await core.deleteNamespacedPod({ name, namespace: AGENT_NAMESPACE });
        deleted += 1;
      } catch { /* swallow — a pod already gone is the state we wanted */ }
    }
    return { rolledPods: deleted, rollError: null };
  } catch (err) {
    return { rolledPods: 0, rollError: errorMessage(err) };
  }
}

const NO_ROLL: RollResult = { rolledPods: 0, rollError: null };

export interface ConvergeResult extends RollResult {
  readonly outcome: 'created' | 'present' | 'reconciled';
  /** What the agent's config says after the call. */
  readonly enabled: boolean;
  readonly alertOnly: readonly string[];
}

/**
 * Bring the global on/off to the SAVED choice.
 *
 * `readDesired` reads platform_settings (null = never saved). ORDERING is the
 * point: the ConfigMap is read FIRST, the saved choice SECOND, then the write
 * is compare-and-swapped against that read. An operator's toggle saves to the
 * database before it writes the ConfigMap, so:
 *
 *   - if the toggle's ConfigMap write landed before our read, its database
 *     write landed before our database read — we see the new choice;
 *   - if it lands after our read, our write is either first (and the toggle
 *     re-reads and overwrites it) or second (and conflicts, and we
 *     re-evaluate from fresh reads).
 *
 * A stale boot-time value can therefore never overwrite a newer toggle.
 *
 * `touch` = write even when nothing changes. The toggle passes it so its
 * write moves the resourceVersion and invalidates any other writer's
 * in-flight read; the startup ensure does not, so booting never writes or
 * bounces the agent when nothing changed. Never-saved (null) leaves an
 * existing ConfigMap as it is; a missing one gets the shipped default.
 * Never touches the per-scenario list.
 */
export async function convergeDetection(
  kc: k8s.KubeConfig,
  readDesired: () => Promise<boolean | null>,
  opts: { readonly touch: boolean },
): Promise<ConvergeResult> {
  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
    const snap = await readSnapshot(kc);
    const desired = await readDesired();
    const current = snap?.state ?? null;
    const alertOnly = current?.alertOnly ?? DEFAULT_SIMULATED_SCENARIOS;
    // Never saved: keep what a healthy ConfigMap says. (One missing its agent
    // file is not healthy — the agent cannot mount it — so it is rewritten.)
    if (current && desired === null) {
      return { outcome: 'present', enabled: !current.globalSimulation, alertOnly, ...NO_ROLL };
    }
    const enabled = desired ?? true;
    const agentChanges = !agentConfigUnchanged(current, alertOnly, enabled);
    if (current && !agentChanges && !opts.touch) {
      return { outcome: 'present', enabled, alertOnly, ...NO_ROLL };
    }
    if (await writeAgainst(kc, snap, alertOnly, enabled) === 'conflict') continue;
    const roll = agentChanges ? await rollAgent(kc) : NO_ROLL;
    const outcome = !snap ? 'created' : agentChanges ? 'reconciled' : 'present';
    return { outcome, enabled, alertOnly, ...roll };
  }
  throw new SimulationConfigConflictError(MAX_CAS_ATTEMPTS);
}

/**
 * Set ONE scenario alert-only (or back to banning), re-applied on top of a
 * fresh read after every conflict so a concurrent change to another scenario
 * survives. Keeps the global on/off as the agent runs it; `readDesired` is
 * only consulted when the ConfigMap has to be created.
 */
export async function updateAlertOnly(
  kc: k8s.KubeConfig,
  name: string,
  simulated: boolean,
  readDesired: () => Promise<boolean | null>,
): Promise<{ simulated: string[] } & RollResult> {
  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
    const snap = await readSnapshot(kc);
    const current = snap?.state ?? null;
    const base = current?.alertOnly ?? DEFAULT_SIMULATED_SCENARIOS;
    const set = new Set(base);
    if (simulated) set.add(name); else set.delete(name);
    const next = [...set].sort();
    if (current && next.join('\n') === [...base].sort().join('\n')) {
      return { simulated: next, ...NO_ROLL };
    }
    const enabled = current ? !current.globalSimulation : ((await readDesired()) ?? true);
    const agentChanges = !agentConfigUnchanged(current, next, enabled);
    if (await writeAgainst(kc, snap, next, enabled) === 'conflict') continue;
    return { simulated: next, ...(agentChanges ? await rollAgent(kc) : NO_ROLL) };
  }
  throw new SimulationConfigConflictError(MAX_CAS_ATTEMPTS);
}
