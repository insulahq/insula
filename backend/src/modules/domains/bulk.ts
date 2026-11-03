import { eq } from 'drizzle-orm';
import { domains } from '../../db/schema.js';
import { verifyDomain, getPlatformConfig } from './verification.js';
import { setDomainVerificationStatus, deleteDomain } from './service.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { BulkIdResult } from '@insula/api-contracts';

type BulkResult = BulkIdResult;

export async function bulkVerifyDomains(
  db: Database,
  domainIds: readonly string[],
): Promise<BulkResult> {
  const succeeded: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  const platformConfig = await getPlatformConfig(db);

  for (const id of domainIds) {
    try {
      const [domain] = await db.select()
        .from(domains)
        .where(eq(domains.id, id));

      if (!domain) {
        failed.push({ id, error: `Domain '${id}' not found` });
        continue;
      }

      const dnsMode = domain.dnsMode as 'primary' | 'cname' | 'secondary';
      const result = await verifyDomain(domain.domainName, dnsMode, platformConfig, db);

      // Use the shared helper so status transitions consistently across
      // every entry point (manual verify, cron, create-time, bulk).
      const now = new Date();
      await setDomainVerificationStatus(db, id, result);
      await db.update(domains).set({ lastVerifiedAt: now }).where(eq(domains.id, id));

      succeeded.push(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      failed.push({ id, error: message });
    }
  }

  return { succeeded, failed };
}

/**
 * Delete each domain the way a single delete does.
 *
 * This deleted the domains row and reconciled the Ingress, and nothing else:
 * no cert-manager Certificate or TLS Secret removed (cert-manager went on
 * renewing a certificate for a domain that was gone), no webmail Ingress, no
 * Stalwart domain or DKIM, no DNS zone on the provider. Every one of those is
 * deleteDomain's job, so a bulk delete is now just deleteDomain per id.
 */
export async function bulkDeleteDomains(
  db: Database,
  domainIds: readonly string[],
  k8s?: K8sClients,
): Promise<BulkResult> {
  const succeeded: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const id of domainIds) {
    try {
      const [domain] = await db.select()
        .from(domains)
        .where(eq(domains.id, id));

      if (!domain) {
        failed.push({ id, error: `Domain '${id}' not found` });
        continue;
      }

      await deleteDomain(db, domain.tenantId, id, k8s);
      succeeded.push(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      failed.push({ id, error: message });
    }
  }

  return { succeeded, failed };
}
