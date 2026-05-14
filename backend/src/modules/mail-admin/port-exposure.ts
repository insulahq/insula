/**
 * Mail port exposure mode — toggle between:
 *
 *   thisNodeOnly   — Stalwart pod binds mail ports via hostPort directly;
 *                    only the node the pod is scheduled on receives traffic.
 *                    No haproxy DaemonSet present in the cluster.
 *
 *   allServerNodes — haproxy DaemonSet bound on every server-role node
 *                    forwards mail traffic to stalwart-mail.mail.svc with
 *                    PROXY Protocol v2 so Stalwart sees real client IPs.
 *                    DS is CREATED by platform-api on entry to this mode,
 *                    DELETED on exit.
 *
 * Switching modes is a two-step operation that avoids port conflicts:
 *
 *   thisNodeOnly → allServerNodes:
 *     1. Remove hostPort from Stalwart Deployment (JSON-Patch on the
 *        ports array; Deployment rolls).
 *     2. CREATE the haproxy DaemonSet (apps.createNamespacedDaemonSet
 *        from the buildHaproxyDaemonSet() spec).
 *     3. Persist mode in system_settings.
 *
 *   allServerNodes → thisNodeOnly:
 *     1. DELETE the haproxy DaemonSet (apps.deleteNamespacedDaemonSet).
 *     2. Re-add hostPort to Stalwart Deployment (Deployment rolls).
 *     3. Persist mode in system_settings.
 *
 * 2026-05-14 streamline: previously the DS was always-applied by Flux
 * with a dummy nodeSelector and platform-api SSA-patched the selector
 * to toggle. That created an ongoing field-ownership war with Flux's
 * kustomize-controller (PRs #43–#45). Moving the DS object lifecycle
 * to platform-api ends the war — Flux still owns the ConfigMap and
 * NetworkPolicy, both of which are static and benefit from GitOps.
 *
 * GET  /admin/mail/port-exposure  → MailPortExposureResponse
 * PATCH /admin/mail/port-exposure → 204
 */

import { eq } from 'drizzle-orm';
import { ApiError } from '../../shared/errors.js';
import { JSON_PATCH } from '../../shared/k8s-patch.js';
import { isNotFound } from '../../shared/k8s-errors.js';
import { systemSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import {
  type MailPortExposureResponse,
  mailPortExposureResponseSchema,
} from '@k8s-hosting/api-contracts';
import {
  buildHaproxyDaemonSet,
  HAPROXY_DS_NAME,
  HAPROXY_DS_NAMESPACE,
} from './haproxy-builder.js';

const SETTINGS_ID = 'system';
const DEPLOYMENT_NAME = 'stalwart-mail';

// Mail ports that Stalwart binds via hostPort in 'thisNodeOnly' mode.
const MAIL_HOST_PORTS = [25, 465, 587, 143, 993, 4190] as const;

export interface PortExposureOptions {
  readonly kubeconfigPath: string | undefined;
}

interface K8sAppsBundle {
  apps: import('@kubernetes/client-node').AppsV1Api;
}

async function loadK8sAppsClient(kubeconfigPath: string | undefined): Promise<K8sAppsBundle> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  return { apps: kc.makeApiClient(k8s.AppsV1Api) };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read the current port-exposure mode and haproxy DaemonSet status.
 *
 * The DS is expected to be ABSENT in `thisNodeOnly` mode (platform-api
 * deleted it) and PRESENT with the expected pod count in `allServerNodes`
 * mode. Drift (DS present but mode=thisNodeOnly, or DS absent but
 * mode=allServerNodes) shows up in the response as `daemonSetStatus`
 * not matching `proxyProtocolActive` — operator-visible in the UI.
 */
export async function getMailPortExposure(
  db: Database,
  opts: PortExposureOptions,
): Promise<MailPortExposureResponse> {
  const { apps } = await loadK8sAppsClient(opts.kubeconfigPath);

  const [row] = await db.select({ v: systemSettings.mailPortExposureMode })
    .from(systemSettings)
    .where(eq(systemSettings.id, SETTINGS_ID));

  const mode = (row?.v as 'thisNodeOnly' | 'allServerNodes' | null) ?? 'thisNodeOnly';

  let daemonSetStatus: { ready: number; desired: number } | null = null;
  try {
    const ds = await apps.readNamespacedDaemonSet({
      namespace: HAPROXY_DS_NAMESPACE,
      name: HAPROXY_DS_NAME,
    }) as { status?: { numberReady?: number; desiredNumberScheduled?: number } };
    daemonSetStatus = {
      ready: ds.status?.numberReady ?? 0,
      desired: ds.status?.desiredNumberScheduled ?? 0,
    };
  } catch (err) {
    if (isNotFound(err)) {
      // DS not present — expected in thisNodeOnly mode.
      daemonSetStatus = null;
    }
    // Non-404 errors are swallowed — mode is still readable from DB.
  }

  return mailPortExposureResponseSchema.parse({
    mode,
    proxyProtocolActive: mode === 'allServerNodes',
    daemonSetStatus,
  });
}

/**
 * Switch the port-exposure mode.
 * Applies the two-step transition to avoid port conflicts on nodes.
 */
export async function updateMailPortExposure(
  { mode }: { mode: 'thisNodeOnly' | 'allServerNodes' },
  db: Database,
  opts: PortExposureOptions,
): Promise<void> {
  const { apps } = await loadK8sAppsClient(opts.kubeconfigPath);

  if (mode === 'allServerNodes') {
    // Step 1: Remove hostPort from Stalwart Deployment so haproxy can bind
    // the same ports on the same nodes without conflict.
    await removeHostPortsFromDeployment(apps);

    // Step 2: Create the haproxy DaemonSet.
    await ensureHaproxyDaemonSetExists(apps);
  } else {
    // thisNodeOnly path — reverse order.

    // Step 1: Delete the haproxy DaemonSet first so its hostPorts are
    // released before Stalwart tries to bind them.
    await ensureHaproxyDaemonSetAbsent(apps);

    // Step 2: Re-add hostPorts to Stalwart Deployment.
    await addHostPortsToDeployment(apps);
  }

  // Step 3: Persist the new mode.
  await db.update(systemSettings)
    .set({ mailPortExposureMode: mode })
    .where(eq(systemSettings.id, SETTINGS_ID));
}

// ── Private helpers ────────────────────────────────────────────────────────────

type ContainerShape = {
  name: string;
  ports?: Array<{ containerPort: number; hostPort?: number; name?: string; protocol?: string }>;
};

type DeploymentShape = {
  spec?: {
    template?: {
      spec?: {
        containers?: ContainerShape[];
      };
    };
  };
};

async function readDeployment(apps: import('@kubernetes/client-node').AppsV1Api): Promise<DeploymentShape> {
  try {
    return await apps.readNamespacedDeployment({
      namespace: HAPROXY_DS_NAMESPACE,
      name: DEPLOYMENT_NAME,
    }) as DeploymentShape;
  } catch (err) {
    throw new ApiError(
      'MAIL_DEPLOYMENT_READ_FAILED',
      `Could not read Stalwart Deployment: ${(err as Error).message ?? String(err)}`,
      503,
    );
  }
}

/**
 * Replace the Stalwart Deployment's container ports array.
 *
 * We use JSON-Patch (`replace` on the whole ports array) rather than
 * strategic-merge-patch because strategic-merge merges port entries by
 * `containerPort`, which means omitting `hostPort` from a port entry does
 * NOT remove the existing hostPort — it just leaves the existing value
 * in place. To toggle hostPort on/off reliably we have to replace the
 * array wholesale.
 */
async function replaceStalwartContainerPorts(
  apps: import('@kubernetes/client-node').AppsV1Api,
  withHostPorts: boolean,
): Promise<void> {
  const dep = await readDeployment(apps);
  const containers = dep.spec?.template?.spec?.containers ?? [];
  const stalwartIdx = containers.findIndex((c) => c.name === 'stalwart');
  if (stalwartIdx < 0) {
    throw new ApiError(
      'MAIL_DEPLOYMENT_PATCH_FAILED',
      'Stalwart container not found in Deployment spec',
      503,
    );
  }
  const stalwart = containers[stalwartIdx];

  const newPorts = (stalwart.ports ?? []).map((p) => {
    const isMailPort = (MAIL_HOST_PORTS as readonly number[]).includes(p.containerPort);
    if (!isMailPort) {
      // Non-mail port (mgmt-http :8080, http-acme :80) — never gets a hostPort.
      const { hostPort: _drop, ...rest } = p;
      return rest;
    }
    if (withHostPorts) {
      return { ...p, hostPort: p.containerPort };
    }
    // Mail port + hostPorts disabled → strip hostPort.
    const { hostPort: _drop, ...rest } = p;
    return rest;
  });

  const body = [
    {
      op: 'replace',
      path: `/spec/template/spec/containers/${stalwartIdx}/ports`,
      value: newPorts,
    },
  ];

  await apps.patchNamespacedDeployment(
    {
      namespace: HAPROXY_DS_NAMESPACE,
      name: DEPLOYMENT_NAME,
      body: body as unknown as object,
    } as unknown as Parameters<typeof apps.patchNamespacedDeployment>[0],
    JSON_PATCH,
  ).catch((err) => {
    throw new ApiError(
      'MAIL_DEPLOYMENT_PATCH_FAILED',
      `Failed to ${withHostPorts ? 're-add' : 'remove'} hostPorts on Stalwart Deployment: ${(err as Error).message ?? String(err)}`,
      500,
    );
  });
}

async function removeHostPortsFromDeployment(
  apps: import('@kubernetes/client-node').AppsV1Api,
): Promise<void> {
  await replaceStalwartContainerPorts(apps, /* withHostPorts= */ false);
}

async function addHostPortsToDeployment(
  apps: import('@kubernetes/client-node').AppsV1Api,
): Promise<void> {
  await replaceStalwartContainerPorts(apps, /* withHostPorts= */ true);
}

/**
 * Create the haproxy DaemonSet if it doesn't exist; do nothing if it
 * already does. Idempotent — safe to call from a retry loop.
 *
 * The spec comes from buildHaproxyDaemonSet() so this function and
 * `getMailPortExposure`'s status read agree on the object's name +
 * namespace.
 */
async function ensureHaproxyDaemonSetExists(
  apps: import('@kubernetes/client-node').AppsV1Api,
): Promise<void> {
  try {
    await apps.readNamespacedDaemonSet({
      namespace: HAPROXY_DS_NAMESPACE,
      name: HAPROXY_DS_NAME,
    });
    // Already present — do not overwrite. Operator can `kubectl delete`
    // to force a re-create from the latest builder output.
    return;
  } catch (err) {
    if (!isNotFound(err)) {
      throw new ApiError(
        'MAIL_HAPROXY_DS_READ_FAILED',
        `Failed to read haproxy DaemonSet: ${(err as Error).message ?? String(err)}`,
        500,
      );
    }
    // 404 — fall through to create.
  }

  const body = buildHaproxyDaemonSet();
  try {
    await apps.createNamespacedDaemonSet({
      namespace: HAPROXY_DS_NAMESPACE,
      body: body as unknown as Parameters<typeof apps.createNamespacedDaemonSet>[0]['body'],
    });
  } catch (err) {
    // Race: someone else created it between our read + create. Treat
    // as success since the desired state is "DS exists".
    if (isConflict(err)) return;
    throw new ApiError(
      'MAIL_HAPROXY_DS_CREATE_FAILED',
      `Failed to create haproxy DaemonSet: ${(err as Error).message ?? String(err)}`,
      500,
    );
  }
}

/**
 * Delete the haproxy DaemonSet. Idempotent — 404 is treated as success.
 */
async function ensureHaproxyDaemonSetAbsent(
  apps: import('@kubernetes/client-node').AppsV1Api,
): Promise<void> {
  try {
    await apps.deleteNamespacedDaemonSet({
      namespace: HAPROXY_DS_NAMESPACE,
      name: HAPROXY_DS_NAME,
    });
  } catch (err) {
    if (isNotFound(err)) return;
    throw new ApiError(
      'MAIL_HAPROXY_DS_DELETE_FAILED',
      `Failed to delete haproxy DaemonSet: ${(err as Error).message ?? String(err)}`,
      500,
    );
  }
}

function isConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: number; statusCode?: number; body?: { code?: number } };
  const code = e.code ?? e.statusCode ?? e.body?.code;
  return code === 409;
}
