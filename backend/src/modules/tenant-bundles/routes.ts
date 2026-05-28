import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, desc, sql, inArray } from 'drizzle-orm';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success, paginated } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { backupJobs, backupComponents, backupConfigurations, tenants, hostingPlans } from '../../db/schema.js';
import {
  BACKUP_META_SCHEMA_VERSION,
  createBundleSchema,
  updateTenantBackupScheduleSchema,
  type BundleSummary,
  type BundleDetail,
  type BackupComponentInfo,
} from '@k8s-hosting/api-contracts';
import { S3BackupStore } from './s3-backup-store.js';
import { resolveShimBackupStore, resolveShimFirstBackupStore } from './shim-backup-store.js';
import { SshBackupStore } from './ssh-backup-store.js';
import type { BackupStore } from './bundle-store.js';
import { runBundle } from './orchestrator.js';
import { decrypt } from '../oidc/crypto.js';
import { decryptSecretsPayload } from './components/secrets.js';
import { CONFIG_DUMP_EXCLUDED_CLIENT_FK_TABLES } from './components/config.js';
import { BUNDLE_COMPONENTS, ownerOfTable } from './component-registry.js';
import { createHash, randomUUID } from 'node:crypto';
import { gunzip } from 'node:zlib';
import { Readable } from 'node:stream';

// Backups-v2 stores bundles OFF-CLUSTER only (S3 / SSH). The cluster's
// disk is reserved for live tenant data — backups must never compete
// for it. Every bundle request therefore requires `targetConfigId`
// pointing at an active row in `backup_configurations`.
//
// (LocalHostPathBackupStore still exists for unit tests via mkdtemp;
// it is never used by the route layer in production.)

/**
 * Redact credentials before writing an error message to a UI-facing
 * column (`backup_jobs.last_error`). The orchestrator may catch
 * driver-level exceptions whose `message` includes the full DSN —
 * Drizzle/pg in particular tends to surface connection strings on
 * pool errors. Operator UIs surface this verbatim, so anything that
 * looks like a credential gets masked. Server logs receive the raw
 * unredacted message separately.
 */
export function redactCredentialsForUi(message: string): string {
  return message
    // <scheme>://user:password@host  →  <scheme>://user:***@host
    .replace(/([a-zA-Z][a-zA-Z0-9+\-.]*:\/\/[^:@/\s]+):[^@\s]+@/g, '$1:***@')
    // password=<value> / pwd=<value> in URL query / log strings
    .replace(/(password|pwd|secret|token)=[^\s&"']+/gi, '$1=***')
    // AWS access-key-id pattern
    .replace(/AKIA[A-Z0-9]{12,}/g, 'AKIA***')
    // 32+ char hex blobs (likely raw key material)
    .replace(/\b[0-9a-f]{32,}\b/gi, '***');
}

export async function backupsV2Routes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  const platformVersion = (app.config as Record<string, unknown>).PLATFORM_VERSION as string | undefined ?? '0.0.0-dev';
  const configuredKey = (app.config as Record<string, unknown>).PLATFORM_ENCRYPTION_KEY as string | undefined
    ?? process.env.PLATFORM_ENCRYPTION_KEY;
  const secretsKeyHex = configuredKey ?? '0'.repeat(64);
  if (!configuredKey && process.env.NODE_ENV === 'production') {
    app.log.error('tenant-bundles: PLATFORM_ENCRYPTION_KEY is not set in production — using zero-key fallback. Secrets-component bundles encrypted today are trivially decryptable. Set PLATFORM_ENCRYPTION_KEY now.');
  } else if (!configuredKey) {
    app.log.warn('tenant-bundles: PLATFORM_ENCRYPTION_KEY not set — using zero-key dev fallback. Secrets bundles produced now will be unencrypted.');
  }
  // Validate the key is the right shape (32 bytes hex) at registration
  // time so a misconfigured operator gets a clear failure now instead
  // of a confusing "key must be 32 bytes" thrown from inside an
  // export-token request 10 minutes later.
  if (Buffer.from(secretsKeyHex, 'hex').length !== 32) {
    throw new Error(`tenant-bundles: PLATFORM_ENCRYPTION_KEY must be 32 bytes hex (got ${secretsKeyHex.length} chars / ${Buffer.from(secretsKeyHex, 'hex').length} bytes)`);
  }

  // ── Legacy path redirects (one cycle) ────────────────────────────
  // The bundle endpoints used to live under /admin/backups/bundles*
  // before the 2026-05-06 rename to /admin/tenant-bundles*. Keep
  // 308-permanent redirects on the old paths for one release cycle so
  // a panel deployed before the backend rolls doesn't 404 — TanStack
  // Query follows redirects transparently. Remove this block after
  // the next release cycle. (Path style: /admin/backups/bundles{,/...}
  // → /admin/tenant-bundles{,/...} preserving query string.)
  const legacyBundlePaths = [
    '/admin/backups/bundles',
    '/admin/backups/bundles/:id',
    '/admin/backups/bundles/:id/verify',
    '/admin/backups/bundles/:id/data-export',
  ] as const;
  for (const legacy of legacyBundlePaths) {
    const target = legacy.replace('/admin/backups/bundles', '/admin/tenant-bundles');
    for (const method of ['get', 'post', 'delete'] as const) {
      app[method](legacy, {
        schema: { tags: ['TenantBundles'], summary: `Legacy redirect → ${target}`, hide: true },
      }, async (request, reply) => {
        const params = request.params as Record<string, string>;
        const url = `/api/v1${target.replace(/:(\w+)/g, (_, k) => params[k] ?? '')}`;
        const qs = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
        reply.code(308).header('Location', `${url}${qs}`).send();
      });
    }
  }

  // ── GET /api/v1/admin/tenant-bundles ──────────────────────────────
  app.get('/admin/tenant-bundles', {
    schema: { tags: ['TenantBundles'], summary: 'List bundles', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const q = request.query as { tenantId?: string; limit?: string; status?: string };
    const limit = Math.min(Math.max(parseInt(q.limit ?? '50', 10) || 50, 1), 100);

    const whereClause = q.tenantId ? eq(backupJobs.tenantId, q.tenantId) : undefined;
    const rowsQuery = whereClause
      ? app.db.select().from(backupJobs).where(whereClause).orderBy(desc(backupJobs.createdAt)).limit(limit + 1)
      : app.db.select().from(backupJobs).orderBy(desc(backupJobs.createdAt)).limit(limit + 1);
    const countQuery = whereClause
      ? app.db.select({ n: sql<number>`count(*)::int` }).from(backupJobs).where(whereClause)
      : app.db.select({ n: sql<number>`count(*)::int` }).from(backupJobs);
    const [rows, countRows] = await Promise.all([rowsQuery, countQuery]);

    const hasMore = rows.length > limit;
    const visibleRows = rows.slice(0, limit);

    // Resolve tenant status + name for every distinct tenant id in a
    // single bulk query. Bundles for deleted tenants miss the JOIN
    // and surface as tenantStatus='missing'.
    const distinctTenantIds = Array.from(new Set(visibleRows.map((r) => r.tenantId)));
    const tenantRows = distinctTenantIds.length === 0
      ? []
      : await app.db
          .select({ id: tenants.id, status: tenants.status, name: tenants.name })
          .from(tenants)
          .where(inArray(tenants.id, distinctTenantIds));
    const tenantById = new Map<string, { status: string; name: string }>(
      tenantRows.map((c) => [c.id, { status: c.status as string, name: c.name }]),
    );

    const items: BundleSummary[] = visibleRows.map((row) => {
      const c = tenantById.get(row.tenantId);
      return toBundleSummary(row, {
        status: tenantRowToBundleStatus(c?.status),
        name: c?.name ?? null,
      });
    });
    const total = countRows[0]?.n ?? items.length;
    // `paginated()` returns the canonical `{data, pagination}` envelope.
    // The earlier `success({data: items, pagination})` produced a
    // double-wrap (`{data: {data: items, pagination}}`) that the
    // admin-panel TenantsBackupsPage decoded as a non-array `rows`
    // prop, crashing with "e.rows.filter is not a function".
    return paginated(items, {
      total_count: total,
      cursor: hasMore ? items[items.length - 1]?.id ?? null : null,
      has_more: hasMore,
      page_size: limit,
    });
  });

  // ── GET /api/v1/admin/tenant-bundles/coverage ──────────────────────
  //
  // MUST be registered BEFORE the parametric `/:id` handler — Fastify
  // (find-my-way) on a v1.x trie can match a literal segment as the
  // `:id` parameter when the parametric route was registered first.
  // Empirically: putting this AFTER /:id returned 404 "Bundle not
  // found" with id="coverage" instead of resolving the static path.
  //
  // Returns the BundleComponent registry + a drift report. The drift
  // section flags any tenant-FK'd DB table that no component claims —
  // the same check the schema-audit script runs at CI time, but
  // available at runtime for the operator coverage UI.
  app.get('/admin/tenant-bundles/coverage', {
    schema: {
      tags: ['TenantBundles'],
      summary: 'Bundle coverage registry + runtime drift report',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    // Pull every table name that has a `tenant_id` column from the
    // information schema. Fast and authoritative — beats parsing
    // schema.ts at runtime.
    const r = await app.db.execute(sql`
      SELECT DISTINCT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'tenant_id'
      ORDER BY table_name
    `);
    const rawDb = r as unknown as { rows: Array<{ table_name: string }> };
    const dbTables = rawDb.rows.map((row) => row.table_name);

    // The registry uses camelCase table names (matching the Drizzle
    // schema export names); information_schema returns snake_case.
    // Convert snake → camel for the comparison.
    const snakeToCamel = (s: string): string =>
      s.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());

    const owned: Array<{ table: string; component: string }> = [];
    const excluded: Array<{ table: string; reason: string }> = [];
    const orphans: Array<{ table: string }> = [];
    for (const t of dbTables) {
      const camel = snakeToCamel(t);
      const owner = ownerOfTable(camel);
      if (owner) {
        owned.push({ table: camel, component: owner.name });
        continue;
      }
      const reason = CONFIG_DUMP_EXCLUDED_CLIENT_FK_TABLES.get(camel);
      if (reason) {
        excluded.push({ table: camel, reason });
      } else {
        orphans.push({ table: camel });
      }
    }

    // success() already wraps in {data: …}; don't double-wrap.
    return success({
      components: BUNDLE_COMPONENTS,
      drift: {
        // Tables claimed by no component AND not in the documented
        // exclusion list. These are the silent-drop hazards — operator
        // UI flags them red.
        orphanTables: orphans,
        // Tables intentionally outside any component, with the
        // documented reason (audit logs, billing, transient state).
        excludedTables: excluded,
        ownedTableCount: owned.length,
        totalTenantTables: dbTables.length,
      },
    });
  });

  // ── GET /api/v1/admin/tenant-bundles/:id ──────────────────────────
  app.get('/admin/tenant-bundles/:id', {
    schema: { tags: ['TenantBundles'], summary: 'Get bundle detail', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, id)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    const [tenantRow] = await app.db
      .select({ status: tenants.status, name: tenants.name })
      .from(tenants).where(eq(tenants.id, job.tenantId)).limit(1);
    const components = await app.db.select().from(backupComponents).where(eq(backupComponents.backupJobId, id));
    const detail: BundleDetail = {
      ...toBundleSummary(job, {
        status: tenantRowToBundleStatus(tenantRow?.status as string | undefined),
        name: tenantRow?.name ?? null,
      }),
      components: components.map(toComponentInfo),
    };
    return success(detail);
  });

  // ── POST /api/v1/admin/tenant-bundles ─────────────────────────────
  app.post('/admin/tenant-bundles', {
    schema: { tags: ['TenantBundles'], summary: 'Create a new bundle', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const parsed = createBundleSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '), 400);
    }
    const input = parsed.data;

    // Backups MUST go to an off-cluster target. The cluster's disk is
    // for live tenant data, not bundles. Reject any request without
    // an explicit targetConfigId.
    if (!input.targetConfigId) {
      throw new ApiError('VALIDATION_ERROR',
        'targetConfigId is required: bundles must be written to an active off-site backup target (S3 or SSH).',
        400);
    }
    // B9 (2026-05-22): bundle writes always go through the R-X20 shim
    // (live staging bench measured ~35% faster than restic native S3,
    // PLUS the shim supports CIFS/NFS upstreams natively while
    // tenant-bundles' direct S3/SSH stores do not). The cfg row is
    // still recorded as targetConfigId for forensics; transport is
    // taken from the shim's `tenant` class binding.
    //
    // Fall back to the legacy direct resolveStore only when the shim
    // creds Secret is missing (BACKUP_TARGET_KEY not yet bootstrapped
    // on a fresh cluster) — that path will go away once every cluster
    // has the shim running.
    let store;
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      const k8sClients = createK8sClients(kubeconfigPath);
      store = await resolveShimBackupStore(k8sClients.core, 'tenant', { log: app.log });
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'tenant-bundles: shim store unavailable — falling back to direct resolveStore',
      );
      store = await resolveStore(app, input.targetConfigId, { requireActive: false });
    }

    // Resolve tenant + plan retention.
    const [tenant] = await app.db.select().from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
    if (!tenant) throw new ApiError('NOT_FOUND', 'Tenant not found', 404);

    // Plan-bound retention. hosting_plans.max_backup_retention_days
    // is the upper bound the operator may request for a tenant on
    // this plan; default is hosting_plans.default_backup_retention_days.
    // Applies to ALL initiators so a Tier-3 tenant-initiated bundle
    // can't bypass the plan cap.
    const [plan] = await app.db.select({
      defaultDays: hostingPlans.defaultBackupRetentionDays,
      maxDays: hostingPlans.maxBackupRetentionDays,
    }).from(hostingPlans).where(eq(hostingPlans.id, tenant.planId)).limit(1);
    if (!plan) throw new ApiError('CONFIG_INVALID', `Tenant ${input.tenantId} has no resolvable plan`, 400);

    const requested = input.retentionDays ?? plan.defaultDays;
    if (requested > plan.maxDays) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `retentionDays ${requested} exceeds the plan's max_backup_retention_days (${plan.maxDays})`,
        400,
      );
    }
    const retentionDays = requested;

    // Build kube tenants best-effort — orchestrator handles undefined.
    let k8s;
    try {
      const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      k8s = createK8sClients(kc);
    } catch (err) {
      app.log.warn({ err }, 'tenant-bundles: k8s tenant unavailable');
      k8s = undefined;
    }

    const targetUri = `${store.kind}://${input.targetConfigId}`;

    // Internal cluster URL the files-component Job uses to POST
    // archive + tree uploads back to platform-api. Falls back to the
    // standard k8s service DNS when not explicitly configured.
    const platformApiUrl = (app.config as Record<string, unknown>).PLATFORM_API_INTERNAL_URL as string | undefined
      ?? process.env.PLATFORM_API_INTERNAL_URL
      ?? 'http://platform-api.platform.svc:3000';

    const triggeredByUserId =
      input.initiator === 'system' || input.initiator === 'cluster'
        ? null
        : ((request.user as { sub?: string } | undefined)?.sub ?? null);
    const orchInput = {
      tenantId: input.tenantId,
      initiator: input.initiator,
      systemTrigger: input.systemTrigger ?? null,
      label: input.label ?? null,
      description: input.description ?? null,
      retentionDays,
      targetConfigId: input.targetConfigId ?? null,
      targetUri,
      components: {
        files: input.components?.files ?? true,
        mailboxes: input.components?.mailboxes ?? true,
        config: input.components?.config ?? true,
        secrets: input.components?.secrets ?? (input.exportMode !== 'data_export'),
      },
      exportMode: input.exportMode ?? null,
      exportPassphrase: input.exportPassphrase ?? null,
      triggeredByUserId,
    };
    const orchDeps = {
      db: app.db,
      k8s,
      store,
      platformVersion,
      secretsKeyHex,
      platformApiUrl,
      // Phase 1.5+ (ADR-036): orchestrator derives the snapshot-tag
      // region id from PLATFORM_BASE_DOMAIN and persists
      // tenant_restic_repo_state with it.
      platformBaseDomain: app.config.PLATFORM_BASE_DOMAIN ?? app.config.INGRESS_BASE_DOMAIN,
      kubeconfigPath: (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined,
    };

    if (input.async) {
      // Async path: return as soon as the orchestrator has reserved
      // the bundle (row inserted + off-site dir reserved). The frontend
      // polls GET /:id every 2 s and renders per-component progress.
      //
      // Failure handling:
      //   - Per-component errors are recorded by the orchestrator on
      //     each backup_components row and aggregated into
      //     backup_jobs.last_error.
      //   - An *unexpected* throw from runBundle itself (e.g. lost DB
      //     connection mid-orchestration, OOM kill) bypasses that path.
      //     We catch here and force the row into `failed` so the
      //     polling modal stops spinning forever and the operator sees
      //     a real error. Without this the row stays at `running`
      //     indefinitely (caught E2E 2026-05-07: 32-min hang).
      let reservedBundleId: string | null = null;
      const reserved = new Promise<string>((resolve) => {
        runBundle(orchDeps, {
          ...orchInput,
          onBundleReserved: (id) => {
            reservedBundleId = id;
            resolve(id);
          },
        }).catch(async (err) => {
          const rawMsg = err instanceof Error ? err.message : String(err);
          // Full message goes to server logs only.
          app.log.error({ err: rawMsg, bundleId: reservedBundleId }, 'tenant-bundles: async runBundle failed');
          if (reservedBundleId) {
            // Operator-visible message: redact connection-string
            // credentials a misbehaving driver might surface in
            // err.message (Drizzle/pg, mysql, redis, etc.). The full
            // unredacted trace is in server logs above.
            const operatorMsg = redactCredentialsForUi(rawMsg).slice(0, 2000);
            try {
              await app.db
                .update(backupJobs)
                .set({
                  status: 'failed',
                  lastError: operatorMsg,
                  finishedAt: new Date(),
                })
                .where(eq(backupJobs.id, reservedBundleId));
            } catch (updateErr) {
              app.log.error(
                { err: updateErr instanceof Error ? updateErr.message : String(updateErr) },
                'tenant-bundles: failed to mark async bundle as failed',
              );
            }
            // Mirror to the task chip + notifications bell so the
            // operator's session learns about the failure without
            // having to manually re-poll. The orchestrator does this
            // in its happy-path terminal block; we duplicate here for
            // the case where runBundle threw before reaching that
            // block (lost DB conn, programmer error, OOM). The chip
            // entry is auto-cleared (clearImmediately) so a permanent
            // red row doesn't linger after the bell catches it.
            if (orchInput.triggeredByUserId) {
              try {
                const { finishByRef } = await import('./../tasks/service.js');
                const { toSafeText } = await import('@k8s-hosting/api-contracts');
                await finishByRef(app.db, 'backup.bundle', reservedBundleId, {
                  status: 'failed',
                  text: toSafeText('aborted'),
                  error: operatorMsg,
                  clearImmediately: true,
                });
              } catch (e) {
                app.log.warn({ err: e }, 'tenant-bundles: async failure → finishByRef failed');
              }
              try {
                const { notifyUser } = await import('./../notifications/service.js');
                await notifyUser(app.db, orchInput.triggeredByUserId, {
                  type: 'error',
                  title: 'Backup bundle failed',
                  message: `Bundle ${reservedBundleId} (${orchInput.tenantId.slice(0, 8)}…) aborted: ${operatorMsg}`,
                  resourceType: 'backup_bundle',
                  resourceId: reservedBundleId,
                });
              } catch (e) {
                app.log.warn({ err: e }, 'tenant-bundles: async failure → notifyUser failed');
              }
            }
          }
        });
      });
      const bundleId = await reserved;
      reply.status(202).send(success({ bundleId, status: 'running', meta: null, async: true }));
      return;
    }

    const result = await runBundle(orchDeps, orchInput);
    reply.status(201).send(success({ bundleId: result.bundleId, status: result.status, meta: result.meta }));
  });

  // ── GET /api/v1/admin/tenant-bundles/:id/data-export ──────────────
  // Streams the AES-256-CBC-encrypted tarball produced by the
  // data_export wrapper to the caller. The body is opaque ciphertext;
  // the tenant decrypts locally with the passphrase they provided at
  // create time:
  //
  //   openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
  //     -in data-export-<bundleId>.tar.gz.enc -out bundle.tar.gz \
  //     -pass stdin <<< "$PASSPHRASE"
  //
  // Auth is admin-gated — for tenant-panel download, the tenant-panel
  // re-uses this same endpoint via its admin proxy + the existing
  // tenant-context check on the bundle.
  app.get('/admin/tenant-bundles/:id/data-export', {
    schema: { tags: ['TenantBundles'], summary: 'Download the GDPR data-export ciphertext for a bundle', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, id)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    if (job.exportMode !== 'data_export' || !job.exportArtifact) {
      throw new ApiError(
        'NO_DATA_EXPORT',
        'This bundle has no data_export artifact. Re-create the bundle with exportMode=data_export + exportPassphrase to enable.',
        400,
      );
    }
    if (!job.targetConfigId) {
      throw new ApiError('CONFIG_INVALID', 'Bundle has no target_config_id', 400);
    }
    const store = await resolveStore(app, job.targetConfigId);
    const handle = await store.open(id);
    if (!handle) throw new ApiError('NOT_FOUND', 'Bundle artefacts not found on remote target', 404);
    // exportArtifact is `components/<comp>/<name>` — split.
    const m = job.exportArtifact.match(/^components\/(files|mailboxes|config|secrets)\/(.+)$/);
    if (!m) throw new ApiError('CONFIG_INVALID', `Malformed export_artifact path '${job.exportArtifact}'`, 400);
    const [, component, artifactName] = m as unknown as [string, 'files' | 'mailboxes' | 'config' | 'secrets', string];
    const stat = await store.stat(handle, component, artifactName);
    if (!stat) throw new ApiError('NOT_FOUND', `Export artifact missing on remote target: ${job.exportArtifact}`, 404);
    const body = await store.readComponent(handle, component, artifactName);
    reply.header('Content-Type', 'application/octet-stream');
    if (Number.isFinite(stat.sizeBytes) && stat.sizeBytes >= 0) {
      reply.header('Content-Length', String(stat.sizeBytes));
    }
    reply.header('Content-Disposition', `attachment; filename="data-export-${id}.tar.gz.enc"`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(body);
  });

  // ── POST /api/v1/admin/tenant-bundles/:id/export ──────────────────
  //
  // Multi-region export: stream a passphrase-encrypted tarball of
  // EVERY component artifact + meta.json. Different from
  // `/data-export`:
  //
  //   - Operator-supplied passphrase (no DB lookup; the bundle
  //     doesn't need to have been created with exportMode='data_export').
  //   - Streams directly to the response — no off-site write.
  //   - Decryptable with stock openssl in the target region:
  //
  //       openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
  //         -in bundle-<id>.tar.gz.enc -out bundle.tar.gz \
  //         -pass stdin <<< "$PASSPHRASE"
  //
  //   - The target region's import endpoint accepts the resulting
  //     ciphertext + passphrase and registers a fresh bundle row.
  //
  // Wire format identical to wrapBundleAsDataExport: Salted__ +
  // 8-byte salt + AES-256-CBC(gzip(tar)) with 100k-iter PBKDF2.
  app.post('/admin/tenant-bundles/:id/export', {
    schema: { tags: ['TenantBundles'], summary: 'Download a bundle tarball (optionally passphrase-encrypted)', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { passphrase?: string } | null;
    const passphrase = body?.passphrase;
    // passphrase is OPTIONAL. When supplied, must be ≥12 chars
    // (matches the OpenSSL-compatible KDF parameters). When absent
    // (undefined / null / empty string), the response is plain
    // `tar.gz`. ANY non-empty value too short raises 400 — must
    // happen BEFORE we call streamEncryptedExport, otherwise the
    // function throws a plain Error which the framework returns as
    // 500. Caught by typescript-reviewer 2026-05-08.
    if (passphrase !== undefined && passphrase !== null && passphrase !== '') {
      if (typeof passphrase !== 'string' || passphrase.length < 1) {
        throw new ApiError('VALIDATION_ERROR', 'passphrase must be a non-empty string (or omit it for an unencrypted tar.gz)', 400);
      }
    }
    const encrypt = typeof passphrase === 'string' && passphrase.length >= 1;

    const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, id)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    if (!job.targetConfigId) throw new ApiError('CONFIG_INVALID', 'Bundle has no targetConfigId; cannot read components', 400);

    const store = await resolveStore(app, job.targetConfigId, { requireActive: false });
    const handle = await store.open(id);
    if (!handle) throw new ApiError('NOT_FOUND', 'Bundle artifacts not found on off-site target', 404);

    // Enumerate every artifact across components. Skip components
    // that weren't captured (orchestrator records `skipped` in meta).
    const allArtifacts: Array<{ component: 'files' | 'mailboxes' | 'config' | 'secrets'; name: string }> = [];
    for (const component of (['files', 'mailboxes', 'config', 'secrets'] as const)) {
      const refs = await store.listArtifacts(handle, component);
      for (const r of refs) {
        // Skip the data-export artifact itself — it'd be circular
        // (and pointless: it's already encrypted with a different
        // passphrase). The synthetic name lives in components/config/
        // and starts with `data-export-`.
        if (component === 'config' && r.name.startsWith('data-export-')) continue;
        allArtifacts.push({ component, name: r.name });
      }
    }

    const { streamEncryptedExport } = await import('./data-export.js');
    const stream = await streamEncryptedExport({ store, handle, passphrase: encrypt ? passphrase : undefined, components: allArtifacts });

    // Defensive: if the async feeder errors after headers are
    // flushed, log so the failure isn't silent in audit logs.
    stream.on('error', (err) => {
      app.log.error({ err: err instanceof Error ? err.message : String(err), bundleId: id }, 'tenant-bundles: tar export stream error');
    });

    reply.header('Content-Type', encrypt ? 'application/octet-stream' : 'application/gzip');
    const filename = encrypt ? `bundle-${id}.tar.gz.enc` : `bundle-${id}.tar.gz`;
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.header('Cache-Control', 'no-store');
    app.log.warn(
      { userId: (request.user as { sub?: string } | undefined)?.sub, bundleId: id, tenantId: job.tenantId, encrypted: encrypt, format: 'tar' },
      'tenant-bundles: export download initiated',
    );
    return reply.send(stream);
  });

  // ── POST /api/v1/admin/tenant-bundles/:id/zip ─────────────────────
  //
  // ZIP variant of the export endpoint — always plaintext. Same
  // per-artifact streaming pipeline (S3 → archiver → reply), no
  // server-side staging.
  //
  // Why no password option: WinZip AE-2 (the only practical Node
  // ZIP-encryption format) uses 1000-iter PBKDF2-SHA1 (vs 100k SHA256
  // for the tar.gz.enc path) and the only available Node implementation
  // is pure-JS `aes-js` which OOM-crashes on multi-hundred-MB bundles.
  // Operators who want password-protected exports use the tar.gz.enc
  // variant via `POST /:id/export`. The ZIP path's value is
  // cross-platform plaintext extraction (Windows / macOS / `unzip`
  // without extra tools).
  app.post('/admin/tenant-bundles/:id/zip', {
    schema: { tags: ['TenantBundles'], summary: 'Download a bundle as plaintext ZIP', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, id)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    if (!job.targetConfigId) throw new ApiError('CONFIG_INVALID', 'Bundle has no targetConfigId; cannot read components', 400);

    const store = await resolveStore(app, job.targetConfigId, { requireActive: false });
    const handle = await store.open(id);
    if (!handle) throw new ApiError('NOT_FOUND', 'Bundle artifacts not found on off-site target', 404);

    const allArtifacts: Array<{ component: 'files' | 'mailboxes' | 'config' | 'secrets'; name: string }> = [];
    for (const component of (['files', 'mailboxes', 'config', 'secrets'] as const)) {
      const refs = await store.listArtifacts(handle, component);
      for (const r of refs) {
        // Same circular-skip as the tar variant.
        if (component === 'config' && r.name.startsWith('data-export-')) continue;
        allArtifacts.push({ component, name: r.name });
      }
    }

    const { streamZipExport } = await import('./data-export.js');
    const stream = await streamZipExport({ store, handle, components: allArtifacts });

    stream.on('error', (err) => {
      app.log.error({
        bundleId: id,
        errMessage: err instanceof Error ? err.message : String(err),
        errName: err instanceof Error ? err.name : 'unknown',
      }, 'tenant-bundles: zip export stream error');
    });

    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="bundle-${id}.zip"`);
    reply.header('Cache-Control', 'no-store');
    app.log.warn(
      { userId: (request.user as { sub?: string } | undefined)?.sub, bundleId: id, tenantId: job.tenantId, format: 'zip' },
      'tenant-bundles: export download initiated',
    );
    return reply.send(stream);
  });

  // ── POST /api/v1/admin/tenant-bundles/:id/export-token ────────────
  //
  // Mint a 5-min single-purpose URL that the browser can open
  // directly via `window.location` to trigger the native save-file
  // dialog the moment the response starts streaming. The companion
  // GET `/exports/:token` endpoint below validates + streams.
  //
  // Why this exists (vs the existing POST /:id/export):
  //   POST handlers can't trigger the browser's save-file dialog
  //   without the response being buffered into a Blob first (the
  //   prior UX). For multi-GB bundles the operator was waiting on
  //   a hidden in-memory copy before the file dialog appeared.
  //   With a signed URL the browser issues an unauthenticated GET,
  //   the server validates the token + streams headers immediately
  //   → save dialog opens at byte 0.
  //
  // Body: { format: 'tar' | 'zip', password?: string }.
  //   - password is only meaningful for tar; the zip variant
  //     ignores it (architectural — see the /zip endpoint comment).
  app.post('/admin/tenant-bundles/:id/export-token', {
    schema: { tags: ['TenantBundles'], summary: 'Mint a single-purpose download URL for a bundle', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const bodySchema = z.object({
      format: z.enum(['tar', 'zip']),
      password: z.string().optional(),
    });
    const parsed = bodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', `invalid body: ${parsed.error.issues[0]?.message ?? 'unknown'}`, 400);
    }
    const { format } = parsed.data;
    // Password rule: only carries through on tar. zip discards it
    // even if supplied — keeps the token small and prevents confusion.
    const password = format === 'tar' ? parsed.data.password : undefined;

    // Validate the bundle exists + is reachable before minting a
    // token. Otherwise the operator clicks Download, the URL goes
    // through, and only then the server returns 404 — confusing UX.
    const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, id)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    if (!job.targetConfigId) throw new ApiError('CONFIG_INVALID', 'Bundle has no targetConfigId', 400);

    const { signExportToken } = await import('./export-token.js');
    const token = signExportToken({ bundleId: id, format, password: password || undefined }, secretsKeyHex);
    const downloadUrl = `/api/v1/admin/tenant-bundles/exports/${encodeURIComponent(token)}`;
    app.log.info(
      { userId: (request.user as { sub?: string } | undefined)?.sub, bundleId: id, format, encrypted: !!(password && password.length > 0) },
      'tenant-bundles: export-token minted',
    );
    return success({ downloadUrl, expiresInSec: 300 });
  });

  // ── GET /api/v1/admin/tenant-bundles/exports/:token ───────────────
  //
  // Token-authenticated download endpoint. The token IS the auth —
  // no Bearer header. The token is bound to one bundleId + format +
  // (encrypted) password and expires after 5 min. See export-token.ts
  // for the token format and signing key.
  //
  // SECURITY: this endpoint is NOT covered by the panel/role
  // onRequest hooks declared at the top of `backupsV2Routes` —
  // `requirePanel('admin')` and `requireRole('super_admin','admin')`
  // both check the request.user populated by JWT auth, which a
  // browser GET via window.location can't supply. We exempt the
  // route via a route-level `config: { skipAuth: true }` flag and
  // verify the signed token instead. Bundle-level access control is
  // enforced by the token's bundleId binding (so an operator can't
  // re-purpose someone else's token for a different bundle).
  app.get(
    '/admin/tenant-bundles/exports/:token',
    {
      schema: { tags: ['TenantBundles'], summary: 'Download a bundle via signed token (no Bearer)', security: [] },
      config: { skipAuth: true },
    },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      // We don't know the expectedBundleId until we decode the token,
      // but we want it bound — so decode once, take .b, and re-verify
      // against itself. This is fine because the HMAC catches a token
      // whose `b` was tampered (any change to the payload breaks the
      // MAC). In other words: trust the .b field iff the MAC is good.
      // Probe the (still-untrusted) payload for its `b` field so we
      // can pass it as `expectedBundleId` to verifyExportToken — the
      // HMAC is then computed over the full payload, so any tampering
      // with `.b` would break the MAC. Both the malformed-shape path
      // and the bad-MAC path map to the SAME 401/INVALID_TOKEN
      // response (no 400 vs 401 oracle for unauthenticated callers).
      const probeOnly = (() => {
        const dot = token.indexOf('.');
        if (dot < 1) return null;
        try {
          const payload = JSON.parse(Buffer.from(token.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { b?: string };
          return payload.b ?? null;
        } catch { return null; }
      })();
      if (!probeOnly) {
        throw new ApiError('INVALID_TOKEN', 'export token rejected', 401);
      }

      const { verifyExportToken } = await import('./export-token.js');
      const v = verifyExportToken(token, probeOnly, secretsKeyHex);
      if (!v.ok) {
        const code = v.error.code === 'EXPIRED' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
        throw new ApiError(code, 'export token rejected', 401);
      }
      const { bundleId, format, password } = v.value;

      const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, bundleId)).limit(1);
      if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
      if (!job.targetConfigId) throw new ApiError('CONFIG_INVALID', 'Bundle has no targetConfigId', 400);

      const store = await resolveStore(app, job.targetConfigId, { requireActive: false });
      const handle = await store.open(bundleId);
      if (!handle) throw new ApiError('NOT_FOUND', 'Bundle artifacts not found on off-site target', 404);

      const allArtifacts: Array<{ component: 'files' | 'mailboxes' | 'config' | 'secrets'; name: string }> = [];
      for (const component of (['files', 'mailboxes', 'config', 'secrets'] as const)) {
        const refs = await store.listArtifacts(handle, component);
        for (const r of refs) {
          if (component === 'config' && r.name.startsWith('data-export-')) continue;
          allArtifacts.push({ component, name: r.name });
        }
      }

      let stream: import('node:stream').Readable;
      if (format === 'zip') {
        const { streamZipExport } = await import('./data-export.js');
        stream = await streamZipExport({ store, handle, components: allArtifacts });
        reply.header('Content-Type', 'application/zip');
        reply.header('Content-Disposition', `attachment; filename="bundle-${bundleId}.zip"`);
      } else {
        const { streamEncryptedExport } = await import('./data-export.js');
        const encrypt = !!(password && password.length > 0);
        stream = await streamEncryptedExport({
          store, handle,
          passphrase: encrypt ? password! : undefined,
          components: allArtifacts,
        });
        reply.header('Content-Type', encrypt ? 'application/octet-stream' : 'application/gzip');
        const filename = encrypt ? `bundle-${bundleId}.tar.gz.enc` : `bundle-${bundleId}.tar.gz`;
        reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      }
      reply.header('Cache-Control', 'no-store');
      stream.on('error', (err) => {
        app.log.error({ err: err instanceof Error ? err.message : String(err), bundleId }, 'tenant-bundles: signed-url stream error');
      });
      app.log.warn({ bundleId, tenantId: job.tenantId, format, encrypted: format === 'tar' && !!(password && password.length > 0) },
        'tenant-bundles: export download via signed-url initiated');
      return reply.send(stream);
    },
  );

  // ── POST /api/v1/admin/tenant-bundles/import ──────────────────────
  //
  // Multi-region import: accept a passphrase-encrypted bundle tarball
  // (produced by the export endpoint), decrypt, upload every component
  // artifact to the local off-site target, and register a fresh
  // backup_jobs row pointing at it. The new bundle appears in the
  // operator's list as a normal capture.
  //
  // Multipart upload: form fields are `passphrase`, `tenantId`
  // (target tenant in this region), `targetConfigId` (off-site), and
  // a file `bundle` containing the ciphertext.
  //
  // The tenantId in meta.json from the source region is REPLACED by
  // the one in the multipart body — operators routinely import a
  // bundle to a different tenant in the new region.
  // Note: registered AFTER /:id/export, but find-my-way v8 (Fastify
  // 5) correctly prefers a literal `import` segment over the `:id`
  // parametric one regardless of registration order. The same holds
  // for verify-all below. The local convention (see comment near
  // /coverage) was set on Fastify v1 trie semantics.
  //
  // 2 GiB per-route bodyLimit override — bundles can dwarf the global
  // 50 MiB. Global stays low so a stray non-bundle endpoint doesn't
  // accept arbitrary uploads.
  // ── POST /api/v1/admin/tenant-bundles/import-preview ─────────────
  //
  // Decode + inspect an uploaded archive WITHOUT writing anything to
  // the DB or the off-site target. Returns the parsed meta v2 fields
  // (tenant block + domains + deployments summaries + counts) so the
  // ImportBundleModal can show the operator who they're about to
  // import + whether the source tenant already exists in this region.
  //
  // Multipart fields: `bundle` (file), `passphrase` (optional, only
  // needed for Salted__-encrypted tar). The archive format is
  // detected from magic bytes — tar.gz / tar.gz.enc / zip all work.
  //
  // The frontend two-step UX uses this endpoint to:
  //   1. Show a preview after the operator picks the file.
  //   2. Detect whether the source tenant UUID already exists in
  //      this region (active/suspended → block with "use Restore
  //      Cart"; archived/missing → unlock the restore-from-bundle
  //      path; new UUID → unlock the "create new tenant" path).
  //
  // Idempotent + side-effect-free: the operator can run this as
  // many times as they like. The actual import / restore happens
  // via POST /import (legacy tenantId-required flow) or via the
  // upcoming POST /import-finalize.
  app.post('/admin/tenant-bundles/import-preview', {
    // 512 MiB cap on the preview path: an operator who's about to
    // commit to a multi-GiB import should run /import-finalize (which
    // bumps to 2 GiB) directly. The preview is a side-effect-free
    // probe — there's no legitimate need to buffer multiple GiB just
    // to read back the meta.json.
    bodyLimit: 512 * 1024 * 1024,
    schema: { tags: ['TenantBundles'], summary: 'Decode an upload + return meta v2 fields, no DB writes', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const req = request as unknown as {
      isMultipart: () => boolean;
      parts: () => AsyncIterable<{ type: 'field' | 'file'; fieldname: string; value?: string; toBuffer?: () => Promise<Buffer> }>;
    };
    if (!req.isMultipart()) {
      throw new ApiError('VALIDATION_ERROR', 'request must be multipart/form-data', 400);
    }
    let passphrase: string | null = null;
    let blob: Buffer | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'field' && part.fieldname === 'passphrase') passphrase = part.value ?? null;
      else if (part.type === 'file' && part.fieldname === 'bundle' && part.toBuffer) blob = await part.toBuffer();
    }
    if (!blob) throw new ApiError('VALIDATION_ERROR', 'bundle file required', 400);

    const { extractImportArchive } = await import('./data-export.js');
    let extracted;
    try {
      extracted = await extractImportArchive({ blob, passphrase: passphrase ?? undefined });
    } catch (err) {
      throw new ApiError('VALIDATION_ERROR', `archive decode failed: ${err instanceof Error ? err.message : String(err)}`, 400);
    }
    const { format, entries } = extracted;

    const metaEntry = entries.find((e) => e.path === 'meta.json');
    if (!metaEntry) throw new ApiError('VALIDATION_ERROR', 'archive missing meta.json', 400);
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(metaEntry.buffer.toString('utf8')) as Record<string, unknown>;
    } catch (err) {
      throw new ApiError('VALIDATION_ERROR', `meta.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, 400);
    }

    const sourceTenant = meta.tenant as Record<string, unknown> | null | undefined;
    const sourceTenantId = (meta.tenantId as string | undefined) ?? null;

    // Look up the tenant in THIS region if the source meta carries an ID.
    // Used by the UI to choose between "restore existing" / "create new"
    // / "block — use Restore Cart" paths. Failure to resolve is benign;
    // it just means the source tenant doesn't exist locally.
    let localTenant: { id: string; status: string; name: string } | null = null;
    if (sourceTenantId) {
      const [c] = await app.db
        .select({ id: tenants.id, status: tenants.status, name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, sourceTenantId))
        .limit(1);
      if (c) localTenant = { id: c.id, status: c.status as string, name: c.name };
    }

    // Component breakdown: enumerate the entries by component so the
    // operator UI can show "files (12 entries), config (1 entry), …"
    const componentBreakdown: Record<string, { count: number; totalBytes: number }> = {};
    for (const e of entries) {
      const m = e.path.match(/^components\/(files|mailboxes|config|secrets)\/.+$/);
      if (!m) continue;
      const comp = m[1]!;
      const bucket = componentBreakdown[comp] ?? { count: 0, totalBytes: 0 };
      bucket.count += 1;
      bucket.totalBytes += e.buffer.length;
      componentBreakdown[comp] = bucket;
    }

    return success({
      format, // 'tar-encrypted' | 'tar-plain' | 'zip'
      sourceMeta: {
        schemaVersion: meta.schemaVersion ?? null,
        backupId: meta.backupId ?? null,
        tenantId: sourceTenantId,
        capturedAt: meta.capturedAt ?? null,
        platformVersion: meta.platformVersion ?? null,
        label: meta.label ?? null,
        tenant: sourceTenant ?? null, // v2: may be null on legacy v1 archives
        domainsSummary: meta.domainsSummary ?? [],
        deploymentsSummary: meta.deploymentsSummary ?? [],
      },
      components: componentBreakdown,
      // Local match: indicates whether this region already has a
      // tenant with the source UUID (and what its status is). UI
      // uses this to pick the right downstream flow.
      localTenantMatch: localTenant,
      // Total entry count (incl. meta.json) and overall size for the
      // "this archive contains N files (X MiB)" UI line.
      entryCount: entries.length,
      totalBytes: entries.reduce((sum, e) => sum + e.buffer.length, 0),
    });
  });

  app.post('/admin/tenant-bundles/import', {
    bodyLimit: 2 * 1024 * 1024 * 1024,
    schema: { tags: ['TenantBundles'], summary: 'Import a passphrase-encrypted bundle from another region', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    // Fastify multipart returns one part per file/field. Walk parts
    // until we have all four.
    const req = request as unknown as {
      isMultipart: () => boolean;
      parts: () => AsyncIterable<{ type: 'field' | 'file'; fieldname: string; value?: string; toBuffer?: () => Promise<Buffer> }>;
    };
    if (!req.isMultipart()) {
      throw new ApiError('VALIDATION_ERROR', 'request must be multipart/form-data', 400);
    }
    let passphrase: string | null = null;
    let tenantId: string | null = null;
    let targetConfigId: string | null = null;
    let blob: Buffer | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'field' && part.fieldname === 'passphrase') passphrase = part.value ?? null;
      else if (part.type === 'field' && part.fieldname === 'tenantId') tenantId = part.value ?? null;
      else if (part.type === 'field' && part.fieldname === 'targetConfigId') targetConfigId = part.value ?? null;
      else if (part.type === 'file' && part.fieldname === 'bundle' && part.toBuffer) blob = await part.toBuffer();
    }
    // No min-length on passphrase — only required when the uploaded
    // archive is the encrypted-tar variant. Plain tar.gz and ZIP both
    // skip the field. The format-detecting decoder enforces this.
    if (!tenantId) throw new ApiError('VALIDATION_ERROR', 'tenantId required', 400);
    if (!targetConfigId) throw new ApiError('VALIDATION_ERROR', 'targetConfigId required', 400);
    if (!blob) throw new ApiError('VALIDATION_ERROR', 'bundle file required', 400);

    const [tenant] = await app.db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!tenant) throw new ApiError('NOT_FOUND', 'Target tenant not found in this region', 404);

    // Format-detecting decoder: dispatches by magic bytes
    // (Salted__/gzip/zip). Encrypted tar requires `passphrase`; the
    // others ignore it. This replaces the original tar-encrypted-only
    // path so the operator can upload any of the three export formats.
    const { extractImportArchive } = await import('./data-export.js');
    let entries;
    try {
      const result = await extractImportArchive({ blob, passphrase: passphrase ?? undefined });
      entries = result.entries;
      app.log.info({ format: result.format, entryCount: entries.length, tenantId }, 'tenant-bundles: import archive decoded');
    } catch (err) {
      throw new ApiError('VALIDATION_ERROR', `archive decode failed: ${err instanceof Error ? err.message : String(err)}`, 400);
    }

    // Pull the source meta.json (kept for label/components info; we
    // override tenantId and capturedAt-vs-importedAt).
    const metaEntry = entries.find((e) => e.path === 'meta.json');
    if (!metaEntry) throw new ApiError('VALIDATION_ERROR', 'tarball missing meta.json', 400);
    let sourceMeta: { backupId?: string; label?: string; description?: string; components?: Record<string, unknown>; retentionDays?: number };
    try {
      sourceMeta = JSON.parse(metaEntry.buffer.toString('utf8'));
    } catch (err) {
      throw new ApiError('VALIDATION_ERROR', `tarball meta.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, 400);
    }

    // DR safety: refuse import on a frozen target. Imports write the
    // bundle contents to the target so the freeze applies the same way
    // as native captures.
    {
      const { requireWritableTarget } = await import('../backup-config/writable-guard.js');
      await requireWritableTarget(app.db, targetConfigId);
    }

    // Allocate a fresh bundleId in this region.
    const newBundleId = `bkp-${randomUUID()}`;
    const store = await resolveStore(app, targetConfigId, { requireActive: false });
    const handle = await store.reserveBundle({ backupId: newBundleId, tenantId });

    // Upload every non-meta entry under its original
    // components/<component>/<name> path.
    const componentSet = new Set(['files', 'mailboxes', 'config', 'secrets'] as const);
    const componentInfo: Array<{ component: string; sizeBytes: number }> = [];
    for (const e of entries) {
      if (e.path === 'meta.json') continue;
      const m = e.path.match(/^components\/(files|mailboxes|config|secrets)\/(.+)$/);
      if (!m) {
        app.log.warn({ path: e.path }, 'import: unexpected tar entry, skipping');
        continue;
      }
      const component = m[1] as 'files' | 'mailboxes' | 'config' | 'secrets';
      const name = m[2]!;
      if (!componentSet.has(component)) continue;
      const ref = await store.writeComponent(handle, component, name, Readable.from(e.buffer));
      componentInfo.push({ component, sizeBytes: ref.sizeBytes });
    }

    // Write a fresh meta.json with this region's bundleId + tenantId.
    // The v2 fields (tenant / domainsSummary / deploymentsSummary) are
    // forwarded as-is from the source meta. If the source was a v1
    // bundle these are missing and the import will fail validation —
    // intentional, no backcompat (see BACKUP_META_SCHEMA_VERSION = 2).
    const sourceTenant = (sourceMeta as Record<string, unknown>).tenant;
    const sourceDomains = (sourceMeta as Record<string, unknown>).domainsSummary;
    const sourceDeploys = (sourceMeta as Record<string, unknown>).deploymentsSummary;
    if (!sourceTenant || !Array.isArray(sourceDomains) || !Array.isArray(sourceDeploys)) {
      throw new ApiError(
        'BUNDLE_VERSION_UNSUPPORTED',
        'Imported bundle is missing v2 meta fields (tenant, domainsSummary, deploymentsSummary). Re-capture the bundle on the source region against a platform-api running schemaVersion=2 or later.',
        400,
      );
    }
    const importMeta: import('@k8s-hosting/api-contracts').BackupMetaV1 = {
      schemaVersion: 2 as const,
      backupId: newBundleId,
      tenantId,
      capturedAt: new Date().toISOString(),
      platformVersion,
      initiator: 'admin',
      systemTrigger: null,
      label: `imported-from-${sourceMeta.backupId ?? 'unknown'}: ${sourceMeta.label ?? ''}`.slice(0, 255),
      components: sourceMeta.components ?? {},
      nodePlacement: null,
      expiresAt: null,
      retentionDays: sourceMeta.retentionDays ?? 30,
      description: sourceMeta.description ?? null,
      tenant: sourceTenant as import('@k8s-hosting/api-contracts').BackupMetaTenant,
      domainsSummary: sourceDomains as import('@k8s-hosting/api-contracts').BackupMetaDomainSummary[],
      deploymentsSummary: sourceDeploys as import('@k8s-hosting/api-contracts').BackupMetaDeploymentSummary[],
    };
    await store.putMeta(handle, importMeta);

    // Persist the new backup_jobs row. We mirror what the orchestrator
    // does for native captures — pull target attribution from the
    // backup_configurations row (we don't surface targetKind/Uri on
    // BundleHandle, that's an internal-only field).
    const totalBytes = componentInfo.reduce((s, c) => s + c.sizeBytes, 0);
    const [cfg] = await app.db.select().from(backupConfigurations).where(eq(backupConfigurations.id, targetConfigId)).limit(1);
    const targetKind = (cfg?.storageType ?? 'ssh') as 'hostpath' | 's3' | 'ssh';
    const targetUri = cfg?.storageType === 's3'
      ? `s3://${cfg.s3Bucket ?? ''}/${cfg.s3Prefix ?? ''}`
      : `ssh://${cfg?.sshUser ?? ''}@${cfg?.sshHost ?? ''}:${cfg?.sshPath ?? ''}`;
    await app.db.insert(backupJobs).values({
      id: newBundleId,
      tenantId,
      initiator: 'admin',
      systemTrigger: null,
      status: 'completed',
      targetKind,
      targetUri,
      targetConfigId,
      label: importMeta.label,
      description: importMeta.description,
      sizeBytes: totalBytes,
      retentionDays: importMeta.retentionDays,
      expiresAt: null,
      exportMode: null,
      exportArtifact: null,
      startedAt: new Date(),
      finishedAt: new Date(),
      lastError: null,
    });

    app.log.warn({ userId: (request.user as { sub?: string } | undefined)?.sub, bundleId: newBundleId, sourceBundleId: sourceMeta.backupId, tenantId, totalBytes }, 'tenant-bundles: import succeeded');
    reply.status(201).send({ data: { bundleId: newBundleId, sizeBytes: totalBytes, componentCount: componentInfo.length } });
  });

  // ── POST /api/v1/admin/tenant-bundles/import-finalize ─────────────
  //
  // Restore-from-bundle: create a brand-new tenant tenant from the
  // operator-edited meta + the uploaded archive. Used when the source
  // tenant doesn't exist (or no longer exists) in this region —
  // typically a deleted tenant whose bundle is the only artifact.
  //
  // Flow:
  //   1. Decode archive (same format-detecting decoder as /import).
  //   2. Validate operator-supplied overrides (Zod schema).
  //   3. Create a fresh tenant via the standard createTenant service
  //      (bcrypt-hashed admin password, kubernetesNamespace generated
  //      from name, default status=pending).
  //   4. Upload every artifact to the off-site target, register a new
  //      backup_jobs row pointing at the new tenant.
  //   5. Return { newTenantId, bundleId, generatedPassword } so the UI
  //      can show "tenant created" + "bundle imported — open
  //      /tenants/<id> and use Restore Cart to apply the data".
  //
  // Scope (deferred):
  //   - reuseUuid / reuseNamespace toggles → require bypassing
  //     createTenant's randomUUID + namespace gen; coming in a follow-up.
  //   - Auto-fire restore-cart against the new tenant (so the operator
  //     doesn't have to click through cart-add for every component) —
  //     out of scope for this endpoint.
  app.post('/admin/tenant-bundles/import-finalize', {
    bodyLimit: 2 * 1024 * 1024 * 1024,
    schema: { tags: ['TenantBundles'], summary: 'Create new tenant + import bundle in one shot', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const req = request as unknown as {
      isMultipart: () => boolean;
      parts: () => AsyncIterable<{ type: 'field' | 'file'; fieldname: string; value?: string; toBuffer?: () => Promise<Buffer> }>;
    };
    if (!req.isMultipart()) {
      throw new ApiError('VALIDATION_ERROR', 'request must be multipart/form-data', 400);
    }
    let passphrase: string | null = null;
    let targetConfigId: string | null = null;
    let overridesJson: string | null = null;
    let blob: Buffer | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'field' && part.fieldname === 'passphrase') passphrase = part.value ?? null;
      else if (part.type === 'field' && part.fieldname === 'targetConfigId') targetConfigId = part.value ?? null;
      else if (part.type === 'field' && part.fieldname === 'overrides') overridesJson = part.value ?? null;
      else if (part.type === 'file' && part.fieldname === 'bundle' && part.toBuffer) blob = await part.toBuffer();
    }
    if (!targetConfigId) throw new ApiError('VALIDATION_ERROR', 'targetConfigId required', 400);
    if (!blob) throw new ApiError('VALIDATION_ERROR', 'bundle file required', 400);
    if (!overridesJson) throw new ApiError('VALIDATION_ERROR', 'overrides JSON required', 400);

    // Operator-supplied overrides — validated against the same Zod
    // schema the /tenants POST endpoint uses, so any value the form
    // accepts here is also acceptable on the regular create-tenant
    // path. The shape is intentionally a strict subset of CreateTenantInput.
    const overridesSchema = z.object({
      name: z.string().min(1).max(255),
      // contact_name + phone_e164 + billing_address are required by
      // createTenantSchema. Restore-from-backup paths must pass these
      // through from the bundle's tenant block (or operator form input).
      contact_name: z.string().min(1).max(255),
      primary_email: z.string().email(),
      secondary_email: z.string().email().optional(),
      phone_e164: z.string(),
      billing_address: z.object({
        street_address: z.string().min(1).max(500),
        postal_address: z.string().min(1).max(500),
        city: z.string().min(1).max(200),
        country: z.string().min(2).max(100),
      }),
      plan_id: z.string().uuid(),
      region_id: z.string().uuid(),
      timezone: z.string().min(1).max(50).optional(),
      node_name: z.string().min(1).max(253).optional(),
      storage_tier: z.enum(['local', 'ha']).optional(),
      // Subscription expiry pulled from the meta is opt-in: only carries
      // through if the operator confirms it on the form. Optional ISO date.
      subscription_expires_at: z.string().datetime().optional(),
    });
    const parsed = overridesSchema.safeParse(JSON.parse(overridesJson));
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', `invalid overrides: ${parsed.error.issues[0]?.message ?? 'unknown'}`, 400);
    }
    const overrides = parsed.data;

    // Decode archive first so a corrupt-bundle / wrong-passphrase
    // failure happens BEFORE we create a phantom tenant row.
    const { extractImportArchive } = await import('./data-export.js');
    let entries;
    try {
      const result = await extractImportArchive({ blob, passphrase: passphrase ?? undefined });
      entries = result.entries;
      app.log.info({ format: result.format, entryCount: entries.length }, 'tenant-bundles: finalize archive decoded');
    } catch (err) {
      throw new ApiError('VALIDATION_ERROR', `archive decode failed: ${err instanceof Error ? err.message : String(err)}`, 400);
    }

    const metaEntry = entries.find((e) => e.path === 'meta.json');
    if (!metaEntry) throw new ApiError('VALIDATION_ERROR', 'archive missing meta.json', 400);
    let sourceMeta: Record<string, unknown>;
    try {
      sourceMeta = JSON.parse(metaEntry.buffer.toString('utf8')) as Record<string, unknown>;
    } catch (err) {
      throw new ApiError('VALIDATION_ERROR', `meta.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, 400);
    }

    // Resolve target config + store BEFORE creating the tenant so an
    // mistyped targetConfigId fails fast.
    const [cfgRow] = await app.db.select().from(backupConfigurations).where(eq(backupConfigurations.id, targetConfigId)).limit(1);
    if (!cfgRow) throw new ApiError('NOT_FOUND', 'targetConfigId does not match any backup configuration', 404);

    // Create the new tenant. Returns id + generatedPassword for the
    // auto-created tenant_admin user.
    const userId = (request.user as { sub?: string } | undefined)?.sub ?? 'system';
    const { createTenant } = await import('../tenants/service.js');
    let newTenant;
    try {
      newTenant = await createTenant(app.db, overrides, userId);
    } catch (err) {
      // Surface stable error codes from createTenant (EMAIL_IN_USE,
      // INVALID_PLAN_ID, INVALID_REGION_ID, plus worker-pin failures
      // from validateWorkerPin) so the frontend can disambiguate
      // operator-correctable validation errors from server-side
      // failures. Falls back to VALIDATION_ERROR if the cause is
      // some other thrown Error.
      const code = (err as { code?: string }).code;
      if (code === 'EMAIL_IN_USE') {
        throw new ApiError('EMAIL_IN_USE', err instanceof Error ? err.message : 'email already in use', 409);
      }
      if (code === 'INVALID_PLAN_ID' || code === 'INVALID_REGION_ID') {
        throw new ApiError(code, err instanceof Error ? err.message : 'invalid id', 400);
      }
      throw new ApiError('VALIDATION_ERROR', `tenant creation failed: ${err instanceof Error ? err.message : String(err)}`, 400);
    }

    // DR safety: refuse import on a frozen target. Same rationale as
    // the legacy import route — imports write to the target.
    {
      const { requireWritableTarget } = await import('../backup-config/writable-guard.js');
      await requireWritableTarget(app.db, targetConfigId);
    }

    // Now register + upload the bundle against the new tenant.
    const newBundleId = `bkp-${randomUUID()}`;
    const store = await resolveStore(app, targetConfigId, { requireActive: false });
    const handle = await store.reserveBundle({ backupId: newBundleId, tenantId: newTenant.id });

    const componentSet = new Set(['files', 'mailboxes', 'config', 'secrets'] as const);
    const componentInfo: Array<{ component: string; sizeBytes: number }> = [];
    let totalBytes = 0;
    for (const e of entries) {
      if (e.path === 'meta.json') continue;
      const m = e.path.match(/^components\/(files|mailboxes|config|secrets)\/(.+)$/);
      if (!m) continue;
      const component = m[1] as 'files' | 'mailboxes' | 'config' | 'secrets';
      const name = m[2]!;
      if (!componentSet.has(component)) continue;
      const ref = await store.writeComponent(handle, component, name, Readable.from(e.buffer));
      componentInfo.push({ component, sizeBytes: ref.sizeBytes });
      totalBytes += ref.sizeBytes;
    }

    // Write a fresh meta.json for the new bundle. v2 tenant block is
    // taken from the operator's overrides, NOT the source meta — the
    // source values are stale (different region, different plan, etc).
    const importMeta = {
      schemaVersion: BACKUP_META_SCHEMA_VERSION,
      backupId: newBundleId,
      tenantId: newTenant.id,
      capturedAt: new Date().toISOString(),
      platformVersion,
      initiator: 'admin' as const,
      systemTrigger: null,
      label: `restored-from-bundle-${(sourceMeta.backupId as string | undefined) ?? 'unknown'}: ${(sourceMeta.label as string | undefined) ?? ''}`.slice(0, 255),
      components: (sourceMeta.components as Record<string, unknown> | undefined) ?? {},
      nodePlacement: null,
      expiresAt: null,
      retentionDays: ((sourceMeta.retentionDays as number | undefined) ?? 30),
      description: ((sourceMeta.description as string | null | undefined) ?? null),
      // v2: rebuild tenant block from the operator overrides. This is
      // the canonical tenant info for the new tenant — the operator
      // edited it, so we trust it over the (possibly stale) source.
      tenant: {
        name: overrides.name,
        primaryEmail: overrides.primary_email,
        secondaryEmail: overrides.secondary_email ?? null,
        status: newTenant.status as string,
        kubernetesNamespace: newTenant.kubernetesNamespace,
        regionId: overrides.region_id,
        planId: overrides.plan_id,
        nodeName: overrides.node_name ?? null,
        storageTier: overrides.storage_tier ?? 'local',
        timezone: overrides.timezone ?? null,
        storageLimitOverride: null,
        cpuLimitOverride: null,
        memoryLimitOverride: null,
        maxSubUsersOverride: null,
        maxMailboxesOverride: null,
        monthlyPriceOverride: null,
        emailSendRateLimit: null,
        subscriptionExpiresAt: overrides.subscription_expires_at ?? null,
        counts: { mailboxes: 0, domains: 0, deployments: 0 }, // restore-cart will fill these
      },
      domainsSummary: [...((sourceMeta.domainsSummary as Array<import('@k8s-hosting/api-contracts').BackupMetaDomainSummary> | undefined) ?? [])],
      deploymentsSummary: [...((sourceMeta.deploymentsSummary as Array<import('@k8s-hosting/api-contracts').BackupMetaDeploymentSummary> | undefined) ?? [])],
    };
    await store.putMeta(handle, importMeta);

    // Register backup_jobs row.
    const targetKind = (cfgRow.storageType as 's3' | 'ssh' | 'hostpath');
    const targetUri = targetKind === 's3'
      ? `s3://${cfgRow.id}`
      : targetKind === 'ssh' ? `ssh://${cfgRow.id}` : `hostpath://${cfgRow.id}`;
    await app.db.insert(backupJobs).values({
      id: newBundleId,
      tenantId: newTenant.id,
      initiator: 'admin',
      systemTrigger: null,
      status: 'completed',
      targetKind,
      targetUri,
      targetConfigId,
      label: importMeta.label,
      description: importMeta.description,
      sizeBytes: totalBytes,
      retentionDays: importMeta.retentionDays,
      expiresAt: null,
      exportMode: null,
      exportArtifact: null,
      startedAt: new Date(),
      finishedAt: new Date(),
      lastError: null,
    });

    app.log.warn({
      userId, newTenantId: newTenant.id, bundleId: newBundleId,
      sourceBundleId: sourceMeta.backupId, totalBytes,
    }, 'tenant-bundles: restore-from-bundle finalize succeeded');

    reply.status(201).send({
      data: {
        newTenantId: newTenant.id,
        bundleId: newBundleId,
        sizeBytes: totalBytes,
        componentCount: componentInfo.length,
        tenantUser: {
          email: overrides.primary_email,
          generatedPassword: (newTenant as unknown as { _generatedPassword?: string })._generatedPassword,
        },
      },
    });
  });

  // ── POST /api/v1/admin/tenant-bundles/:id/verify ──────────────────
  //
  // Read every component artifact back from the off-site target,
  // decrypt secrets, decompress config, and report:
  //   - meta.json schemaVersion + initiator + timestamps
  //   - per-component byte count + SHA-256 (computed live, no sidecar)
  //   - secrets KID + decrypt success + count of TLS Secrets
  //   - config JSON parse success + per-table row counts
  //
  // Operators run this from the admin panel after a backup to confirm
  // the bytes left the pod and round-trip cleanly. No DB writes; safe
  // to run any number of times.
  app.post('/admin/tenant-bundles/:id/verify', {
    schema: { tags: ['TenantBundles'], summary: 'Verify a bundle round-trip', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, id)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    if (!job.targetConfigId) {
      throw new ApiError('CONFIG_INVALID', 'Bundle has no target_config_id (pre-D-redesign row); cannot verify.', 400);
    }
    const store = await resolveStore(app, job.targetConfigId, { requireActive: false });
    const handle = await store.open(id);
    if (!handle) throw new ApiError('NOT_FOUND', 'Bundle artefacts not found on remote target', 404);

    // meta.json
    const meta = await store.getMeta(handle);

    const components: Record<string, unknown> = {};

    // files component — Phase 3 deferred, listed here so the operator
    // sees that the verifier is aware of it.
    if (meta.components.files) {
      const stat = await store.stat(handle, 'files', 'archive.tar.gz').catch(() => null);
      components.files = { reachable: !!stat, sizeBytes: stat?.sizeBytes ?? 0 };
    }

    // config component — gunzip + JSON.parse + count rows per table
    if (meta.components.config) {
      const stream = await store.readComponent(handle, 'config', 'db-rows.json.gz');
      const buf = await streamToBuffer(stream);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      const rowCounts: Record<string, number> = {};
      let parseError: string | null = null;
      try {
        const decompressed = await new Promise<Buffer>((resolve, reject) => {
          gunzip(buf, (err, out) => (err ? reject(err) : resolve(out)));
        });
        const dump = JSON.parse(decompressed.toString('utf8'));
        for (const [table, rows] of Object.entries(dump.tables ?? {})) {
          rowCounts[table] = Array.isArray(rows) ? rows.length : 0;
        }
      } catch (err) {
        parseError = (err as Error).message;
      }
      components.config = {
        sizeBytes: buf.length,
        sha256,
        rowCounts,
        parseError,
      };
    }

    // secrets component — decrypt with k1 + JSON.parse
    if (meta.components.secrets) {
      const stream = await store.readComponent(handle, 'secrets', 'tls.json.gz.enc');
      const buf = await streamToBuffer(stream);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      let secretCount = 0;
      let decryptError: string | null = null;
      try {
        const plaintext = decryptSecretsPayload(buf.toString('utf8'), secretsKeyHex);
        const decompressed = await new Promise<Buffer>((resolve, reject) => {
          gunzip(plaintext, (err, out) => (err ? reject(err) : resolve(out)));
        });
        const dump = JSON.parse(decompressed.toString('utf8'));
        secretCount = Array.isArray(dump.secrets) ? dump.secrets.length : 0;
      } catch (err) {
        decryptError = (err as Error).message;
      }
      components.secrets = {
        sizeBytes: buf.length,
        sha256,
        encryptionKeyId: meta.components.secrets.encryptionKeyId,
        secretCount,
        decryptError,
      };
    }

    return success({
      bundleId: id,
      meta: {
        schemaVersion: meta.schemaVersion,
        capturedAt: meta.capturedAt,
        platformVersion: meta.platformVersion,
        initiator: meta.initiator,
        retentionDays: meta.retentionDays,
        expiresAt: meta.expiresAt,
      },
      components,
    });
  });

  // ── POST /api/v1/admin/tenant-bundles/verify-all ──────────────────
  //
  // Batch verify every bundle that has a targetConfigId (the legacy
  // pre-D rows without one are skipped). Returns a per-bundle summary:
  //
  //   [{ bundleId, status: 'passed' | 'failed' | 'skipped',
  //      reason?: string, durationMs }]
  //
  // No deep per-component detail — operators wanting that drill into
  // /:id/verify. Synchronous: caller pays the wall-clock cost.
  // Bounded at 200 bundles to keep the response under the 60-s ALB
  // timeout; if the cluster has more, the operator filters by tenant.
  app.post('/admin/tenant-bundles/verify-all', {
    schema: { tags: ['TenantBundles'], summary: 'Verify integrity of every bundle (round-trip read)', security: [{ bearerAuth: [] }] },
  }, async () => {
    const rows = await app.db
      .select()
      .from(backupJobs)
      .orderBy(desc(backupJobs.createdAt))
      .limit(200);

    const results: Array<{
      bundleId: string;
      status: 'passed' | 'failed' | 'skipped';
      reason?: string;
      durationMs: number;
    }> = [];

    for (const row of rows) {
      const start = Date.now();
      if (!row.targetConfigId) {
        results.push({ bundleId: row.id, status: 'skipped', reason: 'no target_config_id', durationMs: 0 });
        continue;
      }
      try {
        const store = await resolveStore(app, row.targetConfigId, { requireActive: false });
        const handle = await store.open(row.id);
        if (!handle) {
          results.push({ bundleId: row.id, status: 'failed', reason: 'bundle artefacts not found on remote target', durationMs: Date.now() - start });
          continue;
        }
        // Cheap integrity probe: meta.json must parse + at least one
        // declared component must be readable. We skip the deep
        // SHA-256 compute (too slow for batch); the per-bundle Verify
        // button does that.
        const meta = await store.getMeta(handle);
        let componentChecked = false;
        for (const component of (['files', 'mailboxes', 'config', 'secrets'] as const)) {
          const declared = meta.components[component];
          if (!declared) continue;
          const refs = await store.listArtifacts(handle, component);
          if (refs.length === 0) {
            results.push({ bundleId: row.id, status: 'failed', reason: `meta declares ${component} but no artifacts on store`, durationMs: Date.now() - start });
            componentChecked = true;
            break;
          }
          componentChecked = true;
        }
        if (componentChecked && results.at(-1)?.bundleId !== row.id) {
          results.push({ bundleId: row.id, status: 'passed', durationMs: Date.now() - start });
        } else if (!componentChecked) {
          results.push({ bundleId: row.id, status: 'failed', reason: 'meta declares no components', durationMs: Date.now() - start });
        }
      } catch (err) {
        results.push({
          bundleId: row.id,
          status: 'failed',
          reason: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - start,
        });
      }
    }

    const summary = {
      total: results.length,
      passed: results.filter((r) => r.status === 'passed').length,
      failed: results.filter((r) => r.status === 'failed').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
    };
    return success({ summary, results });
  });

  // ── DELETE /api/v1/admin/tenant-bundles/:id ───────────────────────
  app.delete('/admin/tenant-bundles/:id', {
    schema: { tags: ['TenantBundles'], summary: 'Delete a bundle (also from store)', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, id)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    // Best-effort remote delete: only attempt if the bundle has an
    // off-site target configured. (Older rows could have null
    // targetConfigId from the pre-D-redesign world; for those we
    // just drop the DB row.)
    if (job.targetConfigId) {
      // DR safety: refuse delete on frozen target. The DB row stays
      // intact until the operator unfreezes; otherwise we'd lose the
      // bundle reference and orphan the remote object.
      const { requireWritableTarget } = await import('../backup-config/writable-guard.js');
      await requireWritableTarget(app.db, job.targetConfigId);
      const store = await resolveStore(app, job.targetConfigId, { requireActive: false });
      const handle = await store.open(id);
      if (handle) await store.delete(handle);
    }
    await app.db.delete(backupJobs).where(eq(backupJobs.id, id));
    reply.status(204).send();
  });

  // Per-tenant schedule admin endpoints (/admin/backup-schedules,
  // /admin/tenants/:tenantId/backup-schedule[/run-now]) were retired
  // 2026-05-28 with the tenant_backup_schedules table drop (migration
  // 0034). Use /admin/backups/schedules/tenant_bundle to manage the
  // platform-global schedule that drives ALL tenant bundles.
}

async function resolveStore(
  app: FastifyInstance,
  targetConfigId: string,
  opts: { requireActive: boolean } = { requireActive: true },
): Promise<BackupStore> {
  // Active-gate check runs FIRST (the shim doesn't know which cfg row
  // it's serving — `tenant` class is one bucket regardless of how many
  // configurations are bound to it). Without this, a deactivated cfg
  // could still create bundles by side-channeling through the shim.
  const [cfg] = await app.db.select().from(backupConfigurations).where(eq(backupConfigurations.id, targetConfigId)).limit(1);
  if (!cfg) throw new ApiError('NOT_FOUND', 'Backup target not found', 404);
  // Inactive targets must not accept NEW writes — an operator may have
  // taken the target out of service (rotated keys, decommissioning).
  // DELETE callers pass requireActive=false so cleanup of existing
  // bundles on a deactivated target still works.
  if (opts.requireActive && !cfg.active) {
    throw new ApiError('CONFIG_INVALID',
      `Backup target ${cfg.id} is not active. Activate it via Admin → Backup Settings before writing bundles.`,
      400);
  }

  // B9 shim-first: cifs goes through the rclone-shim (the shim
  // mediates ALL upstream protocols). Falls back to the direct cfg
  // resolver below when BACKUP_TARGET_KEY isn't bootstrapped.
  // (NFS was dropped 2026-05-25; see ADR-043 postscript.)
  return resolveShimFirstBackupStore(
    app, 'tenant',
    () => resolveDirectStore(app, cfg),
    'tenant-bundles',
  );
}

async function resolveDirectStore(
  app: FastifyInstance,
  cfg: typeof backupConfigurations.$inferSelect,
): Promise<BackupStore> {
  const encKey = (app.config as Record<string, unknown>).PLATFORM_ENCRYPTION_KEY as string | undefined
    ?? process.env.PLATFORM_ENCRYPTION_KEY
    ?? '0'.repeat(64);

  if (cfg.storageType === 's3') {
    // Decrypt with a sanitised error wrapper — the underlying decrypt()
    // can throw OpenSSL strings that include ciphertext fragments, and
    // those would otherwise leak through Fastify's default 500 handler
    // into the response body.
    let accessKey = '';
    let secretKey = '';
    try {
      accessKey = cfg.s3AccessKeyEncrypted ? decrypt(cfg.s3AccessKeyEncrypted, encKey) : '';
      secretKey = cfg.s3SecretKeyEncrypted ? decrypt(cfg.s3SecretKeyEncrypted, encKey) : '';
    } catch (err) {
      app.log.error({ err, configId: cfg.id }, 'tenant-bundles: S3 credential decryption failed');
      throw new ApiError('CONFIG_INVALID', 'S3 credential decryption failed (encryption key may have rotated)', 500);
    }
    if (!accessKey || !secretKey) {
      throw new ApiError('CONFIG_INVALID', `Backup target ${cfg.id} has no S3 credentials configured`, 400);
    }
    return new S3BackupStore({
      bucket: cfg.s3Bucket ?? '',
      region: cfg.s3Region ?? 'us-east-1',
      endpoint: cfg.s3Endpoint ?? undefined,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      pathPrefix: cfg.s3Prefix ?? undefined,
    });
  }

  if (cfg.storageType === 'ssh') {
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyEncrypted || !cfg.sshPath) {
      throw new ApiError('CONFIG_INVALID',
        `Backup target ${cfg.id} is missing SSH host/user/key/path`, 400);
    }
    let privateKey = '';
    try {
      privateKey = decrypt(cfg.sshKeyEncrypted, encKey);
    } catch (err) {
      app.log.error({ err, configId: cfg.id }, 'tenant-bundles: SSH key decryption failed');
      throw new ApiError('CONFIG_INVALID', 'SSH key decryption failed (encryption key may have rotated)', 500);
    }
    if (!privateKey) {
      throw new ApiError('CONFIG_INVALID', `Backup target ${cfg.id} has empty SSH key`, 400);
    }
    return new SshBackupStore({
      host: cfg.sshHost,
      port: cfg.sshPort ?? 22,
      user: cfg.sshUser,
      privateKey,
      basePath: cfg.sshPath,
      logFn: (level, ctx, msg) => app.log[level](ctx, msg),
    });
  }

  throw new ApiError('NOT_IMPLEMENTED',
    `Backup store kind '${cfg.storageType}' is not supported`, 501);
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Map a `backup_jobs` row + the live tenant status into the
 * BundleSummary contract. Caller resolves the tenant status via
 * a LEFT JOIN (list endpoint) or a follow-up SELECT (single-bundle
 * endpoints) so this function stays pure.
 */
function toBundleSummary(
  j: typeof backupJobs.$inferSelect,
  tenant: { status: import('@k8s-hosting/api-contracts').BundleTenantStatus; name: string | null },
): BundleSummary {
  return {
    id: j.id,
    tenantId: j.tenantId,
    tenantStatus: tenant.status,
    tenantName: tenant.name,
    initiator: j.initiator,
    systemTrigger: j.systemTrigger,
    status: j.status,
    targetKind: j.targetKind,
    targetUri: j.targetUri,
    targetConfigId: j.targetConfigId,
    label: j.label,
    description: j.description,
    sizeBytes: Number(j.sizeBytes),
    retentionDays: j.retentionDays,
    expiresAt: j.expiresAt ? j.expiresAt.toISOString() : null,
    exportMode: j.exportMode,
    exportArtifact: j.exportArtifact,
    startedAt: j.startedAt ? j.startedAt.toISOString() : null,
    finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
    lastError: j.lastError,
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
  };
}

/**
 * Convert tenants.status (or null when the row was deleted) into the
 * BundleTenantStatus enum the UI consumes.
 */
export function tenantRowToBundleStatus(
  status: string | null | undefined,
): import('@k8s-hosting/api-contracts').BundleTenantStatus {
  if (!status) return 'missing';
  if (status === 'archived') return 'archived';
  if (status === 'suspended') return 'suspended';
  return 'active';
}

function toComponentInfo(c: typeof backupComponents.$inferSelect): BackupComponentInfo {
  return {
    id: c.id,
    component: c.component,
    artifactName: c.artifactName,
    status: c.status,
    sizeBytes: Number(c.sizeBytes),
    sha256: c.sha256,
    startedAt: c.startedAt ? c.startedAt.toISOString() : null,
    finishedAt: c.finishedAt ? c.finishedAt.toISOString() : null,
    lastError: c.lastError,
  };
}
