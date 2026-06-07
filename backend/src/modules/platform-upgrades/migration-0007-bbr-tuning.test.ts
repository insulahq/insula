import { describe, it, expect, vi } from 'vitest';
import { seedHostBbrTuning } from './migrations/0007_seed_host_bbr_tuning.js';
import type { PlatformMigrationContext } from './registry/types.js';

type CMStore = Map<string, Record<string, string>>;

/** Fake CoreV1Api over an in-memory ConfigMap store that honours RFC-7386 merge. */
function fakeK8s(store: CMStore) {
  const core = {
    readNamespacedConfigMap: vi.fn(async ({ name }: { name: string }) => {
      if (!store.has(name)) {
        const err = new Error('not found') as Error & { statusCode: number };
        err.statusCode = 404;
        throw err;
      }
      return { data: { ...store.get(name) } };
    }),
    // MERGE_PATCH semantics: set the provided data keys, preserve the rest.
    patchNamespacedConfigMap: vi.fn(async ({ name, body }: { name: string; body: { data: Record<string, string> } }) => {
      store.set(name, { ...(store.get(name) ?? {}), ...body.data });
      return {};
    }),
  };
  return { core } as unknown as NonNullable<PlatformMigrationContext['k8s']>;
}

function ctx(over: Partial<PlatformMigrationContext>): PlatformMigrationContext {
  return {
    db: {} as never,
    k8s: null,
    config: {},
    log: { info: vi.fn(), warn: vi.fn() },
    dryRun: false,
    ...over,
  };
}

const BBR_KEYS = [
  'net.ipv4.tcp_rmem',
  'net.ipv4.tcp_wmem',
  'net.ipv4.tcp_congestion_control',
  'net.core.default_qdisc',
];

function seededStore(): CMStore {
  return new Map([
    ['host-config-desired', { sysctls: 'net.core.somaxconn = 1024\n' }],
    ['host-modules-desired', { modules: '# header\n', mode: 'observe' }],
  ]);
}

describe('0007_seed_host_bbr_tuning', () => {
  it('adds all BBR sysctls + the tcp_bbr module to existing desired-state CMs', async () => {
    const store = seededStore();
    const k8s = fakeK8s(store);
    await seedHostBbrTuning.up(ctx({ k8s }));

    const sysctls = store.get('host-config-desired')!.sysctls;
    for (const k of BBR_KEYS) expect(sysctls).toContain(k);
    expect(sysctls).toContain('net.ipv4.tcp_congestion_control = bbr');
    expect(sysctls).toContain('net.core.default_qdisc = fq');
    // pre-existing key preserved
    expect(sysctls).toContain('net.core.somaxconn = 1024');

    expect(store.get('host-modules-desired')!.modules).toContain('tcp_bbr');
    // mode key untouched (never auto-enforce)
    expect(store.get('host-modules-desired')!.mode).toBe('observe');
  });

  it('is idempotent — a second run patches nothing', async () => {
    const store = seededStore();
    const k8s = fakeK8s(store);
    await seedHostBbrTuning.up(ctx({ k8s }));
    const callsAfterFirst = (k8s.core.patchNamespacedConfigMap as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterFirst).toBe(2); // config + modules

    await seedHostBbrTuning.up(ctx({ k8s }));
    const callsAfterSecond = (k8s.core.patchNamespacedConfigMap as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterSecond).toBe(2); // no further patches
  });

  it('does NOT clobber an operator-set congestion_control, but adds the missing keys', async () => {
    const store: CMStore = new Map([
      ['host-config-desired', { sysctls: 'net.ipv4.tcp_congestion_control = cubic\n' }],
      ['host-modules-desired', { modules: 'tcp_bbr\n', mode: 'enforce' }],
    ]);
    const k8s = fakeK8s(store);
    await seedHostBbrTuning.up(ctx({ k8s }));

    const sysctls = store.get('host-config-desired')!.sysctls;
    // operator's value kept verbatim — not flipped to bbr, not duplicated
    expect(sysctls).toContain('net.ipv4.tcp_congestion_control = cubic');
    expect(sysctls).not.toContain('net.ipv4.tcp_congestion_control = bbr');
    expect((sysctls.match(/tcp_congestion_control/g) ?? []).length).toBe(1);
    // the other three keys still get added
    expect(sysctls).toContain('net.ipv4.tcp_rmem');
    expect(sysctls).toContain('net.core.default_qdisc = fq');

    // module already present → modules CM not patched at all
    const modulePatches = (k8s.core.patchNamespacedConfigMap as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => (c[0] as { name: string }).name === 'host-modules-desired');
    expect(modulePatches.length).toBe(0);
  });

  it('dry-run mutates nothing and logs the intended changes', async () => {
    const store = seededStore();
    const k8s = fakeK8s(store);
    const log = { info: vi.fn(), warn: vi.fn() };
    await seedHostBbrTuning.up(ctx({ k8s, dryRun: true, log }));

    expect((k8s.core.patchNamespacedConfigMap as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('would add sysctls'));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('would add module'));
  });

  it('no k8s client → no-op, no throw', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    await expect(seedHostBbrTuning.up(ctx({ k8s: null, log }))).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('no k8s client'));
  });

  it('a missing CM is warned (not fatal) and the other CM is still processed', async () => {
    // only the modules CM exists; host-config-desired is 404
    const store: CMStore = new Map([['host-modules-desired', { modules: '', mode: 'observe' }]]);
    const k8s = fakeK8s(store);
    const log = { info: vi.fn(), warn: vi.fn() };
    await seedHostBbrTuning.up(ctx({ k8s, log }));

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('host-config-desired absent'));
    // modules CM still got tcp_bbr
    expect(store.get('host-modules-desired')!.modules).toContain('tcp_bbr');
  });

  it('the inverse — modules CM absent, config CM present — still patches sysctls', async () => {
    const store: CMStore = new Map([['host-config-desired', { sysctls: '' }]]);
    const k8s = fakeK8s(store);
    const log = { info: vi.fn(), warn: vi.fn() };
    await seedHostBbrTuning.up(ctx({ k8s, log }));

    expect(store.get('host-config-desired')!.sysctls).toContain('net.ipv4.tcp_congestion_control = bbr');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('host-modules-desired absent'));
  });

  it('a real (non-404) API error propagates so the runner halts + retries', async () => {
    const k8s = fakeK8s(new Map());
    (k8s.core.readNamespacedConfigMap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('boom'), { statusCode: 500 }),
    );
    await expect(seedHostBbrTuning.up(ctx({ k8s }))).rejects.toThrow(/boom/);
  });
});
