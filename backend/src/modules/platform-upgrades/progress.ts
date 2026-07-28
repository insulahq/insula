/**
 * Live upgrade progress + interruption preview (2026-07-28).
 *
 * A platform upgrade is a Flux APP re-pin: it rolls the platform's own
 * Deployments (management API, admin/tenant panels, reconcilers) to the new
 * image tag. It does NOT roll the nodes and does NOT touch tenant workloads —
 * tenant sites/DBs keep serving throughout. So:
 *   - PROGRESS is "how many platform Deployments have reached the target image
 *     and are Available" — a live per-Deployment view the UI renders as a bar.
 *   - INTERRUPTION is "which platform control-plane services briefly restart",
 *     plus the single-node caveat: with one replica there is no rolling
 *     redundancy, so the API/panel has a short hard-unavailable window.
 *
 * Both read the live cluster; neither mutates anything.
 */
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const PLATFORM_NS = 'platform';

/** Friendly labels for the well-known platform Deployments (fallback: the raw name). */
const SERVICE_LABELS: Record<string, string> = {
  'platform-api': 'Management API',
  'admin-panel': 'Admin panel',
  'tenant-panel': 'Tenant panel',
  'oauth2-proxy': 'OAuth2 proxy (admin SSO gate)',
  dex: 'Dex (OIDC, dev/staging only)',
};

/**
 * A platform-version image tag: CalVer `YYYY.M.PATCH[-rc.N]`. Only Deployments
 * carrying such a tag (management API, admin/tenant panels) actually roll on a
 * version bump — oauth2-proxy (`v7.x`), Dex (`v2.x`) and the reconcilers
 * (build-snapshot tags like `20260728…`) keep their images across upgrades, so
 * they must NOT count toward the progress bar or it could never reach 100%.
 */
const PLATFORM_VERSION_TAG = /^\d{4}\.\d{1,2}\.\d+(-rc\.\d+)?$/;

export interface DeploymentProgress {
  readonly name: string;
  readonly label: string;
  readonly desiredReplicas: number;
  readonly readyReplicas: number;
  readonly imageTag: string | null;
  /** true when the image is a platform-version tag (so it rolls on an upgrade). */
  readonly versionManaged: boolean;
  /** true when every container image is at `targetTag` AND the Deployment is Available. */
  readonly atTarget: boolean;
}

export interface UpgradeProgress {
  readonly targetTag: string | null; // the tag being rolled to (null when idle)
  readonly total: number;
  readonly atTarget: number;
  readonly ready: number;
  readonly percent: number; // atTarget / total * 100, rounded
  readonly deployments: readonly DeploymentProgress[];
  readonly readable: boolean;
}

type RawDeploy = {
  metadata?: { name?: string };
  spec?: { replicas?: number; template?: { spec?: { containers?: Array<{ image?: string }> } } };
  status?: { readyReplicas?: number; availableReplicas?: number };
};

function tagOf(image: string | undefined): string | null {
  if (!image) return null;
  const at = image.lastIndexOf(':');
  return at > 0 ? image.slice(at + 1) : null;
}

/**
 * Live per-Deployment roll progress for the platform namespace. When `targetTag`
 * is given (the release the operator is rolling to), `atTarget` counts the
 * Deployments already on that tag AND Available — that is the progress signal
 * the UI shows as a bar. With no target it still reports readiness.
 */
export async function collectUpgradeProgress(
  k8s: K8sClients,
  targetTag: string | null,
): Promise<UpgradeProgress> {
  let items: RawDeploy[];
  try {
    const list = (await k8s.apps.listNamespacedDeployment({
      namespace: PLATFORM_NS,
    } as unknown as Parameters<typeof k8s.apps.listNamespacedDeployment>[0])) as { items?: RawDeploy[] };
    items = list.items ?? [];
  } catch {
    return { targetTag, total: 0, atTarget: 0, ready: 0, percent: 0, deployments: [], readable: false };
  }

  const all: DeploymentProgress[] = items.map((d) => {
    const name = d.metadata?.name ?? '<unknown>';
    const desired = d.spec?.replicas ?? 1;
    const ready = d.status?.readyReplicas ?? 0;
    const available = d.status?.availableReplicas ?? 0;
    const containers = d.spec?.template?.spec?.containers ?? [];
    const tags = containers.map((c) => tagOf(c.image));
    const imageTag = tags[0] ?? null;
    const versionManaged = tags.some((t) => t !== null && PLATFORM_VERSION_TAG.test(t));
    // At target when every version tag matches the target AND the Deployment has
    // at least its desired replicas Available. Without a target, fall back to
    // plain availability so the bar is still meaningful mid-roll.
    const onTag = targetTag
      ? tags.every((t) => t === null || !PLATFORM_VERSION_TAG.test(t) || t === targetTag)
      : true;
    const atTarget = versionManaged && onTag && available >= desired;
    return { name, label: SERVICE_LABELS[name] ?? name, desiredReplicas: desired, readyReplicas: ready, imageTag, versionManaged, atTarget };
  });

  // The progress bar tracks ONLY version-managed Deployments (the ones that roll
  // on a version bump). Reconcilers / external images are excluded.
  const deployments = all.filter((d) => d.versionManaged);
  const total = deployments.length;
  const atTarget = deployments.filter((d) => d.atTarget).length;
  const ready = deployments.filter((d) => d.readyReplicas >= d.desiredReplicas).length;
  const percent = total > 0 ? Math.round((atTarget / total) * 100) : 0;
  return { targetTag, total, atTarget, ready, percent, deployments, readable: true };
}

export interface AffectedService {
  readonly name: string;
  readonly label: string;
  readonly impact: string;
}

export interface InterruptionPreview {
  /** Control-plane services that briefly restart during the roll. */
  readonly services: readonly AffectedService[];
  /** Cluster node count (server + worker). */
  readonly nodeCount: number | null;
  /** true when the platform runs on a single node → no rolling redundancy. */
  readonly singleNode: boolean;
  /** Plain-language headline the UI shows above the service list. */
  readonly summary: string;
  /** Whether tenant-facing websites/databases are affected (they are NOT by an
   *  app re-pin — included so the UI can state it explicitly and reassure). */
  readonly tenantWorkloadsAffected: boolean;
}

/**
 * Preview what an upgrade will interrupt, BEFORE the operator commits. Computed
 * from the live platform Deployments (the ones that will restart) + the node
 * count (single-node → hard-unavailability window). Read-only.
 */
export async function computeInterruptionPreview(k8s: K8sClients): Promise<InterruptionPreview> {
  let nodeCount: number | null = null;
  try {
    const nodes = (await k8s.core.listNode()) as { items?: unknown[] };
    nodeCount = (nodes.items ?? []).length;
  } catch {
    nodeCount = null;
  }
  const singleNode = nodeCount === 1;

  let services: AffectedService[] = [];
  try {
    const list = (await k8s.apps.listNamespacedDeployment({
      namespace: PLATFORM_NS,
    } as unknown as Parameters<typeof k8s.apps.listNamespacedDeployment>[0])) as { items?: RawDeploy[] };
    // Only the control-plane Deployments that serve operator/tenant traffic are
    // worth calling out (the reconcilers restart invisibly). Highlight the
    // user-facing ones; note single-node makes each a hard gap not a rolling one.
    const userFacing = new Set(['platform-api', 'admin-panel', 'tenant-panel']);
    services = (list.items ?? [])
      .map((d) => d.metadata?.name ?? '')
      .filter((n) => userFacing.has(n))
      .map((n) => ({
        name: n,
        label: SERVICE_LABELS[n] ?? n,
        impact: singleNode
          ? 'brief hard-unavailability while its single replica restarts (~30–90s)'
          : 'rolling restart — stays available via its other replica',
      }));
  } catch {
    services = [];
  }

  const summary = singleNode
    ? 'Single-node cluster: the admin panel, tenant panel, and management API each run one replica, so each has a short hard-unavailable window (~30–90s) while it restarts. Tenant websites and databases are NOT rolled and keep serving.'
    : 'The admin panel, tenant panel, and management API restart one replica at a time and stay available throughout. Tenant websites and databases are NOT rolled and keep serving.';

  return { services, nodeCount, singleNode, summary, tenantWorkloadsAffected: false };
}
