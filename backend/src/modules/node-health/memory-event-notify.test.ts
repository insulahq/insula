import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../notifications/events.js', () => ({
  notifyAdminNodeMemoryEvents: vi.fn(async () => undefined),
  notifyAdminTenantOom: vi.fn(async () => undefined),
  notifyAdminSystemPodOom: vi.fn(async () => undefined),
}));

import {
  notifyAdminNodeMemoryEvents,
  notifyAdminSystemPodOom,
  notifyAdminTenantOom,
} from '../notifications/events.js';
import { describeContainerKill, notifyMemoryEvents, summarizeNodeEvents } from './memory-event-notify.js';
import { normalizeMemoryEvents, type NormalizedMemoryEvent } from './memory-events.js';
import type { Database } from '../../db/index.js';

const NOW = new Date('2026-10-02T13:17:00Z');
const db = {} as Database;

function kill(over: Partial<NormalizedMemoryEvent> = {}): NormalizedMemoryEvent {
  return {
    dedupeKey: 'oomk:uid-1:static-nginx:1:1',
    kind: 'container-oom',
    cause: 'memory-limit',
    nodeName: 'node-a',
    namespace: 'tenant-acme',
    podName: 'my-nginx-pod',
    containerName: 'static-nginx',
    systemWorkload: false,
    platformManaged: false,
    podUid: 'uid-1',
    restartCount: 1,
    message: '',
    occurredAt: new Date('2026-10-02T13:14:28Z'),
    ...over,
  };
}

function evicted(uid: string, message: string, ns = 'tenant-acme', pod = `web-${uid}`) {
  return {
    reason: 'Evicted', message, involvedObject: { kind: 'Pod', name: pod, namespace: ns },
    source: { host: 'node-a' }, metadata: { uid }, lastTimestamp: '2026-10-02T13:10:00Z',
  };
}

const acme = { id: 'tenant-uuid-acme', name: 'Acme Corp' };
const ctx = {
  now: NOW,
  tenantFor: (ns: string) => (ns === 'tenant-acme' ? acme : undefined),
  isNotificationSuppressed: () => false,
};

beforeEach(() => {
  vi.mocked(notifyAdminNodeMemoryEvents).mockClear();
  vi.mocked(notifyAdminTenantOom).mockClear();
  vi.mocked(notifyAdminSystemPodOom).mockClear();
});

describe('notifyMemoryEvents — one alert per kill, in the category it belongs to', () => {
  it('a tenant container OOM is ONE tenant alert and NOT an eviction alert (production 2026-10-02)', async () => {
    await notifyMemoryEvents(db, [kill()], ctx);
    expect(notifyAdminNodeMemoryEvents).not.toHaveBeenCalled();
    expect(notifyAdminSystemPodOom).not.toHaveBeenCalled();
    expect(notifyAdminTenantOom).toHaveBeenCalledTimes(1);
    const [, tenantId, payload, dedupeKey] = vi.mocked(notifyAdminTenantOom).mock.calls[0];
    expect(tenantId).toBe('tenant-uuid-acme');
    expect(payload).toMatchObject({
      tenantLabel: 'Acme Corp', podName: 'my-nginx-pod', containerName: 'static-nginx',
      restartCount: '1', killSummary: 'OOM-killed at its memory limit',
    });
    // Same key the retired hourly scan used: a kill it already announced
    // before the upgrade is not announced again.
    expect(dedupeKey).toBe('oom:tenant-uuid-acme:my-nginx-pod:static-nginx:1');
  });

  it('a platform container kill goes to the platform category, naming the namespace', async () => {
    await notifyMemoryEvents(db, [kill({
      namespace: 'monitoring', podName: 'vmsingle-pod', containerName: 'vmsingle',
      systemWorkload: true, podUid: 'uid-vm',
    })], ctx);
    expect(notifyAdminTenantOom).not.toHaveBeenCalled();
    expect(notifyAdminNodeMemoryEvents).not.toHaveBeenCalled();
    const [, payload, dedupeKey] = vi.mocked(notifyAdminSystemPodOom).mock.calls[0];
    expect(payload).toMatchObject({ component: 'monitoring', containerName: 'vmsingle', nodeName: 'node-a' });
    expect(dedupeKey).toContain('platform-oom:uid-vm:vmsingle:1:');
  });

  it('a platform-sized pod in a tenant namespace is a platform kill that names the tenant', async () => {
    await notifyMemoryEvents(db, [kill({ podName: 'file-manager-x', containerName: 'file-manager', systemWorkload: true, platformManaged: true })], ctx);
    expect(notifyAdminTenantOom).not.toHaveBeenCalled();
    expect(vi.mocked(notifyAdminSystemPodOom).mock.calls[0][1].component).toBe('platform component in tenant "Acme Corp"');
  });

  it('evictions and kills in one tick: one node alert for the evictions, one per kill', async () => {
    const evictions = normalizeMemoryEvents([evicted('e1', 'The node was low on resource: memory. ')], [], NOW);
    await notifyMemoryEvents(db, [...evictions, kill()], ctx);
    expect(notifyAdminNodeMemoryEvents).toHaveBeenCalledTimes(1);
    expect(notifyAdminTenantOom).toHaveBeenCalledTimes(1);
    const [, severity, payload] = vi.mocked(notifyAdminNodeMemoryEvents).mock.calls[0];
    expect(severity).toBe('warning');
    expect(payload.headline).toBe('Tenant pods evicted (node memory pressure)');
    // The eviction alert must not mention the OOM kill.
    expect(payload.summary).not.toContain('static-nginx');
  });

  it('holds everything on a joining node', async () => {
    const evictions = normalizeMemoryEvents([evicted('e1', 'The node was low on resource: memory. ')], [], NOW);
    await notifyMemoryEvents(db, [...evictions, kill()], { ...ctx, isNotificationSuppressed: () => true });
    expect(notifyAdminNodeMemoryEvents).not.toHaveBeenCalled();
    expect(notifyAdminTenantOom).not.toHaveBeenCalled();
  });

  it('falls back to the namespace when the tenant row is gone', async () => {
    await notifyMemoryEvents(db, [kill({ namespace: 'tenant-ghost' })], ctx);
    const [, tenantId, payload, dedupeKey] = vi.mocked(notifyAdminTenantOom).mock.calls[0];
    expect(tenantId).toBeUndefined();
    expect(payload.tenantLabel).toBe('tenant-ghost');
    expect(dedupeKey).toBe('oom:tenant-ghost:my-nginx-pod:static-nginx:1');
  });
});

describe('describeContainerKill — the words follow the evidence', () => {
  it('only a kernel-confirmed limit kill blames the limit', () => {
    expect(describeContainerKill('memory-limit', 'node-a', 'tenant').killDetail).toContain("kernel's own counters confirm");
    for (const c of ['node-oom', 'oom', 'unconfirmed'] as const) {
      expect(describeContainerKill(c, 'node-a', 'tenant').killSummary).not.toContain('at its memory limit');
    }
  });

  it('a node-level OOM says the limit is innocent', () => {
    const p = describeContainerKill('node-oom', 'node-a', 'tenant');
    expect(p.killDetail).toContain('node node-a ran out of memory');
    expect(p.killDetail).toContain('not because of its own limit');
  });

  it('an unconfirmed SIGKILL makes no OOM claim and gives no resize advice', () => {
    const p = describeContainerKill('unconfirmed', 'node-a', 'tenant');
    expect(p.killSummary).toBe('SIGKILLed (cause unconfirmed)');
    expect(p.killSummary).not.toMatch(/OOM/);
    expect(p.killDetail).toContain('UNCONFIRMED');
    expect(p.killDetail).not.toMatch(/raise/i);
  });

  it('platform kills point at the manifest, never at a tenant plan', () => {
    const p = describeContainerKill('memory-limit', 'node-a', 'platform');
    expect(p.killDetail).toContain('manifest');
    expect(p.killDetail).not.toContain('memory limit/plan');
  });

  it('no kill is ever worded as an eviction or memory pressure', () => {
    for (const c of ['memory-limit', 'node-oom', 'oom', 'unconfirmed'] as const) {
      for (const a of ['tenant', 'platform'] as const) {
        const p = describeContainerKill(c, 'node-a', a);
        expect(`${p.killSummary} ${p.killDetail}`).not.toMatch(/evict|memory pressure/i);
      }
    }
  });
});

describe('summarizeNodeEvents — evictions and node OOMs only', () => {
  it('ignores container kills entirely', () => {
    expect(summarizeNodeEvents([kill(), kill({ systemWorkload: true, namespace: 'platform' })])).toEqual([]);
  });

  it('names the resource in the headline: disk pressure is not memory pressure', () => {
    const [s] = summarizeNodeEvents(normalizeMemoryEvents(
      [evicted('d1', 'The node was low on resource: ephemeral-storage. Threshold quantity: 10%. ')], [], NOW));
    expect(s.headline).toBe('Tenant pods evicted (node disk pressure)');
    expect(s.headline).not.toMatch(/memory/i);
    expect(s.summary).toContain('low on disk');
  });

  it("a pod over its own storage limit is an eviction, but says the node is fine", () => {
    const [s] = summarizeNodeEvents(normalizeMemoryEvents(
      [evicted('s1', 'Pod ephemeral local storage usage exceeds the total limit of containers 1Mi. ')], [], NOW));
    expect(s.headline).toBe('Tenant pods evicted (pod ephemeral-storage limit exceeded)');
    expect(s.summary).toContain('the node itself is fine');
  });

  it('lists mixed causes and names tenants, pods and "+N more"', () => {
    const events = normalizeMemoryEvents([
      ...Array.from({ length: 5 }, (_, i) => evicted(`m${i}`, 'The node was low on resource: memory. ')),
      evicted('d1', 'The node had condition: [DiskPressure]. '),
    ], [], NOW);
    const [s] = summarizeNodeEvents(events, (ns) => (ns === 'tenant-acme' ? 'Acme Corp' : undefined));
    expect(s.severity).toBe('warning');
    expect(s.headline).toBe('Tenant pods evicted (node memory pressure, node disk pressure)');
    expect(s.summary).toContain('5 tenant pod(s) evicted (node memory pressure): tenant "Acme Corp" (pod web-m0)');
    expect(s.summary).toContain('+2 more');
    expect(s.summary).toContain('1 tenant pod(s) evicted (node disk pressure)');
    expect(s.summary).toContain('Monitoring -> Node health -> Memory events');
  });

  it('a kernel SystemOOM and a SYSTEM eviction are critical, worded as what they are', () => {
    const events = normalizeMemoryEvents(
      [evicted('p1', 'The node was low on resource: memory. ', 'platform', 'platform-api-x')],
      [{ reason: 'SystemOOM', message: 'System OOM encountered', involvedObject: { kind: 'Node', name: 'node-a' }, metadata: { uid: 'o1' }, lastTimestamp: '2026-10-02T13:10:00Z' }],
      NOW,
    );
    const [s] = summarizeNodeEvents(events);
    expect(s.severity).toBe('critical');
    expect(s.headline).toBe('Node ran out of memory (kernel OOM killer); SYSTEM pods evicted (node memory pressure)');
    expect(s.summary).toContain('platform (pod platform-api-x)');
    expect(s.summary).toContain('investigate node memory now');
  });
});
