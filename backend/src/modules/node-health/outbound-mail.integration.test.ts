/**
 * Node health judges each node's outbound mail ports from its security-probe
 * ConfigMap, end to end through the reconciler: the ConfigMap is read, the
 * result judged against mail placement (system_settings), persisted in
 * node_health_state.outbound_mail (migration 0175), served by the summary,
 * and a blocked port the node needs is announced with what it breaks.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../notifications/events.js', () => ({
  notifyAdminNodeDown: vi.fn().mockResolvedValue(undefined),
  notifyAdminNodeShuttingDown: vi.fn().mockResolvedValue(undefined),
  notifyAdminNodeStartupComplete: vi.fn().mockResolvedValue(undefined),
  notifyAdminOperationalEvent: vi.fn().mockResolvedValue(undefined),
  notifyAdminNodeMemoryEvents: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./kubelet-disk.js', () => ({ readNodeDiskStats: vi.fn().mockResolvedValue(new Map()) }));

import { eq } from 'drizzle-orm';
import { isDbAvailable, runMigrations, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { nodeHealthState, systemSettings } from '../../db/schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { readNodeHealthSummary, reconcileNodeHealth } from './scheduler.js';

const dbAvailable = await isDbAvailable();
const T0 = new Date('2026-11-04T12:00:00.000Z');

type Status = 'open' | 'blocked' | 'unknown';

function outboundMail(statuses: Record<number, Status>, checkedAt = new Date(T0.getTime() - 5 * 60_000)): string {
  return JSON.stringify({
    checkedAt: checkedAt.toISOString().replace('.000Z', 'Z'),
    intervalSeconds: 900,
    ports: Object.entries(statuses).map(([port, status]) => ({
      port: Number(port),
      status,
      target: status === 'open' ? 'smtp.example.test' : null,
      latencyMs: status === 'open' ? 10 : null,
      detail: status === 'open' ? null : 'smtp.example.test timed out after 5s',
    })),
  });
}

function k8s(probeData: Record<string, string> | null | Error): K8sClients {
  return {
    core: {
      listNode: vi.fn(async () => ({
        items: [{
          metadata: { name: 'node-2', creationTimestamp: new Date('2026-01-01T00:00:00Z') },
          status: {
            addresses: [{ type: 'InternalIP', address: '10.0.0.2' }],
            conditions: [{ type: 'Ready', status: 'True', lastTransitionTime: '2026-10-01T00:00:00Z' }],
            nodeInfo: { bootID: 'b1' },
          },
        }],
      })),
      listEventForAllNamespaces: vi.fn(async () => ({ items: [] })),
      listPodForAllNamespaces: vi.fn(async () => ({ items: [] })),
      listNamespacedConfigMap: vi.fn(async () => {
        if (probeData instanceof Error) throw probeData;
        return {
        items: probeData === null ? [] : [{
          metadata: { name: 'security-probe-node-2', labels: { app: 'security-probe', 'security-probe.platform/node': 'node-2' } },
          data: probeData,
        }],
        };
      }),
    },
    storage: { listCSINode: vi.fn(async () => ({ items: [] })) },
    custom: { listClusterCustomObject: vi.fn(async () => ({ items: [] })) },
  } as unknown as K8sClients;
}

describe.skipIf(!dbAvailable)('node health — outbound mail ports (integration)', () => {
  const db = () => getTestDb();
  const row = async () => (await db().select().from(nodeHealthState).where(eq(nodeHealthState.nodeName, 'node-2')))[0];
  const setMailPrimary = async (node: string | null) => {
    await db().insert(systemSettings).values({ id: 'system', mailPrimaryNode: node })
      .onConflictDoUpdate({ target: systemSettings.id, set: { mailPrimaryNode: node } });
  };

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => {
    await setMailPrimary(null);
    await closeTestDb();
  });
  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await db().delete(nodeHealthState);
    await setMailPrimary(null);
    const { notifyAdminOperationalEvent } = await import('../notifications/events.js');
    vi.mocked(notifyAdminOperationalEvent).mockClear();
  });

  it('a blocked submission port is persisted, served, and announced as a warning that says what it breaks', async () => {
    const { notifyAdminOperationalEvent } = await import('../notifications/events.js');
    await reconcileNodeHealth(db(), k8s({ outboundMail: outboundMail({ 25: 'open', 465: 'open', 587: 'blocked' }) }), T0);

    const r = await row();
    expect(r?.severity).toBe('warning');
    expect(r?.outboundMail?.ports.map((p) => [p.port, p.status, p.required])).toEqual([
      [25, 'open', false], [465, 'open', true], [587, 'blocked', true],
    ]);

    const summary = await readNodeHealthSummary(db());
    expect(summary.overallSeverity).toBe('warning');
    expect(summary.nodes[0]?.outboundMail).toMatchObject({ stale: false, ports: expect.any(Array) });

    const call = vi.mocked(notifyAdminOperationalEvent).mock.calls.at(-1);
    expect(call?.[1]).toBe('node');
    expect(call?.[2]).toMatchObject({
      objectLabel: 'node-2',
      severityLabel: 'warning',
      items: ['Outbound port 587 blocked — apps on this node cannot send mail through a mail server'],
    });
    expect((call?.[2] as { recommendedAction: string }).recommendedAction).toMatch(/unblock outbound TCP 25, 465 and 587/);
  });

  it('port 25 blocked counts only on a mail node', async () => {
    const probe = { outboundMail: outboundMail({ 25: 'blocked', 465: 'open', 587: 'open' }) };
    await reconcileNodeHealth(db(), k8s(probe), T0);
    expect((await row())?.severity).toBe('normal');

    await setMailPrimary('node-2');
    await reconcileNodeHealth(db(), k8s(probe), new Date(T0.getTime() + 5 * 60_000));
    const r = await row();
    expect(r?.severity).toBe('warning');
    expect(r?.outboundMail?.ports.find((p) => p.port === 25)).toMatchObject({ status: 'blocked', required: true });
  });

  it('no check reported (an older probe) is stored as null and judged nowhere', async () => {
    await reconcileNodeHealth(db(), k8s({ snapshot: '{}' }), T0);
    const r = await row();
    expect(r?.outboundMail).toBeNull();
    expect(r?.severity).toBe('normal');
    expect((await readNodeHealthSummary(db())).nodes[0]?.outboundMail).toBeNull();
  });

  it('a stale result is kept for the panel but no longer warns', async () => {
    const old = new Date(T0.getTime() - 2 * 60 * 60_000);
    await reconcileNodeHealth(db(), k8s({ outboundMail: outboundMail({ 587: 'blocked' }, old) }), T0);
    const r = await row();
    expect(r?.outboundMail?.stale).toBe(true);
    expect(r?.severity).toBe('normal');
  });

  it('a failed ConfigMap read keeps the last verdict: no "recovered" and no second warning', async () => {
    const { notifyAdminOperationalEvent } = await import('../notifications/events.js');
    await reconcileNodeHealth(db(), k8s({ outboundMail: outboundMail({ 465: 'open', 587: 'blocked' }) }), T0);
    expect((await row())?.severity).toBe('warning');
    const notices = vi.mocked(notifyAdminOperationalEvent).mock.calls.length;

    await reconcileNodeHealth(db(), k8s(new Error('apiserver unavailable')), new Date(T0.getTime() + 5 * 60_000));
    const r = await row();
    expect(r?.severity).toBe('warning');
    expect(r?.outboundMail?.ports.find((p) => p.port === 587)?.status).toBe('blocked');
    expect(vi.mocked(notifyAdminOperationalEvent).mock.calls.length).toBe(notices);

    // Still unreadable long after: the kept result goes stale on schedule, and
    // the node is no longer judged on it.
    await reconcileNodeHealth(db(), k8s(new Error('apiserver unavailable')), new Date(T0.getTime() + 2 * 60 * 60_000));
    expect((await row())?.outboundMail?.stale).toBe(true);
    expect((await row())?.severity).toBe('normal');
  });

  it('recovers to normal once the port opens', async () => {
    await reconcileNodeHealth(db(), k8s({ outboundMail: outboundMail({ 587: 'blocked' }) }), T0);
    expect((await row())?.severity).toBe('warning');
    await reconcileNodeHealth(db(), k8s({ outboundMail: outboundMail({ 587: 'open' }, T0) }), new Date(T0.getTime() + 5 * 60_000));
    expect((await row())?.severity).toBe('normal');
  });
});
