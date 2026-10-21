/**
 * The mail port exposure alert for an endpoint on a node that is down.
 *
 * Production, a server shut down on purpose: "[MAIL] mail port exposure check
 * failing … <node>: no stalwart-haproxy pod runs here — the node lacks the
 * label … re-apply the port-exposure mode", minutes after that server was
 * announced as down. Nothing publishes the mail ports on a server that is off;
 * the advice was wrong, and the alert was the node's outage told again.
 *
 * An endpoint on a node held by node-health/outage-hold.ts — down, back and
 * still settling, or joining — is left out of the alert, on the terms the
 * node's own alerts are held on: still shown in Monitoring → Mail, and
 * announced by a later pass if it outlives the hold. Only the exposure rows
 * are held. The mail server itself failing with that node (the Stalwart pod,
 * JMAP, the mail ports) is mail being down, and is alerted as before.
 */
import type { MailHealthExposureNode } from '@insula/api-contracts';
import type { JoinGraceVerdict } from '../node-health/join-grace.js';
import { describeExposureFailure } from './exposure-probe.js';
import type { ConfirmedFailure } from './health-scheduler.js';

/** A failure still alerted. `endpoints`: for exposure, the endpoints it names. */
export type AlertedFailure = ConfirmedFailure & { readonly endpoints?: readonly string[] };

export interface ExposureHoldResult {
  /** What is still alerted — the exposure component without its held endpoints. */
  readonly alert: AlertedFailure[];
  /** The held endpoints' nodes, with why, for the log. */
  readonly held: ReadonlyArray<readonly [string, JoinGraceVerdict]>;
}

/** Pure. */
export function withoutHeldEndpoints(
  confirmed: readonly ConfirmedFailure[],
  holds: ReadonlyMap<string, JoinGraceVerdict>,
): ExposureHoldResult {
  const alert: AlertedFailure[] = [];
  const held: Array<readonly [string, JoinGraceVerdict]> = [];
  for (const failure of confirmed) {
    const component = failure.component as { nodes?: readonly MailHealthExposureNode[]; error?: string | null } | null;
    const nodes = failure.key === 'exposure' ? component?.nodes ?? [] : [];
    const bad = nodes.filter((n) => n.error !== null);
    const heldBad = bad.filter((n) => holds.has(n.node));
    const rest = bad.filter((n) => !holds.has(n.node));
    const endpoints = rest.map((n) => n.node).sort();
    if (heldBad.length === 0) {
      alert.push(endpoints.length > 0 ? { ...failure, endpoints } : failure);
      continue;
    }
    for (const n of heldBad) held.push([n.node, holds.get(n.node)!]);
    if (rest.length > 0) {
      alert.push({ ...failure, component: { ...component, error: describeExposureFailure(rest, nodes.length) }, endpoints });
    }
  }
  return { alert, held };
}

