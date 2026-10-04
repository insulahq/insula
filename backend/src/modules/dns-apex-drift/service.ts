import { and, eq, exists } from 'drizzle-orm';
import { domains, ingressRoutes, platformSettings } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import * as tasks from '../tasks/service.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { toSafeText } from '@insula/api-contracts';
import type {
  DnsApexDriftDomain,
  DnsApexDriftReport,
  IngressServer,
  RouteDnsDomainResult,
} from '@insula/api-contracts';
import { loadIngressInventory } from './inventory.js';
import { applyDomainRouteDns, planDomainRouteDns } from './reconcile.js';

/**
 * Route DNS drift: detection and repair.
 *
 * Detection never writes DNS. It runs hourly and on demand ("Refresh" in the
 * modal, "Scan for drift" on the DNS page) and stores the report so the page,
 * the banner and the dashboard tile read it without re-scanning. Repair is
 * operator-invoked and runs the same per-domain reconcile as "Refresh route
 * DNS": missing ingress addresses are ADDED, stale ones REMOVED.
 */

/**
 * The report lives in `platform_settings`: a single latest-wins document that
 * must survive a restart and be the same for every API replica.
 */
const REPORT_KEY = 'dns_apex_drift_last_report';

export async function getLastReport(db: Database): Promise<DnsApexDriftReport | null> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, REPORT_KEY));
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<DnsApexDriftReport>;
    // A report stored by an older build has a different shape — treat it as
    // "not scanned yet" rather than rendering half a report.
    return parsed.version === 2 ? (parsed as DnsApexDriftReport) : null;
  } catch {
    return null;
  }
}

async function storeReport(db: Database, report: DnsApexDriftReport): Promise<void> {
  const value = JSON.stringify(report);
  await db.insert(platformSettings).values({ key: REPORT_KEY, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value } });
}

/** Primary-mode domains with at least one ingress route: the platform owns their route records. */
async function routeManagedDomains(db: Database): Promise<Array<{ id: string; domainName: string }>> {
  return db
    .select({ id: domains.id, domainName: domains.domainName })
    .from(domains)
    .where(and(
      eq(domains.dnsMode, 'primary'),
      exists(db.select({ one: ingressRoutes.id }).from(ingressRoutes).where(eq(ingressRoutes.domainId, domains.id))),
    ))
    .orderBy(domains.domainName);
}

export interface ScanOptions {
  readonly trigger: 'manual' | 'scheduled';
  readonly k8s: K8sClients | null;
}

/**
 * Read-only scan of every route-managed domain. Stores and returns the report.
 * An unreadable zone is recorded on that domain and the scan continues — one
 * unreachable provider must not hide drift everywhere else.
 */
export async function scanApexDrift(db: Database, opts: ScanOptions): Promise<DnsApexDriftReport> {
  const inventory = await loadIngressInventory(db, opts.k8s);
  const base = {
    version: 2 as const,
    scannedAt: new Date().toISOString(),
    trigger: opts.trigger,
    expected: inventory.expected,
    ingressSource: inventory.source,
    servers: inventory.servers,
  };

  if (inventory.expected.length === 0) {
    const report: DnsApexDriftReport = {
      ...base, domains: [], driftCount: 0, missingCount: 0, staleCount: 0, heldCount: 0, foreignCount: 0, errorCount: 0,
      scanError:
        'No ingress address is known — no operator override is set and no Ready, ingress-enabled server '
        + 'has a public address. Route DNS cannot be evaluated until at least one exists.',
    };
    await storeReport(db, report);
    return report;
  }

  const results: DnsApexDriftDomain[] = [];
  for (const d of await routeManagedDomains(db)) {
    try {
      results.push(await planDomainRouteDns(db, d, inventory));
    } catch (err) {
      results.push({
        domainId: d.id, domainName: d.domainName, hostnames: [],
        missingCount: 0, staleCount: 0, heldCount: 0, foreignCount: 0,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      });
    }
  }

  const report: DnsApexDriftReport = {
    ...base,
    servers: serversWorthShowing(inventory.servers, results),
    domains: results,
    driftCount: results.filter((r) => r.missingCount + r.staleCount > 0).length,
    missingCount: results.reduce((n, r) => n + r.missingCount, 0),
    staleCount: results.reduce((n, r) => n + r.staleCount, 0),
    heldCount: results.reduce((n, r) => n + r.heldCount, 0),
    foreignCount: results.reduce((n, r) => n + r.foreignCount, 0),
    errorCount: results.filter((r) => r.error !== null).length,
    scanError: null,
  };
  await storeReport(db, report);
  return report;
}

/**
 * Every current server, and a removed one only while a record still points at
 * it — the address history remembers servers forever, the report should not
 * list them forever.
 */
function serversWorthShowing(servers: readonly IngressServer[], results: readonly DnsApexDriftDomain[]): IngressServer[] {
  const referenced = new Set(results.flatMap((d) => d.hostnames.flatMap((h) => [...h.stale, ...h.held].flatMap((r) => r.servers))));
  return servers.filter((s) => s.status !== 'removed' || referenced.has(s.name));
}

// ─── Repair ──────────────────────────────────────────────────────────────────

export interface FixSelection {
  readonly domainIds?: readonly string[];
  readonly all?: boolean;
}

/**
 * Start a repair of the selected drifting domains. Returns at once with the
 * task id; progress and the per-domain change list arrive through the task.
 */
export async function startApexDriftFix(
  db: Database,
  userId: string,
  selection: FixSelection,
  k8s: K8sClients | null,
): Promise<{ taskId: string; domainCount: number }> {
  const report = await getLastReport(db);
  if (!report) {
    throw new ApiError('NO_DRIFT_REPORT', 'No drift scan has been run yet — run a scan before applying fixes.', 409, {
      operatorError: {
        code: 'NO_DRIFT_REPORT',
        title: 'Nothing to fix yet',
        detail: 'Route DNS drift is repaired from a scan result, and no scan has run.',
        remediation: ['Click “Refresh” to scan, then apply fixes from the report.'],
        retryable: true,
      },
    });
  }

  const drifting = report.domains.filter((d) => d.error === null && d.missingCount + d.staleCount > 0);
  const selected = selection.all
    ? drifting
    : drifting.filter((d) => (selection.domainIds ?? []).includes(d.domainId));
  if (selected.length === 0) {
    throw new ApiError('NO_DOMAINS_SELECTED', 'None of the selected domains drift in the latest report.', 400, {
      operatorError: {
        code: 'NO_DOMAINS_SELECTED',
        title: 'Nothing to apply',
        detail: 'The selected domains have no missing or stale records in the latest scan. The report may be stale.',
        remediation: ['Click “Refresh” to rescan, then select domains again.'],
        retryable: true,
      },
    });
  }

  const n = selected.length;
  const { id: taskId } = await tasks.start(db, {
    kind: 'dns.apex-drift-fix',
    scope: 'admin',
    userId,
    label: toSafeText(`Repair route DNS records (${n} domain${n === 1 ? '' : 's'})`),
    target: { type: 'modal', modal: 'dns-apex-drift-fix', modalProps: {} },
    progressPct: 0,
    progressText: toSafeText(`0 / ${n}`),
    details: { steps: selected.map((d) => ({ name: d.domainName, state: 'pending' as const })), results: [] },
  });

  // Fire-and-forget; the catch is mandatory (an unhandled rejection would
  // take the API down).
  void runFix(db, taskId, selected, k8s).catch(async (err) => {
    await tasks.finish(db, taskId, { status: 'failed', error: err instanceof Error ? err.message : String(err) })
      .catch(() => undefined);
  });

  return { taskId, domainCount: n };
}

function summarise(r: RouteDnsDomainResult): string {
  const parts: string[] = [];
  if (r.added.length) parts.push(`${r.added.length} added`);
  if (r.removed.length) parts.push(`${r.removed.length} removed`);
  if (r.failures.length) parts.push(`${r.failures.length} failed`);
  return parts.length ? parts.join(', ') : 'already in sync';
}

async function runFix(
  db: Database,
  taskId: string,
  selected: readonly DnsApexDriftDomain[],
  k8s: K8sClients | null,
): Promise<void> {
  const steps = selected.map((d) => ({
    name: d.domainName,
    state: 'pending' as 'pending' | 'running' | 'done' | 'failed',
    note: undefined as string | undefined,
  }));
  const results: RouteDnsDomainResult[] = [];

  // Re-plan every domain against the inventory NOW, not the stored report:
  // the report can be an hour old, and a repair must act on today's servers.
  const inventory = await loadIngressInventory(db, k8s);

  for (let i = 0; i < selected.length; i += 1) {
    const d = selected[i];
    steps[i].state = 'running';
    await tasks.progress(db, taskId, {
      pct: Math.round((i / selected.length) * 100),
      text: toSafeText(`${i} / ${selected.length} — ${d.domainName}`),
      detailsPatch: { steps, results },
    });
    try {
      const plan = await planDomainRouteDns(db, { id: d.domainId, domainName: d.domainName }, inventory);
      const result = await applyDomainRouteDns(db, { id: d.domainId, domainName: d.domainName }, plan, inventory);
      results.push(result);
      steps[i].state = result.failures.length > 0 ? 'failed' : 'done';
      steps[i].note = summarise(result);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ domainId: d.domainId, domainName: d.domainName, added: [], removed: [], failures: [{ hostname: d.domainName, detail }] });
      steps[i].state = 'failed';
      steps[i].note = detail.slice(0, 200);
    }
  }

  const added = results.reduce((n, r) => n + r.added.length, 0);
  const removed = results.reduce((n, r) => n + r.removed.length, 0);
  const failed = results.filter((r) => r.failures.length > 0).length;

  await tasks.progress(db, taskId, {
    pct: 100,
    text: toSafeText(`${selected.length} / ${selected.length}`),
    detailsPatch: { steps, results },
  });

  // Refresh the stored report so the page, banner and tile reflect the repair
  // at once instead of after the next scheduled scan.
  await scanApexDrift(db, { trigger: 'manual', k8s }).catch(() => undefined);

  await tasks.finish(db, taskId, {
    status: failed > 0 ? 'failed' : 'succeeded',
    error: failed > 0 ? `${failed} of ${selected.length} domain(s) could not be fully repaired — see the per-domain detail.` : null,
    text: toSafeText(`${added} record${added === 1 ? '' : 's'} added, ${removed} removed across ${selected.length} domain${selected.length === 1 ? '' : 's'}`),
    detailsPatch: { steps, results, added, removed, failed },
  });
}
