import { eq, and } from 'drizzle-orm';
import { dnsRecords, domains, tenants } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { getActiveServers, getActiveServersForDomain, getProviderForServer } from '../dns-servers/service.js';
import { canManageDnsZone } from '../dns-servers/authority.js';
import { getReservedPlatformHostnames } from '../system-tenant/reserved-subdomains.js';
import { computeRecordDiff, type DnsRecordDiffEntry } from './diff.js';
import type { Database } from '../../db/index.js';
import type { CreateDnsRecordInput, UpdateDnsRecordInput } from './schema.js';
import type { DnsRecord as DnsRecordRow } from '../../db/schema.js';

const encryptionKey = () => process.env.PLATFORM_ENCRYPTION_KEY ?? '0'.repeat(64) /* Dev-only fallback — production requires PLATFORM_ENCRYPTION_KEY env var */;

/**
 * Result of pushing one record to the domain's authoritative servers.
 *
 * `syncRecordToProviders` deliberately never throws — a dozen callers
 * (ingress-routes, dkim publish, stalwart dns-sync, apex-drift repair)
 * treat DNS publication as best-effort and must not fail their own
 * transaction on it. Callers that DO owe the operator an answer
 * (record CRUD, the Sync Records push button) inspect this instead.
 *
 * Before ADR-058's follow-up, every provider error here was a
 * `console.warn` and the API still answered 201 Created. MX, SRV and CAA
 * records were rejected by PowerDNS for years while the panel reported
 * success — see `formatContent` in dns-servers/wire-format.ts.
 */
export type DnsSyncOutcome =
  | { readonly status: 'published'; readonly servers: number }
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'failed'; readonly errors: ReadonlyArray<{ server: string; message: string }> };

/** Collapse per-server failures into one operator-facing sentence. */
export function describeSyncFailure(outcome: Extract<DnsSyncOutcome, { status: 'failed' }>): string {
  if (outcome.errors.length === 1) return outcome.errors[0].message;
  return outcome.errors.map((e) => `${e.server}: ${e.message}`).join('; ');
}

export async function syncRecordToProviders(
  db: Database,
  domainName: string,
  action: 'create' | 'update' | 'delete',
  record: { type: string; name: string; content: string; ttl?: number; priority?: number | null; weight?: number | null; port?: number | null; id?: string },
  domainId?: string,
): Promise<DnsSyncOutcome> {
  try {
    // Phase 2c: gate record writes on DNS authority. Previously this function
    // happily iterated all servers and logged warnings when writes silently
    // failed (typically because the domain was in cname mode and the platform
    // had no authority over the zone). That produced confusing logs and made
    // it look like there was a transient provider error. Now we short-circuit
    // for non-authoritative domains with a single log line.
    if (domainId) {
      const [domain] = await db
        .select({ dnsMode: domains.dnsMode })
        .from(domains)
        .where(eq(domains.id, domainId));
      if (domain) {
        const servers = await getActiveServersForDomain(db, domainId);
        const canManage = canManageDnsZone({
          dnsMode: domain.dnsMode as 'primary' | 'cname' | 'secondary',
          activeServers: servers.map((s) => ({
            id: s.id,
            providerType: s.providerType,
            enabled: s.enabled,
            role: s.role,
          })),
        });
        if (!canManage) {
          // Not an error — dnsMode=cname is the default for customer-managed
          // domains, and record writes simply don't apply.
          const reason = `platform is not authoritative for this zone (dnsMode=${domain.dnsMode})`;
          console.info(`[dns-sync] Skipping ${action} on '${domainName}' — ${reason}`);
          return { status: 'skipped', reason };
        }

        return await pushToServers(servers, domainName, action, record);
      }
    }

    // Backwards-compat fallback: no domainId → push to all active servers.
    // Callers that hit this path haven't migrated to the domain-scoped API
    // yet; authority can't be resolved without a domain, so we just try.
    const servers = await getActiveServers(db);
    return await pushToServers(servers, domainName, action, record);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[dns-sync] Failed to get active DNS servers:', message);
    return { status: 'failed', errors: [{ server: '(resolution)', message }] };
  }
}

/**
 * Push one record to every server, collecting failures rather than
 * swallowing them.
 *
 * All-or-nothing by design: a record that reaches some primaries but not
 * others leaves the zone inconsistent, and the operator has to know. In
 * practice a provider group has a single primary (record CRUD targets the
 * group's primary — see the DNS provider groups section of AGENTS.md), so
 * "any failure" and "total failure" coincide.
 */
async function pushToServers(
  servers: ReadonlyArray<{ id: string; displayName: string; providerType: string; enabled: number; role: string }>,
  domainName: string,
  action: 'create' | 'update' | 'delete',
  record: { type: string; name: string; content: string; ttl?: number; priority?: number | null; weight?: number | null; port?: number | null; id?: string },
): Promise<DnsSyncOutcome> {
  if (servers.length === 0) {
    return { status: 'skipped', reason: 'no DNS servers are configured for this domain' };
  }

  const errors: Array<{ server: string; message: string }> = [];
  for (const server of servers) {
    try {
      const provider = getProviderForServer(server as never, encryptionKey());
      if (action === 'create' || action === 'update') {
        await provider.createRecord(domainName, {
          type: record.type,
          name: record.name,
          content: record.content,
          ttl: record.ttl ?? 3600,
          // weight/port matter for SRV; without them the provider cannot
          // build valid content and refuses the record outright.
          priority: record.priority ?? undefined,
          weight: record.weight ?? undefined,
          port: record.port ?? undefined,
        });
      } else if (action === 'delete' && record.id) {
        await provider.deleteRecord(domainName, `${record.name}|${record.type}|${record.content}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[dns-sync] Failed to ${action} ${record.type} '${record.name}' on ${server.displayName}: ${message}`);
      errors.push({ server: server.displayName, message });
    }
  }

  return errors.length > 0
    ? { status: 'failed', errors }
    : { status: 'published', servers: servers.length };
}

async function verifyDomainOwnership(db: Database, tenantId: string, domainId: string) {
  const [domain] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.tenantId, tenantId)));

  if (!domain) {
    throw new ApiError('DOMAIN_NOT_FOUND', `Domain '${domainId}' not found for tenant`, 404);
  }
  return domain;
}

export async function listDnsRecords(db: Database, tenantId: string, domainId: string) {
  await verifyDomainOwnership(db, tenantId, domainId);

  return db
    .select()
    .from(dnsRecords)
    .where(eq(dnsRecords.domainId, domainId));
}

/**
 * ADR-040 §3 Q5 reservation enforcement for DNS records.
 *
 * Refuses records whose effective FQDN (record_name + parent domain)
 * matches a platform-reserved hostname — catching a tenant who somehow
 * owns a parent zone like `<apex>` and adds `admin` as a record.
 *
 * Throws `RESERVED_PLATFORM_HOSTNAME` (HTTP 409) when it applies.
 *
 * ── Why there is no check on the record VALUE ──────────────────────
 * This used to also refuse CNAME/A/AAAA/MX/NS/SRV records whose *target*
 * was a reserved hostname, to block a supposed "hijack by CNAME". It
 * blocked no attack and broke the platform's own documented flows:
 *
 *   - The tenant panel tells customers to CNAME their hostname at the
 *     ingress base domain, which is reserved by the `ingress` label.
 *   - `buildEmailDnsRecords` points every tenant MX at `mail.<apex>`,
 *     which is reserved as the platform mail server. A tenant adding
 *     that record by hand — the documented fallback when the platform
 *     cannot write the zone — got a 409.
 *
 * Pointing a record you already own at a platform hostname grants
 * nothing: name resolution is not authorization. Traefik routes on the
 * Host header, so a CNAME to `admin.<apex>` still arrives carrying the
 * tenant's own hostname and matches no admin route; and every admin UI
 * Ingress carries a mandatory auth gate (`ci-admin-auth-check.sh`).
 * The controls that DO stop a hijack are the check below (the record's
 * own name) and the reserved-hostname guard in `domains/service.ts`
 * that stops the tenant registering `admin.<apex>` in the first place.
 * Both are unchanged.
 */
async function assertNotReservedHostname(
  db: Database,
  domainId: string,
  tenantId: string,
  input: CreateDnsRecordInput,
): Promise<void> {
  // .where() (no .limit()) — domains.id is unique, so at most one row.
  // Keeping the chain simple so existing dns-records unit-test mocks
  // (which mock select→from→where but not limit) continue to work.
  const [parent] = await db.select({ domainName: domains.domainName })
    .from(domains).where(eq(domains.id, domainId));
  if (!parent) return; // verifyDomainOwnership already threw; defensive

  // SYSTEM tenant owns platform-managed hostnames — let it create
  // DNS records under them (mail.<apex>, webmail.<apex>, etc.). The
  // reserved-hostname guard exists to prevent NON-system tenants from
  // hijacking platform UIs via tenant-controlled DNS zones.
  const [tenantRow] = await db.select({ isSystem: tenants.isSystem })
    .from(tenants).where(eq(tenants.id, tenantId));
  if (tenantRow?.isSystem) return;

  const reserved = await getReservedPlatformHostnames(db);
  const lower = (s: string) => s.trim().replace(/\.+$/, '').toLowerCase();
  const parentDomain = lower(parent.domainName);

  // Case (a): effective FQDN of this record (label + parent).
  const recordName = input.record_name ? lower(input.record_name) : '';
  const effectiveFqdn = recordName === '' || recordName === '@'
    ? parentDomain
    : `${recordName}.${parentDomain}`;
  if (reserved.fqdns.has(effectiveFqdn)) {
    const reason = reserved.reasons.get(effectiveFqdn) ?? 'platform-reserved hostname';
    throw new ApiError(
      'RESERVED_PLATFORM_HOSTNAME',
      `DNS record '${effectiveFqdn}' collides with a platform-reserved hostname (${reason}).`,
      409,
      {
        hostname: effectiveFqdn,
        reservedFor: reason,
      },
    );
  }

}

export async function createDnsRecord(
  db: Database,
  tenantId: string,
  domainId: string,
  input: CreateDnsRecordInput,
) {
  await verifyDomainOwnership(db, tenantId, domainId);

  // SYSTEM tenant reservation (ADR-040 §3 Q5): refuse records whose
  // effective FQDN resolves to a platform-reserved hostname. This
  // closes the "register a customer domain → CNAME `admin.<apex>` to
  // a tenant deployment" hijack that the domain-create check alone
  // can't catch. The check fires when:
  //   record_name + parent_domain == reserved fqdn   (DNS record on
  //   the tenant's own zone pointing at a reserved hostname target)
  // For CNAME/A/AAAA we also check whether the record_value (target)
  // matches a reserved hostname — refusing those prevents a tenant
  // from creating a CNAME on their own apex pointing at an admin UI.
  await assertNotReservedHostname(db, domainId, tenantId, input);

  const id = crypto.randomUUID();

  await db.insert(dnsRecords).values({
    id,
    domainId,
    recordType: input.record_type,
    recordName: input.record_name ?? null,
    recordValue: input.record_value,
    ttl: input.ttl ?? 3600,
    priority: input.priority ?? null,
    weight: input.weight ?? null,
    port: input.port ?? null,
  });

  const [created] = await db
    .select()
    .from(dnsRecords)
    .where(eq(dnsRecords.id, id));

  // Sync to external DNS servers (domain-scoped)
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (domain) {
    const outcome = await syncRecordToProviders(db, domain.domainName, 'create', {
      type: input.record_type, name: input.record_name ?? '@', content: input.record_value,
      ttl: input.ttl, priority: input.priority, weight: input.weight, port: input.port,
    }, domainId);

    // A record the authoritative server refused is not a record. Keeping the
    // local row while answering 201 is exactly how MX/SRV/CAA appeared to
    // work in the panel for years while never existing in DNS.
    if (outcome.status === 'failed') {
      await db.delete(dnsRecords).where(eq(dnsRecords.id, id));
      throw new ApiError(
        'DNS_PUBLISH_FAILED',
        `The DNS server rejected this record: ${describeSyncFailure(outcome)}`,
        502,
        { recordType: input.record_type, recordName: input.record_name ?? '@', errors: outcome.errors },
      );
    }
  }

  return created;
}

export async function updateDnsRecord(
  db: Database,
  tenantId: string,
  domainId: string,
  recordId: string,
  input: UpdateDnsRecordInput,
) {
  await verifyDomainOwnership(db, tenantId, domainId);

  const [record] = await db
    .select()
    .from(dnsRecords)
    .where(and(eq(dnsRecords.id, recordId), eq(dnsRecords.domainId, domainId)));

  if (!record) {
    throw new ApiError('DNS_RECORD_NOT_FOUND', `DNS record '${recordId}' not found`, 404);
  }

  // No reserved-hostname re-check on UPDATE: the guard keys off the
  // record's own name, and `updateDnsRecordSchema` cannot change it.
  // (It used to re-check the record VALUE — see assertNotReservedHostname
  // for why that check is gone.)

  const updateValues: Record<string, unknown> = {};
  if (input.record_value !== undefined) updateValues.recordValue = input.record_value;
  if (input.ttl !== undefined) updateValues.ttl = input.ttl;
  if (input.priority !== undefined) updateValues.priority = input.priority;
  if (input.weight !== undefined) updateValues.weight = input.weight;
  if (input.port !== undefined) updateValues.port = input.port;

  if (Object.keys(updateValues).length > 0) {
    await db
      .update(dnsRecords)
      .set(updateValues)
      .where(eq(dnsRecords.id, recordId));
  }

  const [updated] = await db
    .select()
    .from(dnsRecords)
    .where(eq(dnsRecords.id, recordId));

  // Sync updated record to external DNS servers (domain-scoped)
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (domain && updated) {
    const outcome = await syncRecordToProviders(db, domain.domainName, 'update', {
      type: updated.recordType,
      name: updated.recordName ?? '@',
      content: updated.recordValue ?? '',
      ttl: updated.ttl,
      priority: updated.priority,
      weight: updated.weight,
      port: updated.port,
      id: recordId,
    }, domainId);

    // Restore the pre-edit row so the panel never shows a value the
    // authoritative server never accepted.
    if (outcome.status === 'failed') {
      await db
        .update(dnsRecords)
        .set({
          recordValue: record.recordValue,
          ttl: record.ttl,
          priority: record.priority,
          weight: record.weight,
          port: record.port,
        })
        .where(eq(dnsRecords.id, recordId));
      throw new ApiError(
        'DNS_PUBLISH_FAILED',
        `The DNS server rejected this change: ${describeSyncFailure(outcome)}`,
        502,
        { recordType: updated.recordType, recordName: updated.recordName ?? '@', errors: outcome.errors },
      );
    }
  }

  return updated;
}

export async function deleteDnsRecord(
  db: Database,
  tenantId: string,
  domainId: string,
  recordId: string,
) {
  await verifyDomainOwnership(db, tenantId, domainId);

  const [record] = await db
    .select()
    .from(dnsRecords)
    .where(and(eq(dnsRecords.id, recordId), eq(dnsRecords.domainId, domainId)));

  if (!record) {
    throw new ApiError('DNS_RECORD_NOT_FOUND', `DNS record '${recordId}' not found`, 404);
  }

  // Delete REMOTELY FIRST, then locally. The reverse order loses the row
  // whenever the provider call fails, leaving a record that is gone from the
  // panel but still resolving in DNS — with nothing left to retry from.
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (domain && record.recordType && record.recordValue) {
    const outcome = await syncRecordToProviders(db, domain.domainName, 'delete', {
      type: record.recordType, name: record.recordName ?? '@', content: record.recordValue ?? '',
      id: recordId,
    }, domainId);

    if (outcome.status === 'failed') {
      throw new ApiError(
        'DNS_PUBLISH_FAILED',
        `The DNS server rejected this deletion: ${describeSyncFailure(outcome)}`,
        502,
        { recordType: record.recordType, recordName: record.recordName ?? '@', errors: outcome.errors },
      );
    }
  }

  await db.delete(dnsRecords).where(eq(dnsRecords.id, recordId));
}

/** Re-exported so existing importers of this module keep working; the
 *  type and the comparison itself live in `./diff.ts`. */
export type { DnsRecordDiffEntry } from './diff.js';

export async function diffRecordsWithProvider(
  db: Database,
  tenantId: string,
  domainId: string,
): Promise<DnsRecordDiffEntry[]> {
  await verifyDomainOwnership(db, tenantId, domainId);

  const [domainRow] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domainRow) throw new ApiError('DOMAIN_NOT_FOUND', 'Domain not found', 404);

  // Get local records
  const localRecords = await db.select().from(dnsRecords).where(eq(dnsRecords.domainId, domainId));

  // Get remote records from provider
  const servers = await getActiveServersForDomain(db, domainId);
  if (servers.length === 0) {
    const allServers = await getActiveServers(db);
    if (allServers.length === 0) throw new ApiError('NO_DNS_SERVERS', 'No DNS servers configured', 400);
    servers.push(...allServers);
  }

  const provider = getProviderForServer(servers[0], encryptionKey());
  let remoteRecords: Awaited<ReturnType<typeof provider.listRecords>>;
  try {
    remoteRecords = await provider.listRecords(domainRow.domainName);
  } catch {
    throw new ApiError('DNS_PROVIDER_ERROR', 'Failed to fetch records from DNS server', 503);
  }

  return computeRecordDiff(domainRow.domainName, localRecords, remoteRecords);
}

/**
 * Adopt a provider-side value into the local row without pushing it back.
 *
 * Used by the Sync Records "pull" action: the value being written came FROM
 * the provider, so re-publishing it is at best a no-op and at worst a
 * spurious failure on a record the provider already accepts.
 */
export async function updateDnsRecordLocalOnly(
  db: Database,
  tenantId: string,
  domainId: string,
  recordId: string,
  input: UpdateDnsRecordInput,
) {
  await verifyDomainOwnership(db, tenantId, domainId);

  const [record] = await db
    .select()
    .from(dnsRecords)
    .where(and(eq(dnsRecords.id, recordId), eq(dnsRecords.domainId, domainId)));
  if (!record) {
    throw new ApiError('DNS_RECORD_NOT_FOUND', `DNS record '${recordId}' not found`, 404);
  }

  const updateValues: Record<string, unknown> = {};
  if (input.record_value !== undefined) updateValues.recordValue = input.record_value;
  if (input.ttl !== undefined) updateValues.ttl = input.ttl;
  if (input.priority !== undefined) updateValues.priority = input.priority;
  if (input.weight !== undefined) updateValues.weight = input.weight;
  if (input.port !== undefined) updateValues.port = input.port;

  if (Object.keys(updateValues).length > 0) {
    await db.update(dnsRecords).set(updateValues).where(eq(dnsRecords.id, recordId));
  }

  const [updated] = await db.select().from(dnsRecords).where(eq(dnsRecords.id, recordId));
  return updated;
}

export async function createDnsRecordLocalOnly(db: Database, tenantId: string, domainId: string, input: CreateDnsRecordInput) {
  await verifyDomainOwnership(db, tenantId, domainId);
  const id = crypto.randomUUID();
  await db.insert(dnsRecords).values({
    id,
    domainId,
    recordType: input.record_type as typeof dnsRecords.$inferInsert['recordType'],
    recordName: input.record_name ?? null,
    recordValue: input.record_value,
    ttl: input.ttl ?? 3600,
    priority: input.priority ?? null,
    weight: input.weight ?? null,
    port: input.port ?? null,
  });
  const [created] = await db.select().from(dnsRecords).where(eq(dnsRecords.id, id));
  return created;
}

export async function syncRecordsFromProvider(
  db: Database,
  tenantId: string,
  domainId: string,
): Promise<DnsRecordRow[]> {
  await verifyDomainOwnership(db, tenantId, domainId);

  const [domainRow] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domainRow) {
    throw new ApiError('DOMAIN_NOT_FOUND', 'Domain not found', 404);
  }

  // Use domain-scoped servers
  const servers = await getActiveServersForDomain(db, domainId);
  if (servers.length === 0) {
    // Fall back to all active servers for backward compat
    const allServers = await getActiveServers(db);
    if (allServers.length === 0) {
      throw new ApiError('NO_DNS_SERVERS', 'No DNS servers configured', 400);
    }
    servers.push(...allServers);
  }

  const provider = getProviderForServer(servers[0], encryptionKey());
  const remoteRecords = await provider.listRecords(domainRow.domainName);

  // Delete all existing local records for this domain
  await db.delete(dnsRecords).where(eq(dnsRecords.domainId, domainId));

  // Insert remote records
  for (const r of remoteRecords) {
    await db.insert(dnsRecords).values({
      id: crypto.randomUUID(),
      domainId,
      recordType: r.type as typeof dnsRecords.$inferInsert['recordType'],
      recordName: r.name,
      recordValue: r.content,
      ttl: r.ttl ?? 3600,
      priority: r.priority ?? null,
    });
  }

  // Return updated list
  return db.select().from(dnsRecords).where(eq(dnsRecords.domainId, domainId));
}
