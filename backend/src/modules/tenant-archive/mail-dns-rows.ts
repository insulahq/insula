/**
 * The DNS records a restored mail domain writes afresh. Restoring an archived
 * tenant rebuilds each mail domain as enabling email does
 * (`enableEmailForDomain` → `provisionEmailDns`, with a NEW DKIM key), and that
 * inserts its rows and publishes them without looking at what is stored. So
 * the archive's copies of those records are neither republished with the zone
 * (restore-dns.ts) nor kept (restore-mail.ts clears them before the rebuild):
 * kept, every MX, SPF and DMARC row would be doubled — two SPF records fail SPF
 * outright — and the old DKIM key published next to the new one.
 */
import { and, eq } from 'drizzle-orm';
import { dnsRecords } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { isEmailDnsRecord } from '../email-domains/dns-provisioning.js';

interface StoredRecord {
  readonly recordType: string;
  readonly recordName: string | null;
  readonly recordValue: string | null;
}

export function rebuiltByMailRestore(record: StoredRecord, domainName: string, webmailEnabled: boolean): boolean {
  if (isEmailDnsRecord(record)) return true;
  if (!webmailEnabled || record.recordType !== 'CNAME') return false;
  // provisionEmailDns writes webmail.<domain> when webmail is on; the route
  // path may have stored the bare label.
  const name = (record.recordName ?? '').replace(/\.$/, '').toLowerCase();
  return name === 'webmail' || name === `webmail.${domainName.toLowerCase()}`;
}

/** Drop the stored rows the rebuild of this mail domain writes again. Returns how many. */
export async function clearRebuiltMailRows(
  db: Database,
  domainId: string,
  domainName: string,
  webmailEnabled: boolean,
): Promise<number> {
  const rows = await db.select().from(dnsRecords).where(eq(dnsRecords.domainId, domainId));
  let cleared = 0;
  for (const row of rows) {
    if (!rebuiltByMailRestore(row, domainName, webmailEnabled)) continue;
    await db.delete(dnsRecords).where(and(eq(dnsRecords.id, row.id), eq(dnsRecords.domainId, domainId)));
    cleared += 1;
  }
  return cleared;
}
