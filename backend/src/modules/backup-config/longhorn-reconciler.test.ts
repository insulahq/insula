import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reconcileBackupTarget, clearBackupTarget } from './longhorn-reconciler.js';

// Default discovered set used when listNamespacedCronJob isn't
// explicitly overridden — mirrors the post-Phase-1 staging cluster.
const DEFAULT_DISCOVERED_CRONS = [
  'platform-cluster-state-backup',
  'platform-etcd-snapshot-upload',
  'platform-pg-backup',
  'platform-secrets-backup',
  'platform-hostpath-snapshot-upload',
  'platform-backup-audit',
];

function createMockTenants(discoveredCrons: string[] = DEFAULT_DISCOVERED_CRONS) {
  const core = {
    replaceNamespacedSecret: vi.fn(),
    createNamespacedSecret: vi.fn(),
  };
  const custom = {
    patchClusterCustomObject: vi.fn(),
    patchNamespacedCustomObject: vi.fn(),
  };
  const batch = {
    patchNamespacedCronJob: vi.fn().mockResolvedValue({}),
    listNamespacedCronJob: vi.fn().mockResolvedValue({
      items: discoveredCrons.map((name) => ({
        metadata: {
          name,
          namespace: 'platform',
          labels: { 'insula.host/depends-on': 'backup-credentials' },
        },
      })),
    }),
  };
  return { core, custom, batch } as unknown as {
    core: {
      replaceNamespacedSecret: ReturnType<typeof vi.fn>;
      createNamespacedSecret: ReturnType<typeof vi.fn>;
    };
    custom: {
      patchClusterCustomObject: ReturnType<typeof vi.fn>;
      patchNamespacedCustomObject: ReturnType<typeof vi.fn>;
    };
    batch: {
      patchNamespacedCronJob: ReturnType<typeof vi.fn>;
      listNamespacedCronJob: ReturnType<typeof vi.fn>;
    };
  };
}

const INPUT = {
  kind: 's3' as const,
  endpoint: 'https://fsn1.example.com',
  region: 'eu-central',
  bucket: 'k8s-staging',
  accessKeyId: 'AKIA' + 'X'.repeat(16),
  secretAccessKey: 'S'.repeat(40),
};

const SSH_INPUT = {
  kind: 'ssh' as const,
  host: 'backup.example.com',
  port: 22,
  user: 'platformbackup',
  path: '/srv/backups/staging',
  privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAA...\n-----END OPENSSH PRIVATE KEY-----\n',
};

describe('reconcileBackupTarget', () => {
  let tenants: ReturnType<typeof createMockTenants>;

  beforeEach(() => {
    tenants = createMockTenants();
  });

  it('replaces the credentials Secret on happy path', async () => {
    tenants.core.replaceNamespacedSecret.mockResolvedValue({});
    tenants.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(tenants as any, INPUT);

    // Called twice — longhorn-system + platform ns. Mail-ns mirror was
    // retired with the CNPG mail-pg cluster (2026-05-12).
    expect(tenants.core.replaceNamespacedSecret).toHaveBeenCalledTimes(2);
    const [args] = tenants.core.replaceNamespacedSecret.mock.calls[0];
    expect(args.name).toBe('longhorn-backup-credentials');
    expect(args.namespace).toBe('longhorn-system');
    expect(args.body.stringData.AWS_ACCESS_KEY_ID).toBe(INPUT.accessKeyId);
    expect(args.body.stringData.AWS_SECRET_ACCESS_KEY).toBe(INPUT.secretAccessKey);
    expect(args.body.stringData.AWS_ENDPOINTS).toBe(INPUT.endpoint);
    expect(args.body.stringData.S3_BUCKET).toBe(INPUT.bucket);
    expect(args.body.metadata.labels['app.kubernetes.io/managed-by']).toBe('platform-api');
  });

  it('marks the platform-ns Secret with TARGET_KIND=s3 on S3 activate', async () => {
    tenants.core.replaceNamespacedSecret.mockResolvedValue({});
    tenants.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(tenants as any, INPUT);

    const [, platformArgs] = tenants.core.replaceNamespacedSecret.mock.calls;
    expect(platformArgs[0].body.stringData.TARGET_KIND).toBe('s3');
    // Switching back from SSH→S3 must drop stale SSH keys. stringData set
    // to '' lets replaceNamespacedSecret overwrite them without leaving
    // ghost values from a prior SSH activation.
    expect(platformArgs[0].body.stringData.SSH_HOST).toBe('');
    expect(platformArgs[0].body.stringData.SSH_PRIVATE_KEY).toBe('');
  });

  it('also writes backup-credentials Secret into the platform namespace for DR CronJobs', async () => {
    tenants.core.replaceNamespacedSecret.mockResolvedValue({});
    tenants.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(tenants as any, INPUT);

    const calls = tenants.core.replaceNamespacedSecret.mock.calls;
    // 2 calls: longhorn-system + platform (mail-ns mirror retired 2026-05-12)
    expect(calls).toHaveLength(2);
    const [, platformArgs] = calls;
    expect(platformArgs[0].name).toBe('backup-credentials');
    expect(platformArgs[0].namespace).toBe('platform');
    // Same creds + convenience keys for aws-cli (bucket/region/prefix)
    expect(platformArgs[0].body.stringData.AWS_ACCESS_KEY_ID).toBe(INPUT.accessKeyId);
    expect(platformArgs[0].body.stringData.S3_BUCKET).toBe(INPUT.bucket);
    expect(platformArgs[0].body.stringData.S3_REGION).toBe(INPUT.region);
  });

  it('continues successfully when the platform-ns sync fails (best-effort)', async () => {
    // Longhorn-ns call succeeds, BackupTarget patch succeeds, but
    // platform-ns call fails. The reconciler should log + return, not
    // throw, so the operator sees the Longhorn target go live.
    tenants.core.replaceNamespacedSecret
      .mockResolvedValueOnce({})   // longhorn-system: ok
      .mockRejectedValueOnce({ statusCode: 500, message: 'platform ns down' });  // platform: fail
    tenants.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(reconcileBackupTarget(tenants as any, INPUT)).resolves.toBeUndefined();
    expect(tenants.custom.patchClusterCustomObject).toHaveBeenCalled();
  });

  it('falls back to create when the Secret does not yet exist (both namespaces)', async () => {
    tenants.core.replaceNamespacedSecret.mockRejectedValue({ statusCode: 404 });
    tenants.core.createNamespacedSecret.mockResolvedValue({});
    tenants.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(tenants as any, INPUT);

    // 2 replace attempts (all 404) → 2 create fallbacks: longhorn-system, platform
    expect(tenants.core.replaceNamespacedSecret).toHaveBeenCalledTimes(2);
    expect(tenants.core.createNamespacedSecret).toHaveBeenCalledTimes(2);
    const calls = tenants.core.createNamespacedSecret.mock.calls;
    expect(calls[0][0].namespace).toBe('longhorn-system');
    expect(calls[0][0].body.metadata.name).toBe('longhorn-backup-credentials');
    expect(calls[1][0].namespace).toBe('platform');
    expect(calls[1][0].body.metadata.name).toBe('backup-credentials');
  });

  it('patches BackupTarget/default with correct S3 URL', async () => {
    tenants.core.replaceNamespacedSecret.mockResolvedValue({});
    tenants.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(tenants as any, INPUT);

    expect(tenants.custom.patchClusterCustomObject).toHaveBeenCalledOnce();
    const [args] = tenants.custom.patchClusterCustomObject.mock.calls[0];
    expect(args.group).toBe('longhorn.io');
    expect(args.version).toBe('v1beta2');
    expect(args.plural).toBe('backuptargets');
    expect(args.name).toBe('default');
    expect(args.body.spec.backupTargetURL).toBe('s3://k8s-staging@eu-central/');
    expect(args.body.spec.credentialSecret).toBe('longhorn-backup-credentials');
  });

  it('includes the path prefix when one is supplied', async () => {
    tenants.core.replaceNamespacedSecret.mockResolvedValue({});
    tenants.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(tenants as any, { ...INPUT, pathPrefix: 'longhorn-staging' });

    const [args] = tenants.custom.patchClusterCustomObject.mock.calls[0];
    expect(args.body.spec.backupTargetURL).toBe('s3://k8s-staging@eu-central/longhorn-staging');
  });

  it('strips leading/trailing slashes from the path prefix', async () => {
    tenants.core.replaceNamespacedSecret.mockResolvedValue({});
    tenants.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(tenants as any, { ...INPUT, pathPrefix: '//nested/path/' });

    const [args] = tenants.custom.patchClusterCustomObject.mock.calls[0];
    expect(args.body.spec.backupTargetURL).toBe('s3://k8s-staging@eu-central/nested/path');
  });

  it('falls back to namespaced BackupTarget on cluster-scope 404', async () => {
    tenants.core.replaceNamespacedSecret.mockResolvedValue({});
    tenants.custom.patchClusterCustomObject.mockRejectedValue({ statusCode: 404 });
    tenants.custom.patchNamespacedCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(tenants as any, INPUT);

    expect(tenants.custom.patchClusterCustomObject).toHaveBeenCalledOnce();
    expect(tenants.custom.patchNamespacedCustomObject).toHaveBeenCalledOnce();
    const [args] = tenants.custom.patchNamespacedCustomObject.mock.calls[0];
    expect(args.namespace).toBe('longhorn-system');
    expect(args.name).toBe('default');
  });

  it('propagates non-404 errors from the Secret API', async () => {
    tenants.core.replaceNamespacedSecret.mockRejectedValue({ statusCode: 500, message: 'boom' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(reconcileBackupTarget(tenants as any, INPUT)).rejects.toMatchObject({
      statusCode: 500,
    });
  });

  it('recognises @kubernetes/client-node v1 wrapped 404 (message + string body)', async () => {
    // Exact shape observed in staging logs 2026-04-22:
    //   HTTP-Code: 404 Message: Unknown API Status Code!
    //   Body: "{\"kind\":\"Status\",\"code\":404,\"reason\":\"NotFound\",...}"
    // None of the outer properties (statusCode/code) are set — signal
    // lives only in message + JSON-stringified body.
    const wrappedErr = new Error(
      'HTTP-Code: 404 Message: Unknown API Status Code! Body: "{\\"kind\\":\\"Status\\",\\"code\\":404,\\"reason\\":\\"NotFound\\"}" Headers: {}',
    );
    tenants.core.replaceNamespacedSecret.mockRejectedValueOnce(wrappedErr);
    tenants.core.createNamespacedSecret.mockResolvedValue({});
    tenants.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(reconcileBackupTarget(tenants as any, INPUT)).resolves.toBeUndefined();
    // Fallback create was reached
    expect(tenants.core.createNamespacedSecret).toHaveBeenCalled();
  });

  it('recognises v1 404 when body is a parseable JSON string carrying reason=NotFound', async () => {
    const err = {
      body: '{"kind":"Status","status":"Failure","code":404,"reason":"NotFound"}',
      message: 'Request failed',
    };
    tenants.core.replaceNamespacedSecret.mockRejectedValueOnce(err);
    tenants.core.createNamespacedSecret.mockResolvedValue({});
    tenants.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(reconcileBackupTarget(tenants as any, INPUT)).resolves.toBeUndefined();
    expect(tenants.core.createNamespacedSecret).toHaveBeenCalled();
  });
});

describe('reconcileBackupTarget — SSH variant', () => {
  let tenants: ReturnType<typeof createMockTenants>;
  beforeEach(() => { tenants = createMockTenants(); });

  it('writes SSH_* keys + TARGET_KIND=ssh to platform-ns Secret', async () => {
    tenants.core.replaceNamespacedSecret.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(tenants as any, SSH_INPUT);

    // One Secret call — platform-ns only. Longhorn-system is never
    // touched for SSH (BackupTarget only talks S3). Mail-ns mirror was
    // retired with the CNPG mail-pg cluster (2026-05-12).
    expect(tenants.core.replaceNamespacedSecret).toHaveBeenCalledTimes(1);
    const [args] = tenants.core.replaceNamespacedSecret.mock.calls[0];
    expect(args.name).toBe('backup-credentials');
    expect(args.namespace).toBe('platform');
    expect(args.body.stringData.TARGET_KIND).toBe('ssh');
    expect(args.body.stringData.SSH_HOST).toBe(SSH_INPUT.host);
    expect(args.body.stringData.SSH_PORT).toBe(String(SSH_INPUT.port));
    expect(args.body.stringData.SSH_USER).toBe(SSH_INPUT.user);
    expect(args.body.stringData.SSH_PATH).toBe(SSH_INPUT.path);
    expect(args.body.stringData.SSH_PRIVATE_KEY).toBe(SSH_INPUT.privateKey);
  });

  it('clears stale AWS_* keys when activating SSH after a prior S3 config', async () => {
    tenants.core.replaceNamespacedSecret.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(tenants as any, SSH_INPUT);

    const [args] = tenants.core.replaceNamespacedSecret.mock.calls[0];
    // Empty-string stringData overwrites prior AWS_* on replace — keeps
    // the Secret shape deterministic across target-kind switches.
    expect(args.body.stringData.AWS_ACCESS_KEY_ID).toBe('');
    expect(args.body.stringData.AWS_SECRET_ACCESS_KEY).toBe('');
    expect(args.body.stringData.AWS_ENDPOINTS).toBe('');
    expect(args.body.stringData.S3_BUCKET).toBe('');
    expect(args.body.stringData.S3_REGION).toBe('');
  });

  it('does NOT patch the Longhorn BackupTarget CR on SSH activate', async () => {
    tenants.core.replaceNamespacedSecret.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(tenants as any, SSH_INPUT);

    // Longhorn does not support SSH as a BackupTarget backend — the CR
    // is left untouched. Longhorn-level volume backups are disabled when
    // the admin panel's active config is SSH-only.
    expect(tenants.custom.patchClusterCustomObject).not.toHaveBeenCalled();
    expect(tenants.custom.patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('falls back to createNamespacedSecret on 404 for SSH variant (platform-ns)', async () => {
    tenants.core.replaceNamespacedSecret.mockRejectedValue({ statusCode: 404 });
    tenants.core.createNamespacedSecret.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(tenants as any, SSH_INPUT);

    // 1 replace attempt (404) → 1 create fallback: platform-ns only.
    expect(tenants.core.createNamespacedSecret).toHaveBeenCalledTimes(1);
    const [args] = tenants.core.createNamespacedSecret.mock.calls[0];
    expect(args.namespace).toBe('platform');
    expect(args.body.metadata.name).toBe('backup-credentials');
    expect(args.body.stringData.TARGET_KIND).toBe('ssh');
  });

  it('propagates non-404 errors from the SSH Secret write', async () => {
    tenants.core.replaceNamespacedSecret.mockRejectedValue({ statusCode: 500, message: 'boom' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(reconcileBackupTarget(tenants as any, SSH_INPUT)).rejects.toMatchObject({
      statusCode: 500,
    });
  });
});

describe('clearBackupTarget', () => {
  it('empties the URL and secret reference', async () => {
    const tenants = createMockTenants();
    tenants.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await clearBackupTarget(tenants as any);

    const [args] = tenants.custom.patchClusterCustomObject.mock.calls[0];
    expect(args.body.spec.backupTargetURL).toBe('');
    expect(args.body.spec.credentialSecret).toBe('');
  });

  it('skips the BackupTarget CR patch when kind=ssh is supplied', async () => {
    const tenants = createMockTenants();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await clearBackupTarget(tenants as any, { kind: 'ssh' });

    // SSH was never patched-in, so clearing has nothing to clear. The
    // caller still wants a well-defined no-op instead of needing to
    // branch on kind externally.
    expect(tenants.custom.patchClusterCustomObject).not.toHaveBeenCalled();
    expect(tenants.custom.patchNamespacedCustomObject).not.toHaveBeenCalled();
  });
});

describe('DR CronJob suspend toggle', () => {
  // Names listed in BACKUP_CRONJOB_NAMES (longhorn-reconciler.ts). Kept
  // in lockstep with k8s/base/backup/*.yaml — every CronJob there that
  // mounts the backup-credentials Secret OR audits backup coverage
  // must appear here.
  const EXPECTED_CRONJOBS = [
    'platform-cluster-state-backup',
    'platform-etcd-snapshot-upload',
    'platform-pg-backup',
    'platform-secrets-backup',
    'platform-hostpath-snapshot-upload',
    'platform-backup-audit',
  ];

  it('unsuspends every DR CronJob on S3 activate', async () => {
    const tenants = createMockTenants();
    tenants.core.replaceNamespacedSecret.mockResolvedValue({});
    tenants.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(tenants as any, INPUT);

    expect(tenants.batch.patchNamespacedCronJob).toHaveBeenCalledTimes(EXPECTED_CRONJOBS.length);
    const namesPatched = tenants.batch.patchNamespacedCronJob.mock.calls.map((c) => c[0].name);
    expect(namesPatched).toEqual(expect.arrayContaining(EXPECTED_CRONJOBS));
    for (const call of tenants.batch.patchNamespacedCronJob.mock.calls) {
      expect(call[0].namespace).toBe('platform');
      expect(call[0].body).toEqual({ spec: { suspend: false } });
    }
  });

  it('unsuspends every DR CronJob on SSH activate', async () => {
    const tenants = createMockTenants();
    tenants.core.replaceNamespacedSecret.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(tenants as any, SSH_INPUT);

    expect(tenants.batch.patchNamespacedCronJob).toHaveBeenCalledTimes(EXPECTED_CRONJOBS.length);
    for (const call of tenants.batch.patchNamespacedCronJob.mock.calls) {
      expect(call[0].body).toEqual({ spec: { suspend: false } });
    }
  });

  it('suspends every DR CronJob on clearBackupTarget (S3)', async () => {
    const tenants = createMockTenants();
    tenants.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await clearBackupTarget(tenants as any);

    expect(tenants.batch.patchNamespacedCronJob).toHaveBeenCalledTimes(EXPECTED_CRONJOBS.length);
    for (const call of tenants.batch.patchNamespacedCronJob.mock.calls) {
      expect(call[0].body).toEqual({ spec: { suspend: true } });
    }
  });

  it('suspends every DR CronJob on clearBackupTarget (SSH)', async () => {
    const tenants = createMockTenants();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await clearBackupTarget(tenants as any, { kind: 'ssh' });

    expect(tenants.batch.patchNamespacedCronJob).toHaveBeenCalledTimes(EXPECTED_CRONJOBS.length);
    for (const call of tenants.batch.patchNamespacedCronJob.mock.calls) {
      expect(call[0].body).toEqual({ spec: { suspend: true } });
    }
  });

  it('skips toggle silently when batch tenant is not provided (legacy callers)', async () => {
    const tenants = createMockTenants();
    tenants.core.replaceNamespacedSecret.mockResolvedValue({});
    tenants.custom.patchClusterCustomObject.mockResolvedValue({});
    const noBatch = { core: tenants.core, custom: tenants.custom };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(reconcileBackupTarget(noBatch as any, INPUT)).resolves.toBeUndefined();
    // The reconciler still completes the Secret + BackupTarget writes;
    // only the cron toggle is skipped (the warning lands in console.warn).
    expect(tenants.core.replaceNamespacedSecret).toHaveBeenCalled();
  });

  it('continues past a missing CronJob (404) on activate', async () => {
    const tenants = createMockTenants();
    tenants.core.replaceNamespacedSecret.mockResolvedValue({});
    tenants.custom.patchClusterCustomObject.mockResolvedValue({});
    // Simulate first cron not deployed yet (e.g. partial Flux apply)
    tenants.batch.patchNamespacedCronJob
      .mockRejectedValueOnce({ statusCode: 404 })
      .mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(reconcileBackupTarget(tenants as any, INPUT)).resolves.toBeUndefined();
    // All five attempted; first 404 swallowed, remaining four succeed.
    expect(tenants.batch.patchNamespacedCronJob).toHaveBeenCalledTimes(EXPECTED_CRONJOBS.length);
  });
});
