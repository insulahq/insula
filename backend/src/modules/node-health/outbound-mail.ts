/**
 * Outbound mail ports, as each node's security-probe measured them.
 *
 * A hosting provider can block outbound TCP 25/465/587 on a server. Nothing on
 * the node shows it — its firewall lets the traffic out and the provider drops
 * it — so every send from the node times out: a tenant app's mail (a production
 * tenant's CRM failed every notification for days that way after its move to
 * such a node), and on a mail node the mail server's own delivery. The probe
 * dials public mail servers from each node's own network every 15 minutes
 * (images/security-probe/outboundmail.go) and publishes the result at
 * data.outboundMail of its ConfigMap. This module reads it and judges it for
 * the two callers:
 *
 *   node health  every node; 465/587 are required everywhere (apps on the node
 *                submit mail on them), 25 only on a mail placement node.
 *   mail health  the mail placement nodes; 25 (delivery) is required.
 *
 * A port that is not required is reported, not judged — a worker that never
 * hosts the mail server runs fine with port 25 blocked, as many clouds do by
 * default. A result older than three probe intervals is stale: shown, never
 * judged, because a probe that stopped reporting says nothing about the port.
 */

import {
  OUTBOUND_MAIL_DELIVERY_PORT,
  OUTBOUND_MAIL_SUBMISSION_PORTS,
  outboundMailProbeSchema,
  type NodeOutboundMail,
  type OutboundMailPort,
  type OutboundMailProbe,
} from '@insula/api-contracts';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { PROBE_CONFIGMAP_PREFIX, PROBE_NAMESPACE } from '../security-hardening/k8s-client.js';

/** The probe labels its ConfigMap with the node it runs on (publisher.go). */
const PROBE_NODE_LABEL = 'security-probe.platform/node';

/** A result older than this many probe intervals is stale. */
export const OUTBOUND_MAIL_STALE_INTERVALS = 3;

/** Decode `data.outboundMail`; null when absent (an older probe, or no check yet) or malformed. */
export function parseOutboundMailProbe(raw: string | undefined): OutboundMailProbe | null {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = outboundMailProbeSchema.safeParse(json);
  return result.success ? result.data : null;
}

/**
 * Every node's latest outbound mail result, keyed by Node name. A listing
 * failure yields an empty map (callers then report the nodes unchecked) and
 * goes to `onError`.
 */
export async function readOutboundMailProbes(
  k8s: Pick<K8sClients, 'core'>,
  onError?: (message: string) => void,
): Promise<Map<string, OutboundMailProbe>> {
  const out = new Map<string, OutboundMailProbe>();
  let items: ReadonlyArray<{ metadata?: { name?: string; labels?: Record<string, string> }; data?: Record<string, string> }>;
  try {
    const list = await k8s.core.listNamespacedConfigMap({
      namespace: PROBE_NAMESPACE,
      labelSelector: 'app=security-probe',
    });
    items = list.items ?? [];
  } catch (err) {
    onError?.(err instanceof Error ? err.message : String(err));
    return out;
  }
  for (const cm of items) {
    const name = cm.metadata?.name ?? '';
    if (!name.startsWith(PROBE_CONFIGMAP_PREFIX)) continue;
    const node = cm.metadata?.labels?.[PROBE_NODE_LABEL] ?? name.slice(PROBE_CONFIGMAP_PREFIX.length);
    const parsed = parseOutboundMailProbe(cm.data?.outboundMail);
    if (node && parsed) out.set(node, parsed);
  }
  return out;
}

export function isOutboundMailStale(probe: OutboundMailProbe, now: Date): boolean {
  const checkedAt = new Date(probe.checkedAt).getTime();
  if (Number.isNaN(checkedAt)) return true;
  return now.getTime() - checkedAt > probe.intervalSeconds * 1000 * OUTBOUND_MAIL_STALE_INTERVALS;
}

/** The ports a node needs open: submission everywhere, delivery on a mail node. */
export function requiredOutboundPorts(mailNode: boolean): ReadonlySet<number> {
  return new Set(mailNode ? [OUTBOUND_MAIL_DELIVERY_PORT, ...OUTBOUND_MAIL_SUBMISSION_PORTS] : OUTBOUND_MAIL_SUBMISSION_PORTS);
}

/** The probe's result with each port marked required or not; null when the node has none. */
export function judgeOutboundMail(
  probe: OutboundMailProbe | null | undefined,
  opts: { readonly required: ReadonlySet<number>; readonly now: Date },
): NodeOutboundMail | null {
  if (!probe) return null;
  const ports: OutboundMailPort[] = [...probe.ports]
    .sort((a, b) => a.port - b.port)
    .map((p) => ({ ...p, required: opts.required.has(p.port) }));
  return { checkedAt: probe.checkedAt, intervalSeconds: probe.intervalSeconds, stale: isOutboundMailStale(probe, opts.now), ports };
}

/**
 * A stored (judged) result back as the probe reported it, to be judged again —
 * when the probes cannot be read this tick, the last result stands (and goes
 * stale on schedule) rather than every node reading as unchecked, which would
 * announce a warned node as recovered and then warn again on the next tick.
 */
export function probeFromStored(stored: NodeOutboundMail | null | undefined): OutboundMailProbe | null {
  if (!stored) return null;
  return {
    checkedAt: stored.checkedAt,
    intervalSeconds: stored.intervalSeconds,
    ports: stored.ports.map(({ required: _required, ...port }) => port),
  };
}

/** Whether the stored verdict required the delivery port — the node was a mail node then. */
export function storedRequiresDelivery(stored: NodeOutboundMail | null | undefined): boolean {
  return stored?.ports.some((p) => p.port === OUTBOUND_MAIL_DELIVERY_PORT && p.required) ?? false;
}

/** Required ports reported blocked by a fresh result — what makes a node `warning`. */
export function blockedRequiredPorts(mail: NodeOutboundMail | null | undefined): number[] {
  if (!mail || mail.stale) return [];
  return mail.ports.filter((p) => p.required && p.status === 'blocked').map((p) => p.port);
}

/** What a blocked port breaks, for a notification line or a panel hint. */
export function blockedPortImpact(port: number): string {
  if (port === OUTBOUND_MAIL_DELIVERY_PORT) {
    return 'the mail server cannot deliver to other mail servers from this node';
  }
  if (OUTBOUND_MAIL_SUBMISSION_PORTS.includes(port)) {
    return 'apps on this node cannot send mail through a mail server';
  }
  return 'mail on this port cannot leave the node';
}

/**
 * The nodes mail placement names: primary, secondary, tertiary. Port 25 is
 * required on each — the mail server delivers from whichever of them it runs
 * on. Not the stored active node: that column can lag the pod (placement.ts
 * self-heals it on read), and mail health judges the node the mail server
 * really runs on.
 */
export function mailNodeNames(settings: {
  readonly mailPrimaryNode?: string | null;
  readonly mailSecondaryNode?: string | null;
  readonly mailTertiaryNode?: string | null;
} | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const n of [settings?.mailPrimaryNode, settings?.mailSecondaryNode, settings?.mailTertiaryNode]) {
    if (n) out.add(n);
  }
  return out;
}
