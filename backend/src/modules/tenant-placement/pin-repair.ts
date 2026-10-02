/**
 * One-shot repair of node pins that redeploys stripped (an operator decision:
 * re-pin only tenants that are already where they belong).
 *
 * Every redeploy path (upgrade, config/credential redeploy, resource change)
 * called the catalog deployer without the tenant's pin, so a fleet-wide
 * redeploy left almost every tenant Deployment without its nodeSelector while
 * `tenants.node_name` still named the primary node. The code path is fixed;
 * this puts the pin back on the Deployments that already lost it.
 *
 * Only for tenants that are exactly where they belong — local tier, and every
 * workload, attachment and data replica on the primary node. Re-pinning such a
 * tenant restarts its pods on the node they already run on. A MISPLACED
 * tenant is left alone: pinning it would move it back and make Longhorn copy
 * its volume across, and that choice belongs to the operator (Placement card:
 * move it back, or make the node it is on its primary).
 *
 * One Deployment at a time, waiting for each rollout, so at most one tenant
 * app is restarting at any moment. Runs once per cluster: claimed with a
 * lease on `platform_settings`, marked done at the end, never again.
 * Kill switch: TENANT_PIN_REPAIR=disable.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';
import { STORAGE_QUIESCED_ANNOTATION } from '../../shared/scale-deployment.js';
import type { TenantPlacementObservation } from './compute.js';

export const PIN_REPAIR_KEY = 'tenant_pin_repair_v1';
const LEASE_MS = 30 * 60_000;
const ROLLOUT_TIMEOUT_MS = 5 * 60_000;
const ROLLOUT_POLL_MS = 3_000;
const HOSTNAME_LABEL = 'kubernetes.io/hostname';

export function pinRepairDisabled(): boolean {
  return (process.env.TENANT_PIN_REPAIR ?? '').toLowerCase() === 'disable';
}

export interface PinRepairResult {
  readonly state: 'running' | 'done';
  readonly leaseUntil?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  /** `namespace/deployment` re-pinned. */
  readonly repaired?: readonly string[];
  /** `namespace/deployment` re-pinned whose rollout did not finish in time. */
  readonly timedOut?: readonly string[];
  /** `namespace/deployment` whose patch failed. */
  readonly failed?: readonly string[];
  /** Tenants not touched, with why — misplaced, HA tier, storage op running. */
  readonly skipped?: readonly string[];
}

interface DeploymentLike {
  readonly metadata?: {
    readonly name?: string;
    readonly generation?: number;
    readonly annotations?: Record<string, string>;
  };
  readonly spec?: {
    readonly replicas?: number;
    readonly template?: { readonly spec?: { readonly nodeSelector?: Record<string, string> } };
  };
  readonly status?: {
    readonly observedGeneration?: number;
    readonly replicas?: number;
    readonly updatedReplicas?: number;
    readonly availableReplicas?: number;
  };
}

/** True when the Deployment's pods would not be held to `primary`. Pure. */
export function deploymentNeedsPin(deploy: DeploymentLike, primary: string): boolean {
  return deploy.spec?.template?.spec?.nodeSelector?.[HOSTNAME_LABEL] !== primary;
}

/** True once a rollout has fully replaced the pods. Pure. */
export function rolloutComplete(deploy: DeploymentLike): boolean {
  const want = deploy.spec?.replicas ?? 1;
  const s = deploy.status ?? {};
  return (s.observedGeneration ?? 0) >= (deploy.metadata?.generation ?? 0)
    && (s.updatedReplicas ?? 0) >= want
    && (s.availableReplicas ?? 0) >= want
    && (s.replicas ?? 0) === want;
}

export interface RepairCandidate {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly namespace: string;
  readonly primaryNode: string;
}

/**
 * Split the fleet into what the repair may touch and what it must not. Pure.
 * `storageIdle` — tenants with no storage operation in flight; a storage op
 * holds its Deployments and must not see a rollout under it.
 */
export function selectRepairCandidates(
  placements: readonly TenantPlacementObservation[],
  namespaces: ReadonlyMap<string, string>,
  storageIdle: ReadonlySet<string>,
): { candidates: RepairCandidate[]; skipped: string[] } {
  const candidates: RepairCandidate[] = [];
  const skipped: string[] = [];
  for (const p of [...placements].sort((a, b) => a.tenantName.localeCompare(b.tenantName))) {
    const ns = namespaces.get(p.tenantId);
    if (!ns || !p.primaryNode) continue;
    if (p.storageTier !== 'local') { skipped.push(`${p.tenantName}: HA tier (pins are soft)`); continue; }
    if (p.status !== 'placed') { skipped.push(`${p.tenantName}: ${p.status}${p.reasons.length ? ` (${p.reasons.join(', ')})` : ''}`); continue; }
    if (!storageIdle.has(p.tenantId)) { skipped.push(`${p.tenantName}: storage operation in progress`); continue; }
    candidates.push({ tenantId: p.tenantId, tenantName: p.tenantName, namespace: ns, primaryNode: p.primaryNode });
  }
  return { candidates, skipped };
}

async function writeState(db: Database, state: PinRepairResult): Promise<void> {
  await db.execute(sql`
    INSERT INTO platform_settings (setting_key, setting_value, updated_at)
    VALUES (${PIN_REPAIR_KEY}, ${JSON.stringify(state)}, now())
    ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = now()
  `);
}

/**
 * Take the repair: true for exactly one caller while it has never run, or a
 * previous run's lease expired (its replica died mid-run — already re-pinned
 * Deployments are skipped on the retry). False once it is done.
 */
export async function claimPinRepair(db: Database, now: Date): Promise<boolean> {
  const state: PinRepairResult = {
    state: 'running',
    startedAt: now.toISOString(),
    leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString(),
  };
  const res = await db.execute<{ setting_key: string }>(sql`
    INSERT INTO platform_settings (setting_key, setting_value, updated_at)
    VALUES (${PIN_REPAIR_KEY}, ${JSON.stringify(state)}, now())
    ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = now()
      WHERE (platform_settings.setting_value::jsonb ->> 'state') = 'running'
        AND (platform_settings.setting_value::jsonb ->> 'leaseUntil') < ${now.toISOString()}
    RETURNING setting_key
  `);
  return ((res as unknown as { rows?: unknown[] }).rows ?? []).length > 0;
}

export async function readPinRepairState(db: Database): Promise<PinRepairResult | null> {
  const res = await db.execute<{ setting_value: string }>(sql`
    SELECT setting_value FROM platform_settings WHERE setting_key = ${PIN_REPAIR_KEY}
  `);
  const raw = ((res as unknown as { rows?: Array<{ setting_value: string }> }).rows ?? [])[0]?.setting_value;
  if (!raw) return null;
  try { return JSON.parse(raw) as PinRepairResult; } catch { return null; }
}

export interface PinRepairDeps {
  readonly db: Database;
  readonly k8s: Pick<K8sClients, 'apps'>;
  readonly logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly rolloutTimeoutMs?: number;
}

async function waitForRollout(deps: PinRepairDeps, namespace: string, name: string): Promise<boolean> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now().getTime() + (deps.rolloutTimeoutMs ?? ROLLOUT_TIMEOUT_MS);
  while (now().getTime() < deadline) {
    await sleep(ROLLOUT_POLL_MS);
    try {
      const d = await deps.k8s.apps.readNamespacedDeployment({ name, namespace }) as DeploymentLike;
      if (rolloutComplete(d)) return true;
    } catch {
      // transient read failure: keep waiting until the deadline
    }
  }
  return false;
}

/**
 * Re-pin every candidate's Deployments, one at a time. The caller has already
 * claimed the run. Never throws: a failure on one Deployment is recorded and
 * the rest continue — each tenant is independent.
 */
export async function runPinRepair(
  deps: PinRepairDeps,
  candidates: readonly RepairCandidate[],
  skipped: readonly string[],
): Promise<PinRepairResult> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const repaired: string[] = [];
  const timedOut: string[] = [];
  const failed: string[] = [];

  for (const c of candidates) {
    // Renew before each tenant so a long run keeps its claim.
    await writeState(deps.db, {
      state: 'running', startedAt, leaseUntil: new Date(now().getTime() + LEASE_MS).toISOString(),
      repaired, timedOut, failed, skipped,
    }).catch(() => undefined);

    let items: DeploymentLike[] = [];
    try {
      const res = await deps.k8s.apps.listNamespacedDeployment({ namespace: c.namespace });
      items = (res.items ?? []) as DeploymentLike[];
    } catch (err) {
      failed.push(`${c.namespace}: list failed (${(err as Error).message})`);
      continue;
    }

    for (const d of items) {
      const name = d.metadata?.name;
      if (!name || !deploymentNeedsPin(d, c.primaryNode)) continue;
      // A storage operation holds this Deployment; a rollout under it would
      // fight the hold. The operation re-renders it when it lets go.
      if (d.metadata?.annotations?.[STORAGE_QUIESCED_ANNOTATION] === 'true') continue;
      const ref = `${c.namespace}/${name}`;
      // Renew before every Deployment, not only every tenant: a tenant with
      // several slow rollouts could otherwise outlive the lease, and a second
      // replica would start its own pass — two tenants restarting at once.
      await writeState(deps.db, {
        state: 'running', startedAt, leaseUntil: new Date(now().getTime() + LEASE_MS).toISOString(),
        repaired, timedOut, failed, skipped,
      }).catch(() => undefined);
      try {
        await deps.k8s.apps.patchNamespacedDeployment({
          name,
          namespace: c.namespace,
          body: { spec: { template: { spec: { nodeSelector: { [HOSTNAME_LABEL]: c.primaryNode } } } } },
        } as unknown as Parameters<K8sClients['apps']['patchNamespacedDeployment']>[0], STRATEGIC_MERGE_PATCH);
      } catch (err) {
        failed.push(`${ref}: ${(err as Error).message}`);
        continue;
      }
      repaired.push(ref);
      // A Deployment at 0 replicas has nothing to roll; everything else is
      // waited for, so the next restart only starts once this one is back.
      if ((d.spec?.replicas ?? 1) > 0 && !(await waitForRollout(deps, c.namespace, name))) {
        timedOut.push(ref);
        deps.logger.warn(`[pin-repair] ${ref} re-pinned to ${c.primaryNode} but its rollout did not finish in time`);
      }
    }
  }

  const result: PinRepairResult = {
    state: 'done', startedAt, finishedAt: now().toISOString(), repaired, timedOut, failed, skipped,
  };
  await writeState(deps.db, result).catch((err) => {
    deps.logger.warn('[pin-repair] finished but could not record it — the lease expiry will re-run it (idempotent):', err);
  });
  deps.logger.info(`[pin-repair] done: ${repaired.length} re-pinned, ${timedOut.length} slow rollout(s), `
    + `${failed.length} failed, ${skipped.length} tenant(s) skipped`);
  return result;
}
