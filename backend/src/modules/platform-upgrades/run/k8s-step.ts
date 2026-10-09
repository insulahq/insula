/**
 * ADR-064 §8 — the opt-in Kubernetes step: k3s to the release's pin, through the
 * same system-upgrade-controller Plans `insula cluster upgrade` uses (servers one
 * at a time; agents drained, after every server). Pure.
 *
 * The Plans come from the CLI's validated builder (skip-a-minor, downgrade,
 * cross-major and no-op are refused there); platform-api writes them, so they
 * carry its label, and nodes the operator left out are left out of them too.
 */
import type { UpgradeRunNode } from '@insula/api-contracts';
import { buildK3sUpgradePlans, k3sVersionAtLeast, parseK3sVersion } from '../../../cli/platform-ops/operations/k3s-plan.js';
import { JOB_FAILURE_THRESHOLD, type NodeFacts, type NodeJobFacts } from './node-state.js';

export const K3S_PLAN_NAMES = ['k3s-server-upgrade', 'k3s-agent-upgrade'] as const;

const NODE_NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

/** The lowest kubelet version among the given nodes (what a hop must start from). */
export function lowestKubelet(nodes: readonly NodeFacts[]): string | null {
  let low: string | null = null;
  for (const n of nodes) {
    const v = n.kubeletVersion;
    if (!v || !parseK3sVersion(v)) continue;
    if (low === null || !k3sVersionAtLeast(v, low)) low = v;
  }
  return low;
}

/** Whether the step is worth offering: a newer target, at most one minor ahead. */
export function kubernetesOffer(current: string | null, target: string | null): { readonly offer: boolean; readonly reason: string | null } {
  if (!target) return { offer: false, reason: null };
  const t = parseK3sVersion(target);
  const c = current ? parseK3sVersion(current) : null;
  if (!t || !c) return { offer: false, reason: 'the cluster\'s Kubernetes version could not be read' };
  if (k3sVersionAtLeast(current as string, target)) return { offer: false, reason: null };
  if (t.major !== c.major) {
    return { offer: false, reason: `Kubernetes ${current} → ${target} changes the major version — not offered here` };
  }
  if (t.minor > c.minor + 1) {
    return { offer: false, reason: `Kubernetes ${current} → ${target} skips a minor version; run \`insula cluster upgrade\`, which steps one minor at a time` };
  }
  return { offer: true, reason: null };
}

export type K3sPlansResult =
  | { readonly ok: true; readonly plans: readonly Record<string, unknown>[] }
  | { readonly ok: false; readonly reason: string };

export function buildRunK3sPlans(target: string, current: string, excluded: readonly string[]): K3sPlansResult {
  const bad = excluded.find((n) => !NODE_NAME_RE.test(n) || n.length > 253);
  if (bad !== undefined) return { ok: false, reason: `refusing Kubernetes plans: ${JSON.stringify(bad)} is not a node name` };
  const r = buildK3sUpgradePlans(target, current);
  if (!r.ok) return r;
  const plans = r.plans.map((p) => {
    const meta = p.metadata as { labels?: Record<string, string> } & Record<string, unknown>;
    const spec = p.spec as { nodeSelector: { matchExpressions: Array<Record<string, unknown>> } } & Record<string, unknown>;
    return {
      ...p,
      metadata: { ...meta, labels: { ...(meta.labels ?? {}), 'insula.host/managed-by': 'platform-api' } },
      spec: {
        ...spec,
        nodeSelector: {
          matchExpressions: [
            ...spec.nodeSelector.matchExpressions,
            ...(excluded.length > 0 ? [{ key: 'kubernetes.io/hostname', operator: 'NotIn', values: [...excluded] }] : []),
          ],
        },
      },
    };
  });
  return { ok: true, plans };
}

/**
 * One node in the Kubernetes step. Done is the kubelet at the target AND the upgrade
 * controller's record that it finished there: the controller uncordons the node in
 * the same update that writes `plan.upgrade.cattle.io/<plan>` = the Plan's hash, and
 * it does neither once the Plan is gone — so ending the step on the kubelet alone
 * (deleting the Plans) could leave the last node cordoned.
 */
export function assessKubernetesNode(
  node: NodeFacts,
  job: NodeJobFacts | undefined,
  target: string,
  excluded: readonly string[],
  latestHash: ReadonlyMap<string, string>,
): UpgradeRunNode {
  const out = (state: UpgradeRunNode['state'], detail: string): UpgradeRunNode =>
    ({ node: node.name, state, cliVersion: null, detail, hostChanges: null });
  if (excluded.includes(node.name)) return out('excluded', 'Left out — run `insula cluster upgrade` on it when it is back.');
  const kubelet = node.kubeletVersion ?? null;
  const atTarget = !!kubelet && k3sVersionAtLeast(kubelet, target);
  // Either Plan: their selectors split the nodes (control-plane In / DoesNotExist),
  // so a node only ever carries the label of the one that selected it.
  const finished = K3S_PLAN_NAMES.some((p) => {
    const h = latestHash.get(p);
    return !!h && node.planHashes?.[p] === h;
  });
  if (atTarget && node.ready && finished) return out('ready', `Kubernetes ${kubelet}.`);
  const active = job?.active ?? 0;
  // Failed only once nothing is in flight: the controller retries a failed pod, and
  // ending the step (deleting its Plans) under a running k3s restart could leave the
  // node cordoned mid-upgrade. The controller leaves a failed node cordoned.
  if ((job?.failed ?? 0) >= JOB_FAILURE_THRESHOLD && active === 0) {
    const cordoned = node.unschedulable ? ' It stays cordoned until you uncordon it.' : '';
    return out('failed', `The Kubernetes upgrade failed ${job?.failed} times — see the job log in namespace system-upgrade.${cordoned}`);
  }
  if (active > 0 || (job?.succeeded ?? 0) > 0) {
    if (!node.ready) return out('updating', 'Restarting k3s…');
    if (atTarget) return out('updating', `Kubernetes ${kubelet} — waiting for the upgrade controller to finish with it.`);
    return out('updating', `Upgrading Kubernetes ${kubelet ?? '?'} → ${target}…`);
  }
  if (!node.ready) return out('waiting', 'Not Ready — the step waits for it.');
  if (atTarget) return out('queued', `On Kubernetes ${kubelet}; the upgrade controller confirms it in its turn.`);
  return out('queued', `On Kubernetes ${kubelet ?? '?'}; waiting for its turn (servers first, then workers).`);
}
