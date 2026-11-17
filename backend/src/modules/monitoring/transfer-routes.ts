/**
 * The routes the platform-surface latency SLO leaves out: those whose request
 * lasts as long as a transfer or a stream, not as long as the platform takes
 * to answer it.
 *
 *  - JMAP's blob upload, blob download and event stream — one carve-out route
 *    on the Stalwart host (shared/traefik-mail-waf.ts). The event stream is
 *    webmail's push channel: each connection stays open for minutes by design
 *    and is recorded as ONE request of that duration.
 *  - The panels' streaming-upload and large-download carve-outs
 *    (system-settings/ingress-reconciler.ts): a file takes as long as the
 *    client's link does.
 *  - Private workers' tunnel routes (private-workers/reconciler.ts), in the
 *    `platform-system` namespace and so inside the rule's `platform-.*`: the
 *    agent's WebSocket is one request lasting as long as the connection.
 *
 * Production fired `platform-latency-slow-share` six times in a month; each
 * time nearly every slow request was on one of these routes (five times the
 * JMAP carve-out, once file-manager uploads), while the platform answered
 * everything else quickly.
 *
 * Traefik names a route's series `<ns>-<IngressRoute>-<hash of its rule>`
 * (traffic/traefik-routes.ts). The rule holds the host, so the label differs
 * per install and can only be computed from the live objects — which is what
 * this does, once per evaluator tick (the list is cached for its TTL).
 *
 * Only the CURRENT rules are hashed. When a carve-out's rule changes (an apex
 * rename, a path added to it), the old label's series stay inside the rule's
 * 30-minute window unexcluded until they age out.
 */

import type * as k8s from '@kubernetes/client-node';
import { isJmapStreamMatch } from '../../shared/traefik-mail-waf.js';
import { isPanelTransferMatch } from '../system-settings/ingress-reconciler.js';
import { isTunnelRouteMatch } from '../private-workers/reconciler.js';
import { INGRESSROUTE_PLURAL, TRAEFIK_GROUP, TRAEFIK_VERSION } from '../ingress-routes/traefik-types.js';
import { createLiveRouteSource, type LiveRouteIndex } from '../traffic/live-ingress-routes.js';

/**
 * The only shape traefikServiceLabel produces (Traefik's Normalize leaves
 * letters, digits and `-`). The labels go into a PromQL regex verbatim, so
 * anything else is dropped rather than escaped: it cannot be one of ours.
 */
const SERVICE_LABEL = /^[\p{L}\p{N}-]+@[a-z]+$/u;

/** Pure: the transfer routes' service labels, sorted. */
export function transferServiceLabels(index: LiveRouteIndex): string[] {
  return [...index]
    .filter(([label, route]) => SERVICE_LABEL.test(label)
      && (isJmapStreamMatch(route.match) || isPanelTransferMatch(route.match) || isTunnelRouteMatch(route.match)))
    .map(([label]) => label)
    .sort();
}

/** The transfer routes' labels, read from the cluster's live IngressRoutes. */
export function transferServiceSource(
  custom: Pick<k8s.CustomObjectsApi, 'listClusterCustomObject'>,
): () => Promise<readonly string[]> {
  const live = createLiveRouteSource(() => custom.listClusterCustomObject({
    group: TRAEFIK_GROUP,
    version: TRAEFIK_VERSION,
    plural: INGRESSROUTE_PLURAL,
  }));
  return async () => transferServiceLabels(await live());
}
