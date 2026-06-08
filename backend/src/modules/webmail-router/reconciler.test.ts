import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  reconcileWebmailIngress,
  reconcileEngineDeployments,
  reconcileStalwartCorsOrigin,
  serviceNameForEngine,
  isValidWebmailHostname,
  WEBMAIL_ENGINE_DISABLED_ANNOTATION,
} from './reconciler.js';
import type { Database } from '../../db/index.js';

vi.mock('../webmail-settings/service.js', () => ({
  getDefaultWebmailEngine: vi.fn(),
  getDefaultWebmailUrl: vi.fn(),
}));

import { getDefaultWebmailEngine, getDefaultWebmailUrl } from '../webmail-settings/service.js';

const DEFAULT_MATCH = 'Host(`webmail.example.com`)';

function makeCustom(currentService: string | null, fluxAnnotated = true, match: string = DEFAULT_MATCH) {
  const metadata = fluxAnnotated
    ? { annotations: { 'kustomize.toolkit.fluxcd.io/reconcile': 'disabled' } }
    : { annotations: {} };
  const irBody = currentService === null
    ? { metadata, spec: { routes: [{ match, services: [] }] } }
    : { metadata, spec: { routes: [{ match, services: [{ name: currentService, port: 80 }] }] } };
  return {
    getNamespacedCustomObject: vi.fn().mockResolvedValue(irBody),
    patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
  };
}

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const db = {} as unknown as Database;

describe('serviceNameForEngine', () => {
  it('maps roundcube → roundcube', () => {
    expect(serviceNameForEngine('roundcube')).toBe('roundcube');
  });
  it('maps bulwark → bulwark (upstream /api/auth/impersonate, no sidecar)', () => {
    expect(serviceNameForEngine('bulwark')).toBe('bulwark');
  });
});

describe('reconcileWebmailIngress', () => {
  beforeEach(() => {
    vi.mocked(getDefaultWebmailEngine).mockReset();
    vi.mocked(getDefaultWebmailUrl).mockReset();
    // Default: host matches the fixture's DEFAULT_MATCH so the Host doesn't
    // drift in engine-flip tests (isolates the service-flip behaviour).
    vi.mocked(getDefaultWebmailUrl).mockResolvedValue('https://webmail.example.com/');
  });

  it('patches the IR when engine=bulwark and current target is roundcube', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('bulwark');
    const custom = makeCustom('roundcube');
    const log = makeLog();

    const result = await reconcileWebmailIngress(db, custom as never, log);

    expect(result).toEqual({
      engine: 'bulwark',
      expectedService: 'bulwark',
      previousService: 'roundcube',
      expectedMatch: DEFAULT_MATCH,
      previousMatch: DEFAULT_MATCH,
      patched: true,
    });
    expect(custom.patchNamespacedCustomObject).toHaveBeenCalledOnce();
    const callArgs = custom.patchNamespacedCustomObject.mock.calls[0][0] as {
      body: { spec: { routes: Array<{ services: Array<{ name: string; port: number }> }> } };
    };
    expect(callArgs.body.spec.routes[0].services[0].name).toBe('bulwark');
    expect(callArgs.body.spec.routes[0].services[0].port).toBe(80);
  });

  it('no-ops when IR already targets the active engine', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('bulwark');
    const custom = makeCustom('bulwark');
    const log = makeLog();

    const result = await reconcileWebmailIngress(db, custom as never, log);

    expect(result).toEqual({
      engine: 'bulwark',
      expectedService: 'bulwark',
      previousService: 'bulwark',
      expectedMatch: DEFAULT_MATCH,
      previousMatch: DEFAULT_MATCH,
      patched: false,
    });
    expect(custom.patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('flips bulwark → roundcube symmetrically', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('roundcube');
    const custom = makeCustom('bulwark');
    const log = makeLog();

    const result = await reconcileWebmailIngress(db, custom as never, log);

    expect(result?.patched).toBe(true);
    expect(result?.expectedService).toBe('roundcube');
    const callArgs = custom.patchNamespacedCustomObject.mock.calls[0][0] as {
      body: { spec: { routes: Array<{ services: Array<{ name: string }> }> } };
    };
    expect(callArgs.body.spec.routes[0].services[0].name).toBe('roundcube');
  });

  it('returns null when the IR does not exist (non-fatal)', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('roundcube');
    const custom = {
      getNamespacedCustomObject: vi.fn().mockRejectedValue(
        Object.assign(new Error('not found'), { statusCode: 404 }),
      ),
      patchNamespacedCustomObject: vi.fn(),
    };
    const log = makeLog();

    const result = await reconcileWebmailIngress(db, custom as never, log);

    expect(result).toBeNull();
    expect(custom.patchNamespacedCustomObject).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it('re-patches when the Flux reconcile=disabled annotation is missing even if service matches', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('bulwark');
    // Service already correct, but annotation missing — must re-patch
    // to lock the resource against Flux reconciliation.
    const custom = makeCustom('bulwark', false);
    const log = makeLog();

    const result = await reconcileWebmailIngress(db, custom as never, log);

    expect(result?.patched).toBe(true);
    const body = custom.patchNamespacedCustomObject.mock.calls[0][0] as {
      body: { metadata: { annotations: Record<string, string> } };
    };
    expect(body.body.metadata.annotations).toEqual({
      'kustomize.toolkit.fluxcd.io/reconcile': 'disabled',
    });
  });

  it('preserves existing route fields (e.g. middlewares) when patching', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('bulwark');
    const custom = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { annotations: { 'kustomize.toolkit.fluxcd.io/reconcile': 'disabled' } },
        spec: {
          routes: [
            {
              match: 'Host(`webmail.example.com`)',
              kind: 'Rule',
              middlewares: [{ name: 'compress', namespace: 'traefik' }],
              services: [{ name: 'roundcube', port: 80 }],
            },
          ],
        },
      }),
      patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    };
    const log = makeLog();

    await reconcileWebmailIngress(db, custom as never, log);

    const body = custom.patchNamespacedCustomObject.mock.calls[0][0] as {
      body: {
        spec: {
          routes: Array<{
            match: string;
            middlewares: Array<{ name: string; namespace: string }>;
            services: Array<{ name: string }>;
          }>;
        };
      };
    };
    expect(body.body.spec.routes[0].match).toBe('Host(`webmail.example.com`)');
    expect(body.body.spec.routes[0].middlewares).toEqual([
      { name: 'compress', namespace: 'traefik' },
    ]);
    expect(body.body.spec.routes[0].services[0].name).toBe('bulwark');
  });

  it('patches the Host when default_webmail_url renames the webmail subdomain', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('bulwark');
    vi.mocked(getDefaultWebmailUrl).mockResolvedValue('https://abc.example.com/');
    const custom = makeCustom('bulwark'); // service already correct; only the host drifts
    const log = makeLog();

    const result = await reconcileWebmailIngress(db, custom as never, log);

    expect(result?.patched).toBe(true);
    expect(result?.expectedMatch).toBe('Host(`abc.example.com`)');
    expect(result?.previousMatch).toBe(DEFAULT_MATCH);
    const body = custom.patchNamespacedCustomObject.mock.calls[0][0] as {
      body: { spec: { routes: Array<{ match: string; services: Array<{ name: string }> }> } };
    };
    expect(body.body.spec.routes[0].match).toBe('Host(`abc.example.com`)');
    expect(body.body.spec.routes[0].services[0].name).toBe('bulwark');
  });

  it('leaves the live match untouched when default_webmail_url is an injection payload', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('bulwark');
    // Not a parseable URL host → resolveWebmailHostOrigin returns null.
    vi.mocked(getDefaultWebmailUrl).mockResolvedValue('https://x`)||Host(`evil.com/');
    const custom = makeCustom('bulwark'); // service correct, annotation present
    const log = makeLog();

    const result = await reconcileWebmailIngress(db, custom as never, log);

    // No service drift, no (safe) match resolved → nothing to patch.
    expect(result?.patched).toBe(false);
    expect(result?.expectedMatch).toBeNull();
    expect(custom.patchNamespacedCustomObject).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('isValidWebmailHostname', () => {
  it('accepts valid FQDNs', () => {
    expect(isValidWebmailHostname('webmail.example.com')).toBe(true);
    expect(isValidWebmailHostname('abc.staging.example.net')).toBe(true);
  });
  it('rejects single-label hosts, empties, and injection payloads', () => {
    expect(isValidWebmailHostname('localhost')).toBe(false);
    expect(isValidWebmailHostname('')).toBe(false);
    expect(isValidWebmailHostname('x`)||host(`evil.com')).toBe(false);
    expect(isValidWebmailHostname('a..b.com')).toBe(false);
  });
});

describe('reconcileStalwartCorsOrigin', () => {
  beforeEach(() => {
    vi.mocked(getDefaultWebmailUrl).mockReset();
    vi.mocked(getDefaultWebmailUrl).mockResolvedValue('https://webmail.example.com/');
  });

  function makeCorsMw(currentOrigin: string | null, fluxAnnotated = true) {
    const metadata = fluxAnnotated
      ? { annotations: { 'kustomize.toolkit.fluxcd.io/reconcile': 'disabled' } }
      : { annotations: {} };
    const headers = currentOrigin === null
      ? {}
      : { customResponseHeaders: { 'Access-Control-Allow-Origin': currentOrigin } };
    return {
      getNamespacedCustomObject: vi.fn().mockResolvedValue({ metadata, spec: { headers } }),
      patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    };
  }

  it('patches ACAO when it drifts from the webmail origin', async () => {
    const custom = makeCorsMw('https://OLD.example.com');
    const log = makeLog();
    const result = await reconcileStalwartCorsOrigin(db, custom as never, log);
    expect(result?.patched).toBe(true);
    expect(result?.expectedOrigin).toBe('https://webmail.example.com');
    const body = custom.patchNamespacedCustomObject.mock.calls[0][0] as {
      body: { spec: { headers: { customResponseHeaders: Record<string, string> } } };
    };
    expect(body.body.spec.headers.customResponseHeaders['Access-Control-Allow-Origin'])
      .toBe('https://webmail.example.com');
  });

  it('no-ops when ACAO already matches', async () => {
    const custom = makeCorsMw('https://webmail.example.com');
    const log = makeLog();
    const result = await reconcileStalwartCorsOrigin(db, custom as never, log);
    expect(result?.patched).toBe(false);
    expect(custom.patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('returns null when the Middleware is absent (non-fatal)', async () => {
    const custom = {
      getNamespacedCustomObject: vi.fn().mockRejectedValue(
        Object.assign(new Error('not found'), { statusCode: 404 }),
      ),
      patchNamespacedCustomObject: vi.fn(),
    };
    const log = makeLog();
    const result = await reconcileStalwartCorsOrigin(db, custom as never, log);
    expect(result).toBeNull();
    expect(custom.patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('skips (returns null) when default_webmail_url is invalid', async () => {
    vi.mocked(getDefaultWebmailUrl).mockResolvedValue('not a url');
    const custom = makeCorsMw('https://webmail.example.com');
    const log = makeLog();
    const result = await reconcileStalwartCorsOrigin(db, custom as never, log);
    expect(result).toBeNull();
    expect(custom.getNamespacedCustomObject).not.toHaveBeenCalled();
  });
});

describe('reconcileEngineDeployments', () => {
  function makeApps(opts: {
    activeName: string;
    activeReplicas?: number;
    activeAnnotated?: boolean;
    inactiveName: string;
    inactiveReplicas?: number;
    inactiveAnnotated?: boolean;
    activeMissing?: boolean;
    inactiveMissing?: boolean;
  }) {
    const readNs = vi.fn(({ name }: { name: string }) => {
      if (name === opts.activeName) {
        if (opts.activeMissing) {
          return Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 }));
        }
        return Promise.resolve({
          metadata: {
            annotations: opts.activeAnnotated
              ? { [WEBMAIL_ENGINE_DISABLED_ANNOTATION]: 'true' }
              : {},
          },
          spec: { replicas: opts.activeReplicas ?? 1 },
        });
      }
      if (name === opts.inactiveName) {
        if (opts.inactiveMissing) {
          return Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 }));
        }
        return Promise.resolve({
          metadata: {
            annotations: opts.inactiveAnnotated
              ? { [WEBMAIL_ENGINE_DISABLED_ANNOTATION]: 'true' }
              : {},
          },
          spec: { replicas: opts.inactiveReplicas ?? 1 },
        });
      }
      return Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 }));
    });
    return {
      readNamespacedDeployment: readNs,
      replaceNamespacedDeploymentScale: vi.fn().mockResolvedValue({}),
      patchNamespacedDeployment: vi.fn().mockResolvedValue({}),
    };
  }

  beforeEach(() => {
    vi.mocked(getDefaultWebmailEngine).mockReset();
  });

  it('engine=roundcube: scales bulwark to 0 + annotates; leaves roundcube alone (already at 1)', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('roundcube');
    const apps = makeApps({
      activeName: 'roundcube',
      activeReplicas: 1,
      activeAnnotated: false,
      inactiveName: 'bulwark',
      inactiveReplicas: 1,
      inactiveAnnotated: false,
    });
    const log = makeLog();

    const result = await reconcileEngineDeployments({} as Database, apps as never, log);

    expect(result?.engine).toBe('roundcube');
    expect(result?.activeDeployment.name).toBe('roundcube');
    expect(result?.inactiveDeployment.name).toBe('bulwark');
    expect(result?.activeAnnotationCleared).toBe(false); // wasn't annotated
    expect(result?.activeScaledUp).toBe(false); // already at 1, no scale needed
    expect(result?.inactiveScaledToZero).toBe(true);
    expect(result?.inactiveAnnotated).toBe(true);

    const scaleCalls = apps.replaceNamespacedDeploymentScale.mock.calls;
    // Only the inactive engine should have been scaled (active was at 1).
    expect(scaleCalls).toHaveLength(1);
    const inactiveScale = scaleCalls[0][0] as { name: string; body: { spec: { replicas: number } } };
    expect(inactiveScale.name).toBe('bulwark');
    expect(inactiveScale.body.spec.replicas).toBe(0);
  });

  it('engine=roundcube + active at 0: floor-scales active to 1 (2026-05-18 fix)', async () => {
    // Repro: operator flipped to bulwark previously (roundcube scaled to 0 + annotated),
    // then flipped back to roundcube. Without the floor-scale, roundcube stays at 0
    // → users see "no available server" until platform-storage-policy fires.
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('roundcube');
    const apps = makeApps({
      activeName: 'roundcube',
      activeReplicas: 0,
      activeAnnotated: true,
      inactiveName: 'bulwark',
      inactiveReplicas: 1,
      inactiveAnnotated: false,
    });
    const log = makeLog();

    const result = await reconcileEngineDeployments({} as Database, apps as never, log);

    expect(result?.activeAnnotationCleared).toBe(true);
    expect(result?.activeScaledUp).toBe(true);
    expect(result?.inactiveScaledToZero).toBe(true);

    const scaleCalls = apps.replaceNamespacedDeploymentScale.mock.calls;
    const activeScaleCall = scaleCalls.find((c: unknown[]) => {
      const arg = c[0] as { name: string; body: { spec: { replicas: number } } };
      return arg.name === 'roundcube';
    });
    expect(activeScaleCall).toBeDefined();
    const args = activeScaleCall![0] as { body: { spec: { replicas: number } } };
    expect(args.body.spec.replicas).toBe(1); // ACTIVE_ENGINE_MIN_REPLICAS
  });

  it('does NOT scale DOWN active when storage-policy has scaled it to 3 (HA)', async () => {
    // HA cluster: storage-policy bumped active to 3 replicas. Reconciler
    // must respect that and not undo the HA scale.
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('bulwark');
    const apps = makeApps({
      activeName: 'bulwark',
      activeReplicas: 3,
      activeAnnotated: false,
      inactiveName: 'roundcube',
      inactiveReplicas: 0,
      inactiveAnnotated: true,
    });
    const log = makeLog();

    const result = await reconcileEngineDeployments({} as Database, apps as never, log);

    expect(result?.activeScaledUp).toBe(false); // already >= ACTIVE_ENGINE_MIN_REPLICAS
    // No scale call against bulwark (the active engine).
    const scaleCalls = apps.replaceNamespacedDeploymentScale.mock.calls;
    const bulwarkScale = scaleCalls.find((c: unknown[]) => {
      const arg = c[0] as { name: string };
      return arg.name === 'bulwark';
    });
    expect(bulwarkScale).toBeUndefined();
  });

  it('engine=bulwark: scales roundcube to 0 + annotates; leaves bulwark alone', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('bulwark');
    const apps = makeApps({
      activeName: 'bulwark',
      activeReplicas: 1,
      inactiveName: 'roundcube',
      inactiveReplicas: 1,
    });
    const log = makeLog();

    const result = await reconcileEngineDeployments({} as Database, apps as never, log);

    expect(result?.engine).toBe('bulwark');
    expect(result?.activeDeployment.name).toBe('bulwark');
    expect(result?.inactiveDeployment.name).toBe('roundcube');
    const scaleCall = apps.replaceNamespacedDeploymentScale.mock.calls[0][0] as {
      name: string;
    };
    expect(scaleCall.name).toBe('roundcube');
  });

  it('clears the disabled annotation from the active engine on engine flip', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('roundcube');
    const apps = makeApps({
      activeName: 'roundcube',
      activeReplicas: 0, // was inactive previously
      activeAnnotated: true, // ← carries the annotation from the prior flip
      inactiveName: 'bulwark',
      inactiveReplicas: 1,
      inactiveAnnotated: false,
    });
    const log = makeLog();

    const result = await reconcileEngineDeployments({} as Database, apps as never, log);

    expect(result?.activeAnnotationCleared).toBe(true);
    // The JSON-patch must be a remove operation for the annotation key.
    const patchCalls = apps.patchNamespacedDeployment.mock.calls;
    const removeCall = patchCalls.find((c: unknown[]) => {
      const arg = c[0] as { name: string; body: ReadonlyArray<{ op: string }> | unknown };
      return arg.name === 'roundcube' && Array.isArray(arg.body) && arg.body[0]?.op === 'remove';
    });
    expect(removeCall).toBeDefined();
  });

  it('skips scaling when inactive Deployment is missing (404 is non-fatal)', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('roundcube');
    const apps = makeApps({
      activeName: 'roundcube',
      inactiveName: 'bulwark',
      inactiveMissing: true,
    });
    const log = makeLog();

    const result = await reconcileEngineDeployments({} as Database, apps as never, log);

    expect(result?.inactiveScaledToZero).toBe(false);
    expect(result?.inactiveAnnotated).toBe(false);
    expect(log.warn).toHaveBeenCalled();
  });

  it('no-ops when inactive is already scaled to 0 + annotated', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('roundcube');
    const apps = makeApps({
      activeName: 'roundcube',
      activeReplicas: 1,
      activeAnnotated: false,
      inactiveName: 'bulwark',
      inactiveReplicas: 0,
      inactiveAnnotated: true,
    });
    const log = makeLog();

    const result = await reconcileEngineDeployments({} as Database, apps as never, log);

    expect(result?.inactiveScaledToZero).toBe(false);
    expect(result?.inactiveAnnotated).toBe(false);
    expect(apps.replaceNamespacedDeploymentScale).not.toHaveBeenCalled();
    expect(apps.patchNamespacedDeployment).not.toHaveBeenCalled();
  });
});
