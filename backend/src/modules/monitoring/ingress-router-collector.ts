/**
 * Ingress-router health collector.
 *
 * WHY: on 2026-08-20 both panels served a bare `404 page not found` for hours
 * while every conventional signal was green — pods Running and Ready, certs
 * valid, Flux READY=True, the API healthy. Traefik had failed to download its
 * plugins at startup, disabled the whole plugin subsystem, and dropped every
 * router whose middleware came from a plugin. Nothing alerted, because nothing
 * was measuring the thing that actually broke: whether a request for the panel
 * hostname still matches a router.
 *
 * So this probes the USER-VISIBLE outcome rather than a proxy for it. It sends
 * a request to the in-cluster Traefik Service with the panel's Host header and
 * asks one question: did a router match?
 *
 *   1  — a router matched (any status that is not Traefik's unrouted 404)
 *   0  — no router matched: the panel is down for real users
 *  -1  — the probe itself could not run (no Service, DNS failure, timeout)
 *
 * The -1 convention is deliberate and matches flux-status-collector: a probe
 * outage must never look like a healthy panel, and must never fire the alert
 * either. The alert rule keys on `== 0`.
 */

import { ingressRouterUp } from '../../shared/metrics.js';

export interface CollectorLog {
  warn: (...args: unknown[]) => void;
}

/** In-cluster address of the Traefik Service (namespace `traefik`, port 80). */
const TRAEFIK_SERVICE_URL = process.env.TRAEFIK_SERVICE_URL
  ?? 'http://traefik.traefik.svc.cluster.local:80/';

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Traefik's unrouted response. It is Go's `http.NotFound`, so it is exactly
 * this string with a text/plain content type — distinct from an application
 * 404, which the panels serve as HTML or the API as a JSON envelope.
 *
 * Matching on the BODY rather than the status code matters: a legitimately
 * routed request can 404 (unknown path) and that is NOT an ingress failure.
 */
const TRAEFIK_UNROUTED_BODY = '404 page not found';

export interface ProbeResult {
  readonly host: string;
  /** 1 routed · 0 unrouted · -1 probe failed */
  readonly value: number;
  readonly detail: string;
}

export async function probeHostRouted(
  host: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(TRAEFIK_SERVICE_URL, {
      method: 'GET',
      headers: { Host: host },
      redirect: 'manual',
      signal: controller.signal,
    });

    // Only a 404 can be the unrouted case; anything else means a router
    // matched and the backend answered (including 401/403/5xx, which are
    // application problems with their own alerts, not ingress problems).
    if (res.status !== 404) {
      return { host, value: 1, detail: `routed (HTTP ${res.status})` };
    }

    const body = (await res.text()).trim();
    if (body === TRAEFIK_UNROUTED_BODY) {
      return { host, value: 0, detail: 'NO ROUTER matched — Traefik served its unrouted 404' };
    }
    return { host, value: 1, detail: 'routed (application 404)' };
  } catch (err: unknown) {
    return {
      host,
      value: -1,
      detail: `probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** One collection pass. Never throws — by contract, like the Flux collector. */
export async function collectIngressRoutersOnce(
  hosts: readonly string[],
  log: CollectorLog,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const host of hosts) {
    let r: ProbeResult;
    try {
      r = await probeHostRouted(host, fetchImpl);
    } catch (err: unknown) {
      r = { host, value: -1, detail: `probe threw: ${err instanceof Error ? err.message : String(err)}` };
    }
    ingressRouterUp.set({ host }, r.value);
    if (r.value === 0) {
      log.warn(`ingress-router-collector: ${host} — ${r.detail}`);
    }
    results.push(r);
  }
  return results;
}

/**
 * Start the periodic collector. Returns a stop function for onClose.
 * An empty host list disables it — a cluster with no configured apex has
 * nothing meaningful to probe and should not emit a permanent -1.
 */
export function startIngressRouterCollector(
  resolveHosts: () => Promise<readonly string[]>,
  log: CollectorLog,
  intervalMs = 60_000,
  fetchImpl: typeof fetch = fetch,
): () => void {
  const runOnce = (): void => {
    void (async () => {
      try {
        const hosts = await resolveHosts();
        if (hosts.length === 0) return;
        await collectIngressRoutersOnce(hosts, log, fetchImpl);
      } catch (err: unknown) {
        log.warn(
          'ingress-router-collector: pass failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
  };
  runOnce();
  const timer = setInterval(runOnce, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
