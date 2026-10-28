/**
 * Who is connected: the platform asks each tenant's frps.
 *
 * Nothing used to. The connect-event endpoint (internal-routes.ts) was never
 * called by anything — frps had no plugin configured, and its NetworkPolicy
 * allows it no egress but DNS — and even a call would only have stamped
 * last_seen_at, never moved a worker out of `pending`. Production: a worker
 * whose client logged "login to server success" stayed "pending" with no
 * last-seen time.
 *
 * Polling frps's own status API rather than having frps call out keeps the
 * tunnel independent of platform-api: a frps server plugin that cannot reach
 * its endpoint rejects the client's login.
 *
 *   online proxy on a worker's port → the worker is connected now:
 *     status pending → active, last_seen_at = now, and a `connect` audit row
 *     when it was not connected at the previous poll
 *
 * A disconnected proxy loses its config in frps's answer (no remote port),
 * so "connected" is exactly "an online proxy on this worker's port".
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { privateWorkerAudit, privateWorkers, tenants } from '../../db/schema.js';
import { FRPS_WEB_API_PORT, FRPS_WEB_API_USER, frpsWebApiPassword, reconcilePrivateWorkersForTenant } from './reconciler.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import { safeTick } from '../../shared/safe-tick.js';

export const CONNECTION_POLL_MS = 60 * 1000;
/** Seen within this window = it was connected at the previous poll. */
const STILL_CONNECTED_MS = 3 * CONNECTION_POLL_MS;
const FRPS_FETCH_TIMEOUT_MS = 5000;

/** Remote ports with an online TCP proxy, from frps's `GET /api/proxy/tcp`. Pure. */
export function frpsOnlinePorts(body: unknown): Set<number> {
  const out = new Set<number>();
  const proxies = (body as { proxies?: unknown } | null)?.proxies;
  if (!Array.isArray(proxies)) return out;
  for (const p of proxies as Array<{ status?: unknown; conf?: { remotePort?: unknown } | null }>) {
    if (p?.status !== 'online') continue;
    const port = p.conf?.remotePort;
    if (typeof port === 'number' && Number.isInteger(port)) out.add(port);
  }
  return out;
}

type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** One tenant's frps, asked for its online ports. Null when it cannot be read. */
async function onlinePortsOf(
  k8s: K8sClients,
  namespace: string,
  password: string,
  fetcher: Fetcher,
): Promise<Set<number> | null> {
  const pods = await k8s.core.listNamespacedPod({
    namespace, labelSelector: 'app.kubernetes.io/name=private-worker-server',
  } as never) as { items?: Array<{ status?: { phase?: string; podIP?: string }; metadata?: { deletionTimestamp?: unknown } }> };
  const pod = (pods.items ?? []).find((p) => p.status?.phase === 'Running' && p.status.podIP && !p.metadata?.deletionTimestamp);
  if (!pod?.status?.podIP) return null;
  const host = pod.status.podIP.includes(':') ? `[${pod.status.podIP}]` : pod.status.podIP;
  const res = await fetcher(`http://${host}:${FRPS_WEB_API_PORT}/api/proxy/tcp`, {
    headers: { authorization: `Basic ${Buffer.from(`${FRPS_WEB_API_USER}:${password}`).toString('base64')}` },
    signal: AbortSignal.timeout(FRPS_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  return frpsOnlinePorts(await res.json());
}

export interface PollResult {
  readonly tenants: number;
  readonly unreadable: number;
  readonly connected: number;
}

export async function pollPrivateWorkerConnections(
  db: Database,
  k8s: K8sClients,
  fetcher: Fetcher = fetch as unknown as Fetcher,
): Promise<PollResult> {
  const rows = await db
    .select({
      workerId: privateWorkers.id,
      tenantId: privateWorkers.tenantId,
      port: privateWorkers.exposedPort,
      lastSeenAt: privateWorkers.lastSeenAt,
      namespace: tenants.kubernetesNamespace,
      secret: tenants.privateWorkerSharedSecret,
    })
    .from(privateWorkers)
    .innerJoin(tenants, eq(tenants.id, privateWorkers.tenantId))
    .where(and(inArray(privateWorkers.status, ['pending', 'active']), eq(tenants.status, 'active')));

  const byTenant = new Map<string, typeof rows>();
  for (const r of rows) byTenant.set(r.tenantId, [...(byTenant.get(r.tenantId) ?? []), r]);

  let unreadable = 0;
  let connected = 0;
  for (const [tenantId, workers] of byTenant) {
    const { namespace, secret } = workers[0];
    if (!namespace || !secret) continue;
    let online: Set<number> | null = null;
    try {
      online = await onlinePortsOf(k8s, namespace, frpsWebApiPassword(tenantId, secret), fetcher);
    } catch {
      online = null;
    }
    if (!online) { unreadable += 1; continue; }
    const now = Date.now();
    for (const w of workers.filter((x) => online!.has(x.port))) {
      connected += 1;
      const wasConnected = w.lastSeenAt !== null && now - new Date(w.lastSeenAt).getTime() < STILL_CONNECTED_MS;
      await db.update(privateWorkers)
        .set({
          lastSeenAt: sql`now()`,
          status: sql`CASE WHEN ${privateWorkers.status} = 'pending' THEN 'active'::private_worker_status ELSE ${privateWorkers.status} END`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(privateWorkers.id, w.workerId), inArray(privateWorkers.status, ['pending', 'active'])));
      if (!wasConnected) {
        await db.insert(privateWorkerAudit).values({
          privateWorkerId: w.workerId, event: 'connect', ip: null, detail: { source: 'frps-status' },
        });
      }
    }
  }
  return { tenants: byTenant.size, unreadable, connected };
}

/**
 * Started once per api replica: a reconcile of every tenant with workers (so a
 * release's frps spec — its pin, its status API — reaches pods created by an
 * older one), then the poll every minute on one replica at a time.
 */
export function startPrivateWorkerConnectionPoller(deps: {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly log: { warn: (obj: unknown, msg?: string) => void };
}): () => void {
  const { db, k8s, log } = deps;
  const warn = { warn: (msg: string, err?: unknown) => log.warn({ err }, `[private-workers] ${msg}`) };
  void (async () => {
    try {
      const tenantIds = await db.selectDistinct({ id: privateWorkers.tenantId }).from(privateWorkers)
        .where(inArray(privateWorkers.status, ['pending', 'active']));
      for (const { id } of tenantIds) {
        const out = await reconcilePrivateWorkersForTenant({ db, k8s }, id);
        if (out.error) log.warn({ tenantId: id, error: out.error }, '[private-workers] startup reconcile reported an error');
      }
    } catch (err) {
      log.warn({ err }, '[private-workers] startup reconcile failed');
    }
  })();
  const tick = (): void => safeTick(
    'private-worker-connections',
    () => withSchedulerLease(db, 'private-worker-connections', CONNECTION_POLL_MS * 1.5, () => pollPrivateWorkerConnections(db, k8s)),
    warn,
  );
  const timer = setInterval(tick, CONNECTION_POLL_MS);
  return () => clearInterval(timer);
}
