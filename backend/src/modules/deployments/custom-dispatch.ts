/**
 * Bridge from the generic (catalog-shaped) deployment lifecycle to the
 * custom-deployment implementations (ADR-036).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `deployments/service.ts` was written for catalog deployments. Every
 * lifecycle verb in it resolves a `catalogEntries` row and then guards the
 * whole Kubernetes half of the operation behind `if (entry) { … }`.
 *
 * Custom deployments (`source='custom'`) have NO catalog entry — the column
 * is NULL by construction. So every one of those guards evaluated false and
 * the cluster work was skipped *in silence*: the DB row was updated, HTTP 200
 * was returned, and `last_error` stayed empty because nothing had failed.
 * Nothing was attempted.
 *
 * Observed in production 2026-09-02: an operator reduced a custom deployment
 * from 4 CPU to 1 and stopped it. The row said `cpu_request=1, status=stopped`;
 * the Pod was still Running and holding all 4 cores, which pinned the tenant's
 * `requests.cpu` quota at its 4-core ceiling and left a sibling catalog
 * deployment permanently unschedulable (`FailedCreate: exceeded quota`).
 *
 * Two things were wrong, not one:
 *
 *   1. The Kubernetes call never happened (the `if (entry)` skip).
 *   2. The DB write went to the wrong column. For custom rows,
 *      `deployments.cpu_request` is a DERIVED PROJECTION — see
 *      `custom-deployments/service.ts`, which recomputes it from
 *      `custom_spec` on every update. The authoritative value lives at
 *      `custom_spec.services.<svc>.resources.cpuRequest`. Writing the
 *      projection alone leaves the row self-inconsistent and any later
 *      redeploy resurrects the old value from the spec.
 *
 * The custom-deployments module already implements all of these verbs
 * correctly. This module is the dispatch layer the generic path was missing —
 * it does not reimplement anything, it routes.
 *
 * DYNAMIC IMPORTS: `deployments/service.ts` is imported very widely; the
 * custom-deployments module pulls in the compose parser, PAT store and image
 * audit chain. Loading that graph eagerly from here would risk an import
 * cycle for no benefit, so every call site uses `await import(...)` — the
 * same pattern `deployments/service.ts` already uses for `k8s-ingress`,
 * `image-reaper` and `resource-parser`.
 */

import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { ApiError } from '../../shared/errors.js';

/** The subset of a `deployments` row these helpers need. */
export interface DispatchTarget {
  readonly id: string;
  readonly name: string;
  readonly source: string | null;
  readonly customSpec: unknown;
}

/**
 * True when this row's workload is rendered from `custom_spec` rather than
 * from a catalog entry. The single predicate every generic lifecycle
 * function must branch on before it touches `catalogEntries`.
 */
export function isCustomDeployment(deployment: { source: string | null }): boolean {
  return deployment.source === 'custom';
}

/**
 * `custom_spec.sourceMode` — 'simple' (one service, editable field-by-field)
 * or 'compose' (multi-service, edited as YAML). Returns null when the spec is
 * absent or malformed, which callers treat as un-dispatchable.
 */
function sourceMode(customSpec: unknown): 'simple' | 'compose' | null {
  const mode = (customSpec as { sourceMode?: unknown } | null)?.sourceMode;
  return mode === 'simple' || mode === 'compose' ? mode : null;
}

/** Service names declared in the spec, in declaration order. */
export function customServiceNames(customSpec: unknown): string[] {
  const services = (customSpec as { services?: Record<string, unknown> } | null)?.services;
  return services && typeof services === 'object' ? Object.keys(services) : [];
}

/** Every distinct image referenced by the spec — used by the image reaper. */
export function customSpecImages(customSpec: unknown): string[] {
  const services = (customSpec as { services?: Record<string, { image?: unknown }> } | null)?.services;
  if (!services || typeof services !== 'object') return [];
  const images = Object.values(services)
    .map((s) => (typeof s?.image === 'string' ? s.image : null))
    .filter((i): i is string => Boolean(i));
  return [...new Set(images)];
}

async function namespaceFor(db: Database, tenantId: string): Promise<string | null> {
  const { tenants } = await import('../../db/schema.js');
  const { eq } = await import('drizzle-orm');
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  return tenant?.kubernetesNamespace ?? null;
}

// ─── Lifecycle verbs ─────────────────────────────────────────────────────────

/**
 * Stop: scale every Deployment carrying this row's `insula.host/deployment-id`
 * label to 0. `stopCustomDeployment` also writes `status='stopped'` itself, so
 * the caller must not duplicate that write.
 */
export async function dispatchCustomStop(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  deploymentId: string,
): Promise<void> {
  const { stopCustomDeployment } = await import('../custom-deployments/service.js');
  await stopCustomDeployment(db, k8s, tenantId, deploymentId);
}

/** Start: scale back to 1. Writes its own status (including the honest
 *  `failed` when no k8s Deployment exists to start). */
export async function dispatchCustomStart(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  deploymentId: string,
): Promise<void> {
  const { startCustomDeployment } = await import('../custom-deployments/service.js');
  await startCustomDeployment(db, k8s, tenantId, deploymentId);
}

/**
 * Scale without touching DB status — used by the soft-delete and restore
 * paths, which own the status write themselves (`deleted` / `running`).
 */
export async function dispatchCustomScale(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  deploymentId: string,
  replicas: number,
): Promise<void> {
  const namespace = await namespaceFor(db, tenantId);
  if (!namespace) return;
  const { scaleCustomDeployment } = await import('../custom-deployments/k8s-deployer.js');
  await scaleCustomDeployment(k8s, namespace, deploymentId, replicas);
}

/**
 * Hard delete: remove every Deployment/Service/ConfigMap/Secret carrying the
 * deployment-id label, plus the image-pull secret. The caller deletes the DB
 * row. Before this dispatch existed, hard-deleting a custom deployment removed
 * the row and left the workload running forever — an orphan consuming tenant
 * quota with nothing left in the DB to explain it.
 */
export async function dispatchCustomHardDelete(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  deployment: DispatchTarget,
): Promise<void> {
  const namespace = await namespaceFor(db, tenantId);
  if (!namespace) return;
  const { deleteCustomDeployment } = await import('../custom-deployments/k8s-deployer.js');
  await deleteCustomDeployment(k8s, namespace, deployment.id, deployment.name);
  try {
    const { deletePullSecret } = await import('../custom-deployments/pat-store.js');
    await deletePullSecret(k8s, namespace, deployment.id);
  } catch {
    // No pull secret attached — the workload objects are already gone,
    // which is the part that matters for quota.
  }
}

/**
 * Resource change. Routes through `updateCustomDeployment` so the authoritative
 * `custom_spec` is rewritten, the row-level `cpu_request`/`memory_request`
 * projection is recomputed from it, and the workload is redeployed — all three,
 * atomically from the caller's point of view.
 *
 * Compose stacks are rejected rather than half-applied: a single deployment-level
 * budget has no unambiguous mapping onto N services, and `updateCustomDeployment`
 * itself refuses per-service patches for compose mode (NOT_SUPPORTED_FOR_COMPOSE).
 * Telling the operator to use the YAML editor is the honest answer.
 */
export async function dispatchCustomResources(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  deployment: DispatchTarget,
  input: { cpu_request?: string; memory_request?: string },
): Promise<void> {
  const mode = sourceMode(deployment.customSpec);
  if (mode === null) {
    throw new ApiError(
      'CUSTOM_DEPLOYMENT_CORRUPT',
      `Custom deployment '${deployment.name}' has no usable spec; its resources cannot be changed.`,
      500,
      { deployment_id: deployment.id },
    );
  }
  if (mode === 'compose') {
    throw new ApiError(
      'NOT_SUPPORTED_FOR_COMPOSE',
      'Compose stacks declare resources per service. Edit the compose YAML to change them — '
      + 'a single deployment-level CPU/memory budget cannot be split across services unambiguously.',
      400,
      { deployment_id: deployment.id, services: customServiceNames(deployment.customSpec) },
    );
  }

  const [serviceName] = customServiceNames(deployment.customSpec);
  const current = (deployment.customSpec as {
    services?: Record<string, { resources?: { cpuRequest?: string; memoryRequest?: string } }>;
  } | null)?.services?.[serviceName]?.resources;

  const { updateCustomDeployment } = await import('../custom-deployments/service.js');
  await updateCustomDeployment(db, k8s, tenantId, deployment.id, {
    resources: {
      // Absent field means "leave alone" — mirror the generic path's
      // semantics by carrying the current spec value forward rather than
      // letting the schema default (100m/128Mi) silently shrink the other axis.
      cpuRequest: input.cpu_request ?? current?.cpuRequest ?? '100m',
      memoryRequest: input.memory_request ?? current?.memoryRequest ?? '128Mi',
    },
  });
}

/**
 * Redeploy from the stored spec with no spec change — the custom-side
 * equivalent of `redeployWithCurrentConfig`.
 */
export async function dispatchCustomRedeploy(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  row: Parameters<
    Awaited<typeof import('../custom-deployments/service.js')>['redeployCustomDeploymentRow']
  >[3],
): Promise<void> {
  const { redeployCustomDeploymentRow } = await import('../custom-deployments/service.js');
  await redeployCustomDeploymentRow(db, k8s, tenantId, row);
}
