/**
 * ADR-064 — pure: where each node stands in an upgrade run.
 *
 * Inputs are three independent views, each of which can lag or lie on its own:
 *   - the Kubernetes Node (Ready or not),
 *   - the node's own relayed host-migration status (its CLI version and per-script
 *     state, written by its converge, published by the host-config-reconciler),
 *   - the upgrade controller's job for that node (running / failed attempts).
 * A node is `ready` only on the node's OWN report — a job that exited 0 says the
 * command ran, not that the node now runs the release and applied its changes.
 */
import type { HostMigrationNodeStatus, UpgradeRunNode, UpgradeRunStep } from '@insula/api-contracts';
import { compareVersions, parseVersion } from '../../platform-updates/poller/semver.js';

/** Failed job attempts before a node counts as failed (the controller retries meanwhile). */
export const JOB_FAILURE_THRESHOLD = 3;

export interface NodeFacts {
  readonly name: string;
  readonly ready: boolean;
}

export interface NodeJobFacts {
  readonly active: number;
  readonly failed: number;
  readonly succeeded: number;
}

const base = (v: string): string | null => {
  const p = parseVersion(v.trim().replace(/^v/, ''));
  return p ? `${p.major}.${p.minor}.${p.patch}` : null;
};

/** Release dir of a migration key (`2026.10.7/0001-x.sh` → `2026.10.7`). */
const releaseOf = (key: string): string => key.split('/')[0] ?? '';

/** Items that belong to releases up to (and including) the target's release. */
function upToTarget(status: HostMigrationNodeStatus | undefined, target: string) {
  const b = base(target);
  if (!status || !b) return [];
  return status.items.filter((i) => {
    const r = releaseOf(i.key);
    return parseVersion(r) !== null && compareVersions(r, b) <= 0;
  });
}

/** The node's CLI is at least the target release. */
export function cliAtTarget(cliVersion: string | null | undefined, target: string): boolean {
  if (!cliVersion || !parseVersion(cliVersion) || !parseVersion(target)) return false;
  return compareVersions(cliVersion, target) >= 0;
}

/**
 * Pure: one node's state in the given step.
 *  - prepare-nodes: ready once its CLI is the release and nothing before-services
 *    up to the release failed or is pending;
 *  - finish: ready once, additionally, no after-services script up to the release
 *    is still deferred.
 */
export function assessRunNode(
  step: UpgradeRunStep,
  node: NodeFacts,
  status: HostMigrationNodeStatus | undefined,
  job: NodeJobFacts | undefined,
  target: string,
  excluded: readonly string[],
): UpgradeRunNode {
  const cliVersion = status?.cliVersion ?? null;
  const out = (state: UpgradeRunNode['state'], detail: string): UpgradeRunNode => ({ node: node.name, state, cliVersion, detail });

  if (excluded.includes(node.name)) {
    return out('excluded', 'Upgraded without it — it updates on its own timer when it is back.');
  }
  if (!node.ready) {
    return out('waiting', 'Not Ready — the upgrade waits for it. Restart the upgrade with this node excluded to go on without it.');
  }

  const items = upToTarget(status, target);
  const broken = items.find((i) => i.state === 'run-failed' || i.state === 'blocked' || i.state === 'invalid');
  const atTarget = cliAtTarget(cliVersion, target);
  const deferred = items.filter((i) => i.state === 'deferred');
  const pendingBefore = items.filter((i) => i.state === 'would-run' && i.phase !== 'after-services');
  const done = atTarget && !broken && pendingBefore.length === 0
    && (step !== 'finish' || deferred.length === 0);
  // The node's own report decides first: a job's failed count only grows, so a
  // node that needed a few attempts and then converged is ready, not failed.
  if (done) {
    return out('ready', step === 'finish'
      ? `On ${cliVersion}; all host changes applied.`
      : `On ${cliVersion}; host changes before the services applied${deferred.length ? ` (${deferred.length} wait for the services)` : ''}.`);
  }
  if ((job?.failed ?? 0) >= JOB_FAILURE_THRESHOLD) {
    return out('failed', broken
      ? `Host change ${broken.key} failed${broken.error ? `: ${broken.error}` : ''}`
      : `The node update failed ${job?.failed} times — see the job log in namespace system-upgrade.`);
  }

  if ((job?.active ?? 0) > 0 || (job?.failed ?? 0) > 0) {
    return out('updating', broken
      ? `Retrying: host change ${broken.key} failed${broken.error ? ` (${broken.error})` : ''}.`
      : atTarget ? 'Applying host changes…' : `Fetching and verifying the ${target} CLI…`);
  }
  if (atTarget && step === 'finish' && deferred.length > 0) {
    return out('queued', `${deferred.length} host change(s) waiting to run now that the services are on ${target}.`);
  }
  return out('queued', atTarget ? 'Waiting for its turn.' : `On ${cliVersion ?? 'an older CLI'}; waiting for its turn.`);
}
