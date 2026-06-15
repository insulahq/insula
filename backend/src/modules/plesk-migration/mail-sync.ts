/**
 * Plesk migration — mail-data import leg (R1).
 *
 * For each Plesk mailbox: create the Stalwart account, then import the mail.
 * The import REUSES the tenant-bundle restore engine — imap-restore.py's
 * multi-worker, byte-budgeted MULTIAPPEND over IMAP via the master-user proxy
 * — so large mailboxes sync fast (NOT the legacy JMAP path).
 *
 * The mail Job runs in the `mail` namespace (where the master-user Secret and
 * Stalwart live). Stalwart's IMAP port 993 accepts any in-cluster source, and a
 * Job with a non-stalwart label has no egress NetworkPolicy in that namespace,
 * so it can both SSH out to the Plesk box and reach Stalwart IMAP — no custom
 * netpol needed. The maildir is staged in the Job's ephemeral emptyDir (rsync
 * → Maildir++ reshape → imap-restore), deleted per-mailbox after import.
 */

import { eq, and } from 'drizzle-orm';
import { emailDomains, domains as domainsTable, mailboxes as mailboxesTable } from '../../db/schema.js';
import { createMailbox } from '../mailboxes/service.js';
import { readStalwartMasterUser } from '../mail-admin/stalwart-master-user.js';
import { sourceAuthSecretData, sourceAuthEnv, sourceAuthKeyVolume } from './ssh-auth.js';
import type { PleskSubscription, PleskMailbox } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { LegItem, MigrationLogger } from './provision.js';

const MAIL_NAMESPACE = 'mail';
const IMAP_HOST = process.env.STALWART_IMAP_HOST ?? 'stalwart-mail.mail.svc.cluster.local';
const IMAP_PORT = '993';
const IMPORT_WORKERS = process.env.PLESK_MAIL_IMPORT_WORKERS ?? '8';
const MASTER_SECRET_NAME = 'mail-secrets';
const MASTER_SECRET_KEY = 'STALWART_MASTER_PASSWORD';
const MAIL_TOOLS_IMAGE = process.env.PLESK_MAIL_TOOLS_IMAGE ?? 'ghcr.io/insulahq/insula/tenant-backup-tools:latest';
// Quota for a Plesk mailbox whose source quota was unlimited (-1/0 → null).
const DEFAULT_MAILBOX_QUOTA_MB = 2048;

const MAILSYNC_BEGIN = '===MAILSYNC-BEGIN===';
const MAILSYNC_END = '===MAILSYNC-END===';

/** Parse the Job's `MAILRESULT <addr> ok|fail <detail>` lines. */
export function parseMailResults(log: string): Map<string, { ok: boolean; message: string }> {
  const out = new Map<string, { ok: boolean; message: string }>();
  const begin = log.indexOf(MAILSYNC_BEGIN);
  const end = log.indexOf(MAILSYNC_END);
  const block = begin >= 0 ? log.slice(begin + MAILSYNC_BEGIN.length, end > begin ? end : undefined) : log;
  for (const line of block.split('\n')) {
    const m = line.match(/^MAILRESULT\s+(\S+)\s+(ok|fail)\s*(.*)$/);
    if (m) out.set(m[1], { ok: m[2] === 'ok', message: (m[3] ?? '').trim() });
  }
  return out;
}

/** mailbox quota (MB): the Plesk quota if positive, else a sane default. */
export function quotaMbFor(mb: PleskMailbox): number {
  return mb.quotaMb && mb.quotaMb > 0 ? mb.quotaMb : DEFAULT_MAILBOX_QUOTA_MB;
}

/** An address safe to use as a local-part + a remote path + an IMAP login —
 *  defence-in-depth before it reaches the Job's shell (the script validates too). */
export function isValidEmailAddress(addr: string): boolean {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(addr) && addr.length <= 320;
}

type SourceRow = typeof import('../../db/schema.js').pleskSources.$inferSelect;

interface CoreApi {
  createNamespacedSecret: (a: { namespace: string; body: unknown }) => Promise<unknown>;
  deleteNamespacedSecret: (a: { name: string; namespace: string }) => Promise<unknown>;
  listNamespacedPod: (a: { namespace: string; labelSelector: string; limit?: number }) => Promise<{ items?: Array<{ metadata?: { name?: string } }> }>;
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

export async function runMailLeg(
  db: Database,
  k8s: K8sClients | undefined,
  tenantId: string,
  source: SourceRow,
  snapshot: PleskSubscription,
  logger: MigrationLogger,
): Promise<LegItem[]> {
  if (snapshot.mailboxes.length === 0) return [];
  if (!k8s) return snapshot.mailboxes.map((m) => ({ name: m.address, status: 'failed', message: 'no kubernetes client available' }));

  // 1. Create each Stalwart mailbox (idempotent — skip if it already exists).
  const items: LegItem[] = [];
  const toImport: string[] = [];
  for (const mb of snapshot.mailboxes) {
    if (!isValidEmailAddress(mb.address)) { items.push({ name: mb.address, status: 'failed', message: 'invalid mailbox address — skipped' }); continue; }
    const localPart = mb.address.split('@')[0];
    const domain = mb.address.split('@')[1]?.toLowerCase();
    if (!localPart || !domain) { items.push({ name: mb.address, status: 'failed', message: 'malformed address' }); continue; }
    const [ed] = await db
      .select({ id: emailDomains.id })
      .from(emailDomains)
      .innerJoin(domainsTable, eq(domainsTable.id, emailDomains.domainId))
      .where(and(eq(domainsTable.tenantId, tenantId), eq(domainsTable.domainName, domain)))
      .limit(1);
    if (!ed) { items.push({ name: mb.address, status: 'skipped', message: 'email not enabled for this domain' }); continue; }
    try {
      const [existing] = await db
        .select({ id: mailboxesTable.id })
        .from(mailboxesTable)
        .where(and(eq(mailboxesTable.emailDomainId, ed.id), eq(mailboxesTable.localPart, localPart)))
        .limit(1);
      if (!existing) {
        await createMailbox(db, tenantId, ed.id, { local_part: localPart, quota_mb: quotaMbFor(mb), mailbox_type: 'mailbox' });
      }
      toImport.push(mb.address);
    } catch (err) {
      items.push({ name: mb.address, status: 'failed', message: `create mailbox failed: ${errMsg(err)}` });
    }
  }
  if (toImport.length === 0) return items;

  // 2. Resolve the Stalwart master-user FQDN (master-user proxy auth).
  let masterUser: string;
  try {
    masterUser = await readStalwartMasterUser(k8s.core);
  } catch (err) {
    return [...items, ...toImport.map((addr) => ({ name: addr, status: 'failed' as const, message: `could not resolve Stalwart master user: ${errMsg(err)}` }))];
  }

  // 3. Import the maildirs via IMAP (multi-worker MULTIAPPEND).
  const results = await spawnMailSyncJob({ k8s, source, masterUser, addresses: toImport, logger });
  for (const addr of toImport) {
    const r = results.get(addr);
    if (r?.ok) items.push({ name: addr, status: 'completed', message: r.message });
    else items.push({ name: addr, status: 'failed', message: r?.message || 'mail sync job produced no result' });
  }
  return items;
}

interface SpawnArgs {
  k8s: K8sClients;
  source: SourceRow;
  masterUser: string;
  addresses: string[];
  logger: MigrationLogger;
}

async function spawnMailSyncJob(args: SpawnArgs): Promise<Map<string, { ok: boolean; message: string }>> {
  const { k8s, source, masterUser, addresses, logger } = args;
  const core = k8s.core as unknown as CoreApi;
  const batch = k8s.batch as unknown as BatchApi;
  const short = source.id.slice(0, 8);
  // Timestamp suffix so a Retry never collides on a not-yet-TTL'd prior Job
  // (matches the db/content sibling legs).
  const stamp = Date.now().toString(36);
  const jobName = `plesk-mailsync-${short}-${stamp}`;
  const secretName = `plesk-mailsync-key-${short}-${stamp}`;

  try {
    // backup-coverage: excluded:transient-migration-job
    // (operator SSH key for a short-lived mail-import Job; deleted in the
    //  finally block — nothing to back up.)
    await core.createNamespacedSecret({
      namespace: MAIL_NAMESPACE,
      body: {
        metadata: { name: secretName, namespace: MAIL_NAMESPACE, labels: { 'app.kubernetes.io/managed-by': 'platform-api', 'app.kubernetes.io/name': 'plesk-mail-sync' } },
        type: 'Opaque',
        stringData: sourceAuthSecretData(source),
      },
    });
    await batch.createNamespacedJob({ namespace: MAIL_NAMESPACE, body: buildMailSyncJob({ jobName, secretName, source, masterUser, addresses }) });

    let succeeded = false;
    // Poll up to the Job's activeDeadlineSeconds (2h) — large mailbox sets are slow.
    for (let i = 0; i < 1440; i++) {
      await sleep(5000);
      const st = await batch.readNamespacedJob({ name: jobName, namespace: MAIL_NAMESPACE }).catch((): { status?: { succeeded?: number; failed?: number } } => ({ status: {} }));
      if (st.status?.succeeded && st.status.succeeded > 0) { succeeded = true; break; }
      if (st.status?.failed && st.status.failed > 0) break;
    }

    const log = await readFullJobLog(core, MAIL_NAMESPACE, jobName);
    if (log === null) {
      logger.warn({ jobName }, 'plesk migration: mail-sync Job pod never produced a log');
      return new Map();
    }
    const results = parseMailResults(log);
    if (!succeeded && results.size === 0) logger.warn({ jobName, tail: log.slice(-800) }, 'plesk migration: mail-sync job produced no results');
    return results;
  } finally {
    await batch.deleteNamespacedJob({ name: jobName, namespace: MAIL_NAMESPACE, propagationPolicy: 'Background' }).catch(() => {});
    await core.deleteNamespacedSecret({ name: secretName, namespace: MAIL_NAMESPACE }).catch(() => {});
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
  source: SourceRow;
  masterUser: string;
  addresses: string[];
}

export function buildMailSyncJob({ jobName, secretName, source, masterUser, addresses }: BuildJobArgs): unknown {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: jobName, namespace: MAIL_NAMESPACE, labels: { 'app.kubernetes.io/name': 'plesk-mail-sync', 'app.kubernetes.io/managed-by': 'platform-api' } },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      activeDeadlineSeconds: 7200,
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'plesk-mail-sync' } },
        spec: {
          restartPolicy: 'Never',
          securityContext: { runAsNonRoot: true, runAsUser: 65534, fsGroup: 65534, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [{
            name: 'mail-sync',
            image: MAIL_TOOLS_IMAGE,
            // Always-pull: the :latest tag must not serve a stale cached layer
            // on a node that ran an earlier migration Job.
            imagePullPolicy: 'Always',
            command: ['bash', '/usr/local/bin/plesk-mail-sync.sh'],
            env: [
              { name: 'PLESK_HOST', value: source.hostname },
              { name: 'PLESK_PORT', value: String(source.sshPort) },
              { name: 'PLESK_USER', value: source.sshUser },
              { name: 'IMAP_HOST', value: IMAP_HOST },
              { name: 'IMAP_PORT', value: IMAP_PORT },
              { name: 'STALWART_MASTER_USER', value: masterUser },
              { name: 'STALWART_MASTER_PASSWORD', valueFrom: { secretKeyRef: { name: MASTER_SECRET_NAME, key: MASTER_SECRET_KEY, optional: false } } },
              { name: 'MAILBOXES', value: addresses.join(' ') },
              { name: 'WORKERS', value: IMPORT_WORKERS },
              { name: 'MODE', value: 'merge-skip-duplicates' },
              { name: 'HOME', value: '/tmp' },
              ...sourceAuthEnv(source, secretName),
            ],
            volumeMounts: [
              ...sourceAuthKeyVolume(source, secretName).volumeMounts,
              { name: 'scratch', mountPath: '/tmp' },
            ],
            resources: { requests: { cpu: '200m', memory: '512Mi' }, limits: { cpu: '2', memory: '2Gi' } },
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
          }],
          volumes: [
            ...sourceAuthKeyVolume(source, secretName).volumes,
            { name: 'scratch', emptyDir: { sizeLimit: '50Gi' } },
          ],
        },
      },
    },
  };
}
