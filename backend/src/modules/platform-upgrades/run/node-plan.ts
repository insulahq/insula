/**
 * ADR-064 §2 — the system-upgrade-controller Plans that make every node act during
 * an upgrade, instead of waiting for its own update timer.
 *
 *   insula-node-update   step 1 (prepare nodes): fetch + verify the release's CLI
 *                        and converge — which applies the release's before-services
 *                        host-migrations (after-services ones are deferred: the
 *                        services still run the previous release).
 *   insula-node-finish   step 3 (finish): converge again, now that the services run
 *                        the release, so after-services host-migrations apply.
 *
 * The push carries only a VERSION. The node downloads that release's CLI and
 * verifies it against the key IT pins (/etc/platform/cosign.pub), failing closed,
 * exactly as its own timer does; a downgrade is refused. So a Plan can make a node
 * fetch a signed release sooner — never run anything else.
 *
 * Every value that reaches the job's command line is validated here: the version
 * against the release grammar, the image against an image-ref grammar, node names
 * as DNS-1123 subdomains. Nothing operator- or node-supplied is interpolated raw.
 */
import { isValidVersion } from '../../platform-updates/poller/semver.js';
import { imageRefValid } from '../../../cli/platform-ops/operations/k3s-plan.js';

export const SUC_NAMESPACE = 'system-upgrade';
export const NODE_UPDATE_PLAN = 'insula-node-update';
export const NODE_FINISH_PLAN = 'insula-node-finish';
export type NodePlanKind = 'update' | 'finish';
export const NODE_PLAN_KINDS: readonly NodePlanKind[] = ['update', 'finish'];

export const planNameFor = (kind: NodePlanKind): string => (kind === 'update' ? NODE_UPDATE_PLAN : NODE_FINISH_PLAN);

const NODE_NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
/** Release grammar, tighter than the general one: what may appear in a shell word. */
const SAFE_VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]{1,40})?$/;
const RUN_ID_RE = /^[0-9a-f-]{8,64}$/i;

export type NodePlanResult =
  | { readonly ok: true; readonly plan: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

/**
 * The host command each Plan's job runs, via nsenter into the host's PID 1
 * namespaces (the job is privileged with hostPID, like the k3s upgrade jobs).
 * `systemctl start` of the converge unit runs it exactly as the node's own timer
 * does — same sandbox, same status file — and returns non-zero when it fails,
 * so the controller retries the job.
 */
function hostCommand(kind: NodePlanKind, version: string): string {
  const converge = '/usr/bin/env systemctl start platform-ops-host-config.service';
  return kind === 'update'
    ? `/usr/local/bin/insula self-upgrade --version ${version} && ${converge}`
    : converge;
}

/**
 * Build one Plan. `runId` makes the Plan's version unique per run: the controller
 * marks a node done per (plan, version), so a retried run for the SAME release
 * would otherwise find every node already "done" and run nothing.
 */
export function buildNodePlan(
  kind: NodePlanKind,
  version: string,
  image: string,
  excluded: readonly string[],
  runId: string,
): NodePlanResult {
  if (!isValidVersion(version) || !SAFE_VERSION_RE.test(version)) {
    return { ok: false, reason: `refusing node plan for invalid version ${JSON.stringify(version)}` };
  }
  if (!imageRefValid(image)) {
    return { ok: false, reason: `refusing node plan with invalid image ${JSON.stringify(image)}` };
  }
  const bad = excluded.find((n) => !NODE_NAME_RE.test(n) || n.length > 253);
  if (bad !== undefined) return { ok: false, reason: `refusing node plan: ${JSON.stringify(bad)} is not a node name` };
  if (!RUN_ID_RE.test(runId)) return { ok: false, reason: 'refusing node plan: invalid run id' };

  const matchExpressions: Array<Record<string, unknown>> = [
    { key: 'kubernetes.io/os', operator: 'In', values: ['linux'] },
  ];
  if (excluded.length > 0) {
    matchExpressions.push({ key: 'kubernetes.io/hostname', operator: 'NotIn', values: [...excluded] });
  }

  return {
    ok: true,
    plan: {
      apiVersion: 'upgrade.cattle.io/v1',
      kind: 'Plan',
      metadata: {
        name: planNameFor(kind),
        namespace: SUC_NAMESPACE,
        labels: {
          'app.kubernetes.io/part-of': 'hosting-platform',
          'insula.host/managed-by': 'platform-api',
          'insula.host/upgrade-run': runId.slice(0, 63),
        },
      },
      spec: {
        // One node at a time: a host change that misbehaves stops at one node, and
        // a server's etcd member is never down together with another's.
        concurrency: 1,
        nodeSelector: { matchExpressions },
        // Servers carry control-plane / server-only taints; every node takes part.
        tolerations: [{ operator: 'Exists' }],
        serviceAccountName: 'system-upgrade',
        version: `${version}-run.${runId.replace(/-/g, '').slice(0, 12)}`,
        upgrade: {
          image,
          command: ['/bin/sh', '-c'],
          args: [`exec nsenter -t 1 -m -u -i -n -p -- /bin/sh -c '${hostCommand(kind, version)}'`],
        },
      },
    },
  };
}
