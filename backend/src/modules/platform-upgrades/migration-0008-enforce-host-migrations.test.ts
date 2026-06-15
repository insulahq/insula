import { describe, it, expect, vi } from 'vitest';
import { enforceHostMigrationsDesired } from './migrations/0008_enforce_host_migrations_desired.js';
import type { PlatformMigrationContext } from './registry/types.js';

type CMStore = Map<string, Record<string, string>>;
const NAME = 'host-migrations-desired';

/** Fake CoreV1Api over an in-memory ConfigMap store (read + merge-patch + create). */
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
    createNamespacedConfigMap: vi.fn(async ({ body }: { body: { metadata: { name: string }; data: Record<string, string> } }) => {
      store.set(body.metadata.name, { ...body.data });
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

const patchCalls = (k8s: NonNullable<PlatformMigrationContext['k8s']>) =>
  (k8s.core.patchNamespacedConfigMap as ReturnType<typeof vi.fn>).mock.calls;
const createCalls = (k8s: NonNullable<PlatformMigrationContext['k8s']>) =>
  (k8s.core.createNamespacedConfigMap as ReturnType<typeof vi.fn>).mock.calls;

describe('0008_enforce_host_migrations_desired', () => {
  it('flips the seeded observe default → enforce (preserving _note)', async () => {
    const store: CMStore = new Map([[NAME, { mode: 'observe', _note: 'keep me' }]]);
    const k8s = fakeK8s(store);
    await enforceHostMigrationsDesired.up(ctx({ k8s }));

    expect(store.get(NAME)!.mode).toBe('enforce');
    expect(store.get(NAME)!._note).toBe('keep me'); // only the mode key patched
    expect(patchCalls(k8s).length).toBe(1);
  });

  it('already enforce → no-op (no patch)', async () => {
    const store: CMStore = new Map([[NAME, { mode: 'enforce' }]]);
    const k8s = fakeK8s(store);
    await enforceHostMigrationsDesired.up(ctx({ k8s }));

    expect(patchCalls(k8s).length).toBe(0);
    expect(createCalls(k8s).length).toBe(0);
  });

  it('an operator-set custom mode is left intact (not flipped)', async () => {
    const store: CMStore = new Map([[NAME, { mode: 'report-only' }]]);
    const k8s = fakeK8s(store);
    const log = { info: vi.fn(), warn: vi.fn() };
    await enforceHostMigrationsDesired.up(ctx({ k8s, log }));

    expect(store.get(NAME)!.mode).toBe('report-only');
    expect(patchCalls(k8s).length).toBe(0);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("operator-set mode 'report-only'"));
  });

  it('a wholesale-absent CM is recreated mode: enforce', async () => {
    const store: CMStore = new Map(); // deleted
    const k8s = fakeK8s(store);
    await enforceHostMigrationsDesired.up(ctx({ k8s }));

    expect(createCalls(k8s).length).toBe(1);
    expect(store.get(NAME)!.mode).toBe('enforce');
  });

  it('dry-run mutates nothing and logs the intended change', async () => {
    const store: CMStore = new Map([[NAME, { mode: 'observe' }]]);
    const k8s = fakeK8s(store);
    const log = { info: vi.fn(), warn: vi.fn() };
    await enforceHostMigrationsDesired.up(ctx({ k8s, dryRun: true, log }));

    expect(patchCalls(k8s).length).toBe(0);
    expect(createCalls(k8s).length).toBe(0);
    expect(store.get(NAME)!.mode).toBe('observe');
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('would set'));
  });

  it('is idempotent — a second run patches nothing more', async () => {
    const store: CMStore = new Map([[NAME, { mode: 'observe' }]]);
    const k8s = fakeK8s(store);
    await enforceHostMigrationsDesired.up(ctx({ k8s }));
    await enforceHostMigrationsDesired.up(ctx({ k8s }));
    expect(patchCalls(k8s).length).toBe(1); // only the first run patched
  });

  it('no k8s client → no-op, no throw', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    await expect(enforceHostMigrationsDesired.up(ctx({ k8s: null, log }))).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('no k8s client'));
  });

  it('a real (non-404) API error propagates so the runner halts + retries', async () => {
    const k8s = fakeK8s(new Map());
    (k8s.core.readNamespacedConfigMap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('boom'), { statusCode: 500 }),
    );
    await expect(enforceHostMigrationsDesired.up(ctx({ k8s }))).rejects.toThrow(/boom/);
  });

  it('declares id matching the filename + the shipping version', () => {
    expect(enforceHostMigrationsDesired.id).toBe('0008_enforce_host_migrations_desired');
    expect(enforceHostMigrationsDesired.version).toBe('2026.6.9');
  });
});
