import { describe, it, expect, vi } from 'vitest';
import { getMailNodeStorage } from './mail-node-storage.js';

// ── Fixtures ─────────────────────────────────────────────────────────

function node(name: string, opts: { standby?: boolean; epStorageGi?: number } = {}) {
  return {
    metadata: {
      name,
      labels: {
        'kubernetes.io/hostname': name,
        ...(opts.standby ? { 'insula.host/mail-standby': 'true' } : {}),
      },
    },
    status: {
      allocatable: {
        'ephemeral-storage': `${opts.epStorageGi ?? 100}Gi`,
      },
    },
  };
}

function pv(name: string, hostname: string, capGi: number) {
  return {
    metadata: { name },
    spec: {
      capacity: { storage: `${capGi}Gi` },
      nodeAffinity: {
        required: {
          nodeSelectorTerms: [
            { matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [hostname] }] },
          ],
        },
      },
    },
  };
}

function dbStub(reports: Record<string, { sizeBytes: number; reportedAt: string }>) {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [{ mail_standby_reports: reports }] }),
  };
}

function buildDeps(opts: {
  nodes: ReturnType<typeof node>[];
  pvs: ReturnType<typeof pv>[];
  standbyReports?: Record<string, { sizeBytes: number; reportedAt: string }>;
  placement: { activeNode: string | null; primaryNode: string | null; secondaryNode: string | null; tertiaryNode: string | null };
  duBytes?: number | null;
  /** nodeName → kubelet node.fs.availableBytes. Absent = that node's read fails. */
  freeByNode?: Record<string, number>;
  /** Make the kubelet proxy throw, to prove one bad node does not poison the rest. */
  freeThrows?: boolean;
}) {
  const core = {
    listNode: vi.fn().mockResolvedValue({ items: opts.nodes }),
    listPersistentVolume: vi.fn().mockResolvedValue({ items: opts.pvs }),
    connectGetNodeProxyWithPath: vi.fn().mockImplementation(async ({ name }: { name: string }) => {
      if (opts.freeThrows) throw new Error('kubelet unreachable');
      const avail = opts.freeByNode?.[name];
      return avail == null ? {} : { node: { fs: { availableBytes: avail } } };
    }),
    listNamespacedPod: vi.fn().mockResolvedValue({
      items: opts.duBytes != null
        ? [{ metadata: { name: 'stalwart-mail-abc' }, status: { phase: 'Running' } }]
        : [],
    }),
  };
  const exec = {
    exec: vi.fn().mockImplementation(
      (_ns: string, _pod: string, _container: string, _argv: string[],
       stdout: NodeJS.WritableStream, _stderr: NodeJS.WritableStream, _stdin: unknown,
       _tty: boolean, cb: (status: { status: string }) => void) => {
        if (opts.duBytes != null) {
          stdout.write(`${opts.duBytes}\t/var/lib/mail-stack\n`);
        }
        cb({ status: 'Success' });
        return Promise.resolve();
      },
    ),
  };
  const db = dbStub(opts.standbyReports ?? {});
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    core: core as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    exec: exec as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: db as any,
    placement: opts.placement,
    logger: { warn: () => {} },
  };
}

describe('mail-node-storage', () => {
  it('returns empty list when no placement and no standby labels', async () => {
    const cards = await getMailNodeStorage(buildDeps({
      nodes: [node('worker1'), node('worker2')], // no standby label
      pvs: [],
      placement: { activeNode: null, primaryNode: null, secondaryNode: null, tertiaryNode: null },
    }));
    expect(cards).toEqual([]);
  });

  it('includes active + placement slots + standby nodes; deduped + sorted', async () => {
    const cards = await getMailNodeStorage(buildDeps({
      nodes: [
        node('staging2', { epStorageGi: 200 }),
        node('staging1', { standby: true, epStorageGi: 150 }),
        node('staging3', { standby: true, epStorageGi: 120 }),
      ],
      pvs: [],
      placement: {
        activeNode: 'staging2',
        primaryNode: 'staging2',
        secondaryNode: 'staging1',
        tertiaryNode: 'staging3',
      },
    }));
    expect(cards).toHaveLength(3);
    // Active first, then alphabetical
    expect(cards[0].nodeName).toBe('staging2');
    expect(cards[0].isActive).toBe(true);
    expect(cards[0].roles).toContain('active');
    expect(cards[0].roles).toContain('primary');
    expect(cards[1].nodeName).toBe('staging1');
    expect(cards[1].roles).toEqual(['secondary', 'standby'].sort());
    expect(cards[2].nodeName).toBe('staging3');
  });

  it('totalBytes pulled from allocatable.ephemeral-storage', async () => {
    const cards = await getMailNodeStorage(buildDeps({
      nodes: [node('staging1', { epStorageGi: 150 })],
      pvs: [],
      placement: { activeNode: 'staging1', primaryNode: null, secondaryNode: null, tertiaryNode: null },
    }));
    expect(cards[0].totalBytes).toBe(150 * 1024 ** 3);
  });

  /**
   * Replaced `scheduledBytes` (sum of PVC requests). On local-path a PVC
   * request reserves nothing and enforces nothing — a 30Gi request sat beside
   * 63MB of actual mail — and headroom was derived from it, so the fiction
   * reached the one number an operator acts on. `freeBytes` is what `df` says.
   */
  it('freeBytes comes from the kubelet Summary API, per node', async () => {
    const cards = await getMailNodeStorage(buildDeps({
      nodes: [node('staging1')],
      pvs: [],
      placement: { activeNode: 'staging1', primaryNode: null, secondaryNode: null, tertiaryNode: null },
      freeByNode: { staging1: 900 * 1024 ** 3 },
    }));
    expect(cards[0].freeBytes).toBe(900 * 1024 ** 3);
  });

  // Null, never 0 — "0 B free" reads as a full disk, the opposite of unknown.
  it('freeBytes is null when the kubelet read fails', async () => {
    const cards = await getMailNodeStorage(buildDeps({
      nodes: [node('staging1')],
      pvs: [],
      placement: { activeNode: 'staging1', primaryNode: null, secondaryNode: null, tertiaryNode: null },
      freeThrows: true,
    }));
    expect(cards[0].freeBytes).toBeNull();
    // The rest of the card still renders — a kubelet blip must not blank it.
    expect(cards[0].totalBytes).not.toBeNull();
  });

  it('one unreachable node does not null out the others', async () => {
    const cards = await getMailNodeStorage(buildDeps({
      nodes: [node('staging1'), node('staging2')],
      pvs: [],
      placement: { activeNode: 'staging1', primaryNode: 'staging2', secondaryNode: null, tertiaryNode: null },
      freeByNode: { staging1: 100 * 1024 ** 3 }, // staging2 absent → its read yields nothing
    }));
    const byName = Object.fromEntries(cards.map((c) => [c.nodeName, c.freeBytes]));
    expect(byName.staging1).toBe(100 * 1024 ** 3);
    expect(byName.staging2).toBeNull();
  });

  it('no longer reports scheduledBytes at all', async () => {
    const cards = await getMailNodeStorage(buildDeps({
      nodes: [node('staging1')],
      pvs: [pv('pv-1', 'staging1', 30)],
      placement: { activeNode: 'staging1', primaryNode: null, secondaryNode: null, tertiaryNode: null },
    }));
    expect(cards[0]).not.toHaveProperty('scheduledBytes');
  });

  it('mailUsed: active node uses du output', async () => {
    const cards = await getMailNodeStorage(buildDeps({
      nodes: [node('staging2')],
      pvs: [],
      placement: { activeNode: 'staging2', primaryNode: null, secondaryNode: null, tertiaryNode: null },
      duBytes: 24_576_000_000, // ~24 GiB
    }));
    expect(cards[0].mailUsedBytes).toBe(24_576_000_000);
    expect(cards[0].mailUsedReportedAt).not.toBeNull();
  });

  it('mailUsed: standby node uses mail_standby_reports', async () => {
    const cards = await getMailNodeStorage(buildDeps({
      nodes: [node('staging1', { standby: true })],
      pvs: [],
      placement: { activeNode: null, primaryNode: null, secondaryNode: null, tertiaryNode: null },
      standbyReports: {
        staging1: { sizeBytes: 22_124_071, reportedAt: '2026-05-26T14:51:33.949Z' },
      },
    }));
    expect(cards[0].mailUsedBytes).toBe(22_124_071);
    expect(cards[0].mailUsedReportedAt).toBe('2026-05-26T14:51:33.949Z');
  });

  it('graceful when standby node has no report yet', async () => {
    const cards = await getMailNodeStorage(buildDeps({
      nodes: [node('staging1', { standby: true })],
      pvs: [],
      placement: { activeNode: null, primaryNode: null, secondaryNode: null, tertiaryNode: null },
      standbyReports: {},
    }));
    expect(cards[0].mailUsedBytes).toBeNull();
    expect(cards[0].mailUsedReportedAt).toBeNull();
  });
});
