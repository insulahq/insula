/**
 * The platform-managed `_dmarc` record of a domain: reading its policy, and
 * writing a new one. Shared by the summary (to show what is PUBLISHED, which
 * reports only confirm a day later) and the apply action.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { dnsRecords, domains } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { DmarcPolicy } from './dmarc-policy.js';

export const DMARC_POLICY_ORDER: readonly DmarcPolicy[] = ['none', 'quarantine', 'reject'];

/** `p=` of a DMARC record value, or null when absent / not a policy. */
export function policyOf(value: string | null | undefined): DmarcPolicy | null {
  const m = /(?:^|;)\s*p\s*=\s*([a-z]+)\s*(?:;|$)/i.exec(value ?? '');
  const p = m?.[1]?.toLowerCase();
  return p === 'none' || p === 'quarantine' || p === 'reject' ? p : null;
}

/** The record value with its `p=` replaced (every other tag kept, in order). */
export function withPolicy(value: string, policy: DmarcPolicy): string {
  const tags = value.split(';').map((t) => t.trim()).filter((t) => t.length > 0);
  let replaced = false;
  const next = tags.map((t) => {
    if (/^p\s*=/i.test(t)) {
      replaced = true;
      return `p=${policy}`;
    }
    return t;
  });
  // RFC 7489: p= follows v=DMARC1 directly.
  if (!replaced) next.splice(1, 0, `p=${policy}`);
  return next.join('; ');
}

export function isTightening(from: DmarcPolicy | null, to: DmarcPolicy): boolean {
  return DMARC_POLICY_ORDER.indexOf(to) > DMARC_POLICY_ORDER.indexOf(from ?? 'none');
}

/** Managed `_dmarc` TXT rows for the given domain names, keyed by domain name. */
export async function managedDmarcRecords(
  db: Database,
  domainNames: readonly string[],
): Promise<Map<string, Array<{ id: string; domainId: string; tenantId: string; recordName: string; recordValue: string }>>> {
  const out = new Map<string, Array<{ id: string; domainId: string; tenantId: string; recordName: string; recordValue: string }>>();
  if (domainNames.length === 0) return out;
  const rows = await db
    .select({
      id: dnsRecords.id,
      domainId: dnsRecords.domainId,
      tenantId: domains.tenantId,
      domainName: domains.domainName,
      recordName: dnsRecords.recordName,
      recordValue: dnsRecords.recordValue,
    })
    .from(dnsRecords)
    .innerJoin(domains, eq(domains.id, dnsRecords.domainId))
    .where(and(
      inArray(domains.domainName, [...domainNames]),
      eq(dnsRecords.recordType, 'TXT'),
      sql`lower(${dnsRecords.recordValue}) LIKE 'v=dmarc1%'`,
    ));
  for (const r of rows) {
    const name = (r.recordName ?? '').toLowerCase().replace(/\.$/, '');
    if (name !== '_dmarc' && name !== `_dmarc.${r.domainName.toLowerCase()}`) continue;
    const list = out.get(r.domainName) ?? [];
    list.push({ id: r.id, domainId: r.domainId, tenantId: r.tenantId, recordName: r.recordName ?? '_dmarc', recordValue: r.recordValue ?? '' });
    out.set(r.domainName, list);
  }
  return out;
}
