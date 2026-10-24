/**
 * What the tenant panel shows about a domain's DKIM: the signing keys the
 * mail server holds, and the TXT records the platform published for them.
 *
 * The keys come from Stalwart (`x:DkimSignature/get`) — it signs the mail, so
 * it is the only source that can say which keys exist. The TXT values come
 * from `dns_records`, the rows enable, rotation and drift repair write through
 * `upsertDkimTxtRecord`. Only the A/B selectors are read back: those are the
 * only names the platform ever publishes, and a domain moved in from another
 * host can carry its old provider's `*._domainkey` records, which say nothing
 * about the keys this platform signs with.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { DkimKey } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import { dnsRecords } from '../../db/schema.js';
import type { StalwartDkimSignatureRow } from '../stalwart-jmap/client.js';
import type { DnsRecordSpec } from '../email-domains/dns-provisioning.js';
import { DKIM_SELECTOR_A, DKIM_SELECTOR_B } from './selectors.js';
import { RSA_SIGNATURE_TYPE, ED25519_SIGNATURE_TYPE } from './signatures.js';

export interface PublishedDkimRecord {
  readonly name: string;
  readonly value: string;
  readonly ttl: number;
}

export function dkimTxtName(selector: string, domainName: string): string {
  return `${selector}._domainkey.${domainName}`;
}

/** The platform's DKIM TXT rows for one domain, `dkim-1` before `dkim-2`. */
export async function readPublishedDkimRecords(
  db: Database,
  domainId: string,
  domainName: string,
): Promise<readonly PublishedDkimRecord[]> {
  const names = [DKIM_SELECTOR_A, DKIM_SELECTOR_B].map((s) => dkimTxtName(s, domainName));
  const rows = await db
    .select({ name: dnsRecords.recordName, value: dnsRecords.recordValue, ttl: dnsRecords.ttl })
    .from(dnsRecords)
    .where(and(
      eq(dnsRecords.domainId, domainId),
      eq(dnsRecords.recordType, 'TXT'),
      inArray(dnsRecords.recordName, names),
    ));
  return rows
    .filter((r): r is { name: string; value: string; ttl: number } => !!r.name && !!r.value)
    .map((r) => ({ name: r.name, value: r.value, ttl: r.ttl }))
    .sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
}

/**
 * The email-domain record list with the published DKIM records slotted in
 * after SPF — the position the record builder gives DKIM when it has a key.
 */
export function withPublishedDkim(
  specs: readonly DnsRecordSpec[],
  published: readonly PublishedDkimRecord[],
): readonly DnsRecordSpec[] {
  const dkim: DnsRecordSpec[] = published.map((r) => ({
    recordType: 'TXT',
    recordName: r.name,
    recordValue: r.value,
    ttl: r.ttl,
    priority: null,
    purpose: 'dkim',
  }));
  const spfAt = specs.findIndex((s) => s.purpose === 'spf');
  return spfAt === -1
    ? [...specs, ...dkim]
    : [...specs.slice(0, spfAt + 1), ...dkim, ...specs.slice(spfAt + 1)];
}

function algorithmOf(type: string): DkimKey['algorithm'] {
  if (type === RSA_SIGNATURE_TYPE) return 'rsa';
  if (type === ED25519_SIGNATURE_TYPE) return 'ed25519';
  return 'other';
}

/**
 * Map Stalwart's signature rows for one domain onto what a tenant may see.
 * Fields are picked one by one: the row Stalwart returns can carry the
 * private key, and nothing beyond these fields ever leaves the API.
 * The current selector sorts first, then by selector name.
 */
export function buildDkimKeyList(params: {
  readonly rows: readonly StalwartDkimSignatureRow[];
  readonly stalwartDomainId: string;
  readonly domainName: string;
  readonly activeSelector: string | null;
  readonly published: readonly PublishedDkimRecord[];
}): DkimKey[] {
  const { rows, stalwartDomainId, domainName, activeSelector, published } = params;
  const valueByName = new Map(published.map((p) => [p.name, p.value]));
  return rows
    .filter((r) => r.domainId === stalwartDomainId)
    .map((r) => {
      const txtRecordName = dkimTxtName(r.selector, domainName);
      return {
        selector: r.selector,
        algorithm: algorithmOf(r['@type']),
        stage: r.stage ?? null,
        current: r.selector === activeSelector,
        txtRecordName,
        txtRecordValue: valueByName.get(txtRecordName) ?? null,
      };
    })
    .sort((a, b) => Number(b.current) - Number(a.current) || a.selector.localeCompare(b.selector));
}
