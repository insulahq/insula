/**
 * Wiring exact route names into a traffic frame — the part that touches the
 * cluster and the database. Best-effort by contract: a name is a label on a
 * chart, and no failure here may fail the traffic request. Whatever cannot
 * be read is logged and the series keep their existing fallback names.
 */

import { eq, inArray } from 'drizzle-orm';
import { deployments, domains, ingressRoutes, privateWorkers, tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { LiveRouteIndex, LiveRouteSource } from './live-ingress-routes.js';
import {
  acmeSolverNamespace, exactRouteName, isHiddenRouteSeries, type RouteRow,
} from './route-names.js';

export interface WarnLogger {
  warn(obj: object, msg: string): void;
}

export interface ExactRouteNamer {
  /** Namespaces whose tenant names the frame must resolve for these series. */
  readonly namespaces: readonly string[];
  /** Exact name for a service label, or null to keep the fallback. */
  name(service: string, nsToName: ReadonlyMap<string, string>): string | null;
  /** Nobody's route — a certificate solver, or a route that no longer exists. */
  hidden(service: string): boolean;
}

export interface ExactRouteNamerOptions {
  readonly db: Database;
  readonly liveRoutes?: LiveRouteSource;
  readonly tenantView: boolean;
  readonly log?: WarnLogger;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const unique = (xs: ReadonlyArray<string | null>): string[] =>
  [...new Set(xs.filter((x): x is string => Boolean(x)))];

/** Every route row in `namespaces`, with the name of whatever it targets. */
export async function loadRouteRows(db: Database, namespaces: readonly string[]): Promise<RouteRow[]> {
  if (namespaces.length === 0) return [];
  const rows = await db
    .select({
      ns: tenants.kubernetesNamespace,
      hostname: ingressRoutes.hostname,
      path: ingressRoutes.path,
      wwwRedirect: ingressRoutes.wwwRedirect,
      deploymentName: deployments.name,
      workerName: privateWorkers.name,
    })
    .from(ingressRoutes)
    .innerJoin(domains, eq(domains.id, ingressRoutes.domainId))
    .innerJoin(tenants, eq(tenants.id, domains.tenantId))
    .leftJoin(deployments, eq(deployments.id, ingressRoutes.deploymentId))
    .leftJoin(privateWorkers, eq(privateWorkers.id, ingressRoutes.privateWorkerId))
    .where(inArray(tenants.kubernetesNamespace, [...namespaces]));
  return rows.flatMap((r): RouteRow[] => (r.ns ? [{
    namespace: r.ns,
    hostname: r.hostname,
    path: r.path,
    wwwRedirect: r.wwwRedirect,
    targetName: r.deploymentName ?? r.workerName ?? null,
  }] : []));
}

/** The live index, and whether it was actually read — an empty map is not proof of absence. */
async function readLive(opts: ExactRouteNamerOptions): Promise<{ index: LiveRouteIndex; ok: boolean }> {
  if (!opts.liveRoutes) return { index: new Map(), ok: false };
  try {
    return { index: await opts.liveRoutes(), ok: true };
  } catch (err) {
    (opts.log ?? console).warn(
      { err: errText(err) },
      '[traffic] live IngressRoutes unreadable; route series keep their fallback names',
    );
    return { index: new Map(), ok: false };
  }
}

async function readRows(opts: ExactRouteNamerOptions, namespaces: readonly string[]): Promise<RouteRow[]> {
  try {
    return await loadRouteRows(opts.db, namespaces);
  } catch (err) {
    (opts.log ?? console).warn(
      { err: errText(err) },
      '[traffic] ingress route rows unreadable; route series are named by backend Service',
    );
    return [];
  }
}

/** Resolve everything needed to name `services` exactly. Never throws. */
export async function loadExactRouteNamer(
  services: readonly string[],
  opts: ExactRouteNamerOptions,
): Promise<ExactRouteNamer> {
  const read = services.length > 0 ? await readLive(opts) : { index: new Map() as LiveRouteIndex, ok: false };
  const live = read.index;
  const routeNamespaces = unique(services.map((s) => live.get(s)?.namespace ?? null));
  const rows = routeNamespaces.length > 0 ? await readRows(opts, routeNamespaces) : [];
  const solverNamespaces = unique(services.map(acmeSolverNamespace));
  return {
    namespaces: unique([...routeNamespaces, ...solverNamespaces]),
    name: (service, nsToName) => exactRouteName(service, { live, rows, nsToName, tenantView: opts.tenantView }),
    hidden: (service) => isHiddenRouteSeries(service, live, read.ok),
  };
}
