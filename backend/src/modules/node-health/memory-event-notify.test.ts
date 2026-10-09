import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../notifications/events.js', () => ({
  notifyAdminNodeMemoryEvents: vi.fn(async () => undefined),
  notifyAdminTenantOom: vi.fn(async () => undefined),
  notifyAdminSystemPodOom: vi.fn(async () => undefined),
  notifyTenantWorkloadDiskLimit: vi.fn(async () => undefined),
}));

import {
  notifyAdminNodeMemoryEvents,
  notifyAdminSystemPodOom,
  notifyAdminTenantOom,
  notifyTenantWorkloadDiskLimit,
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
  vi.mocked(notifyTenantWorkloadDiskLimit).mockClear();
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

  it('dedupes node alerts per kind of event, so a new kind in the same hour still gets through', async () => {
    const storage = normalizeMemoryEvents([evicted('s1', 'Pod ephemeral local storage usage exceeds the total limit of containers 1Mi. ')], [], NOW);
    const disk = normalizeMemoryEvents([evicted('d1', 'The node was low on resource: ephemeral-storage. ')], [], NOW);
    await notifyMemoryEvents(db, storage, ctx);
    await notifyMemoryEvents(db, disk, ctx);
    const keys = vi.mocked(notifyAdminNodeMemoryEvents).mock.calls.map((c) => c[3]);
    expect(keys).toEqual([
      'node-memory:warning:node-a:pod-storage-limit:2026-10-02T13',
      'node-memory:warning:node-a:node-disk-pressure:2026-10-02T13',
    ]);
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
    expect(s.advice).toContain('low on disk');
  });

  it("a pod over its own storage limit is an eviction, but says the node is fine", () => {
    const [s] = summarizeNodeEvents(normalizeMemoryEvents(
      [evicted('s1', 'Pod ephemeral local storage usage exceeds the total limit of containers 1Mi. ')], [], NOW));
    expect(s.headline).toBe('Tenant pods evicted (pod ephemeral-storage limit exceeded)');
    expect(s.advice).toContain('the node itself is fine');
  });

  it('lists mixed causes and names tenants, pods and "+N more"', () => {
    const events = normalizeMemoryEvents([
      ...Array.from({ length: 5 }, (_, i) => evicted(`m${i}`, 'The node was low on resource: memory. ')),
      evicted('d1', 'The node had condition: [DiskPressure]. '),
    ], [], NOW);
    const [s] = summarizeNodeEvents(events, (ns) => (ns === 'tenant-acme' ? 'Acme Corp' : undefined));
    expect(s.severity).toBe('warning');
    expect(s.headline).toBe('Tenant pods evicted (node memory pressure, node disk pressure)');
    // One list item per evicted pod, the overflow counted per cause.
    expect(s.summary).toEqual([
      'tenant "Acme Corp" (pod web-m0) — evicted (node memory pressure)',
      'tenant "Acme Corp" (pod web-m1) — evicted (node memory pressure)',
      'tenant "Acme Corp" (pod web-m2) — evicted (node memory pressure)',
      '+2 more tenant pod(s) evicted (node memory pressure)',
      'tenant "Acme Corp" (pod web-d1) — evicted (node disk pressure)',
    ]);
    expect(s.advice).toContain('Monitoring -> Node health -> Memory events');
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
    expect(s.summary).toEqual([
      'Kernel SystemOOM (1 event) — the node itself ran out of memory',
      'platform (pod platform-api-x) — evicted (node memory pressure)',
    ]);
    expect(s.advice).toContain('investigate node memory now');
  });
});

describe('notifyMemoryEvents — the tenant is told when its app hit its local disk limit (R37)', () => {
  const limitMsg = 'Container wordpress exceeded its local ephemeral storage limit "2048Mi". ';

  it('sends the tenant one notice listing each restarted app, deduped per tenant per hour', async () => {
    const events = normalizeMemoryEvents([
      evicted('a1', limitMsg, 'tenant-acme', 'blog-7d4b9c8f6-x2x9z'),
      evicted('a2', limitMsg, 'tenant-acme', 'blog-7d4b9c8f6-b8b8b'),
      evicted('a3', 'Usage of EmptyDir volume "multihost-sessions" exceeds the limit "256Mi". ', 'tenant-acme', 'shop-6c5d4f7b8-q4q4q'),
    ], [], NOW);
    await notifyMemoryEvents(db, events, ctx);
    expect(notifyTenantWorkloadDiskLimit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyTenantWorkloadDiskLimit).mock.calls[0]).toEqual([
      db, 'tenant-uuid-acme', { workloads: ['blog (2048Mi limit)', 'shop (256Mi limit)'] }, 'disk-limit:tenant-uuid-acme:2026-10-02T13',
    ]);
    // The admin side still gets its node alert.
    expect(notifyAdminNodeMemoryEvents).toHaveBeenCalled();
  });

  it('does not tell a tenant about node pressure, nor anyone about a non-tenant namespace', async () => {
    await notifyMemoryEvents(db, normalizeMemoryEvents([
      evicted('p1', 'The node was low on resource: ephemeral-storage. ', 'tenant-acme'),
      evicted('p2', limitMsg, 'platform', 'platform-api-5f9c7b6d4-xb24c'),
    ], [], NOW), ctx);
    expect(notifyTenantWorkloadDiskLimit).not.toHaveBeenCalled();
  });

  it('holds the tenant notice on a joining node too', async () => {
    await notifyMemoryEvents(db, normalizeMemoryEvents([evicted('j1', limitMsg)], [], NOW), { ...ctx, isNotificationSuppressed: () => true });
    expect(notifyTenantWorkloadDiskLimit).not.toHaveBeenCalled();
  });
});
