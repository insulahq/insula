/**
 * Plesk migration — website content sync leg (R1).
 *
 * For each discovered domain that has a docroot:
 *   1. ensure a web deployment in the tenant namespace — `apache-php` when
 *      the Plesk domain ran PHP, else `static-apache` — and wait for Running,
 *   2. rsync the Plesk docroot into the tenant PVC at the deployment's docroot
 *      subpath (files only, including .htaccess) via a one-shot migration-tools
 *      Job pinned to the deployment's node (the PVC is ReadWriteOnce),
 *   3. route the domain at that deployment (updateDomain → reconcileIngress),
 *   4. record a per-domain item + a VHOST REVIEW signal.
 *
 * What is NOT done (by design — see the operator-aligned vhost split):
 *   - The Plesk <VirtualHost> config is not translated. Routing/SSL is the
 *     platform's ingress; .htaccess rides along with the files. Custom global
 *     Apache directives are FLAGGED (the Job checks for a Plesk conf/vhost.conf)
 *     for manual review, never applied.
 *   - App DB config (e.g. wp-config.php) is not rewritten — the new MariaDB
 *     host/credentials are surfaced for the operator to wire in.
 */

import { createHash } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { tenants, deployments as deploymentsTable, domains as domainsTable } from '../../db/schema.js';
import { getCatalogEntryByCode } from '../catalog/service.js';
import { createDeployment, getDeploymentById } from '../deployments/service.js';
import { updateDomain } from '../domains/service.js';
import { sourceAuthSecretData, sourceAuthEnv, sourceAuthKeyVolume } from './ssh-auth.js';
import type { PleskSubscription, PleskDomain } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { LegItem, MigrationLogger } from './provision.js';

const MIGRATION_TOOLS_IMAGE =
  process.env.PLESK_MIGRATION_TOOLS_IMAGE ?? 'ghcr.io/insulahq/insula/migration-tools:latest';

const CONTENT_BEGIN = '===CONTENTSYNC-BEGIN===';
const CONTENT_END = '===CONTENTSYNC-END===';

/** DNS-safe deployment name for a domain's website (web-<slug>, ≤63 chars). */
export function webDeploymentName(domain: string): string {
  const slug = domain.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `web-${slug}`.slice(0, 63).replace(/-+$/, '');
}

/** Domains worth serving: those with a docroot in the discovery. */
export function webDomainsOf(snapshot: PleskSubscription): PleskDomain[] {
  return snapshot.domains.filter((d) => !!d.docRoot);
}

/** apache-php for PHP domains, static-apache otherwise. */
export function runtimeCodeFor(domain: PleskDomain): 'apache-php' | 'static-apache' {
  return domain.phpVersion ? 'apache-php' : 'static-apache';
}

/** A bare hostname — domain.name reaches a remote shell (vhost check). */
export function isSafeHostname(name: string): boolean {
  return /^[A-Za-z0-9.-]+$/.test(name) && name.length <= 255;
}

/** An absolute path with no shell metacharacters — docRoot reaches rsync/ssh. */
export function isSafeDocRoot(p: string): boolean {
  return /^\/[A-Za-z0-9._/-]+$/.test(p) && p.length <= 1024;
}

interface ContentOutcome { ok: boolean; message: string; vhostReview: 'custom' | 'none' | 'ssh-unreachable' | 'unknown' }

/** Parse the Job's CONTENTRESULT + VHOSTREVIEW lines. */
export function parseContentResult(log: string): ContentOutcome {
  const begin = log.indexOf(CONTENT_BEGIN);
  const end = log.indexOf(CONTENT_END);
  const block = begin >= 0 ? log.slice(begin + CONTENT_BEGIN.length, end > begin ? end : undefined) : log;
  let ok = false;
  let message = 'sync job produced no result';
  let vhostReview: ContentOutcome['vhostReview'] = 'unknown';
  for (const line of block.split('\n')) {
    const c = line.match(/^CONTENTRESULT\s+(ok|fail)\s*(.*)$/);
    if (c) { ok = c[1] === 'ok'; message = (c[2] ?? '').trim(); }
    const v = line.match(/^VHOSTREVIEW\s+\S+\s+(\S+)/);
    if (v) vhostReview = v[1] === 'has-custom-apache-directives' ? 'custom' : v[1] === 'ssh-unreachable' ? 'ssh-unreachable' : 'none';
  }
  return { ok, message, vhostReview };
}

type SourceRow = typeof import('../../db/schema.js').pleskSources.$inferSelect;

interface CoreApi {
  createNamespacedSecret: (a: { namespace: string; body: unknown }) => Promise<unknown>;
  deleteNamespacedSecret: (a: { name: string; namespace: string }) => Promise<unknown>;
  listNamespacedPod: (a: { namespace: string; labelSelector: string; limit?: number }) => Promise<{ items?: Array<{ metadata?: { name?: string }; spec?: { nodeName?: string } }> }>;
  readNamespacedPodLog: (a: { name: string; namespace: string; container?: string }) => Promise<string>;
}
interface BatchApi {
  createNamespacedJob: (a: { namespace: string; body: unknown }) => Promise<unknown>;
  readNamespacedJob: (a: { name: string; namespace: string }) => Promise<{ status?: { succeeded?: number; failed?: number } }>;
  deleteNamespacedJob: (a: { name: string; namespace: string; propagationPolicy?: string }) => Promise<unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => { const t = setTimeout(r, ms); t.unref(); });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runContentLeg(
  db: Database,
  k8s: K8sClients | undefined,
  _kubeconfigPath: string | undefined,
  tenantId: string,
  source: SourceRow,
  snapshot: PleskSubscription,
  logger: MigrationLogger,
): Promise<LegItem[]> {
  const webDomains = webDomainsOf(snapshot);
  if (webDomains.length === 0) return [];
  if (!k8s) return webDomains.map((d) => ({ name: d.name, status: 'failed', message: 'no kubernetes client available' }));

  const [tenant] = await db.select({ namespace: tenants.kubernetesNamespace }).from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant?.namespace) return webDomains.map((d) => ({ name: d.name, status: 'failed', message: 'tenant namespace unknown' }));
  const namespace = tenant.namespace;

  const items: LegItem[] = [];
  for (const d of webDomains) {
    try {
      items.push(await migrateOneSite(db, k8s, tenantId, namespace, source, d, logger));
    } catch (err) {
      logger.warn({ err, domain: d.name, tenantId }, 'plesk migration: content sync failed');
      items.push({ name: d.name, status: 'failed', message: errMsg(err) });
    }
  }
  return items;
}

async function migrateOneSite(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  namespace: string,
  source: SourceRow,
  domain: PleskDomain,
  logger: MigrationLogger,
): Promise<LegItem> {
  if (!domain.docRoot) return { name: domain.name, status: 'skipped', message: 'no docroot' };
  // Defence-in-depth: both values reach a remote shell on the Plesk box (the
  // Job script validates too). Reject unsafe ones per-domain rather than
  // risking injection or poisoning the whole leg.
  if (!isSafeHostname(domain.name)) return { name: domain.name, status: 'failed', message: 'unsafe domain name — skipped' };
  if (!isSafeDocRoot(domain.docRoot)) return { name: domain.name, status: 'failed', message: 'unsafe docroot path — skipped' };

  const code = runtimeCodeFor(domain);
  const entry = await getCatalogEntryByCode(db, code);
  const deploymentName = webDeploymentName(domain.name);

  // 1. ensure the web deployment + wait Running, capture its node.
  const { deployment, nodeName } = await ensureWebDeployment(db, k8s, tenantId, namespace, deploymentName, entry, source.createdBy ?? 'plesk-migration', logger);
  // docroot lives at the deployment's storagePath on the tenant PVC (local_path
  // "." → subPath). Read it from the row (don't recompute) so a deployment that
  // was created with a custom storage_path still rsyncs to the right place.
  const storagePath = deployment.storagePath ?? `${entry.type}/${entry.code}/${deploymentName}`;

  // 2. rsync the Plesk docroot into the PVC at that subpath.
  const outcome = await spawnContentSyncJob({ k8s, namespace, source, srcPath: domain.docRoot, destSubPath: storagePath, domain: domain.name, nodeName, logger });

  // 3. route the domain → this deployment (auto-reconciles ingress).
  let routed = false;
  const [domainRow] = await db.select({ id: domainsTable.id }).from(domainsTable).where(and(eq(domainsTable.tenantId, tenantId), eq(domainsTable.domainName, domain.name))).limit(1);
  if (domainRow) {
    try {
      await updateDomain(db, tenantId, domainRow.id, { deployment_id: deployment.id }, k8s);
      routed = true;
    } catch (err) {
      logger.warn({ err, domain: domain.name }, 'plesk migration: route-to-deployment failed');
    }
  }

  const notes: string[] = [`served by ${code}${domain.phpVersion ? ` (Plesk ${domain.phpVersion})` : ''}`];
  if (!routed) notes.push('domain not routed — wire it to the deployment manually');
  if (outcome.vhostReview === 'custom') notes.push('CUSTOM Apache vhost.conf on source — review/reapply manually (ingress middleware / app config)');
  if (outcome.vhostReview === 'ssh-unreachable') notes.push("couldn't check the source for a custom vhost.conf — review manually");
  // Only PHP apps carry DB config; static sites don't.
  if (code === 'apache-php') notes.push('app DB config (e.g. wp-config.php) still points at the old DB — repoint it at the new MariaDB deployment');

  return { name: domain.name, status: outcome.ok ? 'completed' : 'failed', message: outcome.ok ? notes.join('; ') : outcome.message };
}

const RUNNING_TIMEOUT_MS = 6 * 60 * 1000;

async function ensureWebDeployment(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  namespace: string,
  deploymentName: string,
  entry: { id: string },
  actorId: string,
  logger: MigrationLogger,
): Promise<{ deployment: Awaited<ReturnType<typeof getDeploymentById>>; nodeName: string | undefined }> {
  const [existing] = await db
    .select()
    .from(deploymentsTable)
    .where(and(eq(deploymentsTable.tenantId, tenantId), eq(deploymentsTable.name, deploymentName)));

  let deploymentId: string;
  if (existing) {
    deploymentId = existing.id;
  } else {
    const created = await createDeployment(
      db, tenantId,
      { catalog_entry_id: entry.id, name: deploymentName, replica_count: 1, cpu_request: '0.25', memory_request: '256Mi', storage_mode: 'default' },
      actorId, k8s,
    );
    deploymentId = created.id;
    logger.info({ tenantId, deploymentName }, 'plesk migration: created web deployment');
  }

  const terminalNonRunning = new Set(['failed', 'stopped', 'deleting', 'deleted']);
  const deadline = Date.now() + RUNNING_TIMEOUT_MS;
  for (;;) {
    const row = await getDeploymentById(db, tenantId, deploymentId);
    if (row.status === 'running') {
      const core = k8s.core as unknown as CoreApi;
      const pods = await core.listNamespacedPod({ namespace, labelSelector: `app=${deploymentName}`, limit: 1 }).catch(() => ({ items: [] }));
      const nodeName = pods.items?.[0]?.spec?.nodeName;
      if (!nodeName) {
        // The sync Job can't be co-located on the RWO PVC's node — on a
        // multi-node cluster it may hang Pending (Multi-Attach). Surface it.
        logger.warn({ namespace, deploymentName }, 'plesk migration: could not resolve web deployment node — content-sync Job may fail to attach the RWO PVC on a multi-node cluster');
      }
      return { deployment: row, nodeName };
    }
    if (terminalNonRunning.has(row.status)) {
      throw new Error(`web deployment '${deploymentName}' is '${row.status}'${row.lastError ? `: ${row.lastError}` : ''} — start (or delete) it, then retry`);
    }
    if (Date.now() > deadline) throw new Error(`web deployment '${deploymentName}' not Running after ${Math.round(RUNNING_TIMEOUT_MS / 1000)}s (status=${row.status})`);
    await sleep(5000);
  }
}

interface SyncArgs {
  k8s: K8sClients;
  namespace: string;
  source: SourceRow;
  srcPath: string;
  destSubPath: string;
  domain: string;
  nodeName: string | undefined;
  logger: MigrationLogger;
}

async function spawnContentSyncJob(args: SyncArgs): Promise<ContentOutcome> {
  const { k8s, namespace, source, srcPath, destSubPath, domain, nodeName, logger } = args;
  const core = k8s.core as unknown as CoreApi;
  const batch = k8s.batch as unknown as BatchApi;
  const short = source.id.slice(0, 8);
  // Hash the full domain (not its last chars) so two domains of one tenant
  // can't collide on a Job name; deterministic so a Retry reuses the name.
  const stamp = createHash('sha1').update(domain).digest('hex').slice(0, 8);
  const jobName = `plesk-content-${short}-${stamp}`;
  const secretName = `plesk-content-key-${short}-${stamp}`;
  const pvcName = `${namespace}-storage`;

  try {
    // backup-coverage: excluded:transient-migration-job
    // (operator SSH key for a short-lived content-sync Job; deleted in the
    //  finally block — nothing to back up.)
    await core.createNamespacedSecret({
      namespace,
      body: {
        metadata: { name: secretName, namespace, labels: { 'app.kubernetes.io/managed-by': 'platform-api', 'app.kubernetes.io/name': 'plesk-content-sync' } },
        type: 'Opaque',
        stringData: sourceAuthSecretData(source),
      },
    });
    await batch.createNamespacedJob({ namespace, body: buildContentSyncJob({ jobName, secretName, namespace, pvcName, source, srcPath, destSubPath, domain, nodeName }) });

    let succeeded = false;
    for (let i = 0; i < 360; i++) {
      await sleep(5000);
      const st = await batch.readNamespacedJob({ name: jobName, namespace }).catch((): { status?: { succeeded?: number; failed?: number } } => ({ status: {} }));
      if (st.status?.succeeded && st.status.succeeded > 0) { succeeded = true; break; }
      if (st.status?.failed && st.status.failed > 0) break;
    }

    const log = await readFullJobLog(core, namespace, jobName);
    if (log === null) {
      // No pod log — the pod likely never started (RWO Multi-Attach on a
      // different node / quota / image pull). Make the diagnosis explicit.
      logger.warn({ namespace, jobName, domain }, 'plesk migration: content-sync Job pod never produced a log — check PVC attachment, quota, image pull');
      return { ok: false, message: 'content-sync job never ran (PVC attach / quota / image pull?)', vhostReview: 'unknown' };
    }
    const outcome = parseContentResult(log);
    if (!succeeded && !outcome.ok) {
      logger.warn({ namespace, jobName, domain, tail: log.slice(-800) }, 'plesk migration: content-sync job did not complete cleanly');
    }
    return outcome;
  } finally {
    await batch.deleteNamespacedJob({ name: jobName, namespace, propagationPolicy: 'Background' }).catch(() => {});
    await core.deleteNamespacedSecret({ name: secretName, namespace }).catch(() => {});
  }
}

async function readFullJobLog(core: CoreApi, namespace: string, jobName: string): Promise<string | null> {
  const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${jobName}`, limit: 1 }).catch(() => ({ items: [] }));
  const podName = pods.items?.[0]?.metadata?.name;
  if (!podName) return null;
  return core.readNamespacedPodLog({ name: podName, namespace }).catch(() => null);
}

interface BuildJobArgs {
  jobName: string;
  secretName: string;
  namespace: string;
  pvcName: string;
  source: SourceRow;
  srcPath: string;
  destSubPath: string;
  domain: string;
  nodeName: string | undefined;
}

export function buildContentSyncJob({ jobName, secretName, namespace, pvcName, source, srcPath, destSubPath, domain, nodeName }: BuildJobArgs): unknown {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: jobName, namespace, labels: { 'app.kubernetes.io/name': 'plesk-content-sync', 'app.kubernetes.io/managed-by': 'platform-api' } },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      activeDeadlineSeconds: 3600,
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'plesk-content-sync' } },
        spec: {
          restartPolicy: 'Never',
          // Co-locate with the web deployment's pod: the tenant PVC is RWO, so
          // the Job must run on the node where the deployment already mounted it.
          ...(nodeName ? { nodeName } : {}),
          // Exempt from the tenant's ResourceQuota (platform-managed overhead),
          // like the backup/restore Jobs that also mount the tenant PVC.
          priorityClassName: 'platform-tenant-overhead',
          securityContext: { runAsNonRoot: true, runAsUser: 65534, fsGroup: 65534, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [{
            name: 'content-sync',
            image: MIGRATION_TOOLS_IMAGE,
            // Always-pull: the :latest tag must not serve a stale cached layer
            // on a node that ran an earlier migration Job.
            imagePullPolicy: 'Always',
            command: ['bash', '/usr/local/bin/plesk-content-sync.sh'],
            env: [
              { name: 'PLESK_HOST', value: source.hostname },
              { name: 'PLESK_PORT', value: String(source.sshPort) },
              { name: 'PLESK_USER', value: source.sshUser },
              { name: 'SRC_PATH', value: srcPath },
              { name: 'DEST_PATH', value: `/data/${destSubPath}` },
              { name: 'VHOST_DOMAIN', value: domain },
              { name: 'HOME', value: '/tmp' },
              ...sourceAuthEnv(source, secretName),
            ],
            volumeMounts: [
              ...sourceAuthKeyVolume(source, secretName).volumeMounts,
              { name: 'data', mountPath: '/data' },
              { name: 'tmp', mountPath: '/tmp' },
            ],
            resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1', memory: '512Mi' } },
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
          }],
          volumes: [
            ...sourceAuthKeyVolume(source, secretName).volumes,
            { name: 'data', persistentVolumeClaim: { claimName: pvcName } },
            { name: 'tmp', emptyDir: {} },
          ],
        },
      },
    },
  };
}
