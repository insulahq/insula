/**
 * Per-panel oauth2-proxy, owned by platform-api.
 *
 * "Protect <panel> via OAuth2 Proxy" used to point the panel's routes at ONE
 * Flux-managed `oauth2-proxy` configured from a static Secret that bootstrap.sh
 * wrote for an in-cluster Dex. Production ships neither, so enabling the toggle
 * there made Traefik drop every route on the panel host ("kubernetes service not
 * found: platform/oauth2-proxy") and the panel answered 404. It also could never
 * use the providers the operator manages: oauth2-proxy takes exactly ONE
 * provider, and the panels' login pages can offer several.
 *
 * Now each protected panel gets its own proxy — Secret, Deployment and Service
 * named `oauth2-proxy-<panel>` — built from the provider the operator chose for
 * that panel. The caller applies it, waits for {@link waitPanelProxyReady}, and
 * only then points the panel's routes at it (panel-proxy-sync.ts).
 *
 * oauth2-proxy runs OIDC discovery at startup and exits when it fails, so a
 * Ready pod is one that reached the issuer; an unreachable issuer or a bad image
 * shows up as a crash or pull error here, before any route depends on it.
 */
import crypto from 'node:crypto';
import type * as k8s from '@kubernetes/client-node';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { isNotFound } from '../../shared/k8s-errors.js';
import { ApiError } from '../../shared/errors.js';
import type { PanelProxyProvider } from './service.js';
import { PANEL_PROXY_PORT, panelProxyName, type ProxyPanel } from './panel-proxy-names.js';

export { PANEL_PROXY_PORT, panelProxyName };
const PLATFORM_NAMESPACE = process.env.PLATFORM_NAMESPACE ?? 'platform';
const APP_LABEL = 'oauth2-proxy-panel';
const PANEL_LABEL_KEY = 'insula.host/panel';
const CONFIG_HASH_ANNOTATION = 'insula.host/config-hash';
const REPLICAS = 2;

/**
 * Same release as k8s/base/oauth2-proxy/deployment.yaml (a test keeps the two
 * in step). `OAUTH2_PROXY_IMAGE` overrides it, e.g. for an air-gapped mirror.
 */
export const DEFAULT_OAUTH2_PROXY_IMAGE = 'quay.io/oauth2-proxy/oauth2-proxy:v7.15.5';

export interface PanelProxyConfig {
  readonly panel: ProxyPanel;
  /** Public host of the panel, e.g. `tenant.example.test`. */
  readonly host: string;
  readonly provider: PanelProxyProvider;
  readonly cookieSecret: string;
  readonly image?: string;
}

function labels(panel: ProxyPanel): Record<string, string> {
  return {
    app: APP_LABEL,
    [PANEL_LABEL_KEY]: panel,
    'app.kubernetes.io/managed-by': 'platform-api',
  };
}

function secretData(cfg: PanelProxyConfig): Record<string, string> {
  // oauth2-proxy reads every flag from an OAUTH2_PROXY_<FLAG> environment
  // variable, so the credentials never appear in the pod spec.
  return {
    OAUTH2_PROXY_OIDC_ISSUER_URL: cfg.provider.issuerUrl,
    OAUTH2_PROXY_CLIENT_ID: cfg.provider.clientId,
    OAUTH2_PROXY_CLIENT_SECRET: cfg.provider.clientSecret,
    OAUTH2_PROXY_COOKIE_SECRET: cfg.cookieSecret,
  };
}

/** Pure — exported for tests. */
export function buildPanelProxySecret(cfg: PanelProxyConfig): k8s.V1Secret {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: panelProxyName(cfg.panel), namespace: PLATFORM_NAMESPACE, labels: labels(cfg.panel) },
    type: 'Opaque',
    stringData: secretData(cfg),
  };
}

/**
 * Hash of everything that should restart the proxy when it changes. Stamped on
 * the pod template, so a new provider, client secret or cookie secret rolls the
 * pods; nothing else has to remember to restart them.
 */
export function panelProxyConfigHash(cfg: PanelProxyConfig): string {
  const material = JSON.stringify([secretData(cfg), cfg.host, cfg.image ?? DEFAULT_OAUTH2_PROXY_IMAGE]);
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/** Pure — exported for tests. */
export function buildPanelProxyArgs(panel: ProxyPanel, host: string): string[] {
  return [
    `--http-address=0.0.0.0:${PANEL_PROXY_PORT}`,
    '--upstream=static://200',
    '--provider=oidc',
    // Authentication only. Who may use the panel is the panel's own decision
    // (its login maps the identity to a user, or refuses), so any address the
    // provider vouches for passes the gate — including unverified ones, which
    // oauth2-proxy would otherwise reject with a 500 at the callback.
    '--email-domain=*',
    '--insecure-oidc-allow-unverified-email=true',
    '--code-challenge-method=S256',
    // One proxy per panel host: the cookie and the post-login redirect stay on
    // that host, and the callback is fixed rather than derived from headers.
    `--redirect-url=https://${host}/oauth2/callback`,
    `--whitelist-domain=${host}`,
    `--cookie-name=_insula_proxy_${panel}`,
    '--cookie-secure=true',
    '--cookie-samesite=lax',
    '--reverse-proxy=true',
    '--set-xauthrequest=true',
    '--skip-provider-button=true',
    // The API authenticates every call itself (Bearer JWT); gating it here
    // would only break the panel's own sign-in round trip.
    '--skip-auth-route=^/api/',
    '--skip-auth-route=^/oauth2/',
    '--silence-ping-logging=true',
  ];
}

/** Pure — exported for tests. */
export function buildPanelProxyDeployment(cfg: PanelProxyConfig): k8s.V1Deployment {
  const name = panelProxyName(cfg.panel);
  const podLabels = labels(cfg.panel);
  const selector = { app: APP_LABEL, [PANEL_LABEL_KEY]: cfg.panel };
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace: PLATFORM_NAMESPACE, labels: podLabels },
    spec: {
      replicas: REPLICAS,
      selector: { matchLabels: selector },
      template: {
        metadata: {
          labels: podLabels,
          annotations: { [CONFIG_HASH_ANNOTATION]: panelProxyConfigHash(cfg) },
        },
        spec: {
          // The gate sits in front of a panel: when it is down, so is the panel.
          priorityClassName: 'platform-critical',
          automountServiceAccountToken: false,
          // Prefer the server nodes like the panels themselves (the
          // system-node-affinity component), without making a cluster whose
          // nodes are not labelled unschedulable.
          affinity: {
            nodeAffinity: {
              preferredDuringSchedulingIgnoredDuringExecution: [{
                weight: 100,
                preference: { matchExpressions: [{ key: 'insula.host/node-role', operator: 'In', values: ['server'] }] },
              }],
            },
          },
          tolerations: [{ key: 'insula.host/server-only', operator: 'Equal', value: 'true', effect: 'NoSchedule' }],
          topologySpreadConstraints: [{
            maxSkew: 1,
            topologyKey: 'kubernetes.io/hostname',
            whenUnsatisfiable: 'ScheduleAnyway',
            labelSelector: { matchLabels: selector },
          }],
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65532,
            runAsGroup: 65532,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [{
            name: 'oauth2-proxy',
            image: cfg.image ?? DEFAULT_OAUTH2_PROXY_IMAGE,
            args: buildPanelProxyArgs(cfg.panel, cfg.host),
            envFrom: [{ secretRef: { name } }],
            ports: [{ containerPort: PANEL_PROXY_PORT, name: 'http' }],
            readinessProbe: { httpGet: { path: '/ping', port: PANEL_PROXY_PORT }, initialDelaySeconds: 2, periodSeconds: 5 },
            livenessProbe: { httpGet: { path: '/ping', port: PANEL_PROXY_PORT }, initialDelaySeconds: 10, periodSeconds: 30 },
            resources: {
              requests: { cpu: '10m', memory: '32Mi' },
              // No CPU limit — platform-critical pods are never throttled.
              limits: { memory: '128Mi' },
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ['ALL'] },
            },
          }],
        },
      },
    },
  };
}

/** Pure — exported for tests. */
export function buildPanelProxyService(panel: ProxyPanel): k8s.V1Service {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: panelProxyName(panel), namespace: PLATFORM_NAMESPACE, labels: labels(panel) },
    spec: {
      selector: { app: APP_LABEL, [PANEL_LABEL_KEY]: panel },
      ports: [{ name: 'http', port: PANEL_PROXY_PORT, targetPort: PANEL_PROXY_PORT, protocol: 'TCP' }],
    },
  };
}

// ─── Apply / remove ──────────────────────────────────────────────────────────

export async function applyPanelProxy(k8sc: K8sClients, cfg: PanelProxyConfig): Promise<void> {
  const name = panelProxyName(cfg.panel);
  const namespace = PLATFORM_NAMESPACE;

  // Every platform-api replica runs this at startup. When the live Deployment
  // already carries this exact configuration, leave it alone: no rewrite, no
  // write conflict between replicas, no rollout.
  const live = await k8sc.apps.readNamespacedDeployment({ name, namespace }).catch((err: unknown) => {
    if (isNotFound(err)) return null;
    throw err;
  });
  const liveHash = live?.spec?.template?.metadata?.annotations?.[CONFIG_HASH_ANNOTATION];
  if (live && liveHash === panelProxyConfigHash(cfg)) {
    await k8sc.core.readNamespacedService({ name, namespace }).catch(async (err: unknown) => {
      if (!isNotFound(err)) throw err;
      await k8sc.core.createNamespacedService({ namespace, body: buildPanelProxyService(cfg.panel) });
    });
    return;
  }

  const secret = buildPanelProxySecret(cfg);
  try {
    await k8sc.core.replaceNamespacedSecret({ name, namespace, body: secret });
  } catch (err) {
    if (!isNotFound(err)) throw err;
    // backup-coverage: excluded:cluster-infrastructure
    // (oauth2-proxy-<panel> in `platform` ns; rebuilt from oidc_providers +
    // oidc_global_settings rows by panel-proxy-sync on every startup.)
    await k8sc.core.createNamespacedSecret({ namespace, body: secret });
  }

  const service = buildPanelProxyService(cfg.panel);
  try {
    const existing = await k8sc.core.readNamespacedService({ name, namespace });
    service.spec!.clusterIP = existing.spec?.clusterIP;
    service.metadata!.resourceVersion = existing.metadata?.resourceVersion;
    await k8sc.core.replaceNamespacedService({ name, namespace, body: service });
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await k8sc.core.createNamespacedService({ namespace, body: service });
  }

  const deployment = buildPanelProxyDeployment(cfg);
  if (live) {
    deployment.metadata!.resourceVersion = live.metadata?.resourceVersion;
    await k8sc.apps.replaceNamespacedDeployment({ name, namespace, body: deployment });
  } else {
    await k8sc.apps.createNamespacedDeployment({ namespace, body: deployment });
  }
}

async function ignoreNotFound(op: () => Promise<unknown>): Promise<void> {
  try {
    await op();
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

export async function removePanelProxy(k8sc: K8sClients, panel: ProxyPanel): Promise<void> {
  const name = panelProxyName(panel);
  const namespace = PLATFORM_NAMESPACE;
  await ignoreNotFound(() => k8sc.apps.deleteNamespacedDeployment({ name, namespace }));
  await ignoreNotFound(() => k8sc.core.deleteNamespacedService({ name, namespace }));
  await ignoreNotFound(() => k8sc.core.deleteNamespacedSecret({ name, namespace }));
}

// ─── Readiness ───────────────────────────────────────────────────────────────

/** Waiting reasons that will not resolve by waiting longer. */
const FATAL_WAITING = new Set(['CrashLoopBackOff', 'ErrImagePull', 'ImagePullBackOff', 'InvalidImageName', 'CreateContainerConfigError']);

interface PodProblem {
  readonly pod: string;
  readonly reason: string;
}

function isPodReady(pod: k8s.V1Pod): boolean {
  return (pod.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
}

/** Pure — exported for tests. First pod that is failing in a way waiting will not fix. */
export function fatalPodProblem(pods: ReadonlyArray<k8s.V1Pod>): PodProblem | null {
  for (const pod of pods) {
    for (const cs of pod.status?.containerStatuses ?? []) {
      const waiting = cs.state?.waiting?.reason;
      // A restart already means oauth2-proxy exited at least once — almost
      // always OIDC discovery or a rejected client. Do not wait out the backoff.
      if ((waiting && FATAL_WAITING.has(waiting)) || (cs.restartCount ?? 0) > 0) {
        return { pod: pod.metadata?.name ?? '?', reason: waiting ?? cs.lastState?.terminated?.reason ?? 'restarted' };
      }
    }
  }
  return null;
}

async function logTail(k8sc: K8sClients, pod: string): Promise<string> {
  try {
    const log = await k8sc.core.readNamespacedPodLog({
      name: pod, namespace: PLATFORM_NAMESPACE, container: 'oauth2-proxy', tailLines: 5, previous: true,
    });
    return String(log).trim();
  } catch {
    try {
      const log = await k8sc.core.readNamespacedPodLog({
        name: pod, namespace: PLATFORM_NAMESPACE, container: 'oauth2-proxy', tailLines: 5,
      });
      return String(log).trim();
    } catch {
      return '';
    }
  }
}

function notReady(panel: ProxyPanel, detail: string, log: string): ApiError {
  const code = 'OAUTH2_PROXY_NOT_READY';
  const message = `The ${panel} panel's OAuth2 Proxy did not start: ${detail}. Proxy protection was not enabled.`;
  return new ApiError(code, message, 409, {
    operatorError: {
      code,
      title: 'OAuth2 Proxy did not start',
      detail: message,
      remediation: [
        'Check that the chosen provider\'s issuer URL is reachable from the cluster and its client ID and secret are correct.',
        `Register https://<${panel} panel host>/oauth2/callback as a redirect URI for that client at the identity provider.`,
        'The panel stays reachable with its normal login while protection is off.',
      ],
      retryable: true,
      diagnostics: log ? { proxyLog: log } : undefined,
    },
  });
}

/**
 * Resolve once the panel's proxy has a Ready pod running the CURRENT template;
 * throw an `OAUTH2_PROXY_NOT_READY` OperatorError when it crashes, cannot pull,
 * or is still not ready after `timeoutMs`.
 */
export async function waitPanelProxyReady(
  k8sc: K8sClients,
  panel: ProxyPanel,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const name = panelProxyName(panel);
  const namespace = PLATFORM_NAMESPACE;
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  const pollMs = opts.pollMs ?? 2_000;
  const selector = `app=${APP_LABEL},${PANEL_LABEL_KEY}=${panel}`;

  for (;;) {
    // Judge the pods of the CURRENT template only: during a config change the
    // previous pods are still Ready, and they prove nothing about the new
    // provider. One Ready current pod is enough — it has passed OIDC discovery.
    const dep = await k8sc.apps.readNamespacedDeployment({ name, namespace });
    const hash = dep.spec?.template?.metadata?.annotations?.[CONFIG_HASH_ANNOTATION];
    const pods = await k8sc.core.listNamespacedPod({ namespace, labelSelector: selector });
    const currentPods = pods.items.filter((p) => p.metadata?.annotations?.[CONFIG_HASH_ANNOTATION] === hash);
    if (currentPods.some(isPodReady)) return;
    const problem = fatalPodProblem(currentPods);
    if (problem) throw notReady(panel, `pod ${problem.pod}: ${problem.reason}`, await logTail(k8sc, problem.pod));
    if (Date.now() >= deadline) {
      const pod = currentPods[0]?.metadata?.name;
      throw notReady(panel, 'not ready in time', pod ? await logTail(k8sc, pod) : '');
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
