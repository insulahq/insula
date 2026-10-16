/**
 * ADR-064 §6 — what an upgrade restarts beside the management API and the panels.
 *
 * The interruption preview reads those three live. Everything else Flux applies (the mail
 * server, webmail, the platform database, the reconcilers) restarts only when the release
 * changes what its pods run, and nothing on the cluster knows that before the new manifests
 * are applied — so the release lists it, per earlier version, in its signed manifest
 * (scripts/release-workload-changes.py). This names each listed workload for an operator
 * and says what its restart does, from its live replicas and rollout strategy where a
 * Deployment's can be read.
 */
import type { ReleaseContents, ReleaseWorkloadChange, UpgradeChangesResponse, UpgradeWorkloadItem } from '@insula/api-contracts';
import { deploymentImpact, type DeploymentShape } from './progress.js';

export type UpgradeWorkloads = NonNullable<UpgradeChangesResponse['workloads']>;

export function workloadKey(w: Pick<ReleaseWorkloadChange, 'kind' | 'namespace' | 'name'>): string {
  return `${w.kind}/${w.namespace}/${w.name}`;
}

/** The interruption preview reads these live; listing them again would say it twice. */
const PREVIEWED = new Set(['Deployment/platform/platform-api', 'Deployment/platform/admin-panel', 'Deployment/platform/tenant-panel']);

interface Known {
  readonly label: string;
  /** What an operator's users notice while it restarts — only where that is known. */
  readonly consequence?: string;
}

const KNOWN: Readonly<Record<string, Known>> = {
  'Deployment/mail/stalwart-mail': {
    label: 'Mail server',
    consequence: 'no mail is received or sent meanwhile: sending servers retry, mail clients reconnect',
  },
  'Deployment/mail/bulwark': { label: 'Webmail (Bulwark)', consequence: 'open webmail sessions reconnect' },
  'Deployment/mail/roundcube': { label: 'Webmail (Roundcube)', consequence: 'open webmail sessions reconnect' },
  'DaemonSet/mail/mail-stack-standby-replicate': { label: 'Mail standby copy' },
  'DaemonSet/platform-system/sftp-gateway': { label: 'SFTP gateway', consequence: 'open SFTP sessions are cut; clients reconnect' },
  'DaemonSet/platform-system/firewall-reconciler': { label: 'Node firewall reconciler' },
  'DaemonSet/platform-system/host-config-reconciler': { label: 'Host configuration reconciler' },
  'DaemonSet/platform-system/security-probe': { label: 'Security probe' },
  'Deployment/crowdsec/crowdsec': { label: 'CrowdSec' },
  'DaemonSet/platform-system/crowdsec-agent': { label: 'CrowdSec agent' },
  'Deployment/monitoring/vmsingle': { label: 'Metrics store' },
  'Deployment/traefik/modsec-crs': { label: 'Web application firewall' },
  'Cluster/platform/system-db': { label: 'Platform database' },
};

// CNPG's default primaryUpdateMethod (k8s/base/database.yaml sets none) is `restart`: any
// replicas first, then the primary in place — so there is a gap with one instance or three.
const DATABASE_IMPACT =
  'the primary restarts in place (after any replicas) — the management API and panels wait until it is back, '
  + 'usually under a minute. Tenant databases are separate and keep running';

/** The review reads this many Deployments live at most; the rest say "restarts". */
const MAX_LIVE_READS = 50;

/**
 * One listed workload, named and described. `live` = its Deployment's spec when it could be
 * read — the spec it runs now; a release that also changes the rollout strategy rolls by the
 * new one, which the line does not know.
 */
export function describeWorkload(w: ReleaseWorkloadChange, live: DeploymentShape | undefined): UpgradeWorkloadItem {
  const known = KNOWN[workloadKey(w)];
  const label = known?.label ?? `${w.name} (${w.namespace})`;
  if (w.change === 'added') return { ...w, label, impact: 'new in this release — it starts' };
  if (w.change === 'removed') return { ...w, label, impact: 'no longer part of the platform — it is removed' };
  // A Deployment scaled to zero (Roundcube while Bulwark is the webmail) has nothing running to interrupt.
  if (w.kind === 'Deployment' && live?.replicas === 0) return { ...w, label, impact: 'not running (scaled to zero), so nothing is interrupted' };
  const base =
    w.kind === 'Cluster' ? DATABASE_IMPACT
      : w.kind === 'DaemonSet' ? 'one pod on each node, replaced node by node'
        : w.kind === 'StatefulSet' ? 'its pods are replaced one at a time'
          : live ? deploymentImpact(live) : 'restarts';
  return { ...w, label, impact: known?.consequence ? `${base}; ${known.consequence}` : base };
}

/** The Deployments the review should read live for the installed version's entry. */
export function deploymentsToRead(table: ReleaseContents['workloadChanges'], fromVersion: string | null): ReleaseWorkloadChange[] {
  const list = entryFor(table, fromVersion);
  return (list ?? [])
    .filter((w) => w.kind === 'Deployment' && w.change === 'restart' && !PREVIEWED.has(workloadKey(w)))
    .slice(0, MAX_LIVE_READS);
}

function entryFor(table: ReleaseContents['workloadChanges'], fromVersion: string | null): readonly ReleaseWorkloadChange[] | undefined {
  if (!table || !fromVersion || !Object.hasOwn(table, fromVersion)) return undefined;
  return table[fromVersion];
}

/** Everyone notices these two: no mail, and an API that waits for its database. */
const FIRST = new Set(['Deployment/mail/stalwart-mail', 'Cluster/platform/system-db']);

/** Restarts first — what users notice ahead of the rest — then what starts, then what goes. */
function rank(item: UpgradeWorkloadItem): number {
  if (item.change !== 'restart') return item.change === 'added' ? 3 : 4;
  if (FIRST.has(workloadKey(item))) return 0;
  return KNOWN[workloadKey(item)]?.consequence ? 1 : 2;
}

/**
 * Pure. known=false when the release lists nothing for the installed version: a release cut
 * before the table existed, a version older than it reaches, or a development build.
 */
export function upgradeWorkloads(
  table: ReleaseContents['workloadChanges'],
  fromVersion: string | null,
  live: ReadonlyMap<string, DeploymentShape> = new Map(),
): UpgradeWorkloads {
  const list = entryFor(table, fromVersion);
  if (!list) return { known: false, items: [] };
  const items = list
    .filter((w) => !PREVIEWED.has(workloadKey(w)))
    .map((w) => describeWorkload(w, live.get(workloadKey(w))))
    .map((item, i) => ({ item, i }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.i - b.i)
    .map(({ item }) => item);
  return { known: true, items };
}
