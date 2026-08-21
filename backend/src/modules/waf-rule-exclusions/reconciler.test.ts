/**
 * The modsec-crs Deployment carries a hash annotation; changing it rolls the
 * pods, which is the ONLY way new WAF rules take effect. The exclusions files
 * are mounted with `subPath`, and a subPath ConfigMap mount never receives
 * updates from kubelet — verified on a live cluster: patch the ConfigMap, wait,
 * and the running container still holds the old file.
 *
 * The static exclusions ConfigMap is Flux-applied and has no reload trigger of
 * its own, so `reconcileWafExclusions` folds ITS content into the deploy hash
 * alongside the dynamic (DB-rendered) rules. If that ever regresses, every
 * future static WAF change becomes a silent no-op: green in git, old rules
 * still running. That is the failure mode these tests exist to prevent — the
 * whole reconciler had no tests at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./service.js', () => ({ listExclusionsForReconciler: vi.fn(async () => []) }));
vi.mock('../security-hardening/crowdsec-allowlists.js', () => ({
  listAllowlistEntries: vi.fn(async () => []),
}));

import {
  reconcileWafExclusions,
  WAF_EXCLUSION_HASH_ANNOTATION,
  WAF_STATIC_EXCLUSION_CM_KEY,
  MODSEC_DEPLOY_NAME,
} from './reconciler.js';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

interface Harness {
  clients: Parameters<typeof reconcileWafExclusions>[1];
  patchedHashes: string[];
}

/**
 * @param staticContent  body of the Flux-applied static exclusions file
 * @param liveAnnotation hash already stamped on the Deployment
 * @param staticReadFails simulate the ConfigMap read erroring
 */
function harness(
  staticContent: string | null,
  liveAnnotation?: string,
  staticReadFails = false,
): Harness {
  const patchedHashes: string[] = [];
  const clients = {
    core: {
      readNamespacedConfigMap: vi.fn(async ({ name }: { name: string }) => {
        if (name === MODSEC_DEPLOY_NAME) throw new Error('unexpected');
        if (staticReadFails && !name.endsWith('-dynamic')) {
          throw new Error('boom');
        }
        if (name.endsWith('-dynamic')) {
          // Dynamic CM already exists and is current — keeps the test focused
          // on the deploy-hash behaviour rather than CM create/update paths.
          return { data: {}, metadata: { annotations: {} } };
        }
        return staticContent === null
          ? { data: {} }
          : { data: { [WAF_STATIC_EXCLUSION_CM_KEY]: staticContent } };
      }),
      patchNamespacedConfigMap: vi.fn(async () => ({})),
      createNamespacedConfigMap: vi.fn(async () => ({})),
      replaceNamespacedConfigMap: vi.fn(async () => ({})),
    },
    apps: {
      readNamespacedDeployment: vi.fn(async () => ({
        spec: {
          template: {
            metadata: {
              annotations: liveAnnotation
                ? { [WAF_EXCLUSION_HASH_ANNOTATION]: liveAnnotation }
                : {},
            },
          },
        },
      })),
      patchNamespacedDeployment: vi.fn(async (arg: unknown) => {
        const a = arg as {
          body?: { spec?: { template?: { metadata?: { annotations?: Record<string, string> } } } };
        };
        const h = a.body?.spec?.template?.metadata?.annotations?.[WAF_EXCLUSION_HASH_ANNOTATION];
        if (h) patchedHashes.push(h);
        return {};
      }),
    },
  } as unknown as Parameters<typeof reconcileWafExclusions>[1];
  return { clients, patchedHashes };
}

const db = {} as Parameters<typeof reconcileWafExclusions>[0];

describe('deploy hash covers the STATIC exclusions ConfigMap', () => {
  beforeEach(() => vi.clearAllMocks());

  it('changing static content changes the stamped hash', async () => {
    const a = harness('SecRule REQUEST_URI "@rx /one" "id:9000104,phase:1,pass,nolog"');
    const b = harness('SecRule REQUEST_URI "@rx /two" "id:9000104,phase:1,pass,nolog"');

    await reconcileWafExclusions(db, a.clients, log);
    await reconcileWafExclusions(db, b.clients, log);

    expect(a.patchedHashes).toHaveLength(1);
    expect(b.patchedHashes).toHaveLength(1);
    // If this ever passes with EQUAL hashes, a Flux-delivered WAF rule change
    // stops rolling modsec and silently never takes effect.
    expect(a.patchedHashes[0]).not.toBe(b.patchedHashes[0]);
  });

  it('identical static content produces the same hash', async () => {
    const body = 'SecRule REQUEST_URI "@rx /same" "id:9000104,phase:1,pass,nolog"';
    const a = harness(body);
    const b = harness(body);

    await reconcileWafExclusions(db, a.clients, log);
    await reconcileWafExclusions(db, b.clients, log);

    expect(a.patchedHashes[0]).toBe(b.patchedHashes[0]);
  });

  it('does not re-patch when the live annotation already matches', async () => {
    const body = 'SecRule REQUEST_URI "@rx /stable" "id:9000104,phase:1,pass,nolog"';
    const first = harness(body);
    await reconcileWafExclusions(db, first.clients, log);
    const settled = first.patchedHashes[0];

    // Same content, and the Deployment already carries that hash: a repeat tick
    // must be a no-op. Otherwise the 5-minute drift loop would roll modsec
    // every five minutes forever.
    const second = harness(body, settled);
    const result = await reconcileWafExclusions(db, second.clients, log);

    expect(second.patchedHashes).toHaveLength(0);
    expect(result.deployStamped).toBe(false);
  });

  it('falls back to the dynamic-only hash when the static read fails', async () => {
    // A transient read error must not destabilise the annotation — otherwise
    // modsec rolls on every tick until the read recovers.
    const failing = harness('irrelevant', undefined, true);
    const result = await reconcileWafExclusions(db, failing.clients, log);

    expect(failing.patchedHashes).toHaveLength(1);
    expect(failing.patchedHashes[0]).toBe(result.hash);
    expect(log.warn).toHaveBeenCalled();
  });

  it('uses the dynamic-only hash when the static file is absent', async () => {
    const empty = harness(null);
    const result = await reconcileWafExclusions(db, empty.clients, log);

    expect(empty.patchedHashes[0]).toBe(result.hash);
  });
});
