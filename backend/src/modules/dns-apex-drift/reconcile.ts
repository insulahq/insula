import { and, eq, inArray } from 'drizzle-orm';
import { dnsRecords, domains, ingressRoutes } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { ApiError } from '../../shared/errors.js';
import { relativeRecordName } from '@insula/api-contracts';
import type { DnsApexDriftDomain, RouteDnsDomainResult } from '@insula/api-contracts';
import { getActiveServersForDomain, getProviderForServer } from '../dns-servers/service.js';
import { canManageDnsZone } from '../dns-servers/authority.js';
import { provisionManagedRecord, syncRecordToProviders, describeSyncFailure, type DnsSyncOutcome } from '../dns-records/service.js';
import { getWwwCompanionHostname, isApexHostname } from '../ingress-routes/service.js';
import { addrKey, planHostname, recordNameMatches, type ProviderRecord } from './detector.js';
import type { IngressInventory } from './inventory.js';

/**
 * Route DNS reconcile for ONE domain: the plan (read-only) and the apply.
 *
 * The drift scan plans every domain; the drift repair and "Refresh route
 * DNS" both apply. One implementation, so the three can never disagree about
 * what a domain's route records should be.
 */

function outcomeText(outcome: DnsSyncOutcome): string {
  if (outcome.status === 'failed') return describeSyncFailure(outcome);
  if (outcome.status === 'skipped') return outcome.reason;
  return 'published';
}

const ENCRYPTION_KEY = process.env.PLATFORM_ENCRYPTION_KEY ?? '0'.repeat(64) /* Dev-only fallback */;

/** Owners whose rows mean "the platform created this record". */
const PLATFORM_OWNERS = ['ingress-route', 'apex-drift'] as const;

/** Every name a domain's routes resolve through, www companions included. */
export async function routeHostnames(db: Database, domainId: string): Promise<string[]> {
  const routes = await db
    .select({ hostname: ingressRoutes.hostname, wwwRedirect: ingressRoutes.wwwRedirect })
    .from(ingressRoutes)
    .where(eq(ingressRoutes.domainId, domainId));
  // A route's www companion (add-www / remove-www) carries its own address
  // records — usually the name that actually serves the site.
  return Array.from(new Set(routes.flatMap((r) => {
    const companion = getWwwCompanionHostname(r.hostname, r.wwwRedirect);
    return companion ? [r.hostname, companion] : [r.hostname];
  }))).sort();
}

function recordNameFor(hostname: string, zone: string): string {
  return isApexHostname(hostname, zone) ? '@' : relativeRecordName(hostname, zone);
}

/** Read the zone through the domain's own provider group. */
async function readZone(db: Database, domainId: string, zone: string): Promise<ProviderRecord[]> {
  const activeServers = await getActiveServersForDomain(db, domainId);
  const authoritative = canManageDnsZone({
    dnsMode: 'primary',
    activeServers: activeServers.map((s) => ({ id: s.id, providerType: s.providerType, enabled: s.enabled, role: s.role })),
  });
  const primary = activeServers.find((s) => s.enabled === 1 && s.role === 'primary');
  if (!authoritative || !primary) {
    throw new Error('No enabled primary DNS server in this domain’s provider group');
  }
  const provider = getProviderForServer(primary, ENCRYPTION_KEY);
  const records = await provider.listRecords(zone);
  return records.map((r) => ({ type: r.type, name: r.name, content: r.content }));
}

function isPlatformOwner(managedBy: string | null): boolean {
  return managedBy !== null && (PLATFORM_OWNERS as readonly string[]).includes(managedBy);
}

/**
 * Keys (`hostname|TYPE|value`) of the address records this domain's rows
 * publish at its route names: `platform` for rows the route reconcile owns,
 * `manual` for every other row — hand-made, so never the repair's to remove.
 */
async function rowKeys(db: Database, domainId: string, zone: string, hostnames: readonly string[]): Promise<{ platform: Set<string>; manual: Set<string> }> {
  const rows = await db
    .select({ recordType: dnsRecords.recordType, recordName: dnsRecords.recordName, recordValue: dnsRecords.recordValue, managedBy: dnsRecords.managedBy })
    .from(dnsRecords)
    .where(and(eq(dnsRecords.domainId, domainId), inArray(dnsRecords.recordType, ['A', 'AAAA'])));
  const platform = new Set<string>();
  const manual = new Set<string>();
  for (const r of rows) {
    const host = hostnames.find((h) => recordNameMatches(r.recordName ?? '@', h, zone));
    if (!host) continue;
    (isPlatformOwner(r.managedBy) ? platform : manual).add(`${host}|${addrKey(r.recordType, r.recordValue ?? '')}`);
  }
  return { platform, manual };
}

/** Plan one domain. Never writes. Throws only for an unreadable zone. */
export async function planDomainRouteDns(
  db: Database,
  domain: { readonly id: string; readonly domainName: string },
  inventory: IngressInventory,
): Promise<DnsApexDriftDomain> {
  const hostnames = await routeHostnames(db, domain.id);
  const zoneRecords = await readZone(db, domain.id, domain.domainName);
  const rows = await rowKeys(db, domain.id, domain.domainName, hostnames);

  const plans = hostnames.map((hostname) => planHostname({
    hostname,
    recordName: recordNameFor(hostname, domain.domainName),
    zone: domain.domainName,
    expected: inventory.expected,
    zoneRecords,
    classify: (record) => {
      const key = `${hostname}|${addrKey(record.type, record.content)}`;
      const verdict = inventory.classify(record, rows.platform.has(key));
      // A hand-made record is the operator's decision: even a removed
      // server's address stays when someone published it on purpose.
      if (rows.manual.has(key)) return { kind: 'held', servers: verdict?.servers ?? [], reason: 'manual-record' };
      return verdict;
    },
  }));

  return {
    domainId: domain.id,
    domainName: domain.domainName,
    hostnames: plans,
    missingCount: plans.reduce((n, p) => n + p.missing.length, 0),
    staleCount: plans.reduce((n, p) => n + p.stale.length, 0),
    heldCount: plans.reduce((n, p) => n + p.held.length, 0),
    foreignCount: plans.reduce((n, p) => n + p.foreign.length, 0),
    error: null,
  };
}

/**
 * Bring one domain's route records to the plan: ADD every missing address,
 * then REMOVE every stale one — in that order, so a name never stops
 * resolving mid-repair. When an add fails at a name, nothing is removed at
 * that name: withdrawing the old addresses before the new ones are live could
 * leave it resolving to nothing. Held and foreign records are never touched.
 *
 * Every expected address also gets (or keeps) its `ingress-route` row, so the
 * domain's DNS Records list matches the zone after the repair.
 */
export async function applyDomainRouteDns(
  db: Database,
  domain: { readonly id: string; readonly domainName: string },
  plan: DnsApexDriftDomain,
  inventory: IngressInventory,
): Promise<RouteDnsDomainResult> {
  if (inventory.expected.length === 0) {
    // Refuse rather than "remove everything": an empty expectation means the
    // platform cannot see any ingress address right now, not that there is none.
    throw new ApiError(
      'NO_INGRESS_ADDRESSES',
      'No ingress address is known right now, so route records cannot be reconciled — nothing was changed.',
      409,
    );
  }
  const result: RouteDnsDomainResult = { domainId: domain.id, domainName: domain.domainName, added: [], removed: [], failures: [] };
  const missingKeys = new Set(plan.hostnames.flatMap((h) => h.missing.map((r) => `${h.hostname}|${addrKey(r.type, r.content)}`)));

  for (const h of plan.hostnames) {
    // 1. Expected addresses: publish what is missing; (re)claim the row of
    //    what is already there. provisionManagedRecord is idempotent.
    let addFailed = false;
    for (const r of inventory.expected) {
      const isMissing = missingKeys.has(`${h.hostname}|${addrKey(r.type, r.content)}`);
      try {
        const outcome = await provisionManagedRecord(db, 'ingress-route', domain, { type: r.type, name: h.recordName, content: r.content });
        if (outcome.status !== 'published') {
          if (isMissing) {
            addFailed = true;
            result.failures.push({ hostname: h.hostname, detail: `${r.type} ${r.content} not added: ${outcomeText(outcome)}` });
          }
          continue;
        }
        if (isMissing) result.added.push({ hostname: h.hostname, type: r.type, content: r.content, servers: [...r.servers] });
      } catch (err) {
        if (isMissing) addFailed = true;
        result.failures.push({ hostname: h.hostname, detail: `${r.type} ${r.content} not added: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    if (addFailed && h.stale.length > 0) {
      result.failures.push({
        hostname: h.hostname,
        detail: `${h.stale.map((r) => `${r.type} ${r.content}`).join(', ')} kept: the new addresses could not be added first, so nothing was removed at this name.`,
      });
      continue;
    }

    // 2. Stale addresses: withdraw from the server, then drop the platform
    //    rows that still claim them at this name.
    for (const r of h.stale) {
      try {
        const outcome = await syncRecordToProviders(db, domain.domainName, 'delete',
          { type: r.type, name: h.recordName, content: r.content, id: 'route-dns' }, domain.id);
        if (outcome.status !== 'published') {
          result.failures.push({ hostname: h.hostname, detail: `${r.type} ${r.content} still published: ${outcomeText(outcome)}` });
          continue;
        }
        await dropRows(db, domain, h.hostname, r.type, r.content);
        result.removed.push({ hostname: h.hostname, type: r.type, content: r.content, servers: [...r.servers], reason: r.reason });
      } catch (err) {
        result.failures.push({ hostname: h.hostname, detail: `${r.type} ${r.content} not removed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }
  return result;
}

async function dropRows(
  db: Database,
  domain: { readonly id: string; readonly domainName: string },
  hostname: string,
  type: 'A' | 'AAAA',
  content: string,
): Promise<void> {
  const rows = await db
    .select({ id: dnsRecords.id, recordName: dnsRecords.recordName, recordValue: dnsRecords.recordValue })
    .from(dnsRecords)
    .where(and(
      eq(dnsRecords.domainId, domain.id),
      eq(dnsRecords.recordType, type),
      inArray(dnsRecords.managedBy, [...PLATFORM_OWNERS]),
    ));
  const key = addrKey(type, content);
  for (const r of rows) {
    if (addrKey(type, r.recordValue ?? '') !== key) continue;
    if (!recordNameMatches(r.recordName ?? '@', hostname, domain.domainName)) continue;
    await db.delete(dnsRecords).where(eq(dnsRecords.id, r.id));
  }
}

/** Plan + apply for one domain — what "Refresh route DNS" runs. */
export async function reconcileDomainRouteDns(
  db: Database,
  domainId: string,
  inventory: IngressInventory,
): Promise<{ plan: DnsApexDriftDomain; result: RouteDnsDomainResult }> {
  const [domain] = await db.select({ id: domains.id, domainName: domains.domainName, dnsMode: domains.dnsMode })
    .from(domains).where(eq(domains.id, domainId));
  if (!domain) throw new ApiError('NOT_FOUND', 'Domain not found', 404);
  if (domain.dnsMode !== 'primary') {
    throw new ApiError(
      'DNS_MODE_NOT_PRIMARY',
      `Refreshing route DNS needs primary mode; '${domain.domainName}' is in ${domain.dnsMode} mode, `
      + 'where the platform does not control the zone.',
      409,
    );
  }
  const plan = await planDomainRouteDns(db, domain, inventory);
  const result = await applyDomainRouteDns(db, domain, plan, inventory);
  return { plan, result };
}
