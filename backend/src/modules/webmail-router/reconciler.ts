/**
 * Webmail router — flips the platform-wide `webmail.<apex>`
 * IngressRoute's backend Service to match the active webmail engine,
 * and enforces the engine mutex at the Deployment level.
 *
 * The `platform-webmail-ingress` IngressRoute in the `mail` namespace
 * is created statically by `k8s/overlays/<env>/webmail-ingress.yaml`
 * with `services[0].name = roundcube`. When the operator flips
 * `platform_settings.default_webmail_engine` to `bulwark`, this
 * reconciler patches the IngressRoute to target `bulwark` instead —
 * the upstream Bulwark Service (master-user impersonation is handled
 * by Bulwark's own `/api/auth/impersonate` route, upstream issue #296).
 *
 * Only one engine is active on `webmail.<apex>` at any time. Per-tenant
 * Roundcube subdomains (`webmail.<clientdomain>`) are unaffected — they
 * always point at the Roundcube Service regardless of this setting.
 *
 * Idempotent: if the IngressRoute already targets the expected
 * Service, the reconciler is a no-op.
 */
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import type { Database } from '../../db/index.js';
import { MERGE_PATCH, JSON_PATCH } from '../../shared/k8s-patch.js';
import {
  getDefaultWebmailEngine,
  type WebmailEngine,
} from '../webmail-settings/service.js';

export const WEBMAIL_IR_NAME = 'platform-webmail-ingress';
export const WEBMAIL_IR_NAMESPACE = 'mail';
export const BULWARK_DEPLOY_NAME = 'bulwark';
export const BULWARK_DEPLOY_NAMESPACE = 'mail';
export const ROUNDCUBE_DEPLOY_NAME = 'roundcube';
export const ROUNDCUBE_DEPLOY_NAMESPACE = 'mail';
export const WEBMAIL_ROUTER_FIELD_MANAGER = 'platform-api-webmail-router';
// Annotation key recognised by platform-storage-policy — it skips
// replica reconciliation for any Deployment carrying this annotation
// (set to "true"). Keep in sync with
// modules/platform-storage-policy/service.ts:WEBMAIL_ENGINE_DISABLED_ANNOTATION.
export const WEBMAIL_ENGINE_DISABLED_ANNOTATION =
  'platform.phoenix-host.net/webmail-engine-disabled';
const TRAEFIK_GROUP = 'traefik.io';
const TRAEFIK_VERSION = 'v1alpha1';
const TRAEFIK_PLURAL = 'ingressroutes';

interface EngineDeployment {
  readonly name: string;
  readonly namespace: string;
}

function deploymentForEngine(engine: WebmailEngine): EngineDeployment {
  return engine === 'bulwark'
    ? { name: BULWARK_DEPLOY_NAME, namespace: BULWARK_DEPLOY_NAMESPACE }
    : { name: ROUNDCUBE_DEPLOY_NAME, namespace: ROUNDCUBE_DEPLOY_NAMESPACE };
}

function otherEngine(engine: WebmailEngine): WebmailEngine {
  return engine === 'bulwark' ? 'roundcube' : 'bulwark';
}

/**
 * Maps an engine key to the Service name the IngressRoute should
 * target. Both Services live in `mail/`. The `bulwark` Service routes
 * to the Bulwark Pod on port 3000 — Bulwark's native
 * `/api/auth/impersonate` route handles SSO handoffs (no sidecar).
 */
export function serviceNameForEngine(engine: WebmailEngine): string {
  return engine === 'bulwark' ? 'bulwark' : 'roundcube';
}

interface IngressRoute {
  readonly metadata?: {
    readonly annotations?: Record<string, string>;
  };
  readonly spec?: {
    readonly routes?: ReadonlyArray<{
      readonly services?: ReadonlyArray<{ readonly name: string; readonly port?: number | string }>;
    }>;
  };
}

// Flux annotation that tells the kustomize-controller to skip this
// resource. Without it, every patch we apply gets reverted ~60s later
// when Flux reconciles the static YAML's services[0].name back to
// `roundcube`. The static webmail-ingress.yaml carries this annotation,
// but the reconciler re-stamps it defensively in case the IR was
// created manually or the annotation was edited away.
const FLUX_RECONCILE_DISABLED = { 'kustomize.toolkit.fluxcd.io/reconcile': 'disabled' };

export interface ReconcileResult {
  readonly engine: WebmailEngine;
  readonly expectedService: string;
  readonly previousService: string | null;
  readonly patched: boolean;
}

/**
 * Inspect the IngressRoute and patch services[0].name when it doesn't
 * already match the active engine. Failure to find the IR (e.g. fresh
 * cluster before the static YAML applies, or running in CI without
 * Traefik installed) is non-fatal — the reconciler logs and returns
 * an unpatched result.
 */
export async function reconcileWebmailIngress(
  db: Database,
  custom: k8s.CustomObjectsApi,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<ReconcileResult | null> {
  const engine = await getDefaultWebmailEngine(db);
  const expectedService = serviceNameForEngine(engine);

  let current: IngressRoute;
  try {
    current = (await custom.getNamespacedCustomObject({
      group: TRAEFIK_GROUP,
      version: TRAEFIK_VERSION,
      namespace: WEBMAIL_IR_NAMESPACE,
      plural: TRAEFIK_PLURAL,
      name: WEBMAIL_IR_NAME,
    } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0])) as IngressRoute;
  } catch (err) {
    log.warn(
      { err, name: WEBMAIL_IR_NAME, namespace: WEBMAIL_IR_NAMESPACE },
      'webmail-router: IngressRoute not found — skipping reconcile',
    );
    return null;
  }

  const firstRoute = current.spec?.routes?.[0];
  const previousService = firstRoute?.services?.[0]?.name ?? null;
  const currentAnnotations = current.metadata?.annotations ?? {};
  const annotationMissing =
    currentAnnotations['kustomize.toolkit.fluxcd.io/reconcile'] !== 'disabled';

  if (previousService === expectedService && !annotationMissing) {
    return { engine, expectedService, previousService, patched: false };
  }

  // Patch the first route's services array. We replace the entire
  // services list to clear any stale entries; the IR only has a single
  // route (Host=`webmail.<apex>`) and a single backend Service. Also
  // re-stamp the Flux `reconcile: disabled` annotation so a future
  // YAML change can't accidentally hand ownership back to Flux.
  const port = firstRoute?.services?.[0]?.port ?? 80;
  const body = {
    metadata: { annotations: FLUX_RECONCILE_DISABLED },
    spec: {
      routes: [
        {
          ...firstRoute,
          services: [{ name: expectedService, port }],
        },
      ],
    },
  };

  await custom.patchNamespacedCustomObject(
    {
      group: TRAEFIK_GROUP,
      version: TRAEFIK_VERSION,
      namespace: WEBMAIL_IR_NAMESPACE,
      plural: TRAEFIK_PLURAL,
      name: WEBMAIL_IR_NAME,
      body,
    } as unknown as Parameters<typeof custom.patchNamespacedCustomObject>[0],
    MERGE_PATCH,
  );

  log.info(
    { engine, previousService, newService: expectedService },
    'webmail-router: IngressRoute flipped to match active engine',
  );

  return { engine, expectedService, previousService, patched: true };
}

export interface EngineDeploymentReconcileResult {
  readonly engine: WebmailEngine;
  readonly activeDeployment: EngineDeployment;
  readonly inactiveDeployment: EngineDeployment;
  readonly activeAnnotationCleared: boolean;
  readonly activeScaledUp: boolean;
  readonly inactiveScaledToZero: boolean;
  readonly inactiveAnnotated: boolean;
}

/**
 * Active engine target replicas — the "is the webmail running?" floor.
 * platform-storage-policy may scale this higher on HA tiers (up to 3),
 * but the reconciler always guarantees ≥1 so a freshly-flipped engine
 * is reachable immediately. Below this floor an operator engine flip
 * leaves the active Service with 0 endpoints and the webmail URL
 * returns 503 "no available server" until storage-policy's next tick
 * (which can be minutes).
 */
export const ACTIVE_ENGINE_MIN_REPLICAS = 1;

/**
 * Make the engine selection mutex at the Pod level — when the operator
 * picks Roundcube in admin → Email → Webmail, no Bulwark Pods run; when
 * they pick Bulwark, no Roundcube Pods run.
 *
 * Implementation:
 *   • Active engine's Deployment: clear the webmail-engine-disabled
 *     annotation AND scale to `ACTIVE_ENGINE_MIN_REPLICAS` if currently 0.
 *     The annotation-clear lets platform-storage-policy take over for
 *     tier-correct scaling on HA (up to 3 replicas); the floor-scale-up
 *     is the immediate "make the webmail reachable" guarantee operators
 *     expect from an engine flip.
 *   • Inactive engine's Deployment: scale to 0 via /scale subresource
 *     AND stamp the `webmail-engine-disabled=true` annotation so
 *     storage-policy skips it on subsequent ticks.
 *
 * Failures on individual deployments are non-fatal — overlays that
 * ship only one engine will get 404 on the missing Deployment, which
 * the reconciler logs and continues past.
 */
export async function reconcileEngineDeployments(
  db: Database,
  apps: k8s.AppsV1Api,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<EngineDeploymentReconcileResult | null> {
  const engine = await getDefaultWebmailEngine(db);
  const active = deploymentForEngine(engine);
  const inactive = deploymentForEngine(otherEngine(engine));

  let activeAnnotationCleared = false;
  let activeScaledUp = false;
  let inactiveScaledToZero = false;
  let inactiveAnnotated = false;

  // ─── Active engine: clear the disabled annotation if set + scale up ───
  try {
    const live = (await apps.readNamespacedDeployment({
      namespace: active.namespace,
      name: active.name,
    } as unknown as Parameters<typeof apps.readNamespacedDeployment>[0])) as {
      metadata?: { annotations?: Record<string, string> };
      spec?: { replicas?: number };
    };
    if (live.metadata?.annotations?.[WEBMAIL_ENGINE_DISABLED_ANNOTATION] === 'true') {
      // JSON-patch with `remove` for a single annotation key is the
      // SSA-safe way to drop a field without inadvertently claiming
      // ownership of the surrounding map.
      const annotationPatchPath = `/metadata/annotations/${WEBMAIL_ENGINE_DISABLED_ANNOTATION.replace(
        /~/g,
        '~0',
      ).replace(/\//g, '~1')}`;
      await apps.patchNamespacedDeployment(
        {
          namespace: active.namespace,
          name: active.name,
          body: [{ op: 'remove', path: annotationPatchPath }],
        } as unknown as Parameters<typeof apps.patchNamespacedDeployment>[0],
        JSON_PATCH,
      );
      activeAnnotationCleared = true;
    }
    // Floor-scale the active engine to ACTIVE_ENGINE_MIN_REPLICAS. We
    // don't ever scale DOWN here — platform-storage-policy may have
    // scaled to >=2 for HA, and that's not our call to undo. We only
    // ensure the engine isn't sitting at 0 right after a flip.
    const currentReplicas = live.spec?.replicas ?? 0;
    if (currentReplicas < ACTIVE_ENGINE_MIN_REPLICAS) {
      await apps.replaceNamespacedDeploymentScale({
        namespace: active.namespace,
        name: active.name,
        body: {
          metadata: { name: active.name, namespace: active.namespace },
          spec: { replicas: ACTIVE_ENGINE_MIN_REPLICAS },
        },
      } as unknown as Parameters<typeof apps.replaceNamespacedDeploymentScale>[0]);
      activeScaledUp = true;
    }
  } catch (err) {
    log.warn(
      { err, name: active.name, namespace: active.namespace },
      'webmail-router: active-engine Deployment unreachable (skipping annotation clear + scale-up)',
    );
  }

  // ─── Inactive engine: scale to 0 + stamp the disabled annotation ───
  try {
    const live = (await apps.readNamespacedDeployment({
      namespace: inactive.namespace,
      name: inactive.name,
    } as unknown as Parameters<typeof apps.readNamespacedDeployment>[0])) as {
      metadata?: { annotations?: Record<string, string> };
      spec?: { replicas?: number };
    };
    const currentReplicas = live.spec?.replicas ?? 0;
    const alreadyAnnotated =
      live.metadata?.annotations?.[WEBMAIL_ENGINE_DISABLED_ANNOTATION] === 'true';

    if (currentReplicas !== 0) {
      await apps.replaceNamespacedDeploymentScale({
        namespace: inactive.namespace,
        name: inactive.name,
        body: {
          metadata: { name: inactive.name, namespace: inactive.namespace },
          spec: { replicas: 0 },
        },
      } as unknown as Parameters<typeof apps.replaceNamespacedDeploymentScale>[0]);
      inactiveScaledToZero = true;
    }

    if (!alreadyAnnotated) {
      await apps.patchNamespacedDeployment(
        {
          namespace: inactive.namespace,
          name: inactive.name,
          body: {
            metadata: {
              annotations: { [WEBMAIL_ENGINE_DISABLED_ANNOTATION]: 'true' },
            },
          },
        } as unknown as Parameters<typeof apps.patchNamespacedDeployment>[0],
        MERGE_PATCH,
      );
      inactiveAnnotated = true;
    }
  } catch (err) {
    log.warn(
      { err, name: inactive.name, namespace: inactive.namespace },
      'webmail-router: inactive-engine Deployment unreachable (skipping scale-down)',
    );
  }

  if (activeAnnotationCleared || activeScaledUp || inactiveScaledToZero || inactiveAnnotated) {
    log.info(
      {
        engine,
        active: `${active.namespace}/${active.name}`,
        inactive: `${inactive.namespace}/${inactive.name}`,
        activeAnnotationCleared,
        activeScaledUp,
        inactiveScaledToZero,
        inactiveAnnotated,
      },
      'webmail-router: engine Deployments reconciled (mutex at Pod level)',
    );
  }

  return {
    engine,
    activeDeployment: active,
    inactiveDeployment: inactive,
    activeAnnotationCleared,
    activeScaledUp,
    inactiveScaledToZero,
    inactiveAnnotated,
  };
}

/**
 * Wait until the active engine's Deployment reports
 * `status.readyReplicas >= ACTIVE_ENGINE_MIN_REPLICAS`. Used by the
 * task-center flip handler so the operator's progress modal only
 * reports "engine reachable" once the Pod is actually serving traffic
 * (matters when flipping from a long-cold engine — Bulwark cold-start
 * is ~30s on testing.phoenix-host.net).
 *
 * Polls every `pollIntervalMs` (default 2s) up to `timeoutMs` (default
 * 120s). Returns `{ ready: boolean, replicas: number, elapsedMs: number }`
 * — caller can decide whether to fail the task or just warn.
 */
export interface WaitForActiveReadyOpts {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

export interface WaitForActiveReadyResult {
  readonly ready: boolean;
  readonly readyReplicas: number;
  readonly elapsedMs: number;
}

export async function waitForActiveEngineReady(
  db: Database,
  apps: k8s.AppsV1Api,
  opts: WaitForActiveReadyOpts = {},
): Promise<WaitForActiveReadyResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const engine = await getDefaultWebmailEngine(db);
  const active = deploymentForEngine(engine);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const live = (await apps.readNamespacedDeployment({
        namespace: active.namespace,
        name: active.name,
      } as unknown as Parameters<typeof apps.readNamespacedDeployment>[0])) as {
        status?: { readyReplicas?: number };
      };
      const readyReplicas = live.status?.readyReplicas ?? 0;
      if (readyReplicas >= ACTIVE_ENGINE_MIN_REPLICAS) {
        return { ready: true, readyReplicas, elapsedMs: Date.now() - startedAt };
      }
    } catch {
      // Transient read errors — keep polling until timeout.
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  return { ready: false, readyReplicas: 0, elapsedMs: Date.now() - startedAt };
}
