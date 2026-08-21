import { eq, and } from 'drizzle-orm';
import { domains, ingressRoutes, platformSettings } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { getActiveServersForDomain, getProviderForServer } from '../dns-servers/service.js';
import { canManageDnsZone } from '../dns-servers/authority.js';
import { getIngressSettings, parseIngressIps } from '../ingress-routes/service.js';
import { syncRecordToProviders, provisionManagedRecord } from '../dns-records/service.js';
import { diffApexRecords, buildExpectedApexRecords } from './detector.js';
import * as tasks from '../tasks/service.js';
import type { Database } from '../../db/index.js';
import { toSafeText } from '@insula/api-contracts';
import type {
  DnsApexDriftDomain,
  DnsApexDriftReport,
} from '@insula/api-contracts';

/**
 * Apex ingress-record drift: detection and additive repair.
 *
 * Detection NEVER writes DNS. It is run on a slow schedule and on demand from
 * the DNS settings page, and its only side effect is storing the report so the
 * banner can read it without re-scanning. Repair is always operator-invoked
 * and additive — see `fixApexDrift`.
 */

/**
 * The report lives in `platform_settings` rather than a new table: it is a
 * single latest-wins document, it must survive a restart, and it must be the
 * same for every API replica (an in-memory cache would make the banner flicker
 * depending on which pod answered).
 */
const REPORT_KEY = 'dns_apex_drift_last_report';

const ENCRYPTION_KEY =
  process.env.PLATFORM_ENCRYPTION_KEY ?? '0'.repeat(64) /* Dev-only fallback */;

export async function getLastReport(db: Database): Promise<DnsApexDriftReport | null> {
  const [row] = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.key, REPORT_KEY));
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as DnsApexDriftReport;
  } catch {
    // A malformed blob must not break the page — treat as "never scanned".
    return null;
  }
}

async function storeReport(db: Database, report: DnsApexDriftReport): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key: REPORT_KEY, value: JSON.stringify(report) })
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: { value: JSON.stringify(report) },
    });
}

/**
 * Domains whose apex the platform is responsible for: primary mode (so we own
 * the zone) AND carrying an apex ingress route (so an apex address is supposed
 * to exist at all). A primary domain with only subdomain routes has no apex
 * records by design — reporting it as drifting would be a false positive.
 */
async function getApexManagedDomains(db: Database) {
  const rows = await db
    .select({
      id: domains.id,
      domainName: domains.domainName,
      dnsMode: domains.dnsMode,
    })
    .from(domains)
    .innerJoin(ingressRoutes, eq(ingressRoutes.domainId, domains.id))
    .where(and(eq(domains.dnsMode, 'primary'), eq(ingressRoutes.isApex, 1)));

  // The join yields one row per apex route; collapse to unique domains.
  const seen = new Map<string, { id: string; domainName: string }>();
  for (const r of rows) {
    if (!seen.has(r.id)) seen.set(r.id, { id: r.id, domainName: r.domainName });
  }
  return Array.from(seen.values());
}

/** Read the zone's records through the domain's own provider group. */
async function readZoneRecords(
  db: Database,
  domainId: string,
  domainName: string,
): Promise<{ records: { type: string; name: string; content: string }[] } | { error: string }> {
  const activeServers = await getActiveServersForDomain(db, domainId);
  const authoritative = canManageDnsZone({
    dnsMode: 'primary',
    activeServers: activeServers.map((s) => ({
      id: s.id,
      providerType: s.providerType,
      enabled: s.enabled,
      role: s.role,
    })),
  });
  if (!authoritative) {
    return { error: 'No enabled primary DNS server in this domain’s provider group' };
  }

  const primary = activeServers.find((s) => s.enabled === 1 && s.role === 'primary');
  if (!primary) return { error: 'No enabled primary DNS server' };

  try {
    const provider = getProviderForServer(primary, ENCRYPTION_KEY);
    const records = await provider.listRecords(domainName);
    return { records: records.map((r) => ({ type: r.type, name: r.name, content: r.content })) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ScanOptions {
  readonly trigger: 'manual' | 'scheduled';
}

/**
 * Read-only drift scan. Stores and returns the report.
 *
 * Never throws for a per-domain problem — an unreadable zone is recorded on
 * that domain as `error` and the scan continues, because one unreachable
 * provider must not hide drift on every other domain.
 */
export async function scanApexDrift(
  db: Database,
  opts: ScanOptions,
): Promise<DnsApexDriftReport> {
  const settings = await getIngressSettings(db);
  const ipv4 = parseIngressIps(settings.ingressDefaultIpv4);
  const ipv6 = parseIngressIps(settings.ingressDefaultIpv6);
  const expected = buildExpectedApexRecords(ipv4, ipv6);

  const scannedAt = new Date().toISOString();

  // With no ingress addresses configured there is no expectation to compare
  // against. Report that explicitly rather than declaring "no drift" — the
  // latter reads as healthy when the truth is "we cannot tell".
  if (expected.length === 0) {
    const report: DnsApexDriftReport = {
      scannedAt,
      trigger: opts.trigger,
      expected: [],
      ingressSource: settings.ingressSource,
      ingressDiscoveredNodes: settings.ingressDiscoveredNodes,
      domains: [],
      driftCount: 0,
      unmanagedCount: 0,
      errorCount: 0,
      scanError:
        'No ingress addresses available — no operator override is set and node discovery has not ' +
        'reported any Ready, ingress-eligible node with an ExternalIP. Apex drift cannot be ' +
        'evaluated until at least one address exists.',
    };
    await storeReport(db, report);
    return report;
  }

  const managed = await getApexManagedDomains(db);
  const results: DnsApexDriftDomain[] = [];

  for (const d of managed) {
    const read = await readZoneRecords(db, d.id, d.domainName);
    if ('error' in read) {
      results.push({
        domainId: d.id,
        domainName: d.domainName,
        expected,
        missing: [],
        unmanaged: [],
        error: read.error.slice(0, 500),
      });
      continue;
    }
    const { missing, unmanaged } = diffApexRecords(d.domainName, expected, read.records);
    results.push({
      domainId: d.id,
      domainName: d.domainName,
      expected,
      missing,
      unmanaged,
      error: null,
    });
  }

  const report: DnsApexDriftReport = {
    scannedAt,
    trigger: opts.trigger,
    expected,
    ingressSource: settings.ingressSource,
    ingressDiscoveredNodes: settings.ingressDiscoveredNodes,
    domains: results,
    driftCount: results.filter((r) => r.missing.length > 0).length,
    unmanagedCount: results.filter((r) => r.unmanaged.length > 0).length,
    errorCount: results.filter((r) => r.error !== null).length,
    scanError: null,
  };

  await storeReport(db, report);
  return report;
}

// ─── Repair ──────────────────────────────────────────────────────────────────

export interface FixSelection {
  readonly domainIds?: readonly string[];
  readonly all?: boolean;
}

/**
 * Start an additive repair. Returns immediately with the task id; the work
 * runs in the background and reports through the task center.
 *
 * ADDITIVE ONLY: this adds the ingress addresses a domain is missing. It never
 * deletes, so anything else at the apex (a CDN origin, a legacy host) survives
 * untouched. That is the deliberate trade — a stale extra address is a
 * lesser evil than this tool black-holing a tenant.
 */
export async function startApexDriftFix(
  db: Database,
  userId: string,
  selection: FixSelection,
): Promise<{ taskId: string; domainCount: number }> {
  const report = await getLastReport(db);
  if (!report) {
    throw new ApiError(
      'NO_DRIFT_REPORT',
      'No drift scan has been run yet — run a scan before applying fixes.',
      409,
      {
        operatorError: {
          code: 'NO_DRIFT_REPORT',
          title: 'Nothing to fix yet',
          detail: 'Apex drift can only be repaired from a scan result, and no scan has run.',
          remediation: ['Click “Scan for drift” first, then apply fixes from the report.'],
          retryable: true,
        },
      },
    );
  }

  const drifting = report.domains.filter((d) => d.missing.length > 0 && d.error === null);
  const selected = selection.all
    ? drifting
    : drifting.filter((d) => (selection.domainIds ?? []).includes(d.domainId));

  if (selected.length === 0) {
    throw new ApiError(
      'NO_DOMAINS_SELECTED',
      'None of the selected domains have missing apex records in the latest report.',
      400,
      {
        operatorError: {
          code: 'NO_DOMAINS_SELECTED',
          title: 'Nothing to apply',
          detail:
            'The selected domains have no missing records in the latest scan. The report may be stale.',
          remediation: ['Re-run the scan to refresh the report, then select domains again.'],
          retryable: true,
        },
      },
    );
  }

  const { id: taskId } = await tasks.start(db, {
    kind: 'dns.apex-drift-fix',
    scope: 'admin',
    userId,
    label: toSafeText(`Repair apex DNS records (${selected.length} domain${selected.length === 1 ? '' : 's'})`),
    target: { type: 'modal', modal: 'dns-apex-drift-fix', modalProps: {} },
    progressPct: 0,
    progressText: toSafeText(`0 / ${selected.length}`),
    details: {
      steps: selected.map((d) => ({ name: d.domainName, state: 'pending' as const })),
    },
  });

  // Fire-and-forget. The catch is mandatory: an unhandled rejection here would
  // terminate the API process, which is exactly how a scheduler tick took
  // platform-api down before.
  void runFix(db, taskId, selected).catch(async (err) => {
    await tasks
      .finish(db, taskId, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      })
      .catch(() => undefined);
  });

  return { taskId, domainCount: selected.length };
}

async function runFix(
  db: Database,
  taskId: string,
  selected: readonly DnsApexDriftDomain[],
): Promise<void> {
  const steps = selected.map((d) => ({
    name: d.domainName,
    state: 'pending' as 'pending' | 'running' | 'done' | 'failed',
    note: undefined as string | undefined,
  }));

  let added = 0;
  let failed = 0;

  for (let i = 0; i < selected.length; i += 1) {
    const domain = selected[i];
    steps[i].state = 'running';
    await tasks.progress(db, taskId, {
      pct: Math.round((i / selected.length) * 100),
      text: toSafeText(`${i} / ${selected.length} — ${domain.domainName}`),
      detailsPatch: { steps },
    });

    let domainFailed: string | null = null;
    let domainAdded = 0;
    for (const record of domain.missing) {
      try {
        // provisionManagedRecord, not a bare sync: the repair writes to the
        // DNS server AND records the row, so a record this scan created shows
        // up in the domain's DNS Records list like everything else. A bare
        // sync left the panel claiming the apex had no records while they
        // existed upstream — the same invisible-write bug fixed for ingress
        // routes.
        await provisionManagedRecord(
          db,
          'apex-drift',
          { id: domain.domainId, domainName: domain.domainName },
          { type: record.type, name: '@', content: record.content, ttl: 300 },
        );
        domainAdded += 1;
      } catch (err) {
        domainFailed = err instanceof Error ? err.message : String(err);
        break;
      }
    }

    if (domainFailed) {
      steps[i].state = 'failed';
      steps[i].note = domainFailed.slice(0, 200);
      failed += 1;
    } else {
      steps[i].state = 'done';
      steps[i].note = `${domainAdded} record${domainAdded === 1 ? '' : 's'} added`;
      added += domainAdded;
    }
  }

  await tasks.progress(db, taskId, {
    pct: 100,
    text: toSafeText(`${selected.length} / ${selected.length}`),
    detailsPatch: { steps },
  });

  // Refresh the stored report so the banner reflects reality immediately
  // instead of showing stale drift until the next scheduled scan.
  await scanApexDrift(db, { trigger: 'manual' }).catch(() => undefined);

  await tasks.finish(db, taskId, {
    status: failed > 0 ? 'failed' : 'succeeded',
    error:
      failed > 0
        ? `${failed} of ${selected.length} domain(s) could not be updated — see per-domain detail.`
        : null,
    text: toSafeText(`${added} record${added === 1 ? '' : 's'} added across ${selected.length - failed} domain(s)`),
    detailsPatch: { steps, added, failed },
  });
}
