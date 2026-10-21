/**
 * Publish an archived tenant's DNS zones again when it is restored.
 *
 * Archive removes the zones from the DNS servers like a delete does
 * (dns-zone-cleanup on `archived`, operator decision), and keeps the tenant's
 * `domains` and `dns_records` rows: they are what the zones are rebuilt from.
 * Per domain, what `createDomain` does for a new one: a primary zone with its
 * provider group's nameservers, or a secondary zone pointing at its master;
 * then every stored record, as `migrateDomainDns` pushes a zone's records to a
 * new group — SOA and the apex NS excepted, which the new zone already has.
 * The routes' A/AAAA records are among the stored records. The mail records of
 * a mail domain the restore rebuilds are not: the rebuild writes them afresh,
 * with the new DKIM key (mail-dns-rows.ts).
 *
 * Never throws for one domain or one record: a zone that cannot be published
 * is reported back, and the restore goes on — the tenant is better back with a
 * zone to fix by hand ("Refresh route DNS") than left archived.
 */
import { eq } from 'drizzle-orm';
import { dnsRecords, domains, emailDomains } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { getActiveServersForDomain, getProviderForServer, getProviderGroupById } from '../dns-servers/service.js';
import { canManageDnsZone } from '../dns-servers/authority.js';
import { rebuiltByMailRestore } from './mail-dns-rows.js';

export interface RepublishResult {
  readonly zones: number;
  readonly records: number;
  /** One line per domain or record that could not be published. */
  readonly failures: readonly string[];
}

const say = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Is this stored record one a fresh zone already carries? */
export function zoneOwnsRecord(record: { recordType: string; recordName: string | null }, domainName: string): boolean {
  if (record.recordType === 'SOA') return true;
  if (record.recordType !== 'NS') return false;
  const name = (record.recordName ?? '@').replace(/\.$/, '').toLowerCase();
  return name === '@' || name === '' || name === domainName.toLowerCase();
}

export async function republishTenantZones(db: Database, tenantId: string, encryptionKey: string): Promise<RepublishResult> {
  const rows = await db.select().from(domains).where(eq(domains.tenantId, tenantId));
  // The mail domains restore-mail rebuilds: the ones archive removed from the mail server.
  const rebuiltMail = new Map(
    (await db.select({ domainId: emailDomains.domainId, stalwartDomainId: emailDomains.stalwartDomainId, webmailEnabled: emailDomains.webmailEnabled })
      .from(emailDomains).where(eq(emailDomains.tenantId, tenantId)))
      .filter((m) => !m.stalwartDomainId)
      .map((m) => [m.domainId, m.webmailEnabled === 1] as const),
  );
  const failures: string[] = [];
  let zones = 0;
  let records = 0;

  for (const domain of rows) {
    let servers: Awaited<ReturnType<typeof getActiveServersForDomain>>;
    try {
      servers = await getActiveServersForDomain(db, domain.id);
    } catch (err) {
      failures.push(`${domain.domainName}: its DNS servers could not be read (${say(err)})`);
      continue;
    }
    if (servers.length === 0) continue;

    if (domain.dnsMode === 'secondary' && domain.masterIp) {
      for (const server of servers) {
        try {
          const provider = getProviderForServer(server, encryptionKey);
          if (provider.createSlaveZone) {
            await provider.createSlaveZone(domain.domainName, domain.masterIp);
            zones += 1;
          }
        } catch (err) {
          failures.push(`${domain.domainName} on ${server.displayName}: ${say(err)}`);
        }
      }
      continue;
    }

    const authoritative = canManageDnsZone({
      dnsMode: domain.dnsMode as 'primary' | 'cname' | 'secondary',
      activeServers: servers.map((s) => ({ id: s.id, providerType: s.providerType, enabled: s.enabled, role: s.role })),
    });
    // A domain whose zone lives elsewhere (cname mode) had nothing removed.
    if (!authoritative) continue;

    let nameservers: string[] = [];
    if (domain.dnsGroupId) {
      try {
        const group = await getProviderGroupById(db, domain.dnsGroupId);
        nameservers = Array.from(new Set((group.nsHostnames ?? []).map((ns) => ns.trim()).filter(Boolean)));
      } catch (err) {
        failures.push(`${domain.domainName}: its provider group could not be read (${say(err)})`);
      }
    }

    const webmail = rebuiltMail.get(domain.id);
    const stored = (await db.select().from(dnsRecords).where(eq(dnsRecords.domainId, domain.id)))
      .filter((r) => webmail === undefined || !rebuiltByMailRestore(r, domain.domainName, webmail));
    for (const server of servers) {
      let provider: ReturnType<typeof getProviderForServer>;
      try {
        provider = getProviderForServer(server, encryptionKey);
        const zoneKind = (server.zoneDefaultKind as 'Native' | 'Master') ?? 'Native';
        await provider.createZone(domain.domainName, zoneKind, nameservers);
        zones += 1;
      } catch (err) {
        // A zone the archive could not remove is still there: its records are
        // written all the same.
        failures.push(`${domain.domainName} on ${server.displayName}: zone not created (${say(err)})`);
        try {
          provider = getProviderForServer(server, encryptionKey);
        } catch {
          continue;
        }
      }
      if (nameservers.length > 0 && provider.replaceNsRecords) {
        await provider.replaceNsRecords(domain.domainName, nameservers)
          .catch((err: unknown) => { failures.push(`${domain.domainName} on ${server.displayName}: NS not set (${say(err)})`); });
      }
      for (const record of stored) {
        if (zoneOwnsRecord(record, domain.domainName)) continue;
        try {
          await provider.createRecord(domain.domainName, {
            type: record.recordType,
            name: record.recordName ?? '@',
            content: record.recordValue ?? '',
            ttl: record.ttl ?? 3600,
            priority: record.priority ?? undefined,
          });
          records += 1;
        } catch (err) {
          failures.push(`${record.recordType} ${record.recordName ?? '@'}.${domain.domainName} on ${server.displayName}: ${say(err)}`);
        }
      }
    }
  }
  return { zones, records, failures };
}
