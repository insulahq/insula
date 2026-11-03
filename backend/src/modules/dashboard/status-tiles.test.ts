import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The status tiles' figures, and the names behind every figure that can turn
 * amber or red. The Updates tile and the Scheduled tasks "Overdue" cell were
 * constants, and the Mail queue was "0, reachable" whatever Stalwart said.
 */

const overview = vi.fn();
vi.mock('../deployments/upgrade-version.js', () => ({ getAdminUpgradesOverview: (...a: unknown[]) => overview(...a) }));

const {
  buildCertificatesTile, buildScheduledTasksTile, buildTenantsTile, buildUpdatesTile, readMailQueue,
  resetUpgradeOverviewCache, resetMailQueueFailure,
} = await import('./status-tiles.js');
const { buildTenantSummary } = await import('./tenant-service.js');

type Db = Parameters<typeof buildCertificatesTile>[0];
const render = (q: unknown): string => JSON.stringify(q);
const dbAnswering = (answers: Array<[string, unknown[]]>, seen: string[] = []): Db => ({
  execute: async (q: unknown) => {
    const text = render(q);
    seen.push(text);
    const hit = answers.find(([frag]) => text.includes(frag));
    return { rows: hit ? hit[1] : [] };
  },
}) as unknown as Db;

beforeEach(() => {
  overview.mockReset(); overview.mockResolvedValue([]);
  resetUpgradeOverviewCache(); resetMailQueueFailure();
});

describe('Certificates tile', () => {
  it('names the overdue and failing certificates, and counts only live domains', async () => {
    const seen: string[] = [];
    const tile = await buildCertificatesTile(dbAnswering([
      ['AS issued', [{ issued: 4, wildcards: 2, nearest_days: 3, failing: 1, overdue: 1, attention: 2 }]],
      ['s.last_error IS NOT NULL OR', [
        { name: '*.example.test', tenant: 'Example Tenant', days: 3, last_error: null, overdue: true },
        { name: 'shop.example.test', tenant: null, days: 40, last_error: 'DNS-01 challenge failed', overdue: false },
      ]],
    ], seen));
    expect(tile).toMatchObject({ overdue: 1, failing: 1, needsAttention: 2 });
    expect(tile.attention).toEqual([
      { name: '*.example.test', detail: 'renewal overdue · 3 days left · Example Tenant' },
      { name: 'shop.example.test', detail: 'renewal failing: DNS-01 challenge failed' },
    ]);
    for (const q of seen) {
      expect(q).toContain('JOIN domains d ON d.id = s.domain_id');
      expect(q).not.toContain('LEFT JOIN domains');
    }
  });
});

describe('Updates tile', () => {
  const settings = (installed: string | null, available: string | null) => [
    ...(installed ? [{ key: 'installed_platform_version', value: installed }] : []),
    ...(available ? [{ key: 'available_version', value: available }] : []),
  ];

  it('is behind when a newer verified release is available, and names it', async () => {
    const tile = await buildUpdatesTile(dbAnswering([['FROM platform_settings', settings('2026.11.3', '2026.11.4')]]));
    expect(tile).toMatchObject({ platformCurrent: false, platformInstalled: '2026.11.3', platformAvailable: '2026.11.4' });
  });

  it('is current when nothing newer is available, or nothing is known', async () => {
    expect((await buildUpdatesTile(dbAnswering([['FROM platform_settings', settings('2026.11.4', '2026.11.4')]]))).platformCurrent).toBe(true);
    expect((await buildUpdatesTile(dbAnswering([]))).platformCurrent).toBe(true);
  });

  it('reads the upgrade graph at most every five minutes', async () => {
    await buildUpdatesTile(dbAnswering([]));
    await buildUpdatesTile(dbAnswering([]));
    expect(overview).toHaveBeenCalledTimes(1);
  });

  it('counts and names the deployments with an upgrade, from the upgrade graph', async () => {
    overview.mockResolvedValue([{
      name: 'WordPress',
      deployments: [
        { tenantCompanyName: 'Example Tenant', name: 'blog', installedVersion: '6.4', latestReachable: '6.5', availableUpgradeCount: 1 },
        { tenantCompanyName: 'Other', name: 'site', installedVersion: '6.5', latestReachable: null, availableUpgradeCount: 0 },
      ],
    }]);
    const tile = await buildUpdatesTile(dbAnswering([]));
    expect(tile.deploymentsBehind).toBe(1);
    expect(tile.behind).toEqual([{ name: 'Example Tenant · blog', detail: 'WordPress 6.4 → 6.5' }]);
  });

  it('names the deployments past end-of-life', async () => {
    const seen: string[] = [];
    const tile = await buildUpdatesTile(dbAnswering([['catalog_entry_versions', [
      { total: 1, name: 'db', tenant: 'Example Tenant', app: 'MariaDB', version: '10.5', eol_date: '2025-06-24' },
    ]]], seen));
    expect(tile.eolRuntimes).toBe(1);
    expect(tile.eol).toEqual([{ name: 'Example Tenant · db', detail: 'MariaDB 10.5 · end of life 2025-06-24' }]);
    expect(seen.find((q) => q.includes('catalog_entry_versions'))).toContain("to_char(CURRENT_DATE, 'YYYY-MM-DD')");
  });
});

describe('Scheduled tasks tile', () => {
  it('names the failed and the never-run jobs', async () => {
    const tile = await buildScheduledTasksTile(dbAnswering([
      ['AS never_run', [{ total: 5, enabled: 4, failed24h: 1, never_run: 1 }]],
      ['j.last_run_response_code AS code', [{ name: 'nightly-import', tenant: 'Example Tenant', minutes: 90, code: 500 }]],
      ['j.schedule', [{ name: 'weekly-report', tenant: null, schedule: '0 6 * * 1' }]],
    ]));
    expect(tile).toMatchObject({ failed24h: 1, neverRun: 1 });
    expect(tile.failed).toEqual([{ name: 'Example Tenant · nightly-import', detail: 'failed 1 h ago · HTTP 500' }]);
    expect(tile.neverRunJobs).toEqual([{ name: 'weekly-report', detail: 'schedule 0 6 * * 1' }]);
    // Deprecated, kept at 0 for the previous admin panel build only.
    expect(tile.overdue).toBe(0);
  });
});

describe('Tenants tile', () => {
  it('names the tenants being provisioned', async () => {
    const tile = await buildTenantsTile(dbAnswering([
      ['AS provisioning', [{ active: 3, total: 4, routes: 5, domains: 6, provisioning: 1 }]],
      ['FROM provisioning_tasks p', [{ tenant: 'New Tenant', type: 'create', status: 'running', step: 'namespace', minutes: 4 }]],
    ]));
    expect(tile.provisioning).toEqual([{ name: 'New Tenant', detail: 'create · namespace · 4 min' }]);
  });
});

describe('Mail queue', () => {
  it('reports the depth the mail server gives', async () => {
    expect(await readMailQueue(async () => 7)).toEqual({ depth: 7, reachable: true });
  });

  it('reads a failure as unreachable, not as an empty queue', async () => {
    expect(await readMailQueue(async () => { throw new Error('ECONNREFUSED'); })).toEqual({ depth: 0, reachable: false });
  });

  it('reads a slow answer as unreachable', async () => {
    expect(await readMailQueue(() => new Promise<number>(() => undefined), 20)).toEqual({ depth: 0, reachable: false });
  });

  it('does not ask a mail server that just failed again for a minute', async () => {
    const t0 = 1_000_000;
    await readMailQueue(async () => { throw new Error('down'); }, 3_000, t0);
    const count = vi.fn(async () => 5);
    expect(await readMailQueue(count, 3_000, t0 + 30_000)).toEqual({ depth: 0, reachable: false });
    expect(count).not.toHaveBeenCalled();
    expect(await readMailQueue(count, 3_000, t0 + 61_000)).toEqual({ depth: 5, reachable: true });
  });
});

describe('tenant Domains & certificates tile', () => {
  it('counts verified domains by the state they reach, and certificates of live domains only', async () => {
    const seen: string[] = [];
    await buildTenantSummary(dbAnswering([], seen) as never, 'ten_1');
    const q = seen.find((s) => s.includes('AS verified'))!;
    expect(q).toContain("status::text = 'verified'");
    expect(q).not.toContain("status::text = 'active'");
    expect(q).not.toContain('LEFT JOIN domains cd');
    expect(q).toContain('JOIN domains cd ON cd.id = c.domain_id');
  });
});
