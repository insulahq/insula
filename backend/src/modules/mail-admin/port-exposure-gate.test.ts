import { describe, it, expect, vi, beforeEach } from 'vitest';

// mailMigrationInFlight reads mail_migration_runs; these DB fakes have no
// execute(). Default: nothing in flight (tests that need one override it).
const migrationInFlight = vi.fn(async (): Promise<string | null> => null);
vi.mock('./active-node.js', async (orig) => ({
  ...(await orig<typeof import('./active-node.js')>()),
  mailMigrationInFlight: () => migrationInFlight(),
}));


/**
 * validateModeSwitchAgainstDb node-count gate.
 *
 * The HA-proxy port-exposure modes (assignedMailNodes + allServerNodes —
 * i.e. any non-activeNodeOnly mode) are refused unless the cluster has
 * >=2 Ready SERVER-role nodes. Workers do NOT count toward this gate.
 * activeNodeOnly is always permitted.
 *
 * Driven entirely through the DB-aware wrapper so the pure
 * validateModeSwitch in port-exposure-modes.ts is untouched.
 */

const mockListNode = vi.fn(async () => ({ items: [] as unknown[] }));
// Live Stalwart pods — empty unless a test places one (active-node.ts reads them).
const mockListPods = vi.fn(async () => ({ items: [] as unknown[] }));
const mockReadPvc = vi.fn(async () => { throw Object.assign(new Error('not found'), { code: 404 }); });

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromCluster() {}
    loadFromFile() {}
    makeApiClient(api: unknown) {
      const name = (api as { name?: string })?.name ?? '';
      if (name === 'CoreV1Api') {
        return {
          listNode: mockListNode,
          listNamespacedPod: mockListPods,
          readNamespacedPersistentVolumeClaim: mockReadPvc,
          readPersistentVolume: vi.fn(),
        };
      }
      return {};
    }
  },
  AppsV1Api: { name: 'AppsV1Api' },
  CoreV1Api: { name: 'CoreV1Api' },
}));

// Placement settings row: active node IS in the assigned set so the
// pre-existing assignedMailNodes placement guard does not fire — we are
// isolating the NEW node-count gate.
function buildDb(activeNode: string | null = 'server-0') {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{
          primaryNode: 'server-0',
          secondaryNode: 'server-1',
          tertiaryNode: null,
          activeNode,
        }]),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
  } as unknown as import('../../db/index.js').Database;
}

const stalwartOn = (node: string) => ({
  items: [{ metadata: {}, spec: { nodeName: node }, status: { phase: 'Running' } }],
});

/** Build a node list: `servers` Ready server-role + `workers` Ready worker-role. */
function nodes(servers: number, workers: number) {
  const out: unknown[] = [];
  for (let i = 0; i < servers; i++) {
    out.push({
      metadata: { name: `server-${i}`, labels: { 'insula.host/node-role': 'server' } },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    });
  }
  for (let i = 0; i < workers; i++) {
    out.push({
      metadata: { name: `worker-${i}`, labels: { 'insula.host/node-role': 'worker' } },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    });
  }
  return out;
}

describe('mail-admin/port-exposure.validateModeSwitchAgainstDb node-count gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const mode of ['assignedMailNodes', 'allServerNodes'] as const) {
    it(`REFUSES ${mode} with <2 server nodes (one server only)`, async () => {
      mockListNode.mockResolvedValue({ items: nodes(1, 0) });
      const { validateModeSwitchAgainstDb } = await import('./port-exposure.js');
      const err = await validateModeSwitchAgainstDb(mode, buildDb(), undefined);
      expect(err).toBe('Mail HA-Proxy requires 2 or more server nodes.');
    });

    it(`REFUSES ${mode} when only workers would satisfy the count (1 server + 3 workers)`, async () => {
      // Workers must NOT count toward the gate.
      mockListNode.mockResolvedValue({ items: nodes(1, 3) });
      const { validateModeSwitchAgainstDb } = await import('./port-exposure.js');
      const err = await validateModeSwitchAgainstDb(mode, buildDb(), undefined);
      expect(err).toBe('Mail HA-Proxy requires 2 or more server nodes.');
    });

    it(`ALLOWS ${mode} with >=2 server nodes`, async () => {
      mockListNode.mockResolvedValue({ items: nodes(2, 0) });
      const { validateModeSwitchAgainstDb } = await import('./port-exposure.js');
      const err = await validateModeSwitchAgainstDb(mode, buildDb(), undefined);
      expect(err).toBeNull();
    });
  }

  it('REFUSES any switch while a mail migration is in flight (the active node is not settled)', async () => {
    mockListNode.mockResolvedValue({ items: nodes(3, 0) });
    const { validateModeSwitchAgainstDb } = await import('./port-exposure.js');
    for (const mode of ['activeNodeOnly', 'allServerNodes'] as const) {
      migrationInFlight.mockResolvedValueOnce('run-7');
      expect(await validateModeSwitchAgainstDb(mode, buildDb(), undefined)).toMatch(/mail migration is in progress/);
    }
  });

  it('ALWAYS allows activeNodeOnly even on a single-node cluster', async () => {
    mockListNode.mockResolvedValue({ items: nodes(1, 0) });
    const { validateModeSwitchAgainstDb } = await import('./port-exposure.js');
    const err = await validateModeSwitchAgainstDb('activeNodeOnly', buildDb(), undefined);
    expect(err).toBeNull();
  });
});

describe('validateModeSwitchAgainstDb — active node from the live cluster', () => {
  // VM release verification: on a cluster installed on several nodes
  // mail_active_node is NULL, and assignedMailNodes was refused ("no active
  // mail node is set") although Stalwart ran on an assigned node.
  beforeEach(() => {
    mockListNode.mockResolvedValue({ items: nodes(3, 1) });
    mockListPods.mockReset().mockResolvedValue({ items: [] });
  });

  it('ALLOWS assignedMailNodes when nothing is stored but Stalwart runs on an assigned node', async () => {
    mockListPods.mockResolvedValue(stalwartOn('server-0'));
    const { validateModeSwitchAgainstDb } = await import('./port-exposure.js');
    expect(await validateModeSwitchAgainstDb('assignedMailNodes', buildDb(null), undefined)).toBeNull();
  });

  it('still REFUSES when Stalwart runs outside the assigned set', async () => {
    mockListPods.mockResolvedValue(stalwartOn('server-2'));
    const { validateModeSwitchAgainstDb } = await import('./port-exposure.js');
    const err = await validateModeSwitchAgainstDb('assignedMailNodes', buildDb(null), undefined);
    expect(err).toContain("active mail node 'server-2'");
  });

  it('still REFUSES when no source knows the active node', async () => {
    const { validateModeSwitchAgainstDb } = await import('./port-exposure.js');
    const err = await validateModeSwitchAgainstDb('assignedMailNodes', buildDb(null), undefined);
    expect(err).toContain('no active mail node is set');
  });
});
