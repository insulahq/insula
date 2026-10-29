/**
 * The tenant's sign-in gate: one oauth2-proxy per tenant namespace, with the
 * route-gate sidecar (images/claim-validator) in the same pod.
 *
 *   Traefik ForwardAuth (per protected route)
 *     → gate :4181/auth?route=<route id>   applies the route's policy
 *       → oauth2-proxy :4180/               static://202 upstream: 202 when
 *                                           signed in, else 302 to the IdP
 *   Traefik child route Host(<host>) && PathPrefix(/oauth2)
 *     → oauth2-proxy :4180                  /oauth2/start, /callback, /sign_out
 *
 * The child route is built with the route itself (annotation-sync.ts), inside
 * the route's own IngressRoute, so it carries the route's TLS options (mTLS),
 * WAF, CrowdSec and allow-list Middlewares and disappears with the route.
 *
 * Everything that configures the proxy (client credentials, cookie secret,
 * policy, extra CA) is hashed onto the pod template, so any change rolls the
 * pod; oauth2-proxy reads its configuration only at startup. Credentials live
 * in a Secret read as OAUTH2_PROXY_* environment variables; every other setting
 * is a command-line argument (an array, so no value can inject another option).
 */

import crypto from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type * as k8s from '@kubernetes/client-node';
import {
  ingressAuthConfigs,
  tenants,
  tenantOauth2ProxyState,
} from '../../db/schema.js';
import {
  getOrCreateTenantCookieSecret,
  listEnabledForTenant,
  splitList,
  type EnabledIngressAuthRow,
} from './service.js';
import { decryptProviderSecret } from './providers-service.js';
import type { Database } from '../../db/index.js';
import { resolvePlatformImage } from '../../shared/platform-images.js';
import { loadTenantPodPlacement, platformPodPlacement, type TenantPodPlacement } from '../tenant-placement/pod-placement.js';
import { carryQuiesceHold } from '../../shared/scale-deployment.js';
import { DEFAULT_OAUTH2_PROXY_IMAGE } from '../oidc/panel-proxy.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import { canProtectHost } from './hosts.js';

export const GATE_NAME = 'oauth2-proxy';
export const PROXY_PORT = 4180;
export const GATE_PORT = 4181;
const CONFIGMAP_NAME = 'oauth2-proxy-config';
const SECRET_NAME = 'oauth2-proxy-secrets';
/** Removed: the `/oauth2/*` route now lives in the route's own IngressRoute. */
const LEGACY_PASSTHROUGH_NAME = 'oauth2-proxy-passthrough';
const CONFIG_HASH_ANNOTATION = 'insula.host/config-hash';
const APP_LABEL = { 'app.kubernetes.io/name': 'oauth2-proxy' };
const COOKIE_NAME = '_insula_gate';
const CA_DIR = '/etc/oauth2-proxy/ca';
const POLICY_DIR = '/etc/route-gate';
/** bootstrap.sh --trust-ca writes this; platform-api trusts it too (NODE_EXTRA_CA_CERTS). */
const EXTRA_CA_SECRET = 'platform-extra-ca-trust';
const EXTRA_CA_KEY = 'ca-bundle.crt';
const PLATFORM_NAMESPACE = process.env.PLATFORM_NAMESPACE ?? 'platform';

/** Same release as the panels' gate (oidc/panel-proxy.ts), which a test ties to k8s/base. */
const OAUTH2_PROXY_IMAGE = process.env.OAUTH2_PROXY_IMAGE ?? DEFAULT_OAUTH2_PROXY_IMAGE;
const GATE_IMAGE = resolvePlatformImage('claim-validator');

export interface IngressAuthTenants {
  readonly core: k8s.CoreV1Api;
  readonly apps: k8s.AppsV1Api;
  readonly networking: k8s.NetworkingV1Api;
  readonly custom: k8s.CustomObjectsApi;
}

export interface ReconcileDeps {
  readonly db: Database;
  readonly k8s: IngressAuthTenants;
  readonly encryptionKey: string;
  /** Serialises reconciles of one tenant across replicas; tests pass a plain call. */
  readonly lock?: <T>(tenantId: string, fn: () => Promise<T>) => Promise<T>;
}

/**
 * One reconcile of a tenant's gate at a time, cluster-wide: a reconcile that
 * read "no protected route" must not tear down a gate a concurrent save just
 * built. A run lock on the scheduler-lease table; waits for the holder.
 */
async function tenantGateLock<T>(db: Database, tenantId: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const out = await withSchedulerLease(db, `sign-in-gate:${tenantId}`, 180_000, fn, { release: true });
    if (out.ran) return out.value;
    if (Date.now() >= deadline) throw new Error('another change to this tenant\'s sign-in is still being applied; try again');
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

export interface ReconcileOutcome {
  readonly tenantId: string;
  readonly namespace: string;
  readonly action: 'provisioned' | 'updated' | 'unchanged' | 'torn_down' | 'noop';
  readonly enabledIngresses: number;
  /** Why the gate is not serving, in words the tenant can act on. */
  readonly error: string | null;
  /** The proxy's last log lines when it failed to start. */
  readonly proxyLog?: string;
}

// ─── Pure builders (exported for tests) ──────────────────────────────────────

/** Groups may contain spaces ("Domain Admins"): split on commas, semicolons and newlines only. */
export function splitGroups(value: string | null | undefined): string[] {
  return (value ?? '').split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
}

/** The gate's policy file: one entry per protected route, keyed by the route id the Middleware sends. */
export function buildGatePolicy(rows: ReadonlyArray<EnabledIngressAuthRow>): string {
  const out: Record<string, unknown> = {};
  for (const { cfg } of rows) {
    out[cfg.ingressRouteId] = {
      emails: splitList(cfg.allowedEmails),
      emailDomains: splitList(cfg.allowedEmailDomains),
      groups: splitGroups(cfg.allowedGroups),
      claimRules: cfg.claimRules ?? [],
      redirect: cfg.postLoginRedirectUrl ?? null,
      headers: {
        user: cfg.passUserHeaders,
        groups: cfg.setXauthrequest,
        accessToken: cfg.passAccessToken,
        idToken: cfg.passIdToken,
        authorization: cfg.passAuthorizationHeader,
      },
    };
  }
  return JSON.stringify(out, null, 2);
}

/**
 * Session settings are the proxy's, shared by every route: the strictest of
 * the routes' values applies (shortest expiry; shortest non-zero refresh, kept
 * below the expiry, which oauth2-proxy requires).
 */
export function sessionSettings(rows: ReadonlyArray<EnabledIngressAuthRow>): { expire: number; refresh: number } {
  const expire = Math.min(...rows.map((r) => r.cfg.cookieExpireSeconds));
  const refreshes = rows.map((r) => r.cfg.cookieRefreshSeconds).filter((s) => s > 0);
  const refresh = refreshes.length > 0 ? Math.min(...refreshes) : 0;
  return { expire, refresh: refresh >= expire ? 0 : refresh };
}

const unique = (xs: ReadonlyArray<string>): string[] => [...new Set(xs)];

export interface GateArgsOptions {
  readonly withExtraCa: boolean;
}

/** oauth2-proxy's command line. Pure. */
export function buildGateArgs(rows: ReadonlyArray<EnabledIngressAuthRow>, opts: GateArgsOptions): string[] {
  const provider = rows[0]!.provider;
  const hosts = unique(rows.map((r) => r.host));
  // URL.host keeps a non-default port, which --whitelist-domain must name too.
  // One unparseable legacy value must not take the tenant's whole gate down.
  const redirectHosts = rows
    .map((r) => {
      try {
        return r.cfg.postLoginRedirectUrl ? new URL(r.cfg.postLoginRedirectUrl).host : null;
      } catch {
        return null;
      }
    })
    .filter((h): h is string => !!h);
  // A cookie domain on any route: name one for every host, or a host without
  // one would get the shortest listed domain — one it does not belong to.
  const cookieDomains = rows.some((r) => r.cfg.cookieDomain)
    ? unique(rows.map((r) => r.cfg.cookieDomain?.replace(/^\./, '') ?? r.host)).sort((a, b) => b.length - a.length)
    : [];
  const { expire, refresh } = sessionSettings(rows);
  return [
    `--http-address=0.0.0.0:${PROXY_PORT}`,
    // A signed-in request to `/` answers 202 — what the gate sidecar asks.
    '--upstream=static://202',
    '--provider=oidc',
    `--scope=${provider.defaultScopes}`,
    // Who may pass is each route's policy, applied by the gate sidecar.
    '--email-domain=*',
    // Straight to the identity provider, no "Sign in with OpenID Connect" page.
    '--skip-provider-button=true',
    // The default `force` makes the IdP ask for consent on every sign-in.
    '--approval-prompt=auto',
    // Callback and post-login URL come from the forwarded host: one proxy, many hosts.
    '--reverse-proxy=true',
    '--set-xauthrequest=true',
    '--pass-access-token=true',
    // Authorization: Bearer <ID token> in the answer — the gate reads claims from it.
    '--set-authorization-header=true',
    `--cookie-name=${COOKIE_NAME}`,
    '--cookie-secure=true',
    '--cookie-samesite=lax',
    `--cookie-expire=${expire}s`,
    `--cookie-refresh=${refresh}s`,
    ...unique([...hosts, ...redirectHosts]).map((h) => `--whitelist-domain=${h}`),
    ...cookieDomains.map((d) => `--cookie-domain=${d}`),
    ...(provider.usePkce ? ['--code-challenge-method=S256'] : []),
    ...(opts.withExtraCa
      ? [`--provider-ca-file=${CA_DIR}/${EXTRA_CA_KEY}`, '--use-system-trust-store=true']
      : []),
    '--silence-ping-logging=true',
  ];
}

/** The Secret's data: what oauth2-proxy reads from OAUTH2_PROXY_* variables. Pure. */
export function buildGateSecretData(
  rows: ReadonlyArray<EnabledIngressAuthRow>,
  clientSecret: string,
  cookieSecret: string,
): Record<string, string> {
  const provider = rows[0]!.provider;
  return {
    OAUTH2_PROXY_OIDC_ISSUER_URL: provider.issuerUrl,
    OAUTH2_PROXY_CLIENT_ID: provider.oauthClientId,
    OAUTH2_PROXY_CLIENT_SECRET: clientSecret,
    OAUTH2_PROXY_COOKIE_SECRET: cookieSecret,
  };
}

export interface GateMaterial {
  readonly secretData: Record<string, string>;
  readonly configMapData: Record<string, string>;
  readonly args: string[];
}

/** Everything whose change must restart the pod. Pure. */
export function gateConfigHash(m: GateMaterial): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify([m.secretData, m.configMapData, m.args, OAUTH2_PROXY_IMAGE, GATE_IMAGE]))
    .digest('hex').slice(0, 32);
}

/** Pure — exported for tests. */
export function buildGateDeployment(
  namespace: string,
  m: GateMaterial,
  placement: TenantPodPlacement,
): k8s.V1Deployment {
  const withCa = EXTRA_CA_KEY in m.configMapData;
  const hardened: k8s.V1SecurityContext = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ['ALL'] },
  };
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: GATE_NAME, namespace, labels: { ...APP_LABEL, 'app.kubernetes.io/managed-by': 'platform-api' } },
    spec: {
      replicas: 1,
      selector: { matchLabels: APP_LABEL },
      template: {
        metadata: { labels: APP_LABEL, annotations: { [CONFIG_HASH_ANNOTATION]: gateConfigHash(m) } },
        spec: {
          // The tenant's pin and the overhead class: neither charged to the
          // tenant's quota nor making it look drifted (tenant-placement).
          ...platformPodPlacement(placement),
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65532,
            runAsGroup: 65532,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          volumes: [
            // The whole directory, not a subPath: a subPath never sees an update.
            { name: 'policy', configMap: { name: CONFIGMAP_NAME, items: [{ key: 'policy.json', path: 'policy.json' }] } },
            ...(withCa
              ? [{ name: 'ca', configMap: { name: CONFIGMAP_NAME, items: [{ key: EXTRA_CA_KEY, path: EXTRA_CA_KEY }] } }]
              : []),
          ],
          containers: [
            {
              name: 'oauth2-proxy',
              image: OAUTH2_PROXY_IMAGE,
              args: m.args,
              envFrom: [{ secretRef: { name: SECRET_NAME } }],
              ports: [{ containerPort: PROXY_PORT, name: 'proxy' }],
              ...(withCa ? { volumeMounts: [{ name: 'ca', mountPath: CA_DIR, readOnly: true }] } : {}),
              resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { memory: '128Mi' } },
              readinessProbe: { httpGet: { path: '/ping', port: PROXY_PORT }, initialDelaySeconds: 2, periodSeconds: 5 },
              livenessProbe: { httpGet: { path: '/ping', port: PROXY_PORT }, initialDelaySeconds: 10, periodSeconds: 30 },
              securityContext: hardened,
            },
            {
              name: 'route-gate',
              image: GATE_IMAGE,
              env: [
                { name: 'PORT', value: String(GATE_PORT) },
                { name: 'OAUTH2_PROXY_HOST', value: '127.0.0.1' },
                { name: 'OAUTH2_PROXY_PORT', value: String(PROXY_PORT) },
                { name: 'POLICY_PATH', value: `${POLICY_DIR}/policy.json` },
              ],
              ports: [{ containerPort: GATE_PORT, name: 'gate' }],
              volumeMounts: [{ name: 'policy', mountPath: POLICY_DIR, readOnly: true }],
              resources: { requests: { cpu: '5m', memory: '24Mi' }, limits: { memory: '96Mi' } },
              // /ready fails while no policy is loaded: every request would be refused.
              readinessProbe: { httpGet: { path: '/ready', port: GATE_PORT }, initialDelaySeconds: 1, periodSeconds: 5 },
              livenessProbe: { httpGet: { path: '/ping', port: GATE_PORT }, initialDelaySeconds: 5, periodSeconds: 30 },
              securityContext: hardened,
            },
          ],
        },
      },
    },
  };
}

// ─── Reconcile ───────────────────────────────────────────────────────────────

async function tenantNamespace(db: Database, tenantId: string): Promise<string | null> {
  const [row] = await db.select({ ns: tenants.kubernetesNamespace }).from(tenants).where(eq(tenants.id, tenantId));
  return row?.ns ?? null;
}

/** The platform's extra trusted root CAs, when bootstrap installed some. */
async function platformExtraCa(core: k8s.CoreV1Api): Promise<string | null> {
  try {
    const s = await core.readNamespacedSecret({ name: EXTRA_CA_SECRET, namespace: PLATFORM_NAMESPACE });
    const b64 = s.data?.[EXTRA_CA_KEY];
    const pem = b64 ? Buffer.from(b64, 'base64').toString('utf8').trim() : '';
    return pem.includes('BEGIN CERTIFICATE') ? `${pem}\n` : null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Record the gate's state on every config of the tenant, so each route's form shows it. */
async function recordOutcome(db: Database, tenantId: string, routeConfigIds: ReadonlyArray<string>, error: string | null): Promise<void> {
  await db.update(tenantOauth2ProxyState)
    .set(error ? { lastError: error } : { provisioned: true, lastProvisionedAt: new Date(), lastError: null })
    .where(eq(tenantOauth2ProxyState.tenantId, tenantId));
  if (routeConfigIds.length === 0) return;
  await db.update(ingressAuthConfigs)
    .set(error ? { lastError: error } : { lastError: null, lastReconciledAt: new Date() })
    .where(inArray(ingressAuthConfigs.id, [...routeConfigIds]));
}

/**
 * Bring the tenant's gate in line with its enabled route configs: create or
 * update it, or remove it when none is left. With `wait`, also wait for the
 * new pod to be Ready (oauth2-proxy exits when the issuer's discovery fails)
 * and report why it is not. Never throws.
 */
/**
 * Which enabled routes the gate serves. It holds ONE provider — the first
 * protected route's — and cannot serve a wildcard host; a route the gate does
 * not serve stays closed (the gate refuses an unknown route) and its form says
 * why. Pure.
 */
export function partitionServable(rows: ReadonlyArray<EnabledIngressAuthRow>): {
  serve: EnabledIngressAuthRow[];
  refused: Array<{ row: EnabledIngressAuthRow; reason: string }>;
} {
  const serve: EnabledIngressAuthRow[] = [];
  const refused: Array<{ row: EnabledIngressAuthRow; reason: string }> = [];
  for (const row of rows) {
    if (!canProtectHost(row.hostname)) {
      refused.push({ row, reason: `Sign-in cannot protect the wildcard route ${row.hostname}; this route stays closed. Remove its sign-in, or add a route per host.` });
      continue;
    }
    const primary = serve[0]?.provider;
    if (primary && row.provider.id !== primary.id) {
      refused.push({
        row,
        reason: `This route signs in with "${row.provider.name}", but this tenant's protected routes use "${primary.name}" (one sign-in service per tenant); this route stays closed until it uses "${primary.name}".`,
      });
      continue;
    }
    serve.push(row);
  }
  return { serve, refused };
}

export async function reconcileTenant(
  deps: ReconcileDeps,
  tenantId: string,
  opts: { wait?: boolean; waitTimeoutMs?: number } = {},
): Promise<ReconcileOutcome> {
  const lock = deps.lock ?? (<T>(id: string, fn: () => Promise<T>) => tenantGateLock(deps.db, id, fn));
  try {
    return await lock(tenantId, () => reconcileTenantLocked(deps, tenantId, opts));
  } catch (err) {
    return { tenantId, namespace: '', action: 'noop', enabledIngresses: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

async function reconcileTenantLocked(
  deps: ReconcileDeps,
  tenantId: string,
  opts: { wait?: boolean; waitTimeoutMs?: number },
): Promise<ReconcileOutcome> {
  const namespace = await tenantNamespace(deps.db, tenantId);
  if (!namespace) {
    return { tenantId, namespace: '', action: 'noop', enabledIngresses: 0, error: 'tenant not found' };
  }
  const { serve: enabled, refused } = partitionServable(await listEnabledForTenant(deps.db, tenantId));
  for (const { row, reason } of refused) {
    await deps.db.update(ingressAuthConfigs).set({ lastError: reason }).where(eq(ingressAuthConfigs.id, row.cfg.id));
  }
  const ids = enabled.map((r) => r.cfg.id);
  try {
    if (enabled.length === 0) {
      const removed = await tearDownGate(deps, tenantId, namespace);
      return { tenantId, namespace, action: removed ? 'torn_down' : 'noop', enabledIngresses: 0, error: null };
    }
    const { action, hash } = await ensureGate(deps, tenantId, namespace, enabled);
    // Waiting: until the new pod is Ready or failing. Not waiting: one look,
    // so a crashing pod is still reported — and a pod still starting leaves
    // the recorded state alone rather than claiming success.
    const state = await gateState(deps.k8s, namespace, hash, opts.wait ? (opts.waitTimeoutMs ?? 90_000) : 0);
    if (state === 'starting') {
      return { tenantId, namespace, action, enabledIngresses: enabled.length, error: null };
    }
    if (state !== 'ready') {
      await recordOutcome(deps.db, tenantId, ids, state.error);
      return { tenantId, namespace, action, enabledIngresses: enabled.length, ...state };
    }
    await recordOutcome(deps.db, tenantId, ids, null);
    return { tenantId, namespace, action, enabledIngresses: enabled.length, error: null };
  } catch (err) {
    const msg = `The sign-in service could not be set up: ${err instanceof Error ? err.message : String(err)}`;
    await recordOutcome(deps.db, tenantId, ids, msg).catch(() => undefined);
    return { tenantId, namespace, action: 'noop', enabledIngresses: enabled.length, error: msg };
  }
}

async function ensureGate(
  deps: ReconcileDeps,
  tenantId: string,
  namespace: string,
  enabled: ReadonlyArray<EnabledIngressAuthRow>,
): Promise<{ action: 'provisioned' | 'updated' | 'unchanged'; hash: string }> {
  const cookieSecret = await getOrCreateTenantCookieSecret(deps.db, deps.encryptionKey, tenantId);
  // Mark first: whatever is created from here on, teardown will look for it.
  await deps.db.update(tenantOauth2ProxyState).set({ provisioned: true }).where(eq(tenantOauth2ProxyState.tenantId, tenantId));

  const clientSecret = decryptProviderSecret(enabled[0]!.provider, deps.encryptionKey);
  const ca = await platformExtraCa(deps.k8s.core);
  const configMapData: Record<string, string> = { 'policy.json': buildGatePolicy(enabled) };
  if (ca) configMapData[EXTRA_CA_KEY] = ca;
  const material: GateMaterial = {
    secretData: buildGateSecretData(enabled, clientSecret, cookieSecret),
    configMapData,
    args: buildGateArgs(enabled, { withExtraCa: !!ca }),
  };
  const hash = gateConfigHash(material);

  await upsertSecret(deps.k8s.core, namespace, material.secretData);
  await upsertConfigMap(deps.k8s.core, namespace, configMapData);
  await upsertService(deps.k8s.core, namespace);
  const placement = await loadTenantPodPlacement(deps.db, tenantId);
  const action = await upsertDeployment(deps.k8s.apps, namespace, buildGateDeployment(namespace, material, placement), hash);
  await deleteLegacyPassthrough(deps.k8s.custom, namespace);
  return { action, hash };
}

/**
 * Remove everything the gate may have created. The state row is written before
 * the first object (ensureGate) and deleted only here, so "a state row exists"
 * is exactly "something may be left to remove" — a half-finished setup
 * included. The next enable starts with a new cookie secret, which only
 * invalidates sessions of a gate that no longer exists.
 */
async function tearDownGate(deps: ReconcileDeps, tenantId: string, namespace: string): Promise<boolean> {
  const [state] = await deps.db.select({ tenantId: tenantOauth2ProxyState.tenantId }).from(tenantOauth2ProxyState)
    .where(eq(tenantOauth2ProxyState.tenantId, tenantId));
  if (!state) return false;
  await deleteLegacyPassthrough(deps.k8s.custom, namespace);
  await ignoreNotFound(() => deps.k8s.apps.deleteNamespacedDeployment({ name: GATE_NAME, namespace }));
  await ignoreNotFound(() => deps.k8s.core.deleteNamespacedService({ name: GATE_NAME, namespace }));
  await ignoreNotFound(() => deps.k8s.core.deleteNamespacedConfigMap({ name: CONFIGMAP_NAME, namespace }));
  await ignoreNotFound(() => deps.k8s.core.deleteNamespacedSecret({ name: SECRET_NAME, namespace }));
  await deps.db.delete(tenantOauth2ProxyState).where(eq(tenantOauth2ProxyState.tenantId, tenantId));
  return true;
}

// ─── Readiness ───────────────────────────────────────────────────────────────

const FATAL_WAITING = new Set(['CrashLoopBackOff', 'ErrImagePull', 'ImagePullBackOff', 'InvalidImageName', 'CreateContainerConfigError']);

/** First container of the pods failing in a way waiting will not fix. Pure. */
export function fatalGateProblem(pods: ReadonlyArray<k8s.V1Pod>): { pod: string; container: string; reason: string } | null {
  for (const pod of pods) {
    for (const cs of pod.status?.containerStatuses ?? []) {
      const waiting = cs.state?.waiting?.reason;
      if ((waiting && FATAL_WAITING.has(waiting)) || (cs.restartCount ?? 0) > 0) {
        return { pod: pod.metadata?.name ?? '?', container: cs.name, reason: waiting ?? cs.lastState?.terminated?.reason ?? 'restarted' };
      }
    }
  }
  return null;
}

async function logTail(core: k8s.CoreV1Api, namespace: string, pod: string, container: string): Promise<string> {
  for (const previous of [true, false]) {
    try {
      const log = await core.readNamespacedPodLog({ name: pod, namespace, container, tailLines: 8, previous });
      const text = String(log).trim();
      if (text) return text;
    } catch { /* try the other */ }
  }
  return '';
}

/** Explain the commonest oauth2-proxy start failures in the tenant's terms. Pure. */
export function explainProxyLog(log: string): string {
  if (/issuer did not match|oidc: issuer/i.test(log)) {
    return 'the issuer URL does not match the one your provider publishes (check for a trailing slash)';
  }
  if (/x509|certificate signed by unknown authority|tls:/i.test(log)) {
    return 'the provider\'s TLS certificate is not trusted';
  }
  if (/no such host|dial tcp|i\/o timeout|connection refused/i.test(log)) {
    return 'the provider could not be reached from the cluster';
  }
  if (/404|well-known/i.test(log)) {
    return 'the provider has no OpenID configuration at that issuer URL';
  }
  return 'it exited at startup';
}

/**
 * The pods of the CURRENT template (during a change the previous pod keeps
 * serving and proves nothing about the new configuration): 'ready', failing
 * (with why), or still 'starting' when `timeoutMs` ran out — 0 means one look.
 */
async function gateState(
  k8sc: IngressAuthTenants,
  namespace: string,
  hash: string,
  timeoutMs: number,
): Promise<'ready' | 'starting' | { error: string; proxyLog?: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pods = await k8sc.core.listNamespacedPod({ namespace, labelSelector: 'app.kubernetes.io/name=oauth2-proxy' });
    const current = pods.items.filter((p) => p.metadata?.annotations?.[CONFIG_HASH_ANNOTATION] === hash && !p.metadata?.deletionTimestamp);
    if (current.some((p) => (p.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'))) return 'ready';
    const problem = fatalGateProblem(current);
    if (problem) {
      const log = await logTail(k8sc.core, namespace, problem.pod, problem.container);
      const why = problem.container === 'oauth2-proxy' ? explainProxyLog(log) : `its ${problem.container} container ${problem.reason}`;
      return { error: `The sign-in service did not start: ${why}. The route stays closed until it does.`, ...(log ? { proxyLog: log } : {}) };
    }
    if (Date.now() >= deadline) {
      return timeoutMs > 0
        ? { error: 'The sign-in service did not become ready in time. The route stays closed until it does.' }
        : 'starting';
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

// ─── K8s helpers ─────────────────────────────────────────────────────────────

async function upsertSecret(core: k8s.CoreV1Api, namespace: string, stringData: Record<string, string>): Promise<void> {
  const body: k8s.V1Secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: SECRET_NAME, namespace, labels: { ...APP_LABEL, 'app.kubernetes.io/managed-by': 'platform-api' } },
    type: 'Opaque',
    stringData,
  };
  try {
    await core.replaceNamespacedSecret({ name: SECRET_NAME, namespace, body });
  } catch (err) {
    if (!isNotFound(err)) throw err;
    // backup-coverage: excluded:reconciler-rebuilds-from-config-tables
    // (the gate's client and cookie secrets come from tenant_oidc_providers and
    // tenant_oauth2_proxy_state; the reconciler regenerates the Secret.)
    await core.createNamespacedSecret({ namespace, body });
  }
}

async function upsertConfigMap(core: k8s.CoreV1Api, namespace: string, data: Record<string, string>): Promise<void> {
  const body: k8s.V1ConfigMap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: CONFIGMAP_NAME, namespace, labels: { ...APP_LABEL, 'app.kubernetes.io/managed-by': 'platform-api' } },
    data,
  };
  try {
    await core.replaceNamespacedConfigMap({ name: CONFIGMAP_NAME, namespace, body });
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await core.createNamespacedConfigMap({ namespace, body });
  }
}

async function upsertService(core: k8s.CoreV1Api, namespace: string): Promise<void> {
  const body: k8s.V1Service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: GATE_NAME, namespace, labels: APP_LABEL },
    spec: {
      selector: APP_LABEL,
      ports: [
        { name: 'proxy', port: PROXY_PORT, targetPort: PROXY_PORT, protocol: 'TCP' },
        { name: 'gate', port: GATE_PORT, targetPort: GATE_PORT, protocol: 'TCP' },
      ],
    },
  };
  try {
    // clusterIP is immutable: carry it over.
    const existing = await core.readNamespacedService({ name: GATE_NAME, namespace });
    body.spec!.clusterIP = existing.spec?.clusterIP;
    body.metadata!.resourceVersion = existing.metadata?.resourceVersion;
    await core.replaceNamespacedService({ name: GATE_NAME, namespace, body });
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await core.createNamespacedService({ namespace, body });
  }
}

async function upsertDeployment(
  apps: k8s.AppsV1Api,
  namespace: string,
  body: k8s.V1Deployment,
  hash: string,
): Promise<'provisioned' | 'updated' | 'unchanged'> {
  let existing: k8s.V1Deployment;
  try {
    existing = await apps.readNamespacedDeployment({ name: GATE_NAME, namespace });
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await apps.createNamespacedDeployment({ namespace, body });
    return 'provisioned';
  }
  const unchanged = existing.spec?.template?.metadata?.annotations?.[CONFIG_HASH_ANNOTATION] === hash
    && JSON.stringify(existing.spec?.template?.spec?.containers?.map((c) => [c.image, c.args])) ===
      JSON.stringify(body.spec?.template?.spec?.containers?.map((c) => [c.image, c.args]));
  body.metadata!.resourceVersion = existing.metadata?.resourceVersion;
  await apps.replaceNamespacedDeployment({ name: GATE_NAME, namespace, body: carryQuiesceHold(existing, body) });
  return unchanged ? 'unchanged' : 'updated';
}

async function deleteLegacyPassthrough(custom: k8s.CustomObjectsApi, namespace: string): Promise<void> {
  const { deleteIngressRoute } = await import('../ingress-routes/traefik-apply.js');
  await deleteIngressRoute(custom, namespace, LEGACY_PASSTHROUGH_NAME);
}

async function ignoreNotFound(op: () => Promise<unknown>): Promise<void> {
  try {
    await op();
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { statusCode?: number; code?: number; message?: string };
  if (e.statusCode === 404 || e.code === 404) return true;
  return typeof e.message === 'string' && /HTTP-Code:\s*404/.test(e.message);
}
