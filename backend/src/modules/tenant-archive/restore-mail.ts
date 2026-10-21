/**
 * Bring an archived tenant's mail back when it is restored.
 *
 * Archive removed the tenant's mail domains, DKIM keys and mail accounts from
 * the mail server and kept their rows (stalwart-email-cleanup, mailboxes-status
 * and email-aliases-enable on `archived`). The mail itself is in the archive's
 * final bundle. Restore, in this order:
 *
 *   1. each mail domain built again from its row — the Domain on the mail
 *      server, a NEW DKIM key and its DNS record, MX/SPF/DMARC
 *      (`enableEmailForDomain`, as when email was first enabled), once the
 *      archive's copies of those records are cleared (mail-dns-rows.ts);
 *   2. each mailbox account created again from its row and its mail imported
 *      from the bundle — the restore cart's own mailbox executor, run as a
 *      restore job of the tenant so it shows in the restore history.
 *
 * The aliases' lists come back with the `restored` hooks, which run after this
 * and need the domains' ids. Mail passwords do not come back: the mail server
 * never returns a stored password, so the archive could not hold one, and
 * each restored mailbox gets a new random secret — the restore notice tells the
 * tenant to set new passwords.
 *
 * Never throws for one domain or the import: what failed is reported back and
 * the restore goes on. The bundle stays, so the mail can be restored again from
 * Backups → Tenants.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { domains, emailDomains, mailboxes, restoreItems, restoreJobs } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { clearRebuiltMailRows } from './mail-dns-rows.js';

export interface MailRestoreResult {
  readonly domains: number;
  readonly mailboxes: number;
  readonly failures: readonly string[];
}

const say = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * What the restore cart's executors take from the app: the database, a
 * logger and the kubeconfig. The archive restore runs inside a storage
 * operation, which has no Fastify app.
 */
function executorApp(db: Database): FastifyInstance {
  const log = {
    info: (...a: unknown[]) => console.log('[tenant-archive:restore-mail]', ...a),
    warn: (...a: unknown[]) => console.warn('[tenant-archive:restore-mail]', ...a),
    error: (...a: unknown[]) => console.error('[tenant-archive:restore-mail]', ...a),
    debug: () => undefined,
    trace: () => undefined,
    fatal: (...a: unknown[]) => console.error('[tenant-archive:restore-mail]', ...a),
    child() { return log; },
  };
  return { db, log, config: { KUBECONFIG_PATH: process.env.KUBECONFIG_PATH } } as unknown as FastifyInstance;
}

export async function restoreTenantMail(
  db: Database,
  tenantId: string,
  bundleId: string,
  encryptionKey: string,
): Promise<MailRestoreResult> {
  const failures: string[] = [];
  let domainsBuilt = 0;

  const { enableEmailForDomain } = await import('../email-domains/service.js');
  const mailDomains = await db.select().from(emailDomains).where(eq(emailDomains.tenantId, tenantId));
  const domainNames = new Map(
    (await db.select({ id: domains.id, domainName: domains.domainName }).from(domains).where(eq(domains.tenantId, tenantId)))
      .map((d) => [d.id, d.domainName] as const),
  );
  for (const row of mailDomains) {
    if (row.stalwartDomainId) continue;
    try {
      await clearRebuiltMailRows(db, row.domainId, domainNames.get(row.domainId) ?? '', row.webmailEnabled === 1);
      await enableEmailForDomain(
        db,
        tenantId,
        row.domainId,
        {
          webmail_enabled: row.webmailEnabled === 1,
          ...(row.catchAllAddress ? { catch_all_address: row.catchAllAddress } : {}),
        },
        encryptionKey,
        { restoringArchivedTenant: true },
      );
      domainsBuilt += 1;
    } catch (err) {
      failures.push(`mail domain ${row.domainId}: ${say(err)}`);
    }
  }

  const rows = await db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.tenantId, tenantId));
  if (rows.length === 0) return { domains: domainsBuilt, mailboxes: 0, failures };

  // Active before they are created: the import logs in to each account as the
  // master user, which a suspended account refuses — and the cart's executor
  // creates an account suspended when its row says so.
  await db.update(mailboxes).set({ status: 'active' }).where(eq(mailboxes.tenantId, tenantId));

  const jobId = `rstr-${randomUUID()}`;
  const itemId = randomUUID();
  await db.insert(restoreJobs).values({
    id: jobId,
    tenantId,
    status: 'executing',
    description: 'Restore of the archived tenant: its mailboxes, from the archive bundle',
    startedAt: new Date(),
  });
  await db.insert(restoreItems).values({
    id: itemId,
    restoreJobId: jobId,
    bundleId,
    type: 'mailboxes-by-address',
    // A restore run again (resumed) imports nothing twice.
    selector: { kind: 'all', mode: 'merge-skip-duplicates' },
    label: 'All mailboxes',
    seq: 1,
    status: 'applying',
    startedAt: new Date(),
  });
  try {
    const { dispatchExecutor, resolveStoreForBundle } = await import('../backup-restore/shared.js');
    const app = executorApp(db);
    const [item] = await db.select().from(restoreItems).where(eq(restoreItems.id, itemId));
    const store = await resolveStoreForBundle(app, bundleId);
    await dispatchExecutor(app, item, store);
    await db.update(restoreItems).set({ status: 'done', finishedAt: new Date() }).where(eq(restoreItems.id, itemId));
    await db.update(restoreJobs).set({ status: 'done', finishedAt: new Date() }).where(eq(restoreJobs.id, jobId));
  } catch (err) {
    failures.push(`mail import: ${say(err)}`);
    await db.update(restoreItems).set({ status: 'failed', lastError: say(err), finishedAt: new Date() }).where(eq(restoreItems.id, itemId));
    await db.update(restoreJobs).set({ status: 'failed', lastError: say(err), finishedAt: new Date() }).where(eq(restoreJobs.id, jobId));
  }
  return { domains: domainsBuilt, mailboxes: rows.length, failures };
}
