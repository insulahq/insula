/**
 * Mail port EXPOSURE probe — the `exposure` component of GET /admin/mail/health.
 *
 * Runs over the mail endpoint set (mail-endpoints.ts) and nothing else, so a
 * standby placement node or a server that holds no mail role is never looked
 * at. Split out of health.ts to keep that module within the file-size budget.
 */

import type {
  MailEndpointSet,
  MailHealthExposureComponent,
  MailHealthExposureNode,
} from '@insula/api-contracts';
import { HAPROXY_DS_NAMESPACE, HAPROXY_POD_LABEL_SELECTOR } from './haproxy-builder.js';

/** What the exposure probe needs from the health deps. */
export interface ExposureProbeDeps {
  readonly k8s: {
    readonly core: {
      listNamespacedPod: (q: { namespace: string; labelSelector?: string }) => Promise<unknown>;
    };
  };
  readonly endpoints?: MailEndpointSet;
  readonly endpointsError?: string;
}

/** The Stalwart pod as the pod probe saw it (the active node's publisher). */
export interface ActiveStalwartPod {
  readonly podName: string | null;
  readonly node: string | null;
  readonly containerReady: boolean | null;
  /** hostPorts declared by the stalwart container. */
  readonly hostPorts: ReadonlyArray<number>;
}

/**
 * Per-endpoint port exposure. For every mail endpoint (and ONLY those — a
 * standby or unassigned node is never looked at) check the publisher:
 *
 *   hostPort (active node) — the Stalwart pod runs there, is Ready, and its
 *                            stalwart container declares hostPort=<port>.
 *   haproxy  (other nodes) — a non-terminating stalwart-haproxy pod runs
 *                            there, is Ready (its readinessProbe is a TCP
 *                            connect to :25 on the host network), and declares
 *                            hostPort=<port>.
 *
 * Cluster-state only, by design: opening bare connections to every public
 * address × port from inside the cluster is exactly the pattern Stalwart's
 * port-scan auto-ban punishes, and a banned cluster source would take real
 * mail down with it.
 */
export async function probeExposure(
  deps: ExposureProbeDeps,
  pod: ActiveStalwartPod,
): Promise<MailHealthExposureComponent> {
  if (deps.endpointsError) {
    return {
      status: 'fail',
      healthy: false,
      nodes: [],
      error: `Could not determine the mail endpoints: ${deps.endpointsError}`,
    };
  }
  const set = deps.endpoints;
  if (!set) return { status: 'not_implemented', healthy: true, nodes: [], error: null };
  if (set.endpoints.length === 0) {
    return {
      status: 'fail',
      healthy: false,
      nodes: [],
      error:
        `No node publishes the mail ports (mode ${set.mode}): no Stalwart pod is running and neither an ` +
        'active nor a primary mail node is recorded. Set the primary mail node under Email Operations → Placement.',
    };
  }

  let haproxyPods: ReadonlyArray<PublisherPod> = [];
  let haproxyError: string | null = null;
  if (set.endpoints.some((e) => e.exposure === 'haproxy')) {
    try {
      haproxyPods = await listHaproxyPods(deps);
    } catch (err) {
      haproxyError = (err as Error).message ?? String(err);
    }
  }

  const nodes: MailHealthExposureNode[] = set.endpoints.map((e) => (e.exposure === 'hostPort'
    ? stalwartExposure(e.node, set.ports, pod)
    : haproxyExposure(e.node, set.ports, haproxyPods, haproxyError)));
  const bad = nodes.filter((n) => n.error !== null);
  if (bad.length === 0) return { status: 'ok', healthy: true, nodes, error: null };
  return {
    status: 'fail',
    healthy: false,
    nodes,
    error: `${bad.length}/${nodes.length} mail endpoint(s) not publishing every mail port: ` +
      bad.map((n) => `${n.node}: ${n.error}`).join('; '),
  };
}

interface PublisherPod {
  readonly node: string;
  readonly ready: boolean;
  readonly hostPorts: ReadonlyArray<number>;
}

interface RawHaproxyPod {
  metadata?: { deletionTimestamp?: unknown };
  spec?: {
    nodeName?: string;
    containers?: Array<{ ports?: Array<{ hostPort?: number }> }>;
  };
  status?: { conditions?: Array<{ type?: string; status?: string }> };
}

async function listHaproxyPods(deps: ExposureProbeDeps): Promise<PublisherPod[]> {
  const list = await deps.k8s.core.listNamespacedPod({
    namespace: HAPROXY_DS_NAMESPACE,
    labelSelector: HAPROXY_POD_LABEL_SELECTOR,
  }) as { items?: RawHaproxyPod[] };
  return (list.items ?? [])
    .filter((p) => !p.metadata?.deletionTimestamp && !!p.spec?.nodeName)
    .map((p) => ({
      node: p.spec!.nodeName!,
      ready: (p.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'),
      hostPorts: (p.spec?.containers ?? [])
        .flatMap((c) => c.ports ?? [])
        .map((port) => port.hostPort)
        .filter((port): port is number => typeof port === 'number' && port > 0),
    }));
}

function exposureNode(
  node: string,
  exposure: MailHealthExposureNode['exposure'],
  ports: ReadonlyArray<number>,
  publisher: { ready: boolean; hostPorts: ReadonlyArray<number> },
  notReadyError: string,
): MailHealthExposureNode {
  const rows = ports.map((port) => ({
    port,
    published: publisher.ready && publisher.hostPorts.includes(port),
  }));
  const undeclared = ports.filter((port) => !publisher.hostPorts.includes(port));
  const error = !publisher.ready
    ? notReadyError
    : undeclared.length > 0
      ? `publisher declares no hostPort for ${undeclared.join(', ')}`
      : null;
  return { node, exposure, ready: publisher.ready, ports: rows, error };
}

function stalwartExposure(
  node: string,
  ports: ReadonlyArray<number>,
  pod: ActiveStalwartPod,
): MailHealthExposureNode {
  if (!pod.podName || pod.node !== node) {
    return exposureNode(node, 'hostPort', ports, { ready: false, hostPorts: [] },
      pod.node
        ? `the Stalwart pod runs on ${pod.node}, not on this active mail node`
        : 'no Stalwart pod is running here (see the pod probe)');
  }
  return exposureNode(node, 'hostPort', ports,
    { ready: pod.containerReady === true, hostPorts: pod.hostPorts },
    'the Stalwart pod here is not Ready (see the pod probe)');
}

function haproxyExposure(
  node: string,
  ports: ReadonlyArray<number>,
  pods: ReadonlyArray<PublisherPod>,
  listError: string | null,
): MailHealthExposureNode {
  if (listError) {
    return exposureNode(node, 'haproxy', ports, { ready: false, hostPorts: [] },
      `could not list stalwart-haproxy pods: ${listError}`);
  }
  const onNode = pods.filter((p) => p.node === node);
  const pod = onNode.find((p) => p.ready) ?? onNode[0];
  if (!pod) {
    return exposureNode(node, 'haproxy', ports, { ready: false, hostPorts: [] },
      'no stalwart-haproxy pod runs here — the node lacks the insula.host/mail-haproxy=true label or ' +
      'DaemonSet mail/stalwart-haproxy is missing. Labels are reconciled when the port-exposure mode is ' +
      'applied, after a mail migration and on platform-api start — re-apply the port-exposure mode ' +
      '(e.g. after a node joined)');
  }
  return exposureNode(node, 'haproxy', ports, pod, 'the stalwart-haproxy pod here is not Ready');
}
