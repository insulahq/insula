/**
 * Edit a compose stack IN PLACE from new YAML.
 *
 * The editor used to delete the stack and create it again. That was never an
 * edit: the delete is a hard delete, so the stack's pull credential, network
 * access settings and image audit went with it (FK cascade), its routes were
 * left pointing at an id that no longer existed, and when the new YAML was
 * then refused — a private image probed without the credential the delete had
 * just removed, a refused field, the application limit — the tenant had no
 * stack at all.
 *
 * This keeps the row: same id, name, routes, credential, settings and storage
 * path. The new YAML is held to exactly what a create is (parser errors, the
 * validator, image reachability — with the stored credential), the routes are
 * re-pinned or the edit refused when one would be left with no port, and
 * services the new YAML drops are removed from the cluster. Nothing is written
 * until every check passed.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { deployments, ingressRoutes } from '../../db/schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { ApiError } from '../../shared/errors.js';
import { refuseDeleted } from '../deployments/application-limit.js';
import { getSettings } from '../system-settings/service.js';
import { parseCompose } from './compose-parser.js';
import { composeSpecForCreate, firstErrorIssue } from './compose-create-gate.js';
import { validateCustomSpec } from './validator.js';
import { planRoutesForPortEdit } from './route-port.js';
import { pruneRemovedStackObjects } from './k8s-deployer.js';
import type { CustomDeploymentSpec } from './schema.js';
import { withResolvedLines } from './yaml-line-map.js';

export interface StackTenantContext {
  readonly namespace: string;
  readonly nodeName: string | null;
  readonly storageTier: 'local' | 'ha';
}

export interface ComposeReplaceDeps {
  readonly getCustomDeployment: (db: Database, tenantId: string, id: string) => Promise<{
    readonly id: string; readonly name: string; readonly status: string;
    readonly customSpec: CustomDeploymentSpec; readonly storagePath: string | null;
  }>;
  readonly checkImages: (spec: CustomDeploymentSpec, deploymentId: string) => Promise<readonly import('./schema.js').CustomDeploymentIssue[]>;
  readonly sumResources: (spec: CustomDeploymentSpec) => { cpuRequest: string; memoryRequest: string };
  readonly loadTenantContext: (db: Database, tenantId: string) => Promise<StackTenantContext>;
  readonly deployToCluster: (spec: CustomDeploymentSpec, ctx: StackTenantContext) => Promise<void>;
}

/**
 * The new spec keeps what the row owns and YAML cannot say: the admin's
 * allowRoot decision, the tenant's auto-update switch and the pull credential.
 * Pure.
 */
export function carryRowOwnedFields(next: CustomDeploymentSpec, current: CustomDeploymentSpec): CustomDeploymentSpec {
  return {
    ...next,
    allowRoot: current.allowRoot,
    autoUpdate: current.autoUpdate,
    ...(current.pullCredentialId ? { pullCredentialId: current.pullCredentialId } : {}),
  };
}

export async function replaceComposeDeploymentWith(
  deps: ComposeReplaceDeps,
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  id: string,
  input: { readonly compose_yaml: string; readonly env_files?: Record<string, string> },
): Promise<void> {
  const settings = await getSettings(db);
  if (!settings.customDeploymentsEnabled) {
    throw new ApiError('CUSTOM_DEPLOYMENTS_DISABLED', 'Custom deployments are administratively disabled on this platform.', 403);
  }
  if (!settings.customDeploymentsAllowCompose) {
    throw new ApiError('COMPOSE_DEPLOYMENTS_DISABLED', 'Compose-mode deployments are administratively disabled on this platform.', 403);
  }
  const current = await deps.getCustomDeployment(db, tenantId, id);
  refuseDeleted(current, 'edit');
  if (current.customSpec.sourceMode !== 'compose') {
    throw new ApiError('NOT_A_COMPOSE_STACK', `'${current.name}' is a single container, not a compose stack; change it from its own form.`, 400);
  }

  const parsed = parseCompose({ composeYaml: input.compose_yaml, envFiles: input.env_files });
  const nextSpec = carryRowOwnedFields(composeSpecForCreate(parsed, input.compose_yaml), current.customSpec);
  // callerRole 'admin' for the same reason as updateCustomDeployment: the only
  // role-gated check is allowRoot, and that value is the row's (an admin's
  // decision), never the YAML's — the parser always says false.
  const validation = validateCustomSpec(nextSpec, {
    callerRole: 'admin',
    warnUnpinnedTags: settings.customDeploymentsWarnUnpinnedTags,
    singleServiceOnly: false,
    deploymentName: current.name,
  });
  if (!validation.ok) {
    const issues = withResolvedLines(input.compose_yaml, [...parsed.issues, ...validation.issues]);
    throw new ApiError('CUSTOM_DEPLOYMENT_INVALID', firstErrorIssue(issues), 422, { issues });
  }
  const imageIssues = await deps.checkImages(nextSpec, id);
  if (imageIssues.some((i) => i.severity === 'error')) {
    throw new ApiError('CUSTOM_DEPLOYMENT_INVALID', firstErrorIssue(imageIssues), 422, { issues: imageIssues });
  }

  const boundRoutes = await db
    .select({ id: ingressRoutes.id, hostname: ingressRoutes.hostname, servicePort: ingressRoutes.servicePort })
    .from(ingressRoutes)
    .where(eq(ingressRoutes.deploymentId, id));
  const routePlan = planRoutesForPortEdit(current.customSpec, nextSpec, boundRoutes);
  if (routePlan.stranded.length > 0) {
    throw new ApiError(
      'PORT_IN_USE_BY_ROUTE',
      `This edit leaves ${routePlan.stranded.join(', ')} with no port to route to. Keep an exposed, ingress-eligible port, or point those routes elsewhere first.`,
      409,
      { hostnames: routePlan.stranded },
    );
  }

  const totals = deps.sumResources(nextSpec);
  await db.transaction(async (tx) => {
    await tx.update(deployments)
      .set({
        customSpec: nextSpec as unknown as Record<string, unknown>,
        cpuRequest: totals.cpuRequest,
        memoryRequest: totals.memoryRequest,
        status: 'deploying',
        statusMessage: null,
        lastError: null,
      })
      .where(eq(deployments.id, id));
    for (const repin of routePlan.repins) {
      await tx.update(ingressRoutes).set({ servicePort: repin.servicePort }).where(eq(ingressRoutes.id, repin.routeId));
    }
  });

  const ctx = await deps.loadTenantContext(db, tenantId);
  await deps.deployToCluster(nextSpec, ctx);
  await pruneRemovedStackObjects(k8s, ctx.namespace, id, nextSpec);

  if (boundRoutes.length > 0) {
    try {
      const { reconcileIngress } = await import('../domains/k8s-ingress.js');
      await reconcileIngress(db, k8s, tenantId, ctx.namespace);
    } catch (err) {
      console.warn(`[custom-deployments] reconcileIngress after editing ${current.name} failed: ${(err as Error).message}`);
    }
  }
}
