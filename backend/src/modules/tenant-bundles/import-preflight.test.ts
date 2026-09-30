import { describe, it, expect } from 'vitest';

import {
  deriveImportUnits,
  computeStageSizeLimit,
  toK8sQuantity,
  buildImportPreflight,
  STAGE_FLOOR_BYTES,
  STAGE_CEILING_BYTES,
} from './import-preflight.js';

const GiB = 1024 ** 3;

const META_FULL = {
  backupId: 'bkp-src',
  tenantId: 't-src',
  components: {
    files: { sizeBytes: 5 * GiB },
    mailboxes: { sizeBytes: 3 * GiB, addresses: ['a@example.test', 'b@example.test'] },
    config: { sizeBytes: 2048 },
    secrets: { sizeBytes: 512 },
  },
};

/** db stub: domain rows for the ownership join, tenant row + plan for limits. */
function stubDb(opts: {
  ownedDomains?: string[];
  tenantId?: string;
  storageLimitGi?: number | null;
  tenantMissing?: boolean;
}) {
  const tenantId = opts.tenantId ?? 't-target';
  const domainRows = (opts.ownedDomains ?? []).map((d) => ({
    domainName: d, domainTenantId: tenantId, emailTenantId: tenantId,
  }));
  let call = 0;
  return {
    select: () => ({
      from: (_t: unknown) => {
        call += 1;
        // 1st select → the ownership join; 2nd → the tenant row; 3rd → plan.
        const chain: Record<string, unknown> = {
          innerJoin: () => chain,
          where: () => chain,
          limit: () => Promise.resolve(
            call === 2
              ? (opts.tenantMissing ? [] : [{ id: tenantId, planId: null, storageLimitOverride: opts.storageLimitGi ?? null }])
              : [],
          ),
          then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
            Promise.resolve(call === 1 ? domainRows : []).then(res, rej),
        };
        return chain;
      },
    }),
  } as never;
}

describe('toK8sQuantity', () => {
  it('rounds up and never returns zero', () => {
    expect(toK8sQuantity(0)).toBe('1Mi');
    expect(toK8sQuantity(1)).toBe('1Mi');
    expect(toK8sQuantity(1536 * 1024)).toBe('2Mi');
    expect(toK8sQuantity(GiB)).toBe('1Gi');
    expect(toK8sQuantity(GiB + 1)).toBe('2Gi');
  });
});

describe('computeStageSizeLimit', () => {
  it('applies head-room above the declared total', () => {
    expect(computeStageSizeLimit(8 * GiB)).toBe('10Gi');
  });

  it('never goes below the floor, however small the bundle', () => {
    expect(computeStageSizeLimit(0)).toBe(toK8sQuantity(STAGE_FLOOR_BYTES));
    expect(computeStageSizeLimit(1024)).toBe(toK8sQuantity(STAGE_FLOOR_BYTES));
  });

  it('clamps a manifest that declares an absurd size', () => {
    // The number comes from an uploaded file. Without the ceiling the platform
    // would ask Kubernetes for a 4 TB emptyDir on a manifest's say-so.
    expect(computeStageSizeLimit(4 * 1024 * GiB)).toBe(toK8sQuantity(STAGE_CEILING_BYTES));
  });

  it('ignores a negative or non-numeric declared size rather than underflowing', () => {
    expect(computeStageSizeLimit(-5 as unknown as number)).toBe(toK8sQuantity(STAGE_FLOOR_BYTES));
    expect(computeStageSizeLimit(NaN)).toBe(toK8sQuantity(STAGE_FLOOR_BYTES));
  });
});

describe('deriveImportUnits', () => {
  it('names units exactly as the export writes them', () => {
    // If the two sides disagree the import silently carries nothing, so both
    // state the names rather than inferring them.
    const { units } = deriveImportUnits(META_FULL, 'admin');
    expect(units).toEqual([
      { component: 'files', name: 'archive', sizeBytes: 5 * GiB },
      { component: 'mailboxes', name: 'a@example.test', sizeBytes: 0 },
      { component: 'mailboxes', name: 'b@example.test', sizeBytes: 0 },
    ]);
  });

  it('admin keeps config and secrets as object artifacts', () => {
    const { objectArtifacts, dropped } = deriveImportUnits(META_FULL, 'admin');
    expect(objectArtifacts.map((a) => a.component)).toEqual(['config', 'secrets']);
    expect(dropped).toEqual([]);
  });

  it('tenant drops config and secrets, with a stated reason each', () => {
    // Never silently: a tenant must be able to see that their import will not
    // carry those, and why.
    const { objectArtifacts, dropped } = deriveImportUnits(META_FULL, 'tenant');
    expect(objectArtifacts).toEqual([]);
    expect(dropped.map((d) => d.component)).toEqual(['config', 'secrets']);
    expect(dropped.every((d) => d.reason.length > 20)).toBe(true);
    expect(dropped.find((d) => d.component === 'secrets')!.reason).toMatch(/TLS private keys/);
  });

  it('handles the pre-ADR-061 whole-tenant mailbox format and says so', () => {
    const { units, warnings } = deriveImportUnits({
      components: { mailboxes: { sizeBytes: 100, sha256: 'a'.repeat(64) } },
    }, 'admin');
    expect(units).toEqual([{ component: 'mailboxes', name: 'maildir.tar', sizeBytes: 100 }]);
    expect(warnings.join(' ')).toMatch(/older whole-tenant mailbox format/);
  });

  it('produces no units for a manifest with no components', () => {
    expect(deriveImportUnits({}, 'admin').units).toEqual([]);
    expect(deriveImportUnits({ components: {} }, 'tenant').units).toEqual([]);
  });

  it('refuses a hostile address in the manifest rather than building a Job for it', () => {
    // The addresses come from an uploaded archive and end up on a shell command
    // line inside a pod with the tenant's file space mounted.
    expect(() => deriveImportUnits({
      components: { mailboxes: { addresses: ["a';id;'@x.test"] } },
    }, 'admin')).toThrow(/unexpected characters/);
    expect(() => deriveImportUnits({
      components: { mailboxes: { addresses: ['../../etc/passwd'] } },
    }, 'admin')).toThrow();
  });
});

describe('buildImportPreflight', () => {
  it('passes when domains are owned and the bundle fits', async () => {
    const pre = await buildImportPreflight({
      db: stubDb({ ownedDomains: ['example.test'], storageLimitGi: 50 }),
      meta: META_FULL, targetTenantId: 't-target', scope: 'admin',
    });
    expect(pre.blocked).toBe(false);
    expect(pre.units).toHaveLength(3);
    expect(pre.sourceBundleId).toBe('bkp-src');
    expect(pre.totalBytes).toBe(5 * GiB + 3 * GiB + 2048 + 512);
    // 8 GiB + 2,560 bytes of config/secrets, x1.25 head-room, rounded UP to a
    // whole Gi. Rounding up is deliberate: a stage one byte short evicts the Job.
    expect(pre.stageSizeLimit).toBe('11Gi');
  });

  it('BLOCKS when a mailbox domain is not owned by the target tenant', async () => {
    // Capture bounded this by accident; an upload does not.
    const pre = await buildImportPreflight({
      db: stubDb({ ownedDomains: [], storageLimitGi: 50 }),
      meta: META_FULL, targetTenantId: 't-target', scope: 'admin',
    });
    expect(pre.blocked).toBe(true);
    expect(pre.mailboxDomains.ok).toBe(false);
    expect(pre.blockReasons.join(' ')).toMatch(/does not own/);
  });

  it('BLOCKS when the bundle exceeds the tenant storage allowance', async () => {
    const pre = await buildImportPreflight({
      db: stubDb({ ownedDomains: ['example.test'], storageLimitGi: 1 }),
      meta: META_FULL, targetTenantId: 't-target', scope: 'admin',
    });
    expect(pre.blocked).toBe(true);
    expect(pre.quota.fits).toBe(false);
    expect(pre.blockReasons.join(' ')).toMatch(/storage allowance/);
  });

  it('BLOCKS an archive that carries nothing importable', async () => {
    const pre = await buildImportPreflight({
      db: stubDb({ ownedDomains: [], storageLimitGi: 50 }),
      meta: { components: { config: { sizeBytes: 10 } } }, targetTenantId: 't-target', scope: 'tenant',
    });
    expect(pre.blocked).toBe(true);
    expect(pre.blockReasons.join(' ')).toMatch(/no files or mailboxes/);
  });

  it('warns rather than blocking when the storage limit cannot be read', async () => {
    // A limits lookup failure must not stop an import; it makes headroom
    // unknown, which is reported instead of assumed fine.
    const pre = await buildImportPreflight({
      db: stubDb({ ownedDomains: ['example.test'], tenantMissing: true }),
      meta: META_FULL, targetTenantId: 't-target', scope: 'admin',
    });
    expect(pre.warnings.join(' ')).toMatch(/Could not read/);
    expect(pre.blockReasons.join(' ')).not.toMatch(/storage allowance/);
  });

  it('surfaces the dropped components as a warning on the tenant path', async () => {
    const pre = await buildImportPreflight({
      db: stubDb({ ownedDomains: ['example.test'], storageLimitGi: 50 }),
      meta: META_FULL, targetTenantId: 't-target', scope: 'tenant',
    });
    expect(pre.blocked).toBe(false);
    expect(pre.warnings.join(' ')).toMatch(/will not be imported: config, secrets/);
  });

  it('a bundle with no mailbox addresses needs no domain check and is not blocked by it', async () => {
    const pre = await buildImportPreflight({
      db: stubDb({ ownedDomains: [], storageLimitGi: 50 }),
      meta: { components: { files: { sizeBytes: 1024 } } }, targetTenantId: 't-target', scope: 'tenant',
    });
    expect(pre.mailboxDomains.ok).toBe(true);
    expect(pre.blocked).toBe(false);
  });
});
