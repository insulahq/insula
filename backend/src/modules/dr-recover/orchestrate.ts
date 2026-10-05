/**
 * The one-button tenant DR recover itself (gap G1) — shared by the synchronous
 * route, the background (task-center) run and the batch recover.
 *
 * It ORCHESTRATES the existing restore-cart endpoints via Fastify `app.inject`
 * and deliberately does NOT duplicate any cart / provision / execute logic, so
 * auth, validation, and behaviour stay identical to the hand-driven flow:
 *
 *   1. (optional) POST /admin/tenants/:id/provision   → poll provision/status
 *   2. POST /admin/restores/carts                     → cartId
 *   3. POST /admin/restores/carts/:id/items  ×N       (config → files → databases → mailboxes)
 *   4. POST /admin/restores/carts/:id/execute
 *
 * Every injected call carries a credential from an `AuthProvider` (see
 * ./task-credential.ts): the synchronous route forwards its caller's header; a
 * background run mints a fresh short-lived token per call for the user who
 * started it, after re-checking that user still may. A call the platform
 * rejects (401/403) fails as `DR_CREDENTIAL_REJECTED` — never as a timeout or
 * a generic step failure.
 *
 * Progress is reported through a `DrRecoverReporter` at every phase boundary.
 * The synchronous route passes none; the background run turns the reports into
 * a task-center timeline (see ./recover-task.ts).
 */

import type { FastifyInstance } from 'fastify';
import { and, eq, desc } from 'drizzle-orm';
import { ApiError } from '../../shared/errors.js';
import { tenants, backupJobs, backupComponents } from '../../db/schema.js';
import type { AuthProvider } from './task-credential.js';
import {
  MAILBOX_RESTORE_MODE_DEFAULT,
  type DrRecoverComponent,
  type DrRecoverRequest,
  type DrRecoverResponse,
  type DrRecoverStepKey,
  type MailboxRestoreMode,
  type RestoreJobStatus,
} from '@insula/api-contracts';

// Bounded wait for the async provision task to reach a terminal state before
// the restore items run against the (now provisioned) namespace/PVC.
const PROVISION_POLL_TIMEOUT_MS = 150_000;
const PROVISION_POLL_INTERVAL_MS = 3_000;

/**
 * Apply order matters: `config` recreates the mailbox DB rows that the mailbox
 * import needs; `files` is independent. This array is BOTH the injection order
 * and the response `components` order.
 */
const COMPONENT_APPLY_ORDER: readonly DrRecoverComponent[] = ['config', 'files', 'mailboxes'];

const COMPONENT_TO_ITEM_TYPE: Readonly<Record<DrRecoverComponent, 'config-tables' | 'files-paths' | 'mailboxes-by-address'>> = {
  config: 'config-tables',
  files: 'files-paths',
  mailboxes: 'mailboxes-by-address',
};

const COMPONENT_LABEL: Readonly<Record<DrRecoverComponent, string>> = {
  config: 'config',
  files: 'files',
  mailboxes: 'mail',
};

interface InjectResponseLike {
  readonly statusCode: number;
  readonly body: string;
}

interface AddItemPayload {
  readonly bundleId: string;
  readonly type: 'config-tables' | 'files-paths' | 'databases-by-id' | 'mailboxes-by-address';
  readonly selector: Readonly<Record<string, unknown>>;
}

/** Facts the run learns along the way, for whoever is watching it. */
export interface DrRecoverContext {
  readonly tenantName?: string;
  readonly bundleId?: string;
  readonly cartId?: string;
  /** `provisioning_tasks.id` — the provision route's own task-center row is keyed by it. */
  readonly provisioningTaskId?: string;
}

/**
 * Receives the run's progress. Every method may be awaited by the run, so an
 * implementation must never throw — a broken progress display must not fail a
 * recovery. The run reports `failed` for a step only when it finishes without
 * throwing (a restore cart that ends `failed`); a thrown error is the
 * watcher's to attribute to the step still `running`.
 */
export interface DrRecoverReporter {
  step(key: DrRecoverStepKey, state: 'running' | 'done' | 'skipped' | 'failed', note?: string | null): Promise<void>;
  context(patch: DrRecoverContext): Promise<void>;
}

const NOOP_REPORTER: DrRecoverReporter = {
  step: async () => undefined,
  context: async () => undefined,
};

export interface RunDrRecoverArgs {
  readonly tenantId: string;
  readonly input: DrRecoverRequest;
  /** The `Authorization` header for each injected call — asked for anew per call. */
  readonly auth: AuthProvider;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Best-effort extraction of the upstream error `{ code, message }` envelope. */
function upstreamError(res: InjectResponseLike): { code: string; message: string } {
  try {
    const parsed = JSON.parse(res.body) as { error?: { code?: string; message?: string } };
    return {
      code: parsed.error?.code ?? 'UPSTREAM_ERROR',
      message: parsed.error?.message ?? `HTTP ${res.statusCode}`,
    };
  } catch {
    return { code: 'UPSTREAM_ERROR', message: `HTTP ${res.statusCode}` };
  }
}

/**
 * A 401/403 from an internal call means the CREDENTIAL was refused — an
 * expired forwarded session token, or an account that lost its role. Say so,
 * instead of letting the step read it as "provisioning timed out" or a
 * generic upstream failure.
 */
function assertCredentialAccepted(res: InjectResponseLike, what: string): void {
  if (res.statusCode !== 401 && res.statusCode !== 403) return;
  const info = upstreamError(res);
  throw new ApiError(
    'DR_CREDENTIAL_REJECTED',
    `The platform refused the recovery's credential while ${what} (HTTP ${res.statusCode} ${info.code}).`,
    502,
    { upstreamStatus: res.statusCode, upstreamCode: info.code },
    res.statusCode === 401
      ? 'The session ran out before the recovery finished. Start it again from Disaster Recovery → Recover Tenant — it runs in the background with a fresh credential for every step.'
      : 'The account running the recovery is no longer allowed to do this step — an active admin must start the recovery again.',
  );
}

/** `2026-…T01:36:57Z` → `… 01:36 UTC`; null when there is no usable date. */
function utcMinute(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = new Date(value as string | Date);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * Build the add-item body for a component. The selectors mirror the exact
 * shapes in `@insula/api-contracts` restore.ts:
 *   - config-tables       → `{ kind: 'all' }`     (full config-tables restore)
 *   - files-paths         → `{ kind: 'full' }`    (full archive)
 *   - mailboxes-by-address→ `{ kind: 'all', mode }` (+ confirmDestructive when
 *                             mode is 'replace', which the selector requires)
 */
function buildItemPayload(
  component: DrRecoverComponent,
  bundleId: string,
  mailboxMode: MailboxRestoreMode,
): AddItemPayload {
  const type = COMPONENT_TO_ITEM_TYPE[component];
  if (component === 'config') {
    return { bundleId, type, selector: { kind: 'all' } };
  }
  if (component === 'files') {
    return { bundleId, type, selector: { kind: 'full' } };
  }
  // mailboxes: the DR-recover request is the explicit confirmation for a
  // destructive 'replace' — the selector schema demands confirmDestructive.
  const selector = mailboxMode === 'replace'
    ? { kind: 'all', mode: mailboxMode, confirmDestructive: true }
    : { kind: 'all', mode: mailboxMode };
  return { bundleId, type, selector };
}

/**
 * Poll `GET /admin/tenants/:id/provision/status` until the provision task is
 * `completed` (return) or `failed` (throw). A missing/pending task simply
 * keeps polling until the bounded deadline.
 */
async function waitForProvisioningComplete(
  app: FastifyInstance,
  auth: AuthProvider,
  tenantId: string,
): Promise<void> {
  const deadline = Date.now() + PROVISION_POLL_TIMEOUT_MS;
  for (;;) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/tenants/${encodeURIComponent(tenantId)}/provision/status`,
      headers: { authorization: await auth() },
    });
    assertCredentialAccepted(res, 'checking the provisioning');
    if (res.statusCode === 200) {
      const body = JSON.parse(res.body) as { data?: { status?: string } };
      const status = body.data?.status;
      if (status === 'completed') return;
      if (status === 'failed') {
        throw new ApiError(
          'DR_PROVISION_FAILED',
          'Tenant namespace provisioning failed; recover aborted before restore.',
          502,
          { tenantId },
          'Inspect GET /admin/tenants/:id/provision/status, resolve the failed step (often a quota block), then retry recover.',
        );
      }
    }
    if (Date.now() >= deadline) {
      throw new ApiError(
        'DR_PROVISION_TIMEOUT',
        `Tenant provisioning did not reach 'completed' within ${Math.round(PROVISION_POLL_TIMEOUT_MS / 1000)}s; recover aborted before restore.`,
        504,
        { tenantId },
        'Check the provisioning task and cluster capacity, then retry recover once the namespace is provisioned.',
      );
    }
    await sleep(PROVISION_POLL_INTERVAL_MS);
  }
}

/** One line for the reconcile step: what came back. */
function reconcileNote(report: NonNullable<DrRecoverResponse['reconcile']>): string {
  return [
    `ingress ${report.ingress}`,
    `DKIM ${report.mail.dkimRegenerated}/${report.mail.domainsTotal}`,
    `workloads ${report.workloads.redeployed}/${report.workloads.total}`,
  ].join(' · ');
}

/**
 * Recover one tenant from an off-site bundle. Throws `ApiError` for every
 * refusal and upstream failure (the route renders it); a restore cart that
 * ends `failed` is NOT thrown — it is the terminal `status` of the result.
 */
export async function runDrRecover(
  app: FastifyInstance,
  args: RunDrRecoverArgs,
  reporter: DrRecoverReporter = NOOP_REPORTER,
): Promise<DrRecoverResponse> {
  const { tenantId, auth } = args;
  let input = args.input;

  // ── 1. Tenant must exist — OR be re-created from the bundle (S4) ───────
  // When the tenant's DB row is ABSENT (hard-deleted, or this is a fresh
  // target cluster), re-create it from the bundle's `meta.tenant` block —
  // preserving the ORIGINAL tenantId + namespace — then fall through to the
  // exact same provision + restore-cart flow. This is the cross-cluster /
  // cheap-multi-region unlock. See `./recreate.ts`.
  let recreated = false;
  let residualGaps: string[] = [];
  const [tenant] = await app.db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) {
    await reporter.step('recreate', 'running');
    if (!input.bundleId) {
      // A tenant deleted on THIS cluster keeps its backup_jobs rows (loose
      // FK; bundles are retained for the deleted-tenant window), so its
      // newest completed bundle is known — recover from it, as for a live
      // tenant. Only a tenant this cluster never had (a cross-cluster copy)
      // has no rows, and then the operator must name the bundle.
      const { newestRecoverableBundleId } = await import('../tenant-bundles/recoverable.js');
      const newest = await newestRecoverableBundleId(app.db, tenantId);
      if (newest) input = { ...input, bundleId: newest };
    }
    if (!input.bundleId) {
      throw new ApiError(
        'TENANT_NOT_FOUND',
        `Tenant '${tenantId}' not found; DR re-create requires an explicit bundleId to recover from`,
        404,
        { tenant_id: tenantId },
        'Pass the off-site bundleId to re-create this deleted tenant (preserving its original id).',
      );
    }
    const { recreateTenantFromBundle } = await import('./recreate.js');
    const migrationTargetId = input.targetConfigId;
    const result = await recreateTenantFromBundle(app, tenantId, input.bundleId, {
      targetNode: input.targetNode,
      // Cross-cluster migration (R20): open the bundle from — and register the
      // local backup_jobs row against — the SOURCE cluster's target, so the
      // fall-through restore-cart (§3) reads components straight from it.
      ...(migrationTargetId ? {
        resolveStore: async (a: typeof app) => {
          const { resolveDirectStoreForBundle } = await import('../backup-restore/shared.js');
          const store = await resolveDirectStoreForBundle(a, migrationTargetId, { classSubpath: 'tenant' });
          return { store, targetConfigId: migrationTargetId };
        },
      } : {}),
    });
    recreated = true;
    residualGaps = result.residualGaps;
    await reporter.step('recreate', 'done', 'Re-created with its original id and namespace');
    // Fall through: §2 now finds the just-registered backup_jobs row, §3 its
    // components, and the restore cart resolves the same off-site bundle.
  } else {
    await reporter.context({ tenantName: tenant.name });
    await reporter.step('recreate', 'skipped', 'The tenant exists — nothing to re-create');
  }

  // ── 2. Resolve the bundle ─────────────────────────────────────────────
  await reporter.step('bundle', 'running');
  let bundleId: string;
  let bundleTakenAt: unknown;
  if (input.bundleId) {
    const [bundle] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, input.bundleId)).limit(1);
    if (!bundle) {
      throw new ApiError('DR_BUNDLE_NOT_FOUND', `Bundle '${input.bundleId}' not found`, 404, { bundle_id: input.bundleId });
    }
    if (bundle.tenantId !== tenantId) {
      throw new ApiError('DR_BUNDLE_TENANT_MISMATCH', 'Bundle belongs to a different tenant', 400, { bundle_id: input.bundleId, tenant_id: tenantId });
    }
    if (bundle.status !== 'completed') {
      throw new ApiError('DR_BUNDLE_NOT_COMPLETED', `Bundle '${input.bundleId}' has status '${bundle.status}', expected 'completed'`, 400, { bundle_id: input.bundleId, status: bundle.status });
    }
    bundleId = bundle.id;
    bundleTakenAt = bundle.createdAt;
  } else {
    const [newest] = await app.db.select().from(backupJobs)
      .where(and(eq(backupJobs.tenantId, tenantId), eq(backupJobs.status, 'completed')))
      .orderBy(desc(backupJobs.createdAt))
      .limit(1);
    if (!newest) {
      throw new ApiError(
        'DR_NO_BUNDLE',
        `No completed backup bundle found for tenant '${tenantId}'`,
        404,
        { tenant_id: tenantId },
        'Take a tenant bundle first, or pass an explicit bundleId.',
      );
    }
    bundleId = newest.id;
    bundleTakenAt = newest.createdAt;
  }
  await reporter.context({ bundleId });

  // ── 3. Determine available components (completed rows only) ────────────
  const componentRows = await app.db.select().from(backupComponents)
    .where(and(eq(backupComponents.backupJobId, bundleId), eq(backupComponents.status, 'completed')));
  const available = new Set<DrRecoverComponent>();
  for (const row of componentRows) {
    if (row.component === 'files' || row.component === 'mailboxes' || row.component === 'config') {
      available.add(row.component);
    }
  }

  const requested: readonly DrRecoverComponent[] = input.components ?? [...available];
  for (const component of requested) {
    if (!available.has(component)) {
      throw new ApiError(
        'DR_COMPONENT_UNAVAILABLE',
        `Requested component '${component}' is not present (completed) in bundle '${bundleId}'`,
        400,
        { requested: component, available: [...available] },
        "Pick from the bundle's available components, or recover from a bundle that contains it.",
      );
    }
  }
  const requestedSet = new Set(requested);
  const applied = COMPONENT_APPLY_ORDER.filter((component) => requestedSet.has(component));
  if (applied.length === 0) {
    throw new ApiError('DR_NO_COMPONENTS', `Bundle '${bundleId}' has no restorable components (files/mailboxes/config)`, 400, { bundle_id: bundleId });
  }
  const takenAt = utcMinute(bundleTakenAt);
  await reporter.step(
    'bundle',
    'done',
    `${takenAt ? `Taken ${takenAt}` : 'Bundle'} · ${applied.map((c) => COMPONENT_LABEL[c]).join(', ')}`,
  );

  // ── 4. (optional) Provision, then wait for the namespace/PVC ───────────
  const shouldProvision = input.provision !== false;
  if (shouldProvision) {
    await reporter.step('provision', 'running');
    const provRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/tenants/${encodeURIComponent(tenantId)}/provision`,
      headers: { authorization: await auth(), 'content-type': 'application/json' },
      // Gap G2: forward the operator's node choice so the recovered tenant's
      // resources land on the chosen node. The provision endpoint validates
      // the node exists and pins the tenant to it.
      payload: input.targetNode ? { targetNode: input.targetNode } : {},
    });
    assertCredentialAccepted(provRes, 'starting the provisioning');
    if (provRes.statusCode !== 202) {
      const info = upstreamError(provRes);
      // A provision already in flight is not fatal — poll it to completion.
      if (!(provRes.statusCode === 409 && info.code === 'ALREADY_PROVISIONING')) {
        throw new ApiError(
          'DR_PROVISION_FAILED',
          `Could not start provisioning (upstream ${info.code})`,
          502,
          { tenantId, upstreamStatus: provRes.statusCode, upstreamCode: info.code },
          'Check the tenant state and cluster capacity, then retry recover.',
        );
      }
    } else {
      const provisioningTaskId = (() => {
        try {
          return (JSON.parse(provRes.body) as { data?: { taskId?: unknown } }).data?.taskId;
        } catch {
          return undefined;
        }
      })();
      if (typeof provisioningTaskId === 'string') await reporter.context({ provisioningTaskId });
    }
    await waitForProvisioningComplete(app, auth, tenantId);
    await reporter.step('provision', 'done', input.targetNode ? `On ${input.targetNode}` : null);
  } else {
    await reporter.step('provision', 'skipped', 'Re-provisioning was turned off');
  }

  // ── 5. Create the restore cart ────────────────────────────────────────
  await reporter.step('queue', 'running');
  const cartRes = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/restores/carts',
    headers: { authorization: await auth(), 'content-type': 'application/json' },
    payload: { tenantId, description: `dr-recover ${bundleId}` },
  });
  assertCredentialAccepted(cartRes, 'creating the restore');
  if (cartRes.statusCode !== 201) {
    const info = upstreamError(cartRes);
    throw new ApiError('DR_CART_CREATE_FAILED', `Could not create restore cart (upstream ${info.code})`, 502, { upstreamStatus: cartRes.statusCode, upstreamCode: info.code });
  }
  const cartBody = JSON.parse(cartRes.body) as { data?: { id?: string } };
  const cartId = cartBody.data?.id;
  if (!cartId) {
    throw new ApiError('DR_CART_CREATE_FAILED', 'Restore cart response missing cart id', 502);
  }
  await reporter.context({ cartId });

  // ── 6. Add items in apply order (config → files → databases → mailboxes)
  //       The add-on database dumps ride INSIDE the files snapshot
  //       (ADR-047), so a `databases-by-id` item is queued right after
  //       the `files-paths` item — the `.sql` must land on the PVC first.
  //       It is NOT a request-contract component; it piggybacks on `files`.
  const mailboxMode = input.mailboxMode ?? MAILBOX_RESTORE_MODE_DEFAULT;
  const itemPayloads: AddItemPayload[] = [];
  for (const component of applied) {
    itemPayloads.push(buildItemPayload(component, bundleId, mailboxMode));
    if (component === 'files') {
      itemPayloads.push({ bundleId, type: 'databases-by-id', selector: { kind: 'all' } });
    }
  }
  for (const payload of itemPayloads) {
    const itemRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/restores/carts/${encodeURIComponent(cartId)}/items`,
      headers: { authorization: await auth(), 'content-type': 'application/json' },
      payload,
    });
    assertCredentialAccepted(itemRes, `queuing the ${payload.type} item`);
    if (itemRes.statusCode !== 201) {
      const info = upstreamError(itemRes);
      throw new ApiError(
        'DR_ITEM_ADD_FAILED',
        `Could not add '${payload.type}' item to cart (upstream ${info.code})`,
        502,
        { itemType: payload.type, cartId, upstreamStatus: itemRes.statusCode, upstreamCode: info.code },
      );
    }
  }
  await reporter.step('queue', 'done', `${itemPayloads.length} item${itemPayloads.length === 1 ? '' : 's'}`);

  // ── 7. Execute (the existing /execute is SYNCHRONOUS — it runs the
  //       items to a terminal cart state and returns the full detail) ────
  await reporter.step('restore', 'running');
  const execRes = await app.inject({
    method: 'POST',
    url: `/api/v1/admin/restores/carts/${encodeURIComponent(cartId)}/execute`,
    headers: { authorization: await auth(), 'content-type': 'application/json' },
    payload: {},
  });
  assertCredentialAccepted(execRes, 'running the restore');
  if (execRes.statusCode >= 400) {
    const info = upstreamError(execRes);
    throw new ApiError(
      'DR_EXECUTE_FAILED',
      `Restore cart execution could not run (upstream ${info.code})`,
      502,
      { cartId, upstreamStatus: execRes.statusCode, upstreamCode: info.code },
    );
  }
  const execBody = JSON.parse(execRes.body) as { data?: { status?: RestoreJobStatus } };
  const status: RestoreJobStatus = execBody.data?.status ?? 'executing';
  await reporter.step(
    'restore',
    status === 'failed' ? 'failed' : 'done',
    status === 'failed' ? 'The restore stopped at a failed item' : null,
  );

  // ── 8. Post-restore reconcile. Best-effort re-establish of ingress + mail
  //       DKIM + workloads from the just-restored rows, so a recovered tenant
  //       comes back live in this one click. AUTO on the re-create path (fresh
  //       empty namespace — always safe); the operator can FORCE it via
  //       `reconcile: true` for an existing tenant that lost its namespace to a
  //       dead node, or suppress it with `reconcile: false`. Default keeps a
  //       normal recover into a LIVE tenant from disruptively redeploying its
  //       running workloads. Never fails the recover. See `./reconcile.ts`.
  const runReconcile = status === 'done' && (input.reconcile ?? recreated);
  let reconcile: DrRecoverResponse['reconcile'];
  if (runReconcile) {
    await reporter.step('reconcile', 'running');
    try {
      const { reconcileRecoveredTenant } = await import('./reconcile.js');
      const rec = await reconcileRecoveredTenant(app, tenantId);
      reconcile = rec.report;
      residualGaps = [...rec.residualGaps]; // dynamic gaps supersede the static list
    } catch (err) {
      app.log.warn(
        { tenantId, err: err instanceof Error ? err.message : String(err) },
        'dr-recover: post-restore reconcile failed — returning static residual gaps',
      );
    }
    await reporter.step(
      'reconcile',
      reconcile ? 'done' : 'failed',
      reconcile ? reconcileNote(reconcile) : 'Could not run — see the remaining manual steps',
    );
  } else {
    await reporter.step(
      'reconcile',
      'skipped',
      status !== 'done'
        ? 'The restore did not complete'
        : 'Not requested — the tenant was not re-created',
    );
  }

  // ── 9. /execute is synchronous so `status` is already terminal
  //       (done | failed); the client may still GET the cart for per-item
  //       detail. ─────────────────────────────────────────────────────────
  return {
    cartId,
    bundleId,
    components: [...applied],
    provisioned: shouldProvision,
    status,
    recreated,
    residualGaps,
    ...(reconcile ? { reconcile } : {}),
  };
}
