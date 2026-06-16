import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as tar from 'tar-stream';

// The descriptor builder reaches loadShimAssignments + getClusterId; mock
// both so the test needs no DB. dr-rows/dr-inputs use db.transaction
// directly (not these) so the empty-db mock still serves them.
vi.mock('../backup-rclone-shim/service.js', () => ({ loadShimAssignments: vi.fn() }));
vi.mock('../system-settings/cluster-id.js', () => ({ getClusterId: vi.fn() }));

import { buildSecretsTar } from './secrets-bundle.js';
import { loadShimAssignments } from '../backup-rclone-shim/service.js';
import { getClusterId } from '../system-settings/cluster-id.js';
import type { BackupTargetConfig } from '../backup-rclone-shim/rclone-config.js';

const RECIPIENT = 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p';
const CID = 'cid-aaaa-bbbb';

// The critical-Secret presence check requires both of these in the list,
// else buildSecretsTar throws before reaching the descriptor block.
function makeK8s() {
  return {
    core: {
      listSecretForAllNamespaces: vi.fn().mockResolvedValue({
        items: [
          { metadata: { namespace: 'platform', name: 'platform-secrets' }, type: 'Opaque', data: {} },
          { metadata: { namespace: 'platform', name: 'backup-target-key' }, type: 'Opaque', data: {} },
        ],
      }),
      readNamespacedConfigMap: vi.fn().mockImplementation((req: { name: string }) => {
        if (req.name === 'platform-operator-recipient') return Promise.resolve({ data: { recipient: RECIPIENT } });
        if (req.name === 'platform-cluster-cidrs') return Promise.resolve({ data: { POD_CIDR: '10.42.0.0/16' } });
        return Promise.resolve({ data: {} });
      }),
    },
    custom: { getNamespacedCustomObject: vi.fn().mockResolvedValue({ spec: { plugins: [] } }) },
  } as unknown as Parameters<typeof buildSecretsTar>[0];
}

function emptyDb() {
  const empty = vi.fn().mockReturnValue({
    from: vi.fn().mockImplementation(() => ({
      limit: () => Promise.resolve([]),
      then: (f: (v: unknown[]) => unknown, r?: (e: unknown) => unknown) => Promise.resolve([]).then(f, r),
    })),
  });
  const txFn = vi.fn().mockImplementation(async (cb: (tx: { select: typeof empty }) => unknown) => cb({ select: empty }));
  return { select: empty, transaction: txFn } as unknown as Parameters<typeof buildSecretsTar>[2]['db'];
}

async function tarEntryNames(bytes: Buffer): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const names: string[] = [];
    const ex = tar.extract();
    ex.on('entry', (header, stream, next) => { names.push(header.name); stream.resume(); stream.on('end', next); });
    ex.on('finish', () => resolve(names));
    ex.on('error', reject);
    ex.end(bytes);
  });
}

const SYSTEM_TARGET: BackupTargetConfig = {
  id: 't1', name: 'sys', storageType: 's3',
  s3Endpoint: 'https://s3.example.test', s3Bucket: 'bkt', s3AccessKey: 'ak', s3SecretKey: 'sk', s3Prefix: 'pfx',
};

describe('buildSecretsTar — dr-system-target.json emission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getClusterId as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(CID);
  });

  it('emits dr-system-target.json when encryptionKey is set AND a system target is bound', async () => {
    (loadShimAssignments as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
      assignments: [{ className: 'system', target: SYSTEM_TARGET }],
      shadowed: [], disabledAssignments: [], orphanedAssignments: [],
    });
    const { tarBytes } = await buildSecretsTar(makeK8s(), RECIPIENT, {
      db: emptyDb(), config: { PLATFORM_BASE_DOMAIN: 'test.example' }, encryptionKey: 'enc',
    });
    expect(await tarEntryNames(tarBytes)).toContain('dr-system-target.json');
  });

  it('does NOT emit the descriptor when encryptionKey is absent', async () => {
    (loadShimAssignments as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
      assignments: [{ className: 'system', target: SYSTEM_TARGET }],
      shadowed: [], disabledAssignments: [], orphanedAssignments: [],
    });
    const { tarBytes } = await buildSecretsTar(makeK8s(), RECIPIENT, {
      db: emptyDb(), config: { PLATFORM_BASE_DOMAIN: 'test.example' }, // no encryptionKey
    });
    expect(await tarEntryNames(tarBytes)).not.toContain('dr-system-target.json');
  });

  it('does NOT emit the descriptor when no system target is bound', async () => {
    (loadShimAssignments as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
      assignments: [], shadowed: [], disabledAssignments: [], orphanedAssignments: [],
    });
    const { tarBytes } = await buildSecretsTar(makeK8s(), RECIPIENT, {
      db: emptyDb(), config: { PLATFORM_BASE_DOMAIN: 'test.example' }, encryptionKey: 'enc',
    });
    expect(await tarEntryNames(tarBytes)).not.toContain('dr-system-target.json');
  });
});
