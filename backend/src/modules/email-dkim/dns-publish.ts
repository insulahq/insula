/**
 * DKIM TXT record upsert — shared by rotation (./rotate.ts) and
 * enable/drift-repair normalization callers.
 *
 * Publishes `<selector>._domainkey.<domain>` to the platform
 * dns_records table + DNS providers. On selector REUSE (A/B flip two
 * rotations later) the row already exists with the OLD public key and
 * must be REPLACED, not duplicated — two v=DKIM1 TXT records at one
 * name is a verifier-dependent permfail per RFC 6376 §3.6.2.2.
 *
 * Ordering & failure model: provider-first, DB-second — the same
 * doctrine as the dns-sync reconciler (DB is the cache of confirmed-
 * published state; a DB row with no provider record would be skipped
 * by dns-sync forever). There is deliberately NO transaction around
 * the steps: every residual state self-heals within one dns-sync
 * cycle because Stalwart's dnsZoneFile is authoritative for
 * `*._domainkey.*` names — a missing row is re-created, a stale
 * provider record is pruned. Crucially the OTHER (previous) selector
 * is never touched here, so in-flight mail keeps verifying throughout
 * any partial-failure window. (syncRecordToProviders itself swallows
 * provider errors by design — same reasoning.)
 */

import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { dnsRecords } from '../../db/schema.js';
import { formatDkimDnsValue } from '../email-domains/dkim.js';
import { syncRecordToProviders } from '../email-domains/dns-provisioning.js';

export interface PublishedDkimTxt {
  readonly txtRecordName: string;
  readonly txtRecordValue: string;
}

export async function upsertDkimTxtRecord(
  db: Database,
  params: {
    readonly domainId: string;
    readonly domainName: string;
    readonly selector: string;
    readonly publicKey: string;
    readonly encryptionKey: string;
  },
): Promise<PublishedDkimTxt> {
  const { domainId, domainName, selector, publicKey, encryptionKey } = params;
  const txtName = `${selector}._domainkey.${domainName}`;
  const txtValue = formatDkimDnsValue(publicKey);

  const existingRows = await db
    .select()
    .from(dnsRecords)
    .where(and(
      eq(dnsRecords.domainId, domainId),
      eq(dnsRecords.recordName, txtName),
      eq(dnsRecords.recordType, 'TXT'),
    ));
  for (const row of existingRows) {
    await syncRecordToProviders(
      db,
      domainId,
      domainName,
      'delete',
      { type: 'TXT', name: txtName, content: row.recordValue ?? '', id: row.id },
      encryptionKey,
    );
    await db.delete(dnsRecords).where(eq(dnsRecords.id, row.id));
  }

  await syncRecordToProviders(
    db,
    domainId,
    domainName,
    'create',
    { type: 'TXT', name: txtName, content: txtValue, ttl: 3600, priority: null },
    encryptionKey,
  );

  await db.insert(dnsRecords).values({
    id: crypto.randomUUID(),
    domainId,
    recordType: 'TXT',
    recordName: txtName,
    recordValue: txtValue,
    ttl: 3600,
    priority: null,
  });

  return { txtRecordName: txtName, txtRecordValue: txtValue };
}
