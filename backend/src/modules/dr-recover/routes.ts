/**
 * One-button tenant DR recover (gap G1).
 *
 * `POST /api/v1/admin/dr/tenants/:tenantId/recover` recovers a tenant's data
 * from an off-site bundle in a single admin call. It ORCHESTRATES the existing
 * restore-cart endpoints via Fastify `app.inject` — it deliberately does NOT
 * duplicate any cart / provision / execute logic, so auth, validation, and
 * behaviour stay identical to the hand-driven flow:
 *
 *   1. (optional) POST /admin/tenants/:id/provision   → poll provision/status
 *   2. POST /admin/restores/carts                     → cartId
 *   3. POST /admin/restores/carts/:id/items  ×N       (config → files → databases → mailboxes)
 *   4. POST /admin/restores/carts/:id/execute
 *
 * The caller's `Authorization` header is forwarded into every injected call so
 * the sub-requests authenticate exactly as the operator would.
 *
 * Auth: `authenticate` (Bearer, NOT session) + `requirePanel('admin')` +
 * `requireRole('super_admin','admin')` — matches the restore-cart routes this
 * endpoint drives.
 */

import type { FastifyInstance } from 'fastify';
import { and, eq, desc } from 'drizzle-orm';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError, missingToken } from '../../shared/errors.js';
import { tenants, backupJobs, backupComponents } from '../../db/schema.js';
import {
  drRecoverRequestSchema,
  drRecoverAllRequestSchema,
  MAILBOX_RESTORE_MODE_DEFAULT,
  type DrRecoverComponent,
  type DrRecoverResponse,
  type DrRecoverAllTarget,
  type DrRecoverAllResult,
  type DrRecoverAllResponse,
  type MailboxRestoreMode,
  type RestoreJobStatus,
} from '@insula/api-contracts';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';

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

interface InjectResponseLike {
  readonly statusCode: number;
  readonly body: string;
}

interface AddItemPayload {
  readonly bundleId: string;
  readonly type: 'config-tables' | 'files-paths' | 'databases-by-id' | 'mailboxes-by-address';
  readonly selector: Readonly<Record<string, unknown>>;
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
  authHeader: string,
  tenantId: string,
): Promise<void> {
  const deadline = Date.now() + PROVISION_POLL_TIMEOUT_MS;
  for (;;) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/tenants/${encodeURIComponent(tenantId)}/provision/status`,
      headers: { authorization: authHeader },
    });
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

export async function drRecoverRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  app.post('/admin/dr/tenants/:tenantId/recover', {
    schema: {
      tags: ['Restore'],
      summary: 'One-button tenant DR recover from an off-site bundle',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['tenantId'],
        properties: { tenantId: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };

    const parsed = drRecoverRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_ERROR',
        parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
        400,
      );
    }
    const input = parsed.data;

    // The caller's Bearer is forwarded into every injected sub-request. The
    // `authenticate` hook already guaranteed it exists; this narrows the type
    // and stays defensive.
    const authHeader = request.headers.authorization;
    if (!authHeader) throw missingToken();

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
      if (!input.bundleId) {
        // Re-create needs an explicit bundle: with no local tenant AND no
        // local backup_jobs rows (cascade-dropped on delete), there is no
        // "newest bundle" to resolve — the operator must name the off-site
        // bundle to recover from.
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
      // Fall through: §2 now finds the just-registered backup_jobs row, §3 its
      // components, and the restore cart resolves the same off-site bundle.
    }

    // ── 2. Resolve the bundle ─────────────────────────────────────────────
    let bundleId: string;
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
    }

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

    // ── 4. (optional) Provision, then wait for the namespace/PVC ───────────
    const shouldProvision = input.provision !== false;
    if (shouldProvision) {
      const provRes = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/tenants/${encodeURIComponent(tenantId)}/provision`,
        headers: { authorization: authHeader, 'content-type': 'application/json' },
        // Gap G2: forward the operator's node choice so the recovered tenant's
        // resources land on the chosen node. The provision endpoint validates
        // the node exists and pins the tenant to it.
        payload: input.targetNode ? { targetNode: input.targetNode } : {},
      });
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
      }
      await waitForProvisioningComplete(app, authHeader, tenantId);
    }

    // ── 5. Create the restore cart ────────────────────────────────────────
    const cartRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/restores/carts',
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: { tenantId, description: `dr-recover ${bundleId}` },
    });
    if (cartRes.statusCode !== 201) {
      const info = upstreamError(cartRes);
      throw new ApiError('DR_CART_CREATE_FAILED', `Could not create restore cart (upstream ${info.code})`, 502, { upstreamStatus: cartRes.statusCode, upstreamCode: info.code });
    }
    const cartBody = JSON.parse(cartRes.body) as { data?: { id?: string } };
    const cartId = cartBody.data?.id;
    if (!cartId) {
      throw new ApiError('DR_CART_CREATE_FAILED', 'Restore cart response missing cart id', 502);
    }

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
        headers: { authorization: authHeader, 'content-type': 'application/json' },
        payload,
      });
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

    // ── 7. Execute (the existing /execute is SYNCHRONOUS — it runs the
    //       items to a terminal cart state and returns the full detail) ────
    const execRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/restores/carts/${encodeURIComponent(cartId)}/execute`,
      headers: { authorization: authHeader, 'content-type': 'application/json' },
      payload: {},
    });
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
    }

    // ── 9. Respond. /execute is synchronous so `status` is already terminal
    //       (done | failed); the client may still GET the cart for per-item
    //       detail. 202 = "recover orchestration accepted + performed". ─────
    const response: DrRecoverResponse = {
      cartId,
      bundleId,
      components: [...applied],
      provisioned: shouldProvision,
      status,
      recreated,
      residualGaps,
      ...(reconcile ? { reconcile } : {}),
    };
    reply.status(202).send(success(response));
  });

  // ── Batch recover-all (S3: cluster rebuilt → restore N tenants at once) ────
  // Recovers every LOST tenant (has a completed off-site bundle, namespace
  // absent) in one operation, by injecting the single-tenant recover per
  // tenant so the exact validated flow (re-create/provision/restore/reconcile)
  // runs each time. Dry-run previews the target set; scope='missing' (default)
  // never touches a live tenant.
  app.post('/admin/dr/tenants/recover-all', {
    schema: {
      tags: ['Restore'],
      summary: 'Batch DR recover — restore all lost tenants from their off-site bundles',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const parsed = drRecoverAllRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_ERROR',
        parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
        400,
      );
    }
    const input = parsed.data;
    const authHeader = request.headers.authorization;
    if (!authHeader) throw missingToken();

    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined
      ?? process.env.KUBECONFIG_PATH ?? process.env.KUBECONFIG;
    const existingNamespaces = await listClusterNamespaces(kubeconfigPath);
    const targets = await resolveRecoverAllTargets(app, input, existingNamespaces);

    if (input.dryRun) {
      const dry: DrRecoverAllResponse = {
        dryRun: true, scope: input.scope, total: targets.length, recovered: 0, failed: 0, targets,
      };
      return reply.status(200).send(success(dry));
    }

    // SEQUENTIAL by design: a freshly-rebuilt cluster is fragile and each
    // provision+restore is heavy; parallel recovers would hammer it.
    const results: DrRecoverAllResult[] = [];
    for (const t of targets) {
      const body: Record<string, unknown> = { bundleId: t.bundleId };
      if (input.targetNode) body.targetNode = input.targetNode;
      if (input.components) body.components = input.components;

      let ok = false; let status: RestoreJobStatus | null = null; let recreated = false; let error: string | null = null;
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/dr/tenants/${encodeURIComponent(t.tenantId)}/recover`,
          headers: { authorization: authHeader, 'content-type': 'application/json' },
          payload: JSON.stringify(body),
        });
        ok = res.statusCode >= 200 && res.statusCode < 300;
        let pb: { data?: DrRecoverResponse; error?: { message?: string } } | null = null;
        try { pb = res.json(); } catch { pb = null; }
        status = pb?.data?.status ?? null;
        recreated = pb?.data?.recreated ?? false;
        if (!ok) error = pb?.error?.message ?? `HTTP ${res.statusCode}`;
        else if (status === 'failed') { ok = false; error = 'restore cart reported failed'; }
      } catch (err) {
        ok = false; error = err instanceof Error ? err.message : String(err);
      }
      results.push({ ...t, ok, status, recreated, error });
    }

    const response: DrRecoverAllResponse = {
      dryRun: false,
      scope: input.scope,
      total: results.length,
      recovered: results.filter((r) => r.ok && r.status === 'done').length,
      failed: results.filter((r) => !r.ok || r.status === 'failed').length,
      results,
    };
    reply.status(202).send(success(response));
  });
}

/** Snapshot the cluster's namespace names (empty set on any API error). */
async function listClusterNamespaces(kubeconfigPath?: string): Promise<Set<string>> {
  try {
    const k8s = createK8sClients(kubeconfigPath);
    const res = await k8s.core.listNamespace();
    const out = new Set<string>();
    for (const ns of (res.items ?? [])) {
      const n = ns.metadata?.name;
      if (n) out.add(n);
    }
    return out;
  } catch {
    return new Set();
  }
}

/**
 * Resolve the tenants a batch recover should target. Candidates are the
 * explicit `tenantIds`, else every tenant with a completed bundle (a
 * hard-deleted tenant's backup_jobs rows are cascade-dropped, so this naturally
 * scopes to the S3 "platform DB restored, namespaces lost" set). Each candidate
 * resolves to its NEWEST completed bundle; `scope: 'missing'` drops tenants
 * whose namespace still exists (never restores over a live tenant).
 */
async function resolveRecoverAllTargets(
  app: FastifyInstance,
  input: { tenantIds?: readonly string[]; scope: 'missing' | 'all' },
  existingNamespaces: ReadonlySet<string>,
): Promise<DrRecoverAllTarget[]> {
  let candidateIds: string[];
  if (input.tenantIds && input.tenantIds.length > 0) {
    candidateIds = [...input.tenantIds];
  } else {
    const rows = await app.db.selectDistinct({ tenantId: backupJobs.tenantId })
      .from(backupJobs).where(eq(backupJobs.status, 'completed'));
    candidateIds = rows.map((r) => r.tenantId);
  }

  const targets: DrRecoverAllTarget[] = [];
  for (const tenantId of candidateIds) {
    const [bundle] = await app.db.select({ id: backupJobs.id })
      .from(backupJobs)
      .where(and(eq(backupJobs.tenantId, tenantId), eq(backupJobs.status, 'completed')))
      .orderBy(desc(backupJobs.createdAt)).limit(1);
    if (!bundle) continue; // no completed bundle → not recoverable
    const [t] = await app.db.select({ name: tenants.name, ns: tenants.kubernetesNamespace })
      .from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    const ns = t?.ns ?? null;
    const namespacePresent = ns ? existingNamespaces.has(ns) : false;
    if (input.scope === 'missing' && namespacePresent) continue; // skip live tenants
    targets.push({ tenantId, tenantName: t?.name ?? null, bundleId: bundle.id, namespacePresent });
  }
  return targets;
}
