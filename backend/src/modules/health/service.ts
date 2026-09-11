import { sql, eq } from 'drizzle-orm';
import type * as k8s from '@kubernetes/client-node';
import { dnsServers, oidcProviders } from '../../db/schema.js';
import { getProviderForServer } from '../dns-servers/service.js';
import { getRedis } from '../../shared/redis.js';
import type { Database } from '../../db/index.js';

export interface ServiceStatus {
  readonly name: string;
  readonly status: 'ok' | 'degraded' | 'error';
  readonly latencyMs?: number;
  readonly message?: string;
}

export interface HealthCheckResult {
  readonly overall: 'healthy' | 'degraded' | 'unhealthy';
  readonly services: readonly ServiceStatus[];
  readonly checkedAt: string;
}

export async function checkDatabase(db: Database): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    const latencyMs = Date.now() - start;
    return { name: 'database', status: 'ok', latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : 'Database unreachable';
    return { name: 'database', status: 'error', latencyMs, message };
  }
}

export async function checkDnsServers(db: Database, encryptionKey: string): Promise<readonly ServiceStatus[]> {
  const servers = await db.select().from(dnsServers).where(eq(dnsServers.enabled, 1));

  const results: ServiceStatus[] = [];

  for (const server of servers) {
    try {
      const provider = getProviderForServer(server, encryptionKey);
      const health = await provider.testConnection();
      results.push({
        name: `dns:${server.displayName}`,
        status: health.status === 'ok' ? 'ok' : 'error',
        message: health.message,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      results.push({
        name: `dns:${server.displayName}`,
        status: 'error',
        message,
      });
    }
  }

  return results;
}

export async function checkOidc(db: Database): Promise<ServiceStatus> {
  try {
    const providers = await db.select({ id: oidcProviders.id, enabled: oidcProviders.enabled })
      .from(oidcProviders);

    const enabledCount = providers.filter((p) => p.enabled === 1).length;

    if (providers.length === 0) {
      return { name: 'oidc', status: 'ok', message: 'No OIDC providers configured' };
    }

    if (enabledCount === 0) {
      return { name: 'oidc', status: 'degraded', message: 'All OIDC providers disabled' };
    }

    return { name: 'oidc', status: 'ok', message: `${enabledCount} provider(s) active` };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'OIDC check failed';
    return { name: 'oidc', status: 'error', message };
  }
}

/**
 * Nodes whose `Ready` condition is not `True`, by name.
 *
 * Exported so the readiness verdict can be unit-tested against raw Node
 * objects without standing up a cluster. `Ready` is tri-state: `True`,
 * `False` (kubelet says unhealthy) and `Unknown` (kubelet stopped posting —
 * what a dead node actually looks like). Only `True` counts as ready, so a
 * missing condition is treated as not-ready rather than silently passing.
 */
export function notReadyNodeNames(
  items: ReadonlyArray<{
    metadata?: { name?: string };
    status?: { conditions?: ReadonlyArray<{ type?: string; status?: string }> };
  }>,
): string[] {
  const out: string[] = [];
  for (const node of items) {
    const ready = (node.status?.conditions ?? []).find((c) => c.type === 'Ready');
    if (ready?.status !== 'True') out.push(node.metadata?.name ?? '<unnamed>');
  }
  return out.sort();
}

/**
 * Kubernetes health — reachability AND node readiness.
 *
 * This check used to call `listNode()` and return `ok` whenever the call
 * succeeded, reporting only a node COUNT. That made the platform's only
 * globally-mounted banner structurally incapable of showing a node outage:
 * during the 2026-09-11 drill the dashboard rendered "Platform: Healthy —
 * 4 / 4 services healthy" while a control-plane node was dead, eight volumes
 * were stranded and mail was down. A green banner during an outage is worse
 * than no banner, because it stops the operator looking further.
 *
 * A NotReady node is `degraded`, not `error`: the cluster is still serving
 * from its surviving nodes, and reserving `error` for "the API itself is
 * unreachable" keeps the two failure modes distinguishable in the banner.
 *
 * Readiness is read live from the API rather than from `node_health_state`
 * on purpose — that table is written by a 5-minute reconciler, so during the
 * drill it reported `ready: true` for a node that had been dead for over four
 * minutes. Live truth beats a cached snapshot for a health endpoint.
 */
export async function checkKubernetes(core?: k8s.CoreV1Api): Promise<ServiceStatus> {
  if (!core) {
    return { name: 'kubernetes', status: 'degraded', message: 'No kubeconfig configured' };
  }
  const start = Date.now();
  try {
    const res = await core.listNode();
    const latencyMs = Date.now() - start;
    const items = res.items ?? [];
    const nodeCount = items.length;
    const notReady = notReadyNodeNames(items);
    if (notReady.length > 0) {
      return {
        name: 'kubernetes',
        status: 'degraded',
        latencyMs,
        message: `${nodeCount - notReady.length}/${nodeCount} node(s) Ready — `
          + `NotReady: ${notReady.join(', ')}`,
      };
    }
    return { name: 'kubernetes', status: 'ok', latencyMs, message: `${nodeCount} node(s)` };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : 'K8s API unreachable';
    return { name: 'kubernetes', status: 'error', latencyMs, message };
  }
}

export async function checkRedis(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    const redis = getRedis();
    await redis.ping();
    const latencyMs = Date.now() - start;
    return { name: 'redis', status: 'ok', latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : 'Redis unreachable';
    return { name: 'redis', status: 'error', latencyMs, message };
  }
}

export async function runAllChecks(db: Database, encryptionKey: string, k8sCore?: k8s.CoreV1Api): Promise<HealthCheckResult> {
  const [dbStatus, dnsStatuses, oidcStatus, k8sStatus, redisStatus] = await Promise.all([
    checkDatabase(db),
    checkDnsServers(db, encryptionKey),
    checkOidc(db),
    checkKubernetes(k8sCore),
    checkRedis(),
  ]);

  const services: readonly ServiceStatus[] = [dbStatus, ...dnsStatuses, oidcStatus, k8sStatus, redisStatus];

  const hasError = services.some((s) => s.status === 'error');
  const hasDegraded = services.some((s) => s.status === 'degraded');

  let overall: 'healthy' | 'degraded' | 'unhealthy';
  if (hasError) {
    overall = 'unhealthy';
  } else if (hasDegraded) {
    overall = 'degraded';
  } else {
    overall = 'healthy';
  }

  return {
    overall,
    services,
    checkedAt: new Date().toISOString(),
  };
}
