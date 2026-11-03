import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Every warning tile names what it counts.
 *
 * Production's console showed "2 certificates expiring" with a hover card of
 * "Renewal overdue 2 · Soonest 14 days" — and the two were certificate rows of
 * domains deleted months before, invisible everywhere else. The monitoring,
 * DNS-drift, orphaned-pod and CPU tiles had the same gap: a count, no subject.
 */

const getLastReport = vi.fn();
vi.mock('../dns-apex-drift/service.js', () => ({ getLastReport: (...a: unknown[]) => getLastReport(...a) }));

const { buildAdminAlerts, buildDnsDriftAlert, sloSubject } = await import('./alerts.js');
const { buildOrphanedPodAlert } = await import('./cluster-alerts.js');
const { buildCpuReservationAlert } = await import('./cpu-reservation.js');
const { moreRow, daysLeft, forHowLong } = await import('./subjects.js');
const { ruleById } = await import('../monitoring/rules.js');

type Db = Parameters<typeof buildAdminAlerts>[0];
const render = (q: unknown): string => JSON.stringify(q);
/** A db whose execute answers the first matching SQL fragment. */
const dbAnswering = (answers: Array<[string, unknown[]]>, seen: string[] = []): Db => ({
  execute: async (q: unknown) => {
    const text = render(q);
    seen.push(text);
    const hit = answers.find(([frag]) => text.includes(frag));
    return { rows: hit ? hit[1] : [] };
  },
}) as unknown as Db;

beforeEach(() => { getLastReport.mockReset(); getLastReport.mockResolvedValue(null); });

describe('Certificates expiring', () => {
  const cert = (o: Record<string, unknown>) => ({
    total: 2, name: '*.example.test', tenant_name: 'Example Tenant', days: 14,
    domain_id: 'd-1', tenant_id: 't-1', ...o,
  });

  it('names each certificate with its own expiry and tenant, soonest first', async () => {
    const db = dbAnswering([['FROM ssl_certificates', [
      cert({}),
      cert({ name: 'shop.example.test', tenant_name: 'Shop Tenant', days: 15, domain_id: 'd-2', tenant_id: 't-2' }),
    ]]]);
    const tile = (await buildAdminAlerts(db)).find((a) => a.categoryId === 'admin.cert_expiring');
    expect(tile).toMatchObject({
      value: '2',
      title: 'Certificates expiring',
      // The subtitle pairs the soonest certificate with ITS days — it paired
      // the alphabetically first domain with the soonest days of any.
      subtitle: '*.example.test · 14 days left · 1 more',
      href: '/tenants/domains',
      detail: [
        ['*.example.test', '14 days left · Example Tenant'],
        ['shop.example.test', '15 days left · Shop Tenant'],
      ],
    });
  });

  it('only counts certificates whose domain still exists', async () => {
    const seen: string[] = [];
    await buildAdminAlerts(dbAnswering([], seen));
    const q = seen.find((s) => s.includes('FROM ssl_certificates'))!;
    expect(q).toContain('JOIN domains d ON d.id = c.domain_id');
    expect(q).not.toContain('LEFT JOIN domains');
  });

  it('says how many it leaves out, and words an expired one as expired', async () => {
    const rows = [cert({ total: 7, days: -2 }), ...[1, 2, 3, 4].map((i) => cert({ total: 7, name: `c${i}.example.test`, days: i }))];
    const tile = (await buildAdminAlerts(dbAnswering([['FROM ssl_certificates', rows]]))).find((a) => a.categoryId === 'admin.cert_expiring')!;
    expect(tile.severity).toBe('critical');
    expect(tile.detail[0]).toEqual(['*.example.test', 'expired 2 days ago · Example Tenant']);
    expect(tile.detail.at(-1)).toEqual(['More', '2 not shown']);
  });

  it('one certificate links straight to its domain', async () => {
    const tile = (await buildAdminAlerts(dbAnswering([['FROM ssl_certificates', [cert({ total: 1 })]]])))
      .find((a) => a.categoryId === 'admin.cert_expiring')!;
    expect(tile.href).toBe('/tenants/t-1/domains/d-1');
    expect(tile.subtitle).toBe('*.example.test · 14 days left');
  });
});

describe('Monitoring rules firing', () => {
  it('names each firing rule and the series it fires on', async () => {
    const oom = ruleById('node-kernel-oom')!;
    const db = dbAnswering([['FROM alert_state', [
      { severity: 'warning', total: 2, rule_id: 'node-kernel-oom', subject_labels: { node: 'n1' }, minutes: 12 },
      { severity: 'warning', total: 2, rule_id: 'not-a-rule', subject_labels: {}, minutes: 200 },
    ]]]);
    const tile = (await buildAdminAlerts(db)).find((a) => a.categoryId === 'admin.slo_alert_warning')!;
    expect(tile.value).toBe('2');
    expect(tile.subtitle).toBe(`${oom.name} · node=n1 · 1 more`);
    expect(tile.detail).toEqual([
      [oom.name, 'node=n1 · firing 12 min'],
      ['not-a-rule', 'firing 3 h'],
    ]);
  });

  it('one tile per severity', async () => {
    const db = dbAnswering([['FROM alert_state', [
      { severity: 'critical', total: 1, rule_id: 'node-kernel-oom', subject_labels: { node: 'n1' }, minutes: 1 },
      { severity: 'warning', total: 1, rule_id: 'node-kernel-oom', subject_labels: { node: 'n2' }, minutes: 1 },
    ]]]);
    const alerts = await buildAdminAlerts(db);
    expect(alerts.filter((a) => a.categoryId.startsWith('admin.slo_alert_')).map((a) => a.categoryId).sort())
      .toEqual(['admin.slo_alert_critical', 'admin.slo_alert_warning']);
  });

  it('names the synthetic unreachable rule in words', () => {
    expect(sloSubject('monitoring-unreachable', {})).toEqual({ rule: 'Monitoring unreachable', subject: null });
  });
});

describe('Apex DNS drift', () => {
  it('names the drifting domains, not only the record counts', async () => {
    getLastReport.mockResolvedValue({
      scanError: null, driftCount: 2, errorCount: 1, missingCount: 3, staleCount: 1,
      domains: [
        { domainName: 'a.example.test', missingCount: 2, staleCount: 0, error: null },
        { domainName: 'fine.example.test', missingCount: 0, staleCount: 0, error: null },
        { domainName: 'b.example.test', missingCount: 1, staleCount: 1, error: null },
        { domainName: 'c.example.test', missingCount: 0, staleCount: 0, error: 'SERVFAIL' },
      ],
    });
    const tile = (await buildDnsDriftAlert({} as Db))!;
    expect(tile.detail).toEqual([
      ['a.example.test', '2 to add · 0 to remove'],
      ['b.example.test', '1 to add · 1 to remove'],
      ['c.example.test', 'could not be checked: SERVFAIL'],
    ]);
  });
});

describe('capped lists say what they leave out', () => {
  it('workloads down: five named, the rest counted', async () => {
    const row = (i: number) => ({
      total: 8, tenant_id: `t-${i}`, tenant_name: `Tenant ${i}`, workload: 'web', reason: 'crashloop',
      down_minutes: 30, heal_attempts: 0, healed: 0, heal_failed: 0,
    });
    const db = dbAnswering([['tenant_workload_health_events', [1, 2, 3, 4, 5].map(row)]]);
    const tile = (await buildAdminAlerts(db)).find((a) => a.categoryId === 'admin.tenant_workloads_down')!;
    expect(tile.detail).toHaveLength(6);
    expect(tile.detail.at(-1)).toEqual(['More', '3 not shown']);
  });

  it('a list shown in full has no closing row', () => {
    expect(moreRow(3, 3)).toEqual([]);
    expect(moreRow(4, 3)).toEqual([['More', '1 not shown']]);
  });
});

describe('Orphaned pods', () => {
  it('names the pods, with their node', async () => {
    const pod = (ns: string, name: string, node: string) => ({
      metadata: { namespace: ns, name, labels: {}, ownerReferences: [{ controller: true }] },
      spec: { nodeName: node },
      status: { phase: 'Failed', containerStatuses: [] },
    });
    const k8s = { core: { listPodForAllNamespaces: async () => ({ items: [
      pod('platform', 'migrate-1', 'n2'), pod('platform', 'backup-9', 'n1'), pod('platform', 'migrate-2', 'n2'),
    ] }) } } as unknown as Parameters<typeof buildOrphanedPodAlert>[0];
    const tile = (await buildOrphanedPodAlert(k8s))!;
    expect(tile.value).toBe('3');
    expect(tile.subtitle).toBe('across 2 nodes · worst n2');
    expect(tile.detail).toEqual([
      ['platform/backup-9', 'n1'],
      ['platform/migrate-1', 'n2'],
      ['platform/migrate-2', 'n2'],
    ]);
  });
});

describe('CPU reserved but not used', () => {
  it('names every node with the gap, not only the worst', () => {
    const node = (name: string, requestedMillis: number) => ({ name, allocatableMillis: 7500, requestedMillis, usedMillis: 500 });
    const a = buildCpuReservationAlert([node('quiet', 6500), node('worst', 7450)], [])!;
    expect(a.subtitle).toMatch(/^worst /);
    expect(a.detail).toContainEqual(['quiet', '87% reserved, 7% in use']);
  });
});

describe('subject wording', () => {
  it('days and ages read as the sentence does', () => {
    expect(daysLeft(0)).toBe('expires today');
    expect(daysLeft(1)).toBe('1 day left');
    expect(daysLeft(-1)).toBe('expired 1 day ago');
    expect(forHowLong(59)).toBe('59 min');
    expect(forHowLong(60)).toBe('1 h');
    expect(forHowLong(48 * 60)).toBe('2 d');
  });
});
