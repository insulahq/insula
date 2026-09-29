import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryInstant = vi.fn();
vi.mock('../monitoring/vm-client.js', () => ({ queryInstant: (q: string) => queryInstant(q) }));

const { platformBackupBytesByNamespace, jobNameFromPod, filesJobName, mailboxJobName } =
  await import('./backup-exclusion.js');

const TENANT_A = { tenantId: 'ta', namespace: 'tenant-alpha-1111' };
const TENANT_B = { tenantId: 'tb', namespace: 'tenant-beta-2222' };
const JOB_A = 'bkp-11111111-2222-3333-4444-555555555555';
const JOB_B = 'bkp-99999999-8888-7777-6666-555555555555';

/** Minimal Database stand-in: the module issues exactly one select. */
function dbReturning(rows: Array<{ id: string; tenantId: string; initiator: string }>) {
  return { select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }) } as never;
}
const sample = (namespace: string, pod: string, value: number) => ({ labels: { namespace, pod }, value });

beforeEach(() => { queryInstant.mockReset(); });

describe('jobNameFromPod', () => {
  it('strips the Job pod suffix', () => {
    expect(jobNameFromPod(`${filesJobName(JOB_A)}-x7k2p`)).toBe(filesJobName(JOB_A));
  });
  it('leaves a Deployment pod resolving to its ReplicaSet segment, not the Job name', () => {
    // A tenant deployment called `bk-files-<id>` yields TWO suffixes; stripping
    // one cannot produce the Job name, which is what keeps it billable.
    const deploymentPod = `${filesJobName(JOB_A)}-7f8b79576f-9lrtv`;
    expect(jobNameFromPod(deploymentPod)).not.toBe(filesJobName(JOB_A));
  });
  it('returns null when there is no suffix at all', () => {
    expect(jobNameFromPod('standalone')).toBeNull();
  });
});

describe('platformBackupBytesByNamespace', () => {
  it('excludes a system-initiated backup running in its own tenant namespace', async () => {
    queryInstant.mockResolvedValue([sample(TENANT_A.namespace, `${filesJobName(JOB_A)}-x7k2p`, 17_400_000_000)]);
    const out = await platformBackupBytesByNamespace(
      dbReturning([{ id: JOB_A, tenantId: 'ta', initiator: 'system' }]), [TENANT_A], 3600, new Date(),
    );
    expect(out.get(TENANT_A.namespace)).toBe(17_400_000_000);
  });

  it('does NOT exclude a backup the tenant asked for', async () => {
    // The DB filter is `initiator <> 'tenant'`, so a tenant-initiated job is
    // never a candidate — modelled here by it not coming back from the query.
    queryInstant.mockResolvedValue([sample(TENANT_A.namespace, `${filesJobName(JOB_A)}-x7k2p`, 5_000_000_000)]);
    const out = await platformBackupBytesByNamespace(dbReturning([]), [TENANT_A], 3600, new Date());
    expect(out.size).toBe(0);
  });

  it('does NOT exclude a pod whose job id is unknown', async () => {
    queryInstant.mockResolvedValue([sample(TENANT_A.namespace, 'bk-files-not-a-real-id-x7k2p', 9_000_000_000)]);
    const out = await platformBackupBytesByNamespace(
      dbReturning([{ id: JOB_A, tenantId: 'ta', initiator: 'system' }]), [TENANT_A], 3600, new Date(),
    );
    expect(out.size).toBe(0);
  });

  it('does NOT let one tenant claim another tenant’s backup id', async () => {
    // Tenant B names a workload after tenant A's real, platform-initiated
    // backup. The namespace does not match the job's owner, so it is billed.
    queryInstant.mockResolvedValue([sample(TENANT_B.namespace, `${filesJobName(JOB_A)}-x7k2p`, 8_000_000_000)]);
    const out = await platformBackupBytesByNamespace(
      dbReturning([{ id: JOB_A, tenantId: 'ta', initiator: 'system' }]), [TENANT_A, TENANT_B], 3600, new Date(),
    );
    expect(out.size).toBe(0);
  });

  it('does NOT exclude a Deployment-shaped pod named after a real backup job', async () => {
    queryInstant.mockResolvedValue([
      sample(TENANT_A.namespace, `${filesJobName(JOB_A)}-7f8b79576f-9lrtv`, 12_000_000_000),
    ]);
    const out = await platformBackupBytesByNamespace(
      dbReturning([{ id: JOB_A, tenantId: 'ta', initiator: 'system' }]), [TENANT_A], 3600, new Date(),
    );
    expect(out.size).toBe(0);
  });

  it('sums several backup pods in one namespace and keeps namespaces apart', async () => {
    queryInstant.mockResolvedValue([
      sample(TENANT_A.namespace, `${filesJobName(JOB_A)}-x7k2p`, 1_000),
      sample(TENANT_A.namespace, `${filesJobName(JOB_A)}-q4m8z`, 2_000),
      sample(TENANT_B.namespace, `${filesJobName(JOB_B)}-b2n6c`, 7_000),
    ]);
    const out = await platformBackupBytesByNamespace(
      dbReturning([
        { id: JOB_A, tenantId: 'ta', initiator: 'system' },
        { id: JOB_B, tenantId: 'tb', initiator: 'admin' },
      ]), [TENANT_A, TENANT_B], 3600, new Date(),
    );
    expect(out.get(TENANT_A.namespace)).toBe(3_000);
    expect(out.get(TENANT_B.namespace)).toBe(7_000);
  });

  it('ignores the mailbox Job, which runs in the mail namespace', async () => {
    queryInstant.mockResolvedValue([sample('mail', `bk-mbox-${JOB_A}-x7k2p`, 40_000_000)]);
    const out = await platformBackupBytesByNamespace(
      dbReturning([{ id: JOB_A, tenantId: 'ta', initiator: 'system' }]), [TENANT_A], 3600, new Date(),
    );
    expect(out.has('mail')).toBe(false);
  });

  it('skips the metrics query entirely when no candidate backups exist', async () => {
    const out = await platformBackupBytesByNamespace(dbReturning([]), [TENANT_A], 3600, new Date());
    expect(queryInstant).not.toHaveBeenCalled();
    expect(out.size).toBe(0);
  });

  it('propagates a metrics failure so the caller can skip the tick', async () => {
    queryInstant.mockRejectedValue(new Error('vmsingle down'));
    await expect(platformBackupBytesByNamespace(
      dbReturning([{ id: JOB_A, tenantId: 'ta', initiator: 'system' }]), [TENANT_A], 3600, new Date(),
    )).rejects.toThrow('vmsingle down');
  });
});

describe('Job-name collisions', () => {
  it('excludes nothing on a name two tenants could both claim, in EITHER row order', async () => {
    // `backup_jobs.id` is varchar(64): two long ids truncate to one 63-char
    // Job name. If their tenants differ the name identifies nobody, so it
    // must not authorise an exclusion in either namespace.
    //
    // Both orderings are exercised on purpose. The query has no ORDER BY, so a
    // last-write-wins map would pass one ordering and silently exclude the
    // WRONG tenant's real traffic on the other.
    const longA = `${'a'.repeat(60)}-one`;
    const longB = `${'a'.repeat(60)}-two`;
    expect(filesJobName(longA)).toBe(filesJobName(longB)); // the collision is real
    const rows = [
      { id: longA, tenantId: 'ta', initiator: 'system' },
      { id: longB, tenantId: 'tb', initiator: 'system' },
    ];
    for (const ordered of [rows, [...rows].reverse()]) {
      for (const ns of [TENANT_A.namespace, TENANT_B.namespace]) {
        queryInstant.mockResolvedValue([sample(ns, `${filesJobName(longA)}-x7k2p`, 4_000)]);
        const out = await platformBackupBytesByNamespace(
          dbReturning(ordered), [TENANT_A, TENANT_B], 3600, new Date(),
        );
        expect(out.size).toBe(0);
      }
    }
  });

  it('still excludes when the colliding ids belong to the same tenant', async () => {
    const longA = `${'a'.repeat(60)}-one`;
    const longB = `${'a'.repeat(60)}-two`;
    queryInstant.mockResolvedValue([sample(TENANT_A.namespace, `${filesJobName(longA)}-x7k2p`, 4_000)]);
    const out = await platformBackupBytesByNamespace(
      dbReturning([
        { id: longA, tenantId: 'ta', initiator: 'system' },
        { id: longB, tenantId: 'ta', initiator: 'system' },
      ]), [TENANT_A], 3600, new Date(),
    );
    expect(out.get(TENANT_A.namespace)).toBe(4_000);
  });
});

const VALID_UUID = '11111111-2222-4333-8444-555555555555';

describe('the reserved-name reservation this module depends on', () => {
  it('reserves every Job-name prefix the exclusion trusts', async () => {
    // If a new platform backup component ships with a prefix that tenants can
    // still choose, the exclusion becomes a way for a tenant to stop paying.
    // This is the build failing rather than the meter leaking.
    const { isReservedWorkloadName } = await import('@insula/api-contracts');
    const id = 'bkp-11111111-2222-3333-4444-555555555555';
    for (const jobName of [filesJobName(id), mailboxJobName(id)]) {
      expect(isReservedWorkloadName(jobName)).toBe(true);
    }
  });

  it('refuses a tenant deployment named after a platform backup Job', async () => {
    const { createDeploymentSchema } = await import('@insula/api-contracts');
    const parsed = createDeploymentSchema.safeParse({
      catalog_entry_id: VALID_UUID,
      name: filesJobName('bkp-11111111-2222-4333-8444-555555555555').slice(0, 63),
    });
    expect(parsed.success).toBe(false);
    // Assert WHY it was refused. Without this the test passes on any unrelated
    // validation error — which is how it first "passed", on a malformed uuid.
    expect(parsed.error?.issues.map((i) => i.path.join('.'))).toContain('name');
  });

  it('still accepts an ordinary name', async () => {
    const { createDeploymentSchema } = await import('@insula/api-contracts');
    const parsed = createDeploymentSchema.safeParse({ catalog_entry_id: VALID_UUID, name: 'my-wordpress' });
    expect(parsed.error?.issues ?? []).toEqual([]);
  });
});
