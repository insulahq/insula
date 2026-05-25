import { describe, it, expect, vi } from 'vitest';
import { buildSecretsTar } from './secrets-bundle.js';

// Mock readClusterCR / readNamespacedConfigMap via k8s clients — the
// builder calls them through the dr-sidecars path. Tests only need
// listSecretForAllNamespaces (the secrets list) + an operator-
// recipient ConfigMap reader.

function makeK8s(opts: { secrets: Array<{ namespace: string; name: string }>; recipient?: string }) {
  const recipient = opts.recipient ?? 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p';
  return {
    core: {
      listSecretForAllNamespaces: vi.fn().mockResolvedValue({
        items: opts.secrets.map((s) => ({
          metadata: { namespace: s.namespace, name: s.name },
          type: 'Opaque',
          data: {},
        })),
      }),
      readNamespacedConfigMap: vi.fn().mockImplementation((req: { name: string }) => {
        if (req.name === 'platform-operator-recipient') {
          return Promise.resolve({ data: { recipient } });
        }
        if (req.name === 'platform-cluster-cidrs') {
          return Promise.resolve({ data: { POD_CIDR: '10.42.0.0/16' } });
        }
        // For the allowlist ConfigMap reader in secrets-audit.
        return Promise.resolve({ data: {} });
      }),
    },
    custom: {
      getNamespacedCustomObject: vi.fn().mockResolvedValue({ spec: { plugins: [] } }),
    },
  } as unknown as Parameters<typeof buildSecretsTar>[0];
}

function emptyDb() {
  // buildDrInputs reads platform_storage_policy (singleton — 0 rows OK)
  // and system_settings (0 rows OK). buildDrRows reads
  // backup_configurations + backup_target_assignments via
  // db.transaction, so the mock provides tx with the same select chain.
  const empty = vi.fn().mockReturnValue({
    from: vi.fn().mockImplementation(() => {
      const chain: PromiseLike<unknown[]> & { limit: () => PromiseLike<unknown[]> } = {
        limit: () => Promise.resolve([]),
        then: (onFulfilled, onRejected) => Promise.resolve([]).then(onFulfilled, onRejected),
      };
      return chain;
    }),
  });
  const txFn = vi.fn().mockImplementation(async (cb: (tx: { select: typeof empty }) => unknown) =>
    cb({ select: empty }),
  );
  return { select: empty, transaction: txFn } as unknown as Parameters<typeof buildSecretsTar>[2]['db'];
}

describe('buildSecretsTar critical-Secret presence enforcement', () => {
  it('THROWS when neither critical Secret is present (bundle would be unrestorable)', async () => {
    // Cluster has only some non-critical Secret. Both
    // platform/platform-secrets and platform/backup-target-key
    // MUST land in the manifest or the bundle is unrestorable.
    const k8s = makeK8s({
      secrets: [{ namespace: 'mail', name: 'stalwart-admin-creds' }],
    });
    await expect(buildSecretsTar(k8s, 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p', {
      db: emptyDb(),
      config: { PLATFORM_BASE_DOMAIN: 'test.example' },
    })).rejects.toThrow(/missing critical Secrets/);
  });

  it('THROWS when ONE critical Secret is present and the other missing', async () => {
    const k8s = makeK8s({
      secrets: [
        { namespace: 'platform', name: 'platform-secrets' },
        // backup-target-key intentionally missing
      ],
    });
    await expect(buildSecretsTar(k8s, 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p', {
      db: emptyDb(),
      config: { PLATFORM_BASE_DOMAIN: 'test.example' },
    })).rejects.toThrow(/platform\/backup-target-key/);
  });

  it('throw error message names the specific missing Secret(s) for the operator', async () => {
    const k8s = makeK8s({ secrets: [] });
    try {
      await buildSecretsTar(k8s, 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p', {
        db: emptyDb(),
        config: { PLATFORM_BASE_DOMAIN: 'test.example' },
      });
      expect.fail('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('platform/platform-secrets');
      expect(msg).toContain('platform/backup-target-key');
      // The operator-actionable remediation hint must surface.
      expect(msg).toContain('tier-1');
    }
  });

  it('does NOT throw when opts.db is omitted (legacy / test path)', async () => {
    // Without db, the sidecars are not emitted and the presence
    // check does not run. This is the documented escape hatch for
    // tests + legacy callers.
    const k8s = makeK8s({ secrets: [] });
    const result = await buildSecretsTar(k8s, 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p');
    expect(result.manifest).toEqual([]);
    expect(result.manifestV2.entries).toEqual([]);
  });
});
