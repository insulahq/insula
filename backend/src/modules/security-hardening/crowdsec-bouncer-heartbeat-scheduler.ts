/**
 * platform-api bouncer heartbeat.
 *
 * Background: the `crowdsec-bouncer-prune-scheduler` deletes any
 * bouncer whose `last_pull` is older than 24h. CrowdSec only updates
 * `last_pull` when a bouncer actually calls the LAPI — for the
 * Traefik DaemonSet bouncers this is automatic (they poll every 60s)
 * but the platform-api "bouncer" only calls LAPI when an operator
 * opens the Banned IPs / WAF Settings tab in the admin panel.
 * Quiet clusters where no operator visits those tabs for 24h+ get
 * the platform-api bouncer silently pruned, and every subsequent
 * LAPI call from platform-api fails with 403 until someone notices
 * and re-registers (or until the self-heal in lapiGet kicks in).
 *
 * This scheduler runs every 12h and calls `/v1/decisions` from
 * inside platform-api. The call is identical to what the route
 * handler does on operator click — same headers, same key — so
 * CrowdSec bumps last_pull naturally. We deliberately don't use a
 * different endpoint (e.g. `/health`) because only the bouncer-
 * authenticated endpoints update `last_pull`.
 *
 * Endpoint choice (`/v1/decisions` vs `/v1/decisions/stream`):
 * verified on staging 2026-05-28 against CrowdSec v1.7.x that the
 * non-stream endpoint bumps `last_pull`. Real bouncers (Traefik
 * plugin) use the stream form because it's long-poll-friendly; for
 * heartbeat-only we don't need the streaming semantics. Keep the
 * non-stream form because it matches what listDecisions already
 * runs — one less LAPI surface to track upstream.
 *
 * Cold-start behaviour: on a brand-new install where bootstrap.sh
 * registered the bouncer at install time, the first heartbeat tick
 * at t+2min is a cheap no-op success. On an install where the
 * bouncer wasn't registered (or was lost), the first tick triggers
 * lapiGet's 403 self-heal which re-registers from the Secret's key
 * and retries — operator sees `crowdsec-bouncer-heartbeat: tick OK`
 * in logs without ever having to touch cscli.
 *
 * Failure is non-fatal: if the heartbeat itself returns 403 (bouncer
 * already pruned), lapiGet's self-heal will re-register on the way
 * out. If the cluster has no CrowdSec at all (single-node dev), the
 * tick just logs warn and moves on.
 */

import type { Logger } from 'pino';
import { fetchDecisionsHeartbeat } from './crowdsec.js';

// 12h interval — comfortably under the 24h prune threshold (with
// headroom for the warm-up delay + retries).
const HEARTBEAT_INTERVAL_MS = 12 * 60 * 60 * 1000;
// 2-minute warm-up so a cold start doesn't fire a heartbeat before
// the platform-api Pod's networking is fully ready. Long enough to
// be well past the readinessProbe period (5s) and any sidecar
// dependency settling.
const HEARTBEAT_INITIAL_DELAY_MS = 2 * 60 * 1000;

export interface BouncerHeartbeatSchedulerHandle {
  readonly stop: () => void;
}

export function startCrowdsecBouncerHeartbeatScheduler(
  kubeconfigPath: string | undefined,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): BouncerHeartbeatSchedulerHandle {
  let cancelled = false;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    try {
      const n = await fetchDecisionsHeartbeat(kubeconfigPath);
      log.info(
        { decisionsSeen: n },
        'crowdsec-bouncer-heartbeat: tick OK (last_pull refreshed)',
      );
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'crowdsec-bouncer-heartbeat: tick failed (will retry next interval)',
      );
    }
  };

  const initial = setTimeout(tick, HEARTBEAT_INITIAL_DELAY_MS);
  initial.unref();

  const timer = setInterval(tick, intervalMs);
  timer.unref();

  log.info(
    { intervalMs, initialDelayMs: HEARTBEAT_INITIAL_DELAY_MS },
    'crowdsec-bouncer-heartbeat-scheduler: started',
  );

  return {
    stop: () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(timer);
    },
  };
}
