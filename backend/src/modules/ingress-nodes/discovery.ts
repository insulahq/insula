/**
 * Discover the cluster's ingress-capable node addresses.
 *
 * This mirrors — deliberately and exactly — the node filter in
 * `k8s/base/ingress-external-ips/cronjob.yaml`, which maintains Traefik's
 * `Service.spec.externalIPs`. Two different definitions of "ingress-capable"
 * would be worse than none: DNS would advertise a node Traefik doesn't serve,
 * or vice versa. If that filter changes, change it here too.
 *
 * The one intentional difference: the CronJob keeps IPv4 only (a Service's
 * externalIPs list there), whereas DNS wants both families, so AAAA is
 * collected as well.
 */

/** The subset of a Node object this module reads. */
export interface NodeLike {
  readonly metadata?: {
    readonly name?: string;
    readonly labels?: Record<string, string>;
  };
  readonly status?: {
    readonly conditions?: ReadonlyArray<{ readonly type?: string; readonly status?: string }>;
    readonly addresses?: ReadonlyArray<{ readonly type?: string; readonly address?: string }>;
  };
}

export interface DiscoveredIngressAddresses {
  readonly ipv4: string[];
  readonly ipv6: string[];
  /** Names of the nodes that contributed, for operator-facing logging. */
  readonly nodeNames: string[];
}

const INGRESS_MODE_LABEL = 'insula.host/ingress-mode';
const EXPOSURE_LABEL = 'insula.host/exposure';

function isReady(node: NodeLike): boolean {
  const ready = node.status?.conditions?.find((c) => c.type === 'Ready');
  return ready?.status === 'True';
}

/**
 * Both labels default to "include" when absent — that is what makes an
 * ordinary worker node eligible without any labelling, and it matches the
 * CronJob, where a missing label renders as `<none>` and passes the `!=`
 * filters.
 */
function isIngressEligible(node: NodeLike): boolean {
  const labels = node.metadata?.labels ?? {};
  if (labels[INGRESS_MODE_LABEL] === 'none') return false;
  if (labels[EXPOSURE_LABEL] === 'private') return false;
  return true;
}

function isIpv4(addr: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(addr);
}

/**
 * Pure selector — the interesting logic, kept free of the k8s client so the
 * filter rules are directly testable.
 *
 * Only `ExternalIP` counts. An InternalIP is by definition not reachable by
 * the clients a tenant apex record serves, and publishing one would create an
 * apex that resolves but never connects.
 */
export function selectIngressNodeAddresses(
  nodes: readonly NodeLike[],
): DiscoveredIngressAddresses {
  const ipv4 = new Set<string>();
  const ipv6 = new Set<string>();
  const nodeNames: string[] = [];

  for (const node of nodes) {
    if (!isReady(node) || !isIngressEligible(node)) continue;

    const external = (node.status?.addresses ?? []).filter(
      (a) => a.type === 'ExternalIP' && typeof a.address === 'string' && a.address.length > 0,
    );
    if (external.length === 0) continue;

    let contributed = false;
    for (const a of external) {
      const addr = (a.address as string).trim();
      if (isIpv4(addr)) {
        ipv4.add(addr);
        contributed = true;
      } else if (addr.includes(':')) {
        ipv6.add(addr.toLowerCase());
        contributed = true;
      }
    }
    if (contributed && node.metadata?.name) nodeNames.push(node.metadata.name);
  }

  return {
    ipv4: Array.from(ipv4).sort(),
    ipv6: Array.from(ipv6).sort(),
    nodeNames: nodeNames.sort(),
  };
}
