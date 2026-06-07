import { describe, it, expect, vi } from 'vitest';
import {
  ensureHostDesiredConfigMaps,
  HOST_DESIRED_CONFIGMAPS,
  DESIRED_NAMESPACE,
} from './host-desired-state.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { MigrationLogger } from './registry/types.js';

type CMStore = Map<string, Record<string, string>>;

function fakeK8s(store: CMStore, opts: { failRead?: string; failCreate?: string } = {}) {
  const core = {
    readNamespacedConfigMap: vi.fn(async ({ name }: { name: string }) => {
      if (opts.failRead === name) throw Object.assign(new Error('boom-read'), { statusCode: 500 });
      if (!store.has(name)) throw Object.assign(new Error('not found'), { statusCode: 404 });
      return { data: { ...store.get(name) } };
    }),
    createNamespacedConfigMap: vi.fn(async ({ body }: { body: { metadata: { name: string }; data: Record<string, string> } }) => {
      const name = body.metadata.name;
      if (opts.failCreate === name) throw Object.assign(new Error('boom-create'), { statusCode: 500 });
      store.set(name, { ...body.data });
      return {};
    }),
  };
  return { k8s: { core } as unknown as K8sClients, core };
}

function log(): MigrationLogger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn() };
}

describe('ensureHostDesiredConfigMaps', () => {
  it('creates all desired ConfigMaps when none exist', async () => {
    const store: CMStore = new Map();
    const { k8s, core } = fakeK8s(store);
    const result = await ensureHostDesiredConfigMaps(k8s, log());

    expect(result.created.sort()).toEqual(HOST_DESIRED_CONFIGMAPS.map((c) => c.name).sort());
    expect(core.createNamespacedConfigMap).toHaveBeenCalledTimes(HOST_DESIRED_CONFIGMAPS.length);
    // every created CM lands in the right namespace
    for (const call of core.createNamespacedConfigMap.mock.calls) {
      expect((call[0] as { namespace: string }).namespace).toBe(DESIRED_NAMESPACE);
    }
  });

  it('restores a deleted host-config-desired with the canonical BBR content', async () => {
    // everything present except host-config-desired (the reported anomaly)
    const store: CMStore = new Map(
      HOST_DESIRED_CONFIGMAPS.filter((c) => c.name !== 'host-config-desired').map((c) => [c.name, c.data]),
    );
    const { k8s } = fakeK8s(store);
    const result = await ensureHostDesiredConfigMaps(k8s, log());

    expect(result.created).toEqual(['host-config-desired']);
    const sysctls = store.get('host-config-desired')!.sysctls;
    expect(sysctls).toContain('net.ipv4.tcp_congestion_control = bbr');
    expect(sysctls).toContain('net.core.default_qdisc = fq');
    // baseline defaults preserved alongside BBR
    expect(sysctls).toContain('net.core.somaxconn = 1024');
  });

  it('never overwrites an existing (operator-edited) ConfigMap', async () => {
    const store: CMStore = new Map(
      HOST_DESIRED_CONFIGMAPS.map((c) => [c.name, c.data]),
    );
    // operator pinned cubic
    store.set('host-config-desired', { sysctls: 'net.ipv4.tcp_congestion_control = cubic\n' });
    const { k8s, core } = fakeK8s(store);
    const result = await ensureHostDesiredConfigMaps(k8s, log());

    expect(result.created).toEqual([]);
    expect(core.createNamespacedConfigMap).not.toHaveBeenCalled();
    expect(store.get('host-config-desired')!.sysctls).toBe('net.ipv4.tcp_congestion_control = cubic\n');
  });

  it('every restored gating policy is mode: observe (never auto-enforce)', async () => {
    const store: CMStore = new Map();
    const { k8s } = fakeK8s(store);
    await ensureHostDesiredConfigMaps(k8s, log());
    for (const name of ['host-packages-desired', 'host-migrations-desired', 'host-ulimits-desired', 'host-modules-desired']) {
      expect(store.get(name)!.mode).toBe('observe');
    }
  });

  it('no k8s client → no-op, no throw', async () => {
    const l = log();
    const result = await ensureHostDesiredConfigMaps(null, l);
    expect(result.created).toEqual([]);
    expect(l.info).toHaveBeenCalledWith(expect.stringContaining('no k8s client'));
  });

  it('dry-run reports would-create but writes nothing', async () => {
    const store: CMStore = new Map();
    const { k8s, core } = fakeK8s(store);
    const result = await ensureHostDesiredConfigMaps(k8s, log(), { dryRun: true });
    expect(result.created.length).toBe(HOST_DESIRED_CONFIGMAPS.length);
    expect(core.createNamespacedConfigMap).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it('isolates a per-ConfigMap error — the others still get created', async () => {
    const store: CMStore = new Map();
    const l = log();
    // creating host-config-desired blows up; the rest must still be created
    const { k8s } = fakeK8s(store, { failCreate: 'host-config-desired' });
    const result = await ensureHostDesiredConfigMaps(k8s, l);

    expect(result.created).not.toContain('host-config-desired');
    expect(result.created.length).toBe(HOST_DESIRED_CONFIGMAPS.length - 1);
    expect(l.warn).toHaveBeenCalledWith(expect.stringContaining('could not ensure host-config-desired'), expect.anything());
  });

  it('is idempotent — a second pass creates nothing', async () => {
    const store: CMStore = new Map();
    const { k8s, core } = fakeK8s(store);
    await ensureHostDesiredConfigMaps(k8s, log());
    const callsAfterFirst = core.createNamespacedConfigMap.mock.calls.length;
    const second = await ensureHostDesiredConfigMaps(k8s, log());
    expect(second.created).toEqual([]);
    expect(core.createNamespacedConfigMap.mock.calls.length).toBe(callsAfterFirst);
  });
});
