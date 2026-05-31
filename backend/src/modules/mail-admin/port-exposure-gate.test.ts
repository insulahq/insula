import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * validateModeSwitchAgainstDb node-count gate (2026-05-31).
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

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromCluster() {}
    loadFromFile() {}
    makeApiClient(api: unknown) {
      const name = (api as { name?: string })?.name ?? '';
      if (name === 'CoreV1Api') {
        return { listNode: mockListNode };
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
function buildDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{
          primaryNode: 'server-0',
          secondaryNode: 'server-1',
          tertiaryNode: null,
          activeNode: 'server-0',
        }]),
      })),
    })),
  } as unknown as import('../../db/index.js').Database;
}

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

  it('ALWAYS allows activeNodeOnly even on a single-node cluster', async () => {
    mockListNode.mockResolvedValue({ items: nodes(1, 0) });
    const { validateModeSwitchAgainstDb } = await import('./port-exposure.js');
    const err = await validateModeSwitchAgainstDb('activeNodeOnly', buildDb(), undefined);
    expect(err).toBeNull();
  });
});
