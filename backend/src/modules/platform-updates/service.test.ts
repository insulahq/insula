import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── DB Mock ────────────────────────────────────────────────────────────────
const settingsStore = new Map<string, string>();

function buildSelectChain(key: string) {
  const row = settingsStore.has(key) ? { key, value: settingsStore.get(key)! } : undefined;
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(row ? [row] : []),
    }),
  };
}

const mockDb = {
  select: vi.fn().mockImplementation(() => ({
    from: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation((_condition: unknown) => {
        // The condition encodes the key — we inspect the last setSetting/getSetting key via call tracking
        return Promise.resolve([]);
      }),
    })),
  })),
  insert: vi.fn().mockImplementation(() => ({
    values: vi.fn().mockImplementation(() => ({
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    })),
  })),
  update: vi.fn().mockImplementation(() => ({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  })),
};

// More precise DB mock: intercept eq() calls to track keys
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, value: unknown) => ({ _type: 'eq', value })),
}));

vi.mock('../../db/schema.js', () => ({
  platformSettings: {
    key: 'platformSettings.key',
    value: 'platformSettings.value',
  },
}));

// ─── Rebuild mock DB with key tracking ──────────────────────────────────────
function createTrackedDb() {
  const db = {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation((condition: { _type: string; value: string }) => {
          const key = condition?.value as string;
          const stored = settingsStore.get(key);
          return Promise.resolve(stored !== undefined ? [{ key, value: stored }] : []);
        }),
      })),
    })),
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((vals: { key: string; value: string }) => ({
        onConflictDoUpdate: vi.fn().mockImplementation(() => {
          settingsStore.set(vals.key, vals.value);
          return Promise.resolve(undefined);
        }),
      })),
    })),
  };
  return db as unknown as import('../../db/index.js').Database;
}

// ─── Module Under Test ──────────────────────────────────────────────────────
let getVersionInfo: typeof import('./service.js').getVersionInfo;
let updateSettings: typeof import('./service.js').updateSettings;
let getCapacityCheck: typeof import('./service.js').getCapacityCheck;
let triggerUpdate: typeof import('./service.js').triggerUpdate;
let persistInstalledVersion: typeof import('./service.js').persistInstalledVersion;

let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  settingsStore.clear();
  originalFetch = globalThis.fetch;
  // service.ts reads PLATFORM_VERSION at module load, so set it before
  // importing. '0.1.0' matches the pre-refactor fallback default so
  // existing "should detect update available" expectations still hold.
  process.env.PLATFORM_VERSION = '0.1.0';
  process.env.PLATFORM_ENV = 'production';
  vi.resetModules();
  const mod = await import('./service.js');
  getVersionInfo = mod.getVersionInfo;
  updateSettings = mod.updateSettings;
  getCapacityCheck = mod.getCapacityCheck;
  triggerUpdate = mod.triggerUpdate;
  persistInstalledVersion = mod.persistInstalledVersion;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('platform-updates service', () => {
  describe('getVersionInfo', () => {
    it('should return correct structure with mocked fetch', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: 'v1.2.0' }),
      });

      const db = createTrackedDb();
      const result = await getVersionInfo(db);

      expect(result).toHaveProperty('currentVersion');
      expect(result).toHaveProperty('latestVersion');
      expect(result).toHaveProperty('latestSource');
      expect(result).toHaveProperty('updateAvailable');
      expect(result).toHaveProperty('environment');
      expect(result).toHaveProperty('autoUpdate');
      expect(result).toHaveProperty('lastCheckedAt');
      expect(result.latestVersion).toBe('1.2.0');
      expect(result.latestSource).toBe('releases');
    });

    it('should fall back to tags when releases endpoint returns 404', async () => {
      // First call (releases) → 404; second call (tags) → valid list.
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([{ name: 'v0.5.0' }, { name: 'v0.4.2' }]),
        });

      const db = createTrackedDb();
      const result = await getVersionInfo(db);

      expect(result.latestVersion).toBe('0.5.0');
      expect(result.latestSource).toBe('tags');
    });

    it('should report none when both releases and tags are empty', async () => {
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });

      const db = createTrackedDb();
      const result = await getVersionInfo(db);

      expect(result.latestVersion).toBeNull();
      expect(result.latestSource).toBe('none');
      expect(result.updateAvailable).toBe(false);
    });

    it('should detect update available when latest > current', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: 'v2.0.0' }),
      });

      const db = createTrackedDb();
      const result = await getVersionInfo(db);

      expect(result.updateAvailable).toBe(true);
      expect(result.latestVersion).toBe('2.0.0');
    });

    it('should not mark update available when latest equals current', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: 'v0.1.0' }),
      });

      const db = createTrackedDb();
      const result = await getVersionInfo(db);

      expect(result.updateAvailable).toBe(false);
    });

    it('should use cached version when fetch fails', async () => {
      settingsStore.set('latest_version', '1.5.0');
      settingsStore.set('last_update_check', new Date(Date.now() - 10 * 60 * 1000).toISOString());

      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const db = createTrackedDb();
      const result = await getVersionInfo(db);

      expect(result.latestVersion).toBe('1.5.0');
    });
  });

  describe('version spine — installed / running / available', () => {
    it('getVersionInfo exposes running (env), available (latest) and installed', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: 'v2026.7.1' }),
      });
      const db = createTrackedDb();
      const result = await getVersionInfo(db);

      expect(result.running).toBe('0.1.0');          // = PLATFORM_VERSION env
      expect(result.available).toBe('2026.7.1');      // = latestVersion
      expect(result.installed).toBe('0.1.0');         // no DB row → running fallback
    });

    it('installed falls back to the running version when no DB row exists', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) });
      const db = createTrackedDb();
      const result = await getVersionInfo(db);
      expect(result.installed).toBe('0.1.0');
    });

    it('installed reflects the persisted DB row over the running env', async () => {
      settingsStore.set('installed_platform_version', '2026.5.3');
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) });
      const db = createTrackedDb();
      const result = await getVersionInfo(db);
      expect(result.installed).toBe('2026.5.3');
      expect(result.running).toBe('0.1.0');           // env unchanged
    });

    // W11 verified-poller surfaces — `available` prefers the cosign-VERIFIED value.
    it('prefers the verified available_version over the unverified latestVersion', async () => {
      // Lazy checker would see 2026.7.1; the poller has VERIFIED 2026.6.9.
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ tag_name: 'v2026.7.1' }) });
      settingsStore.set('available_version', '2026.6.9');
      settingsStore.set('available_verified_at', '2026-06-03T07:00:00.000Z');
      settingsStore.set('available_verify_status', 'verified');
      const db = createTrackedDb();
      const result = await getVersionInfo(db);
      expect(result.available).toBe('2026.6.9');               // verified wins
      expect(result.availableVerifiedAt).toBe('2026-06-03T07:00:00.000Z');
      expect(result.availableVerifyStatus).toBe('verified');
      expect(result.updateAvailable).toBe(true);               // 2026.6.9 > 0.1.0
    });

    it('falls back to latestVersion when no verified available_version exists', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ tag_name: 'v2026.7.1' }) });
      settingsStore.set('available_verify_status', 'unsigned'); // poller refused → no available_version
      const db = createTrackedDb();
      const result = await getVersionInfo(db);
      expect(result.available).toBe('2026.7.1');               // unverified fallback
      expect(result.availableVerifyStatus).toBe('unsigned');
    });

    it('ignores a malformed persisted available_version and falls back', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ tag_name: 'v2026.7.1' }) });
      settingsStore.set('available_version', 'not-a-version');
      const db = createTrackedDb();
      const result = await getVersionInfo(db);
      expect(result.available).toBe('2026.7.1');               // bad value rejected → fallback
    });

    it('surfaces includePrereleases from platform_settings', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) });
      settingsStore.set('auto_update_include_prereleases', 'true');
      const db = createTrackedDb();
      const result = await getVersionInfo(db);
      expect(result.includePrereleases).toBe(true);
    });

    it('persistInstalledVersion writes the running version to platform_settings', async () => {
      const db = createTrackedDb();
      const written = await persistInstalledVersion(db);
      expect(written).toBe('0.1.0');
      expect(settingsStore.get('installed_platform_version')).toBe('0.1.0');
    });

    it('persistInstalledVersion is a no-op when the running version is unknown', async () => {
      const saved = process.env.PLATFORM_VERSION;
      try {
        process.env.PLATFORM_VERSION = 'unknown';
        vi.resetModules();
        const mod = await import('./service.js');
        const db = createTrackedDb();
        const written = await mod.persistInstalledVersion(db);
        expect(written).toBeNull();
        expect(settingsStore.has('installed_platform_version')).toBe(false);
      } finally {
        process.env.PLATFORM_VERSION = saved;
      }
    });

    it('persistInstalledVersion rejects a malformed (leading-zero / four-part) version', async () => {
      for (const bad of ['2026.06.1', '1.2.3.4', '2026.6']) {
        const saved = process.env.PLATFORM_VERSION;
        try {
          process.env.PLATFORM_VERSION = bad;
          vi.resetModules();
          const mod = await import('./service.js');
          settingsStore.clear();
          expect(await mod.persistInstalledVersion(createTrackedDb())).toBeNull();
          expect(settingsStore.has('installed_platform_version')).toBe(false);
        } finally {
          process.env.PLATFORM_VERSION = saved;
        }
      }
    });
  });

  describe('updateSettings', () => {
    it('should store auto_update setting and return it', async () => {
      const db = createTrackedDb();
      const result = await updateSettings(db, true);

      expect(result).toEqual({ autoUpdate: true, includePrereleases: false });
      expect(settingsStore.get('auto_update')).toBe('true');
    });

    it('should store false value', async () => {
      const db = createTrackedDb();
      const result = await updateSettings(db, false);

      expect(result).toEqual({ autoUpdate: false, includePrereleases: false });
      expect(settingsStore.get('auto_update')).toBe('false');
    });

    it('persists includePrereleases when provided and echoes it back', async () => {
      const db = createTrackedDb();
      const result = await updateSettings(db, true, true);

      expect(result).toEqual({ autoUpdate: true, includePrereleases: true });
      expect(settingsStore.get('auto_update_include_prereleases')).toBe('true');
    });
  });

  describe('getCapacityCheck', () => {
    it('should return fits=true when resources are sufficient', async () => {
      const db = createTrackedDb();
      settingsStore.set('node_cpu_total', '4');
      settingsStore.set('node_memory_total', '8Gi');
      settingsStore.set('node_storage_total', '80Gi');

      const result = await getCapacityCheck(db, '500m', '1Gi', '10Gi');

      expect(result.fits).toBe(true);
      expect(result.requestedCpu).toBe(0.5);
      expect(result.requestedMemory).toBe(1);
      expect(result.requestedStorage).toBe(10);
      expect(result.totalCpu).toBe(4);
      expect(result.totalMemory).toBe(8);
      expect(result.totalStorage).toBe(80);
      expect(result.warnings).toEqual([]);
    });

    it('should return fits=false when CPU exceeds capacity', async () => {
      const db = createTrackedDb();
      settingsStore.set('node_cpu_total', '2');
      settingsStore.set('node_memory_total', '8Gi');
      settingsStore.set('node_storage_total', '80Gi');

      const result = await getCapacityCheck(db, '4', '1Gi', '10Gi');

      expect(result.fits).toBe(false);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('CPU');
    });

    it('should return fits=false when memory exceeds capacity', async () => {
      const db = createTrackedDb();
      settingsStore.set('node_cpu_total', '4');
      settingsStore.set('node_memory_total', '4Gi');
      settingsStore.set('node_storage_total', '80Gi');

      const result = await getCapacityCheck(db, '500m', '8Gi', '10Gi');

      expect(result.fits).toBe(false);
      expect(result.warnings.some((w: string) => w.includes('memory'))).toBe(true);
    });

    it('should return fits=false when storage exceeds capacity', async () => {
      const db = createTrackedDb();
      settingsStore.set('node_cpu_total', '4');
      settingsStore.set('node_memory_total', '8Gi');
      settingsStore.set('node_storage_total', '20Gi');

      const result = await getCapacityCheck(db, '500m', '1Gi', '30Gi');

      expect(result.fits).toBe(false);
      expect(result.warnings.some((w: string) => w.includes('storage'))).toBe(true);
    });

    it('should use defaults when settings not in DB', async () => {
      const db = createTrackedDb();

      const result = await getCapacityCheck(db, '1', '2Gi', '10Gi');

      // defaults: 4 CPU, 8Gi memory, 80Gi storage
      expect(result.totalCpu).toBe(4);
      expect(result.totalMemory).toBe(8);
      expect(result.totalStorage).toBe(80);
      expect(result.fits).toBe(true);
    });

    it('should parse millicores CPU values', async () => {
      const db = createTrackedDb();

      const result = await getCapacityCheck(db, '2000m', '1Gi', '1Gi');

      expect(result.requestedCpu).toBe(2);
    });

    it('should parse Mi memory values', async () => {
      const db = createTrackedDb();

      const result = await getCapacityCheck(db, '500m', '512Mi', '1Gi');

      expect(result.requestedMemory).toBe(0.5);
    });
  });

  describe('triggerUpdate', () => {
    it('should return "Already up to date" when no update available', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: 'v0.1.0' }),
      });

      const db = createTrackedDb();
      const result = await triggerUpdate(db);

      expect(result.message).toBe('Already up to date');
    });

    it('should set pending_update_version when update is available', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: 'v3.0.0' }),
      });

      const db = createTrackedDb();
      const result = await triggerUpdate(db);

      expect(result.message).toBe('Update initiated — will be applied on next reconciliation cycle');
      expect(result.targetVersion).toBe('3.0.0');
      expect(settingsStore.get('pending_update_version')).toBe('3.0.0');
    });
  });
});
