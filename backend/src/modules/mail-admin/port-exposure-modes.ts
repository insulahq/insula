/**
 * Mail port exposure — three-mode core logic (2026-05-28).
 *
 * Pure helpers consumed by port-exposure.ts (Kubernetes-touching code)
 * and by routes.ts (HTTP boundary). Keeping the policy logic in pure
 * functions makes it unit-testable without spinning up a cluster.
 *
 * Modes:
 *   activeNodeOnly    → data plane = [active]
 *   assignedMailNodes → data plane = {primary, secondary, tertiary}
 *                       (refused at switch time if active not in set)
 *   allServerNodes    → data plane = server-role nodes ∪ {active if worker}
 *
 * Data plane = the set of node names that should be running haproxy
 * (or Stalwart's own hostPort, for activeNodeOnly). The haproxy DS
 * selects on `insula.host/mail-haproxy=true`; this
 * module's reconcileMailHaproxyLabels keeps that label set in sync
 * with the data plane.
 */

import type { CoreV1Api } from '@kubernetes/client-node';
import type { MailPortExposureMode } from '@insula/api-contracts';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';

export const MAIL_HAPROXY_LABEL_KEY = 'insula.host/mail-haproxy';
const NODE_ROLE_LABEL_KEY = 'insula.host/node-role';

export interface PlacementSettings {
  readonly primaryNode: string | null;
  readonly secondaryNode: string | null;
  readonly tertiaryNode: string | null;
  readonly activeNode: string | null;
}

export interface NodeRef {
  readonly metadata: {
    readonly name: string;
    readonly labels: Record<string, string>;
  };
}

/**
 * Pre-flight check for a mode change. Returns null when the switch is
 * safe; a human-readable error string when it would leave the data
 * plane inconsistent with operator intent.
 *
 * Only `assignedMailNodes` has a guard — it requires the active mail
 * node to be in the operator-chosen {primary, secondary, tertiary} set,
 * because that mode binds public mail traffic ONLY to those nodes. If
 * the active is elsewhere, external clients would hit haproxy on a
 * node that the Stalwart pod isn't on, then forward via ClusterIP
 * to the actual pod — that works, but it violates the "the assigned
 * set IS the public surface" contract operators set up in placement.
 * Better to make the operator align placement first (via Recover Mail
 * or by changing placement to include the active).
 */
export function validateModeSwitch(
  target: MailPortExposureMode,
  settings: PlacementSettings,
): string | null {
  if (target === 'activeNodeOnly') return null;
  if (target === 'allServerNodes') return null;
  // target === 'assignedMailNodes'
  const assigned = [settings.primaryNode, settings.secondaryNode, settings.tertiaryNode]
    .filter((n): n is string => !!n);
  if (assigned.length === 0) {
    return (
      'Cannot switch to assignedMailNodes mode: no nodes are assigned as primary, ' +
      'secondary, or tertiary mail node. Assign at least one in Email Operations → ' +
      'Placement before switching.'
    );
  }
  if (!settings.activeNode) {
    return (
      'Cannot switch to assignedMailNodes mode: no active mail node is set. The ' +
      'mode requires the active node to be one of the assigned mail nodes.'
    );
  }
  if (!assigned.includes(settings.activeNode)) {
    return (
      `Cannot switch to assignedMailNodes mode: active mail node '${settings.activeNode}' ` +
      `is not in the assigned set [${assigned.join(', ')}]. Migrate mail to one of the ` +
      `assigned nodes (Email Operations → Recover Mail) or change the placement so the ` +
      `assigned set includes '${settings.activeNode}' before switching.`
    );
  }
  return null;
}

/**
 * Compute the public-facing "data plane" — every node that exposes
 * mail ports to external clients. This is the OPERATOR-FACING set
 * (used for display).
 *
 * For internal orchestration prefer the two more-specific resolvers:
 *   - resolveHaproxyNodes:    where haproxy DS schedules (excludes active)
 *   - resolveExternalIpNodes: now always [] — externalIPs are no longer
 *                             used (the DNAT preempted haproxy + caused
 *                             tunnel-IP autoban; see that function's doc)
 *
 * The active node is ALWAYS in the public-facing set when there is
 * one, because Stalwart's hostPort exposes it directly via CNI portmap.
 *
 * Sort is alphabetical for stable label-reconciler output.
 */
export function resolveDataPlaneNodes(
  mode: MailPortExposureMode,
  settings: PlacementSettings,
  nodes: ReadonlyArray<NodeRef>,
): string[] {
  const known = new Set(nodes.map((n) => n.metadata.name));

  if (mode === 'activeNodeOnly') {
    return settings.activeNode && known.has(settings.activeNode)
      ? [settings.activeNode]
      : [];
  }

  if (mode === 'assignedMailNodes') {
    const assigned = [settings.primaryNode, settings.secondaryNode, settings.tertiaryNode]
      .filter((n): n is string => !!n && known.has(n));
    // Dedup + stable sort
    return Array.from(new Set(assigned)).sort();
  }

  // allServerNodes
  const out = new Set<string>();
  for (const n of nodes) {
    if (n.metadata.labels[NODE_ROLE_LABEL_KEY] === 'server') {
      out.add(n.metadata.name);
    }
  }
  // ALSO include the active node when it isn't server-role (worker
  // placements still need data-plane coverage so external mail
  // survives a server-tier outage).
  if (settings.activeNode && known.has(settings.activeNode)) {
    out.add(settings.activeNode);
  }
  return Array.from(out).sort();
}

/**
 * Compute the set of nodes that should run a haproxy DS pod.
 *
 * Excludes the active node in ALL haproxy-using modes because the
 * Stalwart Deployment ALWAYS binds hostPort=25 on the active node
 * (post-2026-05-28 hairpin fix), so haproxy hostPort=25 on the same
 * node would conflict. Returns [] for activeNodeOnly (no DS at all —
 * Stalwart hostPort is the only listener).
 *
 * Returns deduplicated, alphabetically sorted node names.
 */
export function resolveHaproxyNodes(
  mode: MailPortExposureMode,
  settings: PlacementSettings,
  nodes: ReadonlyArray<NodeRef>,
): string[] {
  if (mode === 'activeNodeOnly') return [];

  // Single-server deployments NEVER run haproxy: Stalwart binds the mail
  // hostPorts directly via CNI portmap (the always-on hostPort invariant).
  // haproxy exists only to forward external mail from OTHER nodes to the
  // active node — with a single node there are none, and a haproxy DS on
  // the sole node fights Stalwart for hostPort=25. This guard is load-
  // bearing on a fresh single-node bootstrap where `settings.activeNode`
  // is not yet recorded, so the active-node exclusion below is a no-op and
  // would otherwise schedule haproxy on the one node (regression, 2026-05-29).
  if (nodes.length <= 1) return [];

  const known = new Set(nodes.map((n) => n.metadata.name));
  let candidates: string[];

  if (mode === 'assignedMailNodes') {
    candidates = [settings.primaryNode, settings.secondaryNode, settings.tertiaryNode]
      .filter((n): n is string => !!n && known.has(n));
  } else {
    // allServerNodes — every server-role node
    candidates = nodes
      .filter((n) => n.metadata.labels[NODE_ROLE_LABEL_KEY] === 'server')
      .map((n) => n.metadata.name);
  }

  // Exclude active node (port conflict + hairpin avoidance — see file header).
  const active = settings.activeNode;
  const filtered = active ? candidates.filter((n) => n !== active) : candidates;
  return Array.from(new Set(filtered)).sort();
}

/**
 * Compute the set of node names whose IPs should be in
 * Service.spec.externalIPs.
 *
 * Returns `[]` ALWAYS (2026-06-29). The haproxy DaemonSet runs
 * `hostNetwork: true` and binds the public mail hostPorts directly on each
 * non-active node, so external mail reaches haproxy WITHOUT any Service
 * externalIP. The externalIP DNAT was not merely unnecessary — it was
 * actively HARMFUL on multi-node clusters:
 *
 *   - kube-proxy installs an externalIP PREROUTING DNAT that PREEMPTS the
 *     haproxy hostNetwork socket entirely. External mail was DNAT'd
 *     straight to the Stalwart pod and haproxy received ZERO external
 *     traffic, so PROXY-v2 never ran and the real client IP was lost.
 *   - Calico/WireGuard then MASQUERADES every cross-node connection to the
 *     origin node's pod-network tunnel IP (10.42.x). Every external client
 *     collapsed to ONE tunnel IP hammering all 6 mail ports, so Stalwart's
 *     `portScanning` autoban permanently banned that tunnel IP and killed
 *     mail on the node.
 *
 * Proven on multi-node staging 2026-06-29. The fix repoints haproxy
 * backends to Stalwart's DEDICATED PROXY-protocol listeners (which trust
 * the pod CIDR) so send-proxy-v2 is honored and Stalwart sees the REAL
 * client IP — no Service externalIP is needed or wanted anywhere.
 *
 * Params are retained for call-site compatibility but intentionally unused.
 */
export function resolveExternalIpNodes(
  _mode: MailPortExposureMode,
  _settings: PlacementSettings,
  _nodes: ReadonlyArray<NodeRef>,
): string[] {
  return [];
}

/**
 * Add `mail-haproxy=true` to every node in `dataPlane` that doesn't
 * already carry it; remove it from every node that DOES carry it but
 * isn't in `dataPlane`. Pure shim — never touches unrelated labels.
 *
 * Idempotent (same dataPlane → no-op on second call). Safe to call
 * after every mode change AND after every migration (active-node
 * changes can shift the set under modes activeNodeOnly + allServerNodes).
 *
 * NOTE: passes patches as a JSON merge-patch with the label value
 * `null` to delete. Strategic-merge would also work for labels but
 * merge-patch is simpler and labels aren't a list type. Field-manager
 * is not set — these labels are owned exclusively by the platform-api.
 */
export async function reconcileMailHaproxyLabels(
  core: Pick<CoreV1Api, 'patchNode'>,
  dataPlane: ReadonlyArray<string>,
  allNodes: ReadonlyArray<NodeRef>,
): Promise<void> {
  const desired = new Set(dataPlane);
  // patches issued sequentially (Kubernetes serialises per-resource
  // anyway; concurrent patches don't gain throughput and complicate
  // error reporting). 4-12 nodes max per cluster — negligible.
  for (const node of allNodes) {
    const hasLabel = node.metadata.labels[MAIL_HAPROXY_LABEL_KEY] === 'true';
    const shouldHave = desired.has(node.metadata.name);
    if (hasLabel === shouldHave) continue;
    // MERGE_PATCH (Content-Type: application/merge-patch+json, RFC 7396).
    // Without this, the SDK defaults to application/json-patch+json
    // which expects an array of JSON Patch ops; the merge-style body
    // we send below would error 400 with "cannot unmarshal object into
    // Go value of type []handlers.jsonPatchOp" — observed at staging
    // deploy time (2026-05-28).
    await core.patchNode(
      {
        name: node.metadata.name,
        body: {
          metadata: {
            labels: {
              [MAIL_HAPROXY_LABEL_KEY]: shouldHave ? 'true' : null,
            },
          },
        },
      } as unknown as Parameters<typeof core.patchNode>[0],
      MERGE_PATCH,
    );
  }
}
