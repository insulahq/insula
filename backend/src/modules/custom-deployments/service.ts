// Custom Deployments — orchestration layer.
//
// Bridges the HTTP routes to the validator, k8s deployer, PAT store
// and DB. Lives BESIDE `deployments/service.ts` (catalog) — both
// modules operate on the same `deployments` table, discriminated by
// the `source` column (ADR-036).
//
// PR-2 scope: simple-mode only. Compose-mode submissions are 400'd
// at the route layer (see routes.ts) until PR-3 ships the parser.

import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { customDeploymentImageAudit, deployments, tenants } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { getSettings } from '../system-settings/service.js';
import { isCustomContainersAllowedByPlan } from '../subscriptions/service.js';
import { assertTenantActive } from '../tenants/guards.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  validateCustomSpec,
  type ValidatorContext,
} from './validator.js';
import {
  deployCustomDeployment,
  deleteCustomDeployment,
  scaleCustomDeployment,
} from './k8s-deployer.js';
import { checkImageReachable } from './image-reachability.js';
import { parseImageReference } from './image-reference.js';
import {
  upsertPullCredential,
  getPullCredential,
  deletePullCredential,
  loadDecryptedToken,
  materializePullSecret,
  deletePullSecret,
  type PatSubmission,
  type PullCredentialRecord,
} from './pat-store.js';
import { recordImageAudit } from './image-audit.js';
import {
  type CustomDeploymentSpec,
  type CustomDeploymentIssue,
  type CreateCustomDeploymentSimpleInput,
  type CreateCustomDeploymentComposeInput,
  type UpdateCustomDeploymentInput,
  type UpdateNowResult,
} from './schema.js';
import { CUSTOM_SPEC_VERSION } from './schema.js';
import { parseCompose } from './compose-parser.js';
import { withResolvedLines } from './yaml-line-map.js';

type CallerRole = ValidatorContext['callerRole'];

interface CallerCtx {
  readonly role: CallerRole;
}

export interface CustomDeploymentRow {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly status: string;
  readonly customSpec: CustomDeploymentSpec;
  readonly storagePath: string | null;
  readonly currentNodeName: string | null;
  readonly statusMessage: string | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// ─── Read ────────────────────────────────────────────────────────────────────

export async function listCustomDeployments(
  db: Database,
  tenantId: string,
): Promise<readonly CustomDeploymentRow[]> {
  const rows = await db.select().from(deployments)
    .where(and(eq(deployments.tenantId, tenantId), eq(deployments.source, 'custom')))
    .orderBy(desc(deployments.createdAt));
  return rows.map(toRow);
}

export async function getCustomDeployment(
  db: Database,
  tenantId: string,
  id: string,
): Promise<CustomDeploymentRow> {
  const [row] = await db.select().from(deployments)
    .where(and(
      eq(deployments.id, id),
      eq(deployments.tenantId, tenantId),
      eq(deployments.source, 'custom'),
    ));
  if (!row) {
    throw new ApiError(
      'CUSTOM_DEPLOYMENT_NOT_FOUND',
      `Custom deployment '${id}' not found`,
      404,
      { deployment_id: id },
    );
  }
  return toRow(row);
}

// ─── Create ──────────────────────────────────────────────────────────────────

/**
 * Validate a simple-form spec without persisting or deploying it.
 * Used by the wizard's "preview" step.
 */
export async function validateSimpleSpec(
  db: Database,
  input: CreateCustomDeploymentSimpleInput,
  ctx: CallerCtx,
): Promise<{ ok: boolean; issues: readonly CustomDeploymentIssue[]; spec: CustomDeploymentSpec }> {
  const spec = buildSpecFromSimple(input);
  const settings = await getSettings(db);
  const result = validateCustomSpec(spec, {
    callerRole: ctx.role,
    warnUnpinnedTags: settings.customDeploymentsWarnUnpinnedTags,
    singleServiceOnly: true,
    deploymentName: input.name,
  });
  const issues = [...result.issues, ...await checkSpecImagesReachable(spec)];
  return { ok: !issues.some((i) => i.severity === 'error'), issues, spec };
}

/**
 * Pre-flight every service image: reject a malformed reference and probe the
 * registry so a typo / nonexistent tag fails at validate/create time instead of
 * silently sitting in ImagePullBackOff. Creds-less (public probe): a public typo
 * is a hard error (404), a private image only warns (401) — never a false block.
 * Best-effort: a registry outage degrades to a warning, never throws.
 */
async function checkSpecImagesReachable(
  spec: CustomDeploymentSpec,
  cred?: { registryHost: string; username: string; password: string },
): Promise<CustomDeploymentIssue[]> {
  const issues: CustomDeploymentIssue[] = [];
  for (const [name, svc] of Object.entries(spec.services)) {
    try {
      // ONLY send the credential to the registry it belongs to. A compose
      // stack routinely mixes registries (`ghcr.io/acme/app` + `redis:7`), and
      // the probe authenticates by replying to the registry's own
      // WWW-Authenticate challenge — so passing the credential unconditionally
      // would hand a tenant's ghcr.io PAT to Docker Hub's auth realm. The
      // dockerconfigjson Secret is already host-scoped; this makes the
      // pre-flight match it.
      const authCreds = cred && imageIsOnRegistry(svc.image, cred.registryHost)
        ? { username: cred.username, password: cred.password }
        : undefined;
      issues.push(...await checkImageReachable(svc.image, `services.${name}.image`, authCreds));
    } catch {
      // A probe implementation error must never block a deployment.
    }
  }
  return issues;
}

/**
 * Does this image reference live on `registryHost`?
 *
 * Docker Hub is the awkward case: a bare `redis:7` normalises to `docker.io`,
 * while operators type `docker.io`, `index.docker.io` or
 * `registry-1.docker.io` interchangeably. Treat those as one host so a genuine
 * Docker Hub credential still applies; everything else is an exact,
 * case-insensitive hostname match.
 */
const DOCKER_HUB_ALIASES = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);

export function imageIsOnRegistry(image: string, registryHost: string): boolean {
  const ref = parseImageReference(image);
  if (!ref) return false;
  const a = ref.registryHost.toLowerCase();
  const b = registryHost.trim().toLowerCase();
  if (DOCKER_HUB_ALIASES.has(a) && DOCKER_HUB_ALIASES.has(b)) return true;
  return a === b;
}

/**
 * Per-tenant subscription gate for the custom-container path (ADR-036).
 * Layered ON TOP of the system-wide `customDeploymentsEnabled` kill-switch:
 * even when custom deployments are enabled platform-wide, a tenant may deploy
 * one only if its subscription allows it (plan default OR per-tenant override).
 * Throws 403 CUSTOM_CONTAINERS_NOT_IN_PLAN otherwise.
 */
async function assertCustomContainersAllowed(db: Database, tenantId: string): Promise<void> {
  if (!(await isCustomContainersAllowedByPlan(db, tenantId))) {
    throw new ApiError(
      'CUSTOM_CONTAINERS_NOT_IN_PLAN',
      'Custom containers are not enabled for this tenant\'s subscription. An administrator can enable "Allow Custom Containers" on the plan or as a per-tenant override.',
      403,
    );
  }
}

export async function createSimpleDeployment(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  input: CreateCustomDeploymentSimpleInput,
  ctx: CallerCtx,
): Promise<CustomDeploymentRow> {
  const settings = await getSettings(db);
  if (!settings.customDeploymentsEnabled) {
    throw new ApiError(
      'CUSTOM_DEPLOYMENTS_DISABLED',
      'Custom deployments are administratively disabled on this platform.',
      403,
    );
  }
  await assertCustomContainersAllowed(db, tenantId);
  if (input.pull_credential) await assertInlineCredentialAllowed(db);

  const { namespace, nodeName, storageTier } = await loadTenantContext(db, tenantId);

  // Build + validate the normalized spec.
  const spec = buildSpecFromSimple(input);
  const validation = validateCustomSpec(spec, {
    callerRole: ctx.role,
    warnUnpinnedTags: settings.customDeploymentsWarnUnpinnedTags,
    singleServiceOnly: true,
    deploymentName: input.name,
  });
  if (!validation.ok) {
    throw new ApiError(
      'CUSTOM_DEPLOYMENT_INVALID',
      firstErrorIssue(validation.issues),
      422,
      { issues: validation.issues },
    );
  }

  // Pre-flight the image with the supplied PAT when there is one: a creds-less
  // probe of a private image can only ever return 401 (a warning), so a WRONG
  // token would sail through create and surface as ImagePullBackOff. With the
  // credential the 404-vs-401 distinction is meaningful again.
  const probeCreds = input.pull_credential
    ? {
        registryHost: input.pull_credential.registry_host,
        username: input.pull_credential.username,
        password: input.pull_credential.token,
      }
    : undefined;
  const imageIssues = await checkSpecImagesReachable(spec, probeCreds);
  if (imageIssues.some((i) => i.severity === 'error')) {
    throw new ApiError('CUSTOM_DEPLOYMENT_INVALID', firstErrorIssue(imageIssues), 422, { issues: imageIssues });
  }

  // Uniqueness: per-tenant deployment name (catalog already enforces
  // this on the same `deployments_client_name_unique` constraint).
  const existing = await db.select().from(deployments)
    .where(and(eq(deployments.tenantId, tenantId), eq(deployments.name, input.name)));
  if (existing.length > 0) {
    throw new ApiError(
      'DEPLOYMENT_NAME_IN_USE',
      `A deployment named '${input.name}' already exists in this tenant.`,
      409,
      { name: input.name },
    );
  }

  // Persist row first — k8s apply happens AFTER the DB row exists so
  // a deploy failure leaves a `failed` row the operator can see and
  // retry (matches the catalog path).
  const id = randomUUID();
  const storagePath = `custom-deployment/${input.name}`;
  await db.insert(deployments).values({
    id,
    tenantId,
    catalogEntryId: null,
    source: 'custom',
    customSpec: spec as unknown as Record<string, unknown>,
    name: input.name,
    replicaCount: 1,
    cpuRequest: spec.services[input.name].resources.cpuRequest,
    memoryRequest: spec.services[input.name].resources.memoryRequest,
    configuration: null,
    storagePath,
    status: 'deploying',
  });

  // Credential BEFORE deploy — deployToCluster reads the row to build the
  // pull Secret, so writing it afterwards would miss the very first pull.
  // On failure, drop the row: a half-created deployment the tenant never
  // asked for is worse than a clean 4xx.
  if (input.pull_credential) {
    try {
      await persistInlinePullCredential(db, id, toPatSubmission(input.pull_credential));
    } catch (err) {
      await db.delete(deployments).where(eq(deployments.id, id));
      throw err;
    }
  }

  await deployToCluster(db, k8s, id, namespace, input.name, storagePath, spec, nodeName, storageTier);

  return getCustomDeployment(db, tenantId, id);
}

// ─── Compose create / validate ──────────────────────────────────────────────

/**
 * Validate a compose-form spec without persisting or deploying it.
 * Used by the editor's preview step. Returns parser issues + the
 * normalized spec (when parse succeeded) so the editor can render
 * the "Issues" pane and the "Rendered" tab side by side.
 */
export async function validateComposeSpec(
  db: Database,
  input: { composeYaml: string; envFiles?: Record<string, string>; name?: string },
  ctx: CallerCtx,
): Promise<{ ok: boolean; issues: readonly CustomDeploymentIssue[]; spec: CustomDeploymentSpec | null }> {
  const settings = await getSettings(db);
  // Same gate as createComposeDeployment — operators disabling
  // compose to contain blast radius should see the preview path
  // also reject, not silently keep echoing the parser surface.
  if (!settings.customDeploymentsAllowCompose) {
    throw new ApiError(
      'COMPOSE_DEPLOYMENTS_DISABLED',
      'Compose-mode deployments are administratively disabled on this platform.',
      403,
    );
  }
  const parsed = parseCompose({ composeYaml: input.composeYaml, envFiles: input.envFiles });
  if (!parsed.spec) {
    // Attach a line to every issue whose path we can locate in the submitted
    // YAML. Without this the editor could say WHAT was wrong but not WHERE,
    // which in a 60-line stack means hunting by eye.
    return { ok: false, issues: withResolvedLines(input.composeYaml, parsed.issues), spec: null };
  }
  const semantic = validateCustomSpec(parsed.spec, {
    callerRole: ctx.role,
    warnUnpinnedTags: settings.customDeploymentsWarnUnpinnedTags,
    singleServiceOnly: false,
    deploymentName: input.name,
  });
  // Merge parser + validator + image-reachability issues for the editor's pane.
  const allIssues = withResolvedLines(
    input.composeYaml,
    [...parsed.issues, ...semantic.issues, ...await checkSpecImagesReachable(parsed.spec)],
  );
  return { ok: !allIssues.some((i) => i.severity === 'error'), issues: allIssues, spec: parsed.spec };
}

/**
 * Persist + apply a compose-form deployment. Mirrors
 * `createSimpleDeployment` but with the compose parser feeding the
 * normalized spec, and multi-service stacks allowed.
 */
export async function createComposeDeployment(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  input: CreateCustomDeploymentComposeInput,
  ctx: CallerCtx,
): Promise<CustomDeploymentRow> {
  const settings = await getSettings(db);
  if (!settings.customDeploymentsEnabled) {
    throw new ApiError(
      'CUSTOM_DEPLOYMENTS_DISABLED',
      'Custom deployments are administratively disabled on this platform.',
      403,
    );
  }
  if (!settings.customDeploymentsAllowCompose) {
    throw new ApiError(
      'COMPOSE_DEPLOYMENTS_DISABLED',
      'Compose-mode deployments are administratively disabled on this platform.',
      403,
    );
  }
  await assertCustomContainersAllowed(db, tenantId);
  if (input.pull_credential) await assertInlineCredentialAllowed(db);

  if (!input.name) {
    throw new ApiError('MISSING_REQUIRED_FIELD', 'Stack name is required to create a deployment.', 400, { field: 'name' });
  }

  const { namespace, nodeName, storageTier } = await loadTenantContext(db, tenantId);

  // Phase 1: parse → validate → reject if errors.
  const parsed = parseCompose({ composeYaml: input.compose_yaml, envFiles: input.env_files });
  if (!parsed.spec) {
    throw new ApiError(
      'CUSTOM_DEPLOYMENT_INVALID',
      firstErrorIssue(parsed.issues),
      422,
      { issues: withResolvedLines(input.compose_yaml, parsed.issues) },
    );
  }
  const validation = validateCustomSpec(parsed.spec, {
    callerRole: ctx.role,
    warnUnpinnedTags: settings.customDeploymentsWarnUnpinnedTags,
    singleServiceOnly: false,
    deploymentName: input.name,
  });
  if (!validation.ok) {
    throw new ApiError(
      'CUSTOM_DEPLOYMENT_INVALID',
      firstErrorIssue([...parsed.issues, ...validation.issues]),
      422,
      { issues: withResolvedLines(input.compose_yaml, [...parsed.issues, ...validation.issues]) },
    );
  }

  // Pre-flight every service image — reject a malformed or nonexistent reference
  // instead of deploying the stack and waiting for ImagePullBackOff.
  // Same as the simple path: probe with the PAT when one was supplied so a
  // wrong token is a create-time error, not a later ImagePullBackOff.
  const imageIssues = await checkSpecImagesReachable(
    parsed.spec,
    input.pull_credential
      ? {
          registryHost: input.pull_credential.registry_host,
          username: input.pull_credential.username,
          password: input.pull_credential.token,
        }
      : undefined,
  );
  if (imageIssues.some((i) => i.severity === 'error')) {
    throw new ApiError('CUSTOM_DEPLOYMENT_INVALID', firstErrorIssue(imageIssues), 422, { issues: imageIssues });
  }

  // Uniqueness — per the existing deployments_client_name_unique constraint.
  const existing = await db.select().from(deployments)
    .where(and(eq(deployments.tenantId, tenantId), eq(deployments.name, input.name)));
  if (existing.length > 0) {
    throw new ApiError(
      'DEPLOYMENT_NAME_IN_USE',
      `A deployment named '${input.name}' already exists in this tenant.`,
      409,
      { name: input.name },
    );
  }

  // For multi-service, the row-level resource fields summarise the
  // stack as the SUM of all services. Used for UI display + future
  // plan-quota math. The customSpec carries per-service values.
  const totals = sumResources(parsed.spec);

  // Attach PAT id from the input (compose body never carries
  // cleartext credentials — those go through the PAT routes).
  // ParseResult.spec is `readonly`, so we copy with the field set
  // rather than reassigning.
  const finalSpec: CustomDeploymentSpec = input.pull_credential_id
    ? { ...parsed.spec, pullCredentialId: input.pull_credential_id }
    : parsed.spec;

  const id = randomUUID();
  const storagePath = `custom-deployment/${input.name}`;
  await db.insert(deployments).values({
    id,
    tenantId,
    catalogEntryId: null,
    source: 'custom',
    customSpec: finalSpec as unknown as Record<string, unknown>,
    name: input.name,
    replicaCount: 1,
    cpuRequest: totals.cpuRequest,
    memoryRequest: totals.memoryRequest,
    configuration: null,
    storagePath,
    status: 'deploying',
  });

  // Same ordering rule as the simple path: the pull Secret is built from this
  // row inside deployToCluster.
  if (input.pull_credential) {
    try {
      await persistInlinePullCredential(db, id, toPatSubmission(input.pull_credential));
    } catch (err) {
      await db.delete(deployments).where(eq(deployments.id, id));
      throw err;
    }
  }

  await deployToCluster(db, k8s, id, namespace, input.name, storagePath, finalSpec, nodeName, storageTier);
  return getCustomDeployment(db, tenantId, id);
}

// ─── Update ──────────────────────────────────────────────────────────────────

/**
 * Apply a narrow patch to a custom deployment. Role-gating: the route
 * layer already checks `requireTenantRoleByMethod` (writes need
 * tenant_admin+); the validator below uses hardcoded `'admin'` for
 * `callerRole` because patches CANNOT alter the admin-only allowRoot
 * flag (it's not in `UpdateCustomDeploymentInput`). Adding a CallerCtx
 * parameter here would be dead surface that risks a future caller
 * mistakenly thinking they can elevate via this entrypoint.
 */
export async function updateCustomDeployment(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  id: string,
  patch: UpdateCustomDeploymentInput,
): Promise<CustomDeploymentRow> {
  const current = await getCustomDeployment(db, tenantId, id);
  let nextSpec = current.customSpec;
  let needsRedeploy = false;
  const isCompose = current.customSpec.sourceMode === 'compose';

  // The PATCH surface in PR-3 supports two flavours:
  //   - Simple-mode (single service): image / env / resources land on
  //     the lone service. Tag-upgrade and env tweaks go through here.
  //   - Compose-mode (multi-service): per-service mutation is NOT
  //     exposed in PR-3 (the UpdateCustomDeploymentInput schema has
  //     no service selector). Compose stacks accept ONLY `restart`
  //     and `pull_credential_id` patches in this PR; image/env/
  //     resources patches return NOT_SUPPORTED_FOR_COMPOSE so the
  //     operator knows to drop into the YAML editor (PR-4) for a
  //     per-service change.
  const serviceName = Object.keys(current.customSpec.services)[0];
  if (!serviceName || !nextSpec.services[serviceName]) {
    throw new ApiError(
      'CUSTOM_DEPLOYMENT_CORRUPT',
      'Custom deployment has no services in spec.',
      500,
    );
  }

  const composeReject = (field: string): never => {
    throw new ApiError(
      'NOT_SUPPORTED_FOR_COMPOSE',
      `Patching '${field}' on a compose-mode deployment is not supported in this release; edit the compose YAML and recreate, or wait for the per-service patch surface in the next release.`,
      400,
      { field },
    );
  };

  if (patch.image !== undefined) {
    if (isCompose) composeReject('image');
    nextSpec = withServiceMutation(nextSpec, serviceName, (s) => ({ ...s, image: patch.image! }));
    needsRedeploy = true;
  }
  if (patch.env !== undefined) {
    if (isCompose) composeReject('env');
    nextSpec = withServiceMutation(nextSpec, serviceName, (s) => ({ ...s, env: patch.env! }));
    needsRedeploy = true;
  }
  if (patch.resources !== undefined) {
    if (isCompose) composeReject('resources');
    nextSpec = withServiceMutation(nextSpec, serviceName, (s) => ({ ...s, resources: { ...s.resources, ...patch.resources! } }));
    needsRedeploy = true;
  }
  if (patch.ports !== undefined) {
    if (isCompose) composeReject('ports');
    nextSpec = withServiceMutation(nextSpec, serviceName, (s) => ({ ...s, ports: patch.ports! }));
    needsRedeploy = true;
  }
  if (patch.pull_credential_id !== undefined) {
    nextSpec = { ...nextSpec, pullCredentialId: patch.pull_credential_id ?? undefined };
    needsRedeploy = true;
  }
  if (patch.restart) {
    needsRedeploy = true;
  }

  if (!needsRedeploy) return current;

  // Re-validate so a patch that introduces an invalid combination is
  // rejected before any cluster mutation. callerRole is hardcoded to
  // 'admin' here because the previously-validated spec may carry an
  // admin-set allowRoot=true; we never want a tenant-initiated patch
  // (image bump, restart) to fail the ALLOW_ROOT_REQUIRES_ADMIN check
  // for a flag the tenant didn't touch. The update schema does NOT
  // expose `allowRoot` (admin-only post-create knob), so there's no
  // path for a tenant to escalate via this elevation.
  //
  // `singleServiceOnly` mirrors the source mode — compose stacks
  // get the multi-service validator path so the existing N-service
  // spec doesn't trip COMPOSE_NOT_SUPPORTED_YET.
  const settings = await getSettings(db);
  const validation = validateCustomSpec(nextSpec, {
    callerRole: 'admin',
    warnUnpinnedTags: settings.customDeploymentsWarnUnpinnedTags,
    singleServiceOnly: !isCompose,
    deploymentName: current.name,
  });
  if (!validation.ok) {
    throw new ApiError(
      'CUSTOM_DEPLOYMENT_INVALID',
      firstErrorIssue(validation.issues),
      422,
      { issues: validation.issues },
    );
  }

  // Row-level totals: compose stacks sum across services, simple
  // mode uses the (only) service's own values directly. Keeps the
  // row's cpu/memory request aligned with the actual cluster
  // footprint so plan-quota math stays honest.
  const updatedService = nextSpec.services[serviceName];
  const totals = isCompose
    ? sumResources(nextSpec)
    : {
      cpuRequest: updatedService.resources.cpuRequest,
      memoryRequest: updatedService.resources.memoryRequest,
    };
  await db.update(deployments)
    .set({
      customSpec: nextSpec as unknown as Record<string, unknown>,
      cpuRequest: totals.cpuRequest,
      memoryRequest: totals.memoryRequest,
      status: 'deploying',
      statusMessage: null,
      lastError: null,
    })
    .where(eq(deployments.id, id));

  const { namespace, nodeName, storageTier } = await loadTenantContext(db, tenantId);
  await deployToCluster(db, k8s, id, namespace, current.name, current.storagePath ?? `custom-deployment/${current.name}`, nextSpec, nodeName, storageTier);

  return getCustomDeployment(db, tenantId, id);
}

/**
 * Refuse a create carrying an inline PAT when the platform has private
 * registries turned off. Runs BEFORE the image pre-flight, not after: the
 * pre-flight AUTHENTICATES to the registry with this token, so checking it
 * afterwards would let a tenant make the platform use a credential the
 * operator has forbidden — and would insert a deployment row only to delete
 * it again.
 */
async function assertInlineCredentialAllowed(db: Database): Promise<void> {
  const settings = await getSettings(db);
  if (!settings.customDeploymentsAllowPrivateRegistries) {
    throw new ApiError(
      'PRIVATE_REGISTRIES_DISABLED',
      'Private registries are administratively disabled on this platform.',
      403,
    );
  }
  if (!process.env.PLATFORM_ENCRYPTION_KEY) {
    throw new ApiError(
      'ENCRYPTION_KEY_MISSING',
      'Platform is not configured for credential storage.',
      500,
    );
  }
}

/**
 * Persist an inline create-time PAT for a deployment that was just inserted.
 *
 * Must run BEFORE `deployToCluster` — that function reads the credential row
 * and materialises the dockerconfigjson Secret, so a row written afterwards
 * would miss the first pull and the tenant would still see ImagePullBackOff,
 * which is the whole bug this closes.
 *
 * Errors are NOT swallowed. A tenant who supplied a PAT did so because the
 * image is private; quietly deploying without it just produces an
 * ImagePullBackOff with no explanation. The caller deletes the half-created
 * row so create stays all-or-nothing.
 */
async function persistInlinePullCredential(
  db: Database,
  deploymentId: string,
  submission: PatSubmission,
): Promise<void> {
  // `assertInlineCredentialAllowed` has already run at the top of create, so
  // both the operator gate and the key are known good here. Re-read the key
  // rather than threading it through — upsertPullCredential rejects an empty
  // one anyway.
  await upsertPullCredential(db, deploymentId, submission, process.env.PLATFORM_ENCRYPTION_KEY ?? '');
}

/** Map an inline create-time credential onto the store's submission shape. */
function toPatSubmission(
  input: { registry_host: string; username: string; token: string },
): PatSubmission {
  return { registryHost: input.registry_host, username: input.username, token: input.token };
}

/**
 * DR helper: redeploy a custom-deployment ROW's k8s workload from its stored
 * spec, with NO spec change. Used by the DR recover reconcile and the bundle
 * restore executor to bring restored custom deployments back up on a re-created
 * tenant — the `deployments` row + its `customSpec` jsonb survive the bundle
 * restore, but the k8s Deployment does not. Reuses the exact create/update
 * deploy path (loadTenantContext → deployToCluster) so image-pull secrets,
 * storage, and node/quota placement are materialised identically to a normal
 * deploy. Throws on a non-custom row or a spec-less row so the caller can
 * record a per-workload failure.
 */
export async function redeployCustomDeploymentRow(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  row: typeof deployments.$inferSelect,
): Promise<void> {
  if (row.source !== 'custom' || !row.customSpec) {
    throw new ApiError(
      'CUSTOM_DEPLOYMENT_INVALID',
      `Deployment '${row.id}' is not a custom deployment with a spec`,
      422,
      { deployment_id: row.id },
    );
  }
  const spec = row.customSpec as unknown as CustomDeploymentSpec;
  const { namespace, nodeName, storageTier } = await loadTenantContext(db, tenantId);
  await db.update(deployments)
    .set({ status: 'deploying', statusMessage: null, lastError: null })
    .where(eq(deployments.id, row.id));
  await deployToCluster(
    db, k8s, row.id, namespace, row.name,
    row.storagePath ?? `custom-deployment/${row.name}`,
    spec, nodeName, storageTier,
  );
}

// ─── Pull-latest + redeploy ("Update now") ──────────────────────────────────

/**
 * Re-pull every image at its CURRENT tag and roll the pods.
 *
 * Distinct from upgradeTag, which points the deployment at a DIFFERENT tag.
 * This one keeps the tenant's pinned tag and picks up a republished digest —
 * the `:latest`/`:1.27`-moved case, and the only thing auto-update ever does.
 *
 * Works for compose stacks too: one Deployment per service, all rolled, since
 * "update this stack" with per-service granularity would be a different (and
 * much more confusing) feature.
 *
 * The roll marker goes in the SPEC. See customDeploymentSpecSchema.rolledAt for
 * why a deploy-time timestamp would be wrong.
 */
export async function pullAndRedeploy(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  id: string,
  now: () => Date = () => new Date(),
): Promise<UpdateNowResult> {
  const current = await getCustomDeployment(db, tenantId, id);
  // Tenant-active is asserted by loadTenantContext below, with the correct
  // action label — no separate check needed here.

  // What the pods are running right now, so the caller can show a before/after
  // and an auto-update has something to roll back to. Best-effort: a
  // deployment that has never reported a digest just yields null.
  const previousDigest = await getRunningDigest(db, id);

  const nextSpec: CustomDeploymentSpec = {
    ...current.customSpec,
    rolledAt: now().toISOString(),
  };

  await db.update(deployments)
    .set({
      customSpec: nextSpec as unknown as Record<string, unknown>,
      status: 'deploying',
      statusMessage: null,
      lastError: null,
    })
    .where(eq(deployments.id, id));

  const { namespace, nodeName, storageTier } = await loadTenantContext(db, tenantId);
  await deployToCluster(
    db, k8s, id, namespace, current.name,
    current.storagePath ?? `custom-deployment/${current.name}`,
    nextSpec, nodeName, storageTier,
  );

  const services = Object.keys(nextSpec.services);
  return {
    rolled: true,
    services,
    previousDigest,
    message: previousDigest
      ? `Re-pulling ${services.length} image(s) at their current tags. Previously running ${previousDigest}.`
      : `Re-pulling ${services.length} image(s) at their current tags.`,
  };
}

/**
 * Digest the pods most recently reported running, from the image audit the
 * status reconciler populates out of `containerStatuses[].imageID`.
 *
 * Sentinel rows (digest still NULL while the kubelet pulls) are skipped —
 * those mean "we know the image, not yet the digest", and treating one as the
 * current digest would make a comparison against the registry meaningless.
 */
export async function getRunningDigest(db: Database, deploymentId: string): Promise<string | null> {
  const rows = await db.select({ digest: customDeploymentImageAudit.resolvedDigest })
    .from(customDeploymentImageAudit)
    .where(and(
      eq(customDeploymentImageAudit.deploymentId, deploymentId),
      isNotNull(customDeploymentImageAudit.resolvedDigest),
    ))
    .orderBy(desc(customDeploymentImageAudit.pulledAt))
    .limit(1);
  return rows[0]?.digest ?? null;
}

// ─── Auto-update toggle ─────────────────────────────────────────────────────

/**
 * Enable/disable the hourly same-tag re-pull.
 *
 * Single-service only. A stack has N images with N independent digests, so
 * "the image changed" has no single meaning — and rolling an entire stack
 * because one sidecar was republished is not a behaviour to give anyone by
 * default. Stacks still get the manual Update button.
 *
 * Persisting this does NOT redeploy: flipping a checkbox must never restart a
 * running workload.
 */
/**
 * Stop a custom deployment: scale its k8s Deployment(s) to 0 and mark it
 * 'stopped'. This is the BREAK for a CrashLoopBackOff — the container stops
 * restarting, but the deployment row, its config, PVC and pull secret are all
 * kept, so Start brings it back without re-creating anything. Idempotent.
 */
export async function stopCustomDeployment(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  id: string,
): Promise<CustomDeploymentRow> {
  const current = await getCustomDeployment(db, tenantId, id); // 404s if not this tenant's
  const namespace = await loadTenantNamespace(db, tenantId);
  await scaleCustomDeployment(k8s, namespace, id, 0);
  await db.update(deployments)
    .set({ status: 'stopped', statusMessage: null, currentNodeName: null })
    .where(eq(deployments.id, current.id));
  return getCustomDeployment(db, tenantId, id);
}

/**
 * Start a stopped custom deployment: scale its Deployment(s) back to 1. If the
 * k8s objects were never created (0 patched) the row is left as-is with a clear
 * message rather than a misleading 'deploying' that will never converge.
 */
export async function startCustomDeployment(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  id: string,
): Promise<CustomDeploymentRow> {
  const current = await getCustomDeployment(db, tenantId, id);
  const namespace = await loadTenantNamespace(db, tenantId);
  const patched = await scaleCustomDeployment(k8s, namespace, id, 1);
  await db.update(deployments)
    .set(patched > 0
      ? { status: 'deploying', statusMessage: null, lastError: null }
      : { status: 'failed', statusMessage: 'No k8s Deployment exists to start — redeploy this container.' })
    .where(eq(deployments.id, current.id));
  return getCustomDeployment(db, tenantId, id);
}

export async function setAutoUpdate(
  db: Database,
  tenantId: string,
  id: string,
  enabled: boolean,
): Promise<CustomDeploymentRow> {
  const current = await getCustomDeployment(db, tenantId, id);
  if (enabled && current.customSpec.sourceMode === 'compose') {
    throw new ApiError(
      'NOT_SUPPORTED_FOR_COMPOSE',
      'Auto-update is available for single-container deployments only. A stack has one digest per service, '
      + 'so there is no single "newer image" to act on — use Update now to re-pull the whole stack.',
      400,
      { field: 'enabled' },
    );
  }
  const nextSpec: CustomDeploymentSpec = {
    ...current.customSpec,
    autoUpdate: enabled,
    // Drop any half-finished rollback bookkeeping when auto-update is turned
    // off, so re-enabling later starts from a clean slate rather than
    // resurrecting a digest from weeks ago.
    ...(enabled ? {} : { rollbackDigest: undefined }),
  };
  await db.update(deployments)
    .set({ customSpec: nextSpec as unknown as Record<string, unknown> })
    .where(eq(deployments.id, id));
  return getCustomDeployment(db, tenantId, id);
}

// ─── Upgrade-tag (one-click) ────────────────────────────────────────────────

export async function upgradeTag(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  id: string,
  newImage: string,
): Promise<CustomDeploymentRow> {
  return updateCustomDeployment(db, k8s, tenantId, id, { image: newImage });
}

// ─── Delete ──────────────────────────────────────────────────────────────────

export async function deleteCustomDeploymentRow(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  id: string,
): Promise<void> {
  const current = await getCustomDeployment(db, tenantId, id);
  const namespace = await loadTenantNamespace(db, tenantId);

  // Mark as deleting BEFORE the cluster mutation so a concurrent
  // reconciler tick doesn't bring it back to `running`.
  await db.update(deployments)
    .set({ status: 'deleting' })
    .where(eq(deployments.id, id));

  try {
    await deleteCustomDeployment(k8s, namespace, id, current.name);
    await deletePullSecret(k8s, namespace, id);
  } catch (err) {
    await db.update(deployments)
      .set({
        status: 'failed',
        lastError: err instanceof Error ? err.message : String(err),
      })
      .where(eq(deployments.id, id));
    throw err;
  }

  // The credentials row cascades on the deployment row delete, but
  // we still call deletePullCredential() defensively in case the FK
  // CASCADE is removed in a future migration.
  await deletePullCredential(db, id);
  await db.delete(deployments).where(eq(deployments.id, id));
}

// ─── PAT (pull credentials) ─────────────────────────────────────────────────

export async function attachPullCredential(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  deploymentId: string,
  submission: PatSubmission,
  encryptionKey: string,
): Promise<PullCredentialRecord> {
  const settings = await getSettings(db);
  if (!settings.customDeploymentsAllowPrivateRegistries) {
    throw new ApiError(
      'PRIVATE_REGISTRIES_DISABLED',
      'Private registries are administratively disabled on this platform.',
      403,
    );
  }
  // Ownership check.
  await getCustomDeployment(db, tenantId, deploymentId);
  const record = await upsertPullCredential(db, deploymentId, submission, encryptionKey);

  // Materialise the k8s Secret immediately so the next pod restart
  // picks up the new credentials. The deployment isn't redeployed
  // here — the operator can call /restart explicitly if they want
  // the pull to happen now.
  const namespace = await loadTenantNamespace(db, tenantId);
  await materializePullSecret(k8s, namespace, deploymentId, {
    registryHost: submission.registryHost,
    username: submission.username,
    token: submission.token,
  });
  return record;
}

export async function revokePullCredential(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  deploymentId: string,
): Promise<void> {
  await getCustomDeployment(db, tenantId, deploymentId);
  const namespace = await loadTenantNamespace(db, tenantId);
  await deletePullSecret(k8s, namespace, deploymentId);
  await deletePullCredential(db, deploymentId);
}

export async function readPullCredentialPublic(
  db: Database,
  tenantId: string,
  deploymentId: string,
): Promise<PullCredentialRecord | null> {
  await getCustomDeployment(db, tenantId, deploymentId);
  return getPullCredential(db, deploymentId);
}

/**
 * Admin-only: flip the `allowRoot` flag on an existing deployment.
 * Does NOT trigger a re-deploy — the tenant must re-apply the spec
 * (restart or update) after the admin flips this flag.
 *
 * Caller MUST have verified super_admin role before calling this.
 */
export async function setAllowRoot(
  db: Database,
  tenantId: string,
  deploymentId: string,
  allowRoot: boolean,
): Promise<CustomDeploymentRow> {
  const current = await getCustomDeployment(db, tenantId, deploymentId);
  const nextSpec: CustomDeploymentSpec = { ...current.customSpec, allowRoot };
  const [updated] = await db
    .update(deployments)
    .set({ customSpec: nextSpec as unknown as Record<string, unknown> })
    .where(and(eq(deployments.id, deploymentId), eq(deployments.tenantId, tenantId), eq(deployments.source, 'custom')))
    .returning();
  if (!updated) {
    throw new ApiError('CUSTOM_DEPLOYMENT_NOT_FOUND', `Deployment '${deploymentId}' not found`, 404);
  }
  return toRow(updated);
}

// ─── Cluster apply ──────────────────────────────────────────────────────────

async function deployToCluster(
  db: Database,
  k8s: K8sClients,
  deploymentId: string,
  namespace: string,
  deploymentName: string,
  storageSubPath: string,
  spec: CustomDeploymentSpec,
  nodeName?: string | null,
  storageTier?: 'local' | 'ha' | null,
): Promise<void> {
  const hasPullCredential = await getPullCredential(db, deploymentId);
  if (hasPullCredential) {
    // The deployer is about to set `imagePullSecrets: [image-pull-X]`
    // on the Pod. If we silently skip re-materialisation because the
    // platform can't decrypt the token, the Pod hits ImagePullBackOff
    // with no operator-visible signal. Fail loudly instead — the
    // operator sees `ENCRYPTION_KEY_MISSING` / `PAT_DECRYPT_FAILED`
    // on the deployment row and can act.
    if (!process.env.PLATFORM_ENCRYPTION_KEY) {
      throw new ApiError(
        'ENCRYPTION_KEY_MISSING',
        'Cannot re-materialise the image-pull Secret without PLATFORM_ENCRYPTION_KEY; this deployment is configured to use a PAT.',
        500,
        { deployment_id: deploymentId },
      );
    }
    const decrypted = await loadDecryptedToken(db, deploymentId, process.env.PLATFORM_ENCRYPTION_KEY);
    if (!decrypted) {
      // DB row was deleted between the getPullCredential check and the
      // load — shouldn't happen under normal locking, but if it does
      // the Pod's imagePullSecrets ref would still point at a missing
      // Secret. Drop the ref instead of leaving a dangling reference.
      throw new ApiError(
        'PAT_VANISHED',
        'Image-pull credential disappeared between read and apply.',
        500,
        { deployment_id: deploymentId },
      );
    }
    await materializePullSecret(k8s, namespace, deploymentId, decrypted);
  }

  try {
    await deployCustomDeployment(k8s, {
      deploymentId,
      deploymentName,
      namespace,
      storageSubPath,
      spec,
      hasPullCredential: !!hasPullCredential,
      nodeName: nodeName ?? undefined,
      storageTier: storageTier ?? undefined,
    });
    // Optimistic: status flips to running on the next reconciler tick
    // when k8s reports ready replicas. Until then it stays 'deploying'.
    // Fire-and-forget image-audit so the audit trail starts populating
    // ASAP without blocking the deploy response. Errors are swallowed
    // (the next reconciler tick will retry).
    void recordImageAudit(db, k8s, deploymentId, namespace, deploymentName).catch(() => undefined);
  } catch (err) {
    await db.update(deployments)
      .set({
        status: 'failed',
        lastError: err instanceof Error ? err.message : String(err),
      })
      .where(eq(deployments.id, deploymentId));
    throw err;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function loadTenantNamespace(db: Database, tenantId: string): Promise<string> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) {
    throw new ApiError('TENANT_NOT_FOUND', `Tenant '${tenantId}' not found`, 404, { tenant_id: tenantId });
  }
  return tenant.kubernetesNamespace;
}

interface TenantContext {
  readonly namespace: string;
  readonly nodeName: string | null;
  readonly storageTier: 'local' | 'ha';
}

async function loadTenantContext(db: Database, tenantId: string): Promise<TenantContext> {
  const [tenant] = await db
    .select({
      kubernetesNamespace: tenants.kubernetesNamespace,
      nodeName: tenants.nodeName,
      storageTier: tenants.storageTier,
      status: tenants.status,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) {
    throw new ApiError('TENANT_NOT_FOUND', `Tenant '${tenantId}' not found`, 404, { tenant_id: tenantId });
  }
  // Custom deployments create/update k8s resources — block non-active tenants.
  assertTenantActive({ id: tenantId, status: tenant.status }, 'create custom deployments');
  return {
    namespace: tenant.kubernetesNamespace,
    nodeName: tenant.nodeName ?? null,
    storageTier: (tenant.storageTier ?? 'local') as 'local' | 'ha',
  };
}

function buildSpecFromSimple(input: CreateCustomDeploymentSimpleInput): CustomDeploymentSpec {
  // The single service is named the same as the deployment.
  // PR-3 (compose) will produce multi-service maps.
  const serviceName = input.name;
  return {
    specVersion: CUSTOM_SPEC_VERSION,
    sourceMode: 'simple',
    services: {
      [serviceName]: {
        image: input.image,
        command: input.command,
        entrypoint: input.entrypoint,
        env: input.env ?? [],
        ports: input.ports ?? [],
        volumeMounts: input.volumes ?? [],
        resources: input.resources ?? { cpuRequest: '100m', memoryRequest: '128Mi' },
        healthCheck: input.health_check,
        restartPolicy: input.restart_policy ?? 'Always',
        runAsUser: input.run_as_user,
        runAsGroup: input.run_as_group,
        readOnlyRootFilesystem: input.read_only_root_filesystem ?? false,
        tmpfs: [],
        capAdd: [],
        dependsOn: [],
        workingDir: undefined,
        stopGracePeriodSeconds: undefined,
      },
    },
    // Volume names referenced by mounts must exist as top-level
    // entries. Build them implicitly from the mount list so the
    // tenant doesn't need to declare them twice in the simple form.
    volumes: Object.fromEntries(
      (input.volumes ?? []).map((vm) => [vm.name, {}] as const),
    ),
    configMaps: [],
    secrets: [],
    allowRoot: false,
    autoUpdate: false,
    pullCredentialId: input.pull_credential_id,
  };
}

function withServiceMutation(
  spec: CustomDeploymentSpec,
  serviceName: string,
  fn: (s: CustomDeploymentSpec['services'][string]) => CustomDeploymentSpec['services'][string],
): CustomDeploymentSpec {
  return {
    ...spec,
    services: { ...spec.services, [serviceName]: fn(spec.services[serviceName]) },
  };
}

function firstErrorIssue(issues: readonly CustomDeploymentIssue[]): string {
  const err = issues.find((i) => i.severity === 'error');
  return err ? `${err.code}: ${err.message}` : 'Validation failed';
}

/**
 * Sum the per-service `cpuRequest` + `memoryRequest` to produce a
 * row-level "stack total" stored on `deployments.cpu_request` and
 * `deployments.memory_request`. Used for UI display and future
 * plan-quota math. The per-service values stay in `customSpec` and
 * drive what the deployer puts into each container.
 */
function sumResources(spec: CustomDeploymentSpec): { cpuRequest: string; memoryRequest: string } {
  let cpuMillis = 0;
  let memMi = 0;
  for (const svc of Object.values(spec.services)) {
    cpuMillis += parseCpuMillis(svc.resources.cpuRequest);
    memMi += parseMemMi(svc.resources.memoryRequest);
  }
  return {
    cpuRequest: `${cpuMillis || 100}m`,
    memoryRequest: `${memMi || 128}Mi`,
  };
}

function parseCpuMillis(qty: string): number {
  const m = /^([0-9]+(?:\.[0-9]+)?)(m)?$/.exec(qty);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return m[2] === 'm' ? Math.round(n) : Math.round(n * 1000);
}

function parseMemMi(qty: string): number {
  const m = /^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(qty);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2] ?? '';
  const factor: Record<string, number> = {
    '': 1 / (1024 * 1024),
    k: 1000 / (1024 * 1024), M: 1_000_000 / (1024 * 1024), G: 1_000_000_000 / (1024 * 1024),
    Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024,
  };
  return Math.max(1, Math.round(n * (factor[unit] ?? 1)));
}

function toRow(row: typeof deployments.$inferSelect): CustomDeploymentRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    status: row.status,
    customSpec: row.customSpec as unknown as CustomDeploymentSpec,
    storagePath: row.storagePath,
    currentNodeName: row.currentNodeName,
    statusMessage: row.statusMessage,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
