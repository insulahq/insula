// Which port of a custom deployment an ingress route lands on.
//
// One resolver for both sides of a port edit: the ingress reconciler uses it
// to build the IngressRoute, and the edit uses it to keep routes attached.
// The reconciler SKIPS a route it cannot resolve, so a port edit that strands
// a route turns its hostname into a 404 with no error anywhere — the edit has
// to catch that before it saves.

export interface RoutePortTarget {
  /** Key in `customSpec.services`. */
  readonly svcName: string;
  readonly portName: string;
  readonly port: number;
}

interface PortLike {
  readonly name: string;
  readonly containerPort: number;
  readonly exposeAsService?: boolean;
  readonly ingressEligible?: boolean;
}

export interface SpecPortsLike {
  readonly services?: Readonly<Record<string, { readonly ports?: readonly PortLike[] }>>;
}

/**
 * A pinned route (`servicePort` set — chosen from a multi-port picker) lands
 * on the port with that number; an unpinned one on the first ingress-eligible
 * port. Either way only an exposed port qualifies: without
 * `exposeAsService` no Service exists for the ingress to point at.
 */
export function resolveCustomRoutePort(spec: SpecPortsLike, servicePort: number | null): RoutePortTarget | undefined {
  for (const [svcName, svc] of Object.entries(spec.services ?? {})) {
    const p = (svc.ports ?? []).find((q) => q.exposeAsService !== false
      && (servicePort ? q.containerPort === servicePort : q.ingressEligible === true));
    if (p) return { svcName, portName: p.name, port: p.containerPort };
  }
  return undefined;
}

export interface RouteForPortEdit {
  readonly id: string;
  readonly hostname: string;
  readonly servicePort: number | null;
}

export interface PortEditRoutePlan {
  /** Pinned routes whose port kept its name but changed number. */
  readonly repins: ReadonlyArray<{ readonly routeId: string; readonly servicePort: number }>;
  /** Hostnames that resolved before the edit and would resolve to nothing after it. */
  readonly stranded: readonly string[];
}

/**
 * What a port edit does to the routes bound to the deployment.
 *
 * A pinned route follows its port by NAME within its service — renumbering
 * `http` 80 → 8080 re-pins the route to 8080 rather than stranding it, and a
 * swap of two numbers does not silently send it to the other port. When the
 * name is gone but the number survives (a rename), the number decides.
 *
 * A route that did not resolve before the edit is not counted: refusing the
 * save would not repair it.
 */
export function planRoutesForPortEdit(
  before: SpecPortsLike,
  after: SpecPortsLike,
  routes: readonly RouteForPortEdit[],
): PortEditRoutePlan {
  const repins: Array<{ routeId: string; servicePort: number }> = [];
  const stranded: string[] = [];
  for (const route of routes) {
    const was = resolveCustomRoutePort(before, route.servicePort);
    if (!was) continue;
    if (route.servicePort === null) {
      if (!resolveCustomRoutePort(after, null)) stranded.push(route.hostname);
      continue;
    }
    const sameName = (after.services?.[was.svcName]?.ports ?? [])
      .find((p) => p.name === was.portName && p.exposeAsService !== false);
    if (sameName) {
      if (sameName.containerPort !== route.servicePort) {
        repins.push({ routeId: route.id, servicePort: sameName.containerPort });
      }
      continue;
    }
    if (!resolveCustomRoutePort(after, route.servicePort)) stranded.push(route.hostname);
  }
  return { repins, stranded };
}
