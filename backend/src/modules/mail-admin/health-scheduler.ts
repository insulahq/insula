/**
 * Scheduled mail-server health watch.
 *
 * WHY THIS EXISTS: mail health was computed ONLY on demand, when an admin
 * opened Monitoring → Mail. The periodic `mail-health-collector` publishes two
 * Prometheus gauges (`platform_mail_server_up`, `platform_mail_outbound_queue_depth`)
 * and nothing else, and the deliverability/cert findings are not in those gauges
 * at all — so nothing periodic even evaluated them. A cluster could serve
 * Stalwart's self-signed `SAN: localhost` certificate on 465/993, or have the
 * pod down entirely, and no notification reached the admin panel or any
 * configured channel. The only mail signal that ever notified was a DNSBL
 * listing (`blocklist-scheduler`, which this mirrors deliberately).
 *
 * POLICY — deliberately narrow, because a noisy alert is an ignored alert:
 *   • Fires ONLY on components with `healthy === false`. `probeDeliverability`
 *     keeps warnings healthy by design (a missing AAAA is a reachability nicety,
 *     not an outage), so those stay in the UI and never page anyone.
 *   • `not_implemented` never fires — that is "not configured", not "broken".
 *   • One notification PER COMPONENT, deduped into a 12h bucket, so a sustained
 *     outage alerts twice a day per component instead of every pass.
 */

import { getMailHealth } from './health.js';
import { resolveMailEndpoints } from './mail-endpoints.js';
import type { MailEndpointSet } from '@insula/api-contracts';
import { notifyAdminMailHealthDegraded } from '../notifications/events.js';
import { capacityItems, mailCapacityReader } from './health-capacity.js';
import type { Database } from '../../db/index.js';

export interface MailHealthSchedulerLog {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/** Operator-facing names. The response keys ('jmap', 'rocksdb') are jargon. */
const COMPONENT_LABELS: Record<string, string> = {
  pod: 'Stalwart pod',
  jmap: 'JMAP API',
  rocksdb: 'RocksDB store',
  cert: 'TLS certificate',
  tcp: 'mail ports',
  deliverability: 'deliverability',
  exposure: 'mail port exposure',
  standby: 'standby mail copy',
  storage: 'mail disk headroom',
};

/** 12h bucket: two alerts/day per component while a failure is sustained. */
export function dedupeBucket(now: number): string {
  const d = new Date(now);
  return `${d.toISOString().slice(0, 10)}:${d.getUTCHours() < 12 ? 'am' : 'pm'}`;
}

/**
 * Pull the first actionable sentence out of a failing component. Every
 * component carries a different shape, so this is deliberately defensive
 * rather than clever — a missing detail is fine, a thrown scheduler is not.
 * Returns '' or a string with a LEADING SPACE (templates have no conditionals).
 */
export function componentDetail(key: string, component: unknown): string {
  const c = component as Record<string, unknown> | null;
  if (!c || typeof c !== 'object') return '';
  const direct = typeof c.error === 'string' ? c.error : null;
  if (direct) return ` ${direct}`;
  // The failing sub-probes are named in `items` (componentProbes), one list
  // entry each — not run into this sentence.
  if (key === 'deliverability' && componentProbes(key, component).length > 0) return ' Failing probes:';
  return '';
}

/**
 * The failing deliverability sub-probes, one list item each; that is what
 * makes this alert actionable (e.g. "certSanMatch" is the self-signed-cert
 * case). Warnings are not failures and are not named. For the standby and
 * storage components, the nodes behind the failure (health-capacity.ts). Pure.
 */
export function componentProbes(key: string, component: unknown): string[] {
  if (key === 'standby' || key === 'storage') return capacityItems(key, component);
  if (key !== 'deliverability' || !component || typeof component !== 'object') return [];
  const failing: string[] = [];
  for (const [k, v] of Object.entries(component as Record<string, unknown>)) {
    const probe = v as Record<string, unknown> | null;
    if (probe && typeof probe === 'object' && probe.severity === 'fail') failing.push(k);
  }
  return failing;
}

/**
 * The failing components, one alert each. `healthy !== false` covers both ok
 * and absent-in-this-response (the optional components, for older backends).
 * A failed capacity read fails `standby` and `storage` with the same reason;
 * that is one problem, so it alerts once, under `standby`. Pure.
 */
export function componentsToAlert(components: Record<string, unknown>): Array<[string, unknown]> {
  const failing = Object.entries(components).filter(([, component]) => {
    const c = component as { healthy?: boolean } | undefined;
    return !!c && c.healthy === false;
  });
  const standby = (components.standby as { healthy?: boolean; error?: string | null } | undefined);
  return failing.filter(([key, component]) => !(
    key === 'storage'
    && standby?.healthy === false
    && typeof standby.error === 'string'
    && (component as { error?: string | null }).error === standby.error
  ));
}

/** One mail-health pass. Never throws (fire-and-forget contract). */
export async function runMailHealthCheckOnce(
  db: Database,
  log: MailHealthSchedulerLog,
  kubeconfigPath: string | undefined,
  clock: () => number = Date.now,
): Promise<number> {
  let k8s: Awaited<ReturnType<typeof import('../k8s-provisioner/k8s-client.js')['createK8sClients']>>;
  try {
    const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
    k8s = createK8sClients(kubeconfigPath);
  } catch {
    return 0; // no kube client (local dev) — nothing to probe.
  }

  let mailHostname: string | null = null;
  try {
    const { getWebmailSettings } = await import('../webmail-settings/service.js');
    mailHostname = (await getWebmailSettings(db)).mailServerHostname ?? null;
  } catch (err) {
    // "Could not read the setting" is NOT "mail is not set up".
    //
    // This catch used to set `mailHostname = null` and fall into the skip
    // below, so a database blip disabled every mail-health alert on the
    // cluster and said nothing — the check simply reported 0 and returned.
    // The settings read failing is itself worth an operator's attention, and
    // it must not be laundered into a confident claim about configuration.
    log.warn(
      '[mail-health] could not read mail settings; skipping this pass '
      + '(this is NOT a statement that mail is unconfigured): '
      + (err instanceof Error ? err.message : String(err)),
    );
    return 0;
  }
  // A genuinely absent hostname → mail is not set up on this cluster. Alerting
  // would be pure noise on every dev/staging install that never enabled mail.
  if (!mailHostname) return 0;

  let jmapBaseUrl = process.env.STALWART_MGMT_URL
    ?? 'http://stalwart-mgmt.mail.svc.cluster.local:8080';
  let creds: { user: string; password: string } | null = null;
  try {
    const { readStalwartCredentials } = await import('./credentials.js');
    const c = readStalwartCredentials(process.env);
    creds = { user: c.username, password: c.password };
  } catch {
    creds = null;
  }
  try {
    // Same in-cluster/loopback/RFC-1918 constraint the route enforces before
    // sending admin credentials anywhere. Fail closed to the in-cluster default.
    const host = new URL(jmapBaseUrl).hostname.toLowerCase();
    const safe = host.endsWith('.svc.cluster.local') || host === 'localhost' || host === '127.0.0.1'
      || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
      || host.startsWith('fc') || host.startsWith('fd');
    if (!safe) jmapBaseUrl = 'http://stalwart-mgmt.mail.svc.cluster.local:8080';
  } catch {
    jmapBaseUrl = 'http://stalwart-mgmt.mail.svc.cluster.local:8080';
  }

  // Same endpoint set the route uses: only nodes that publish the mail ports
  // under the current placement + port-exposure mode are probed. A lookup
  // failure is handed on (the exposure component reports it) rather than
  // becoming an empty set that silently skips every per-node check.
  let endpoints: MailEndpointSet | undefined;
  let endpointsError: string | undefined;
  try {
    endpoints = await resolveMailEndpoints(k8s, db, log);
  } catch (err) {
    endpointsError = err instanceof Error ? err.message : String(err);
  }

  // refresh:true — the on-demand cache would otherwise let this scheduler
  // re-read a stale response and alert (or stay silent) on old data.
  const capacity = mailCapacityReader({ k8s, db, kubeconfigPath, log });
  const health = await getMailHealth(
    { k8s, jmapBaseUrl, jmapAdminCredentials: creds, mailHostname, kubeconfigPath, endpoints, endpointsError, capacity },
    { refresh: true },
  );
  if (health.healthy) return 0;

  const bucket = dedupeBucket(clock());
  let fired = 0;
  for (const [key, component] of componentsToAlert(health.components)) {
    const label = COMPONENT_LABELS[key] ?? key;
    try {
      await notifyAdminMailHealthDegraded(
        db,
        {
          component: label,
          mailHostname,
          detail: componentDetail(key, component),
          items: componentProbes(key, component),
          panelUrl: '/monitoring/mail',
        },
        `mail-health:${key}:${bucket}`,
      );
      fired += 1;
    } catch (err) {
      log.warn({ err, component: key }, 'mail-health-scheduler: notification failed');
    }
  }
  if (fired > 0) {
    log.info({ fired, hostname: mailHostname }, 'mail-health-scheduler: mail health failures alerted');
  }
  return fired;
}

/**
 * Start the mail-health watch. Returns a stop function for onClose.
 * Kicks ~3min after boot — later than the blocklist watch, because a cluster
 * that is still finishing its first reconcile would otherwise alert on
 * components that are merely not up YET.
 */
export function startMailHealthScheduler(
  db: Database,
  log: MailHealthSchedulerLog,
  opts: { kubeconfigPath?: string; intervalMs?: number } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? 900_000; // 15min: an outage signal, unlike the hourly DNSBL watch
  const runOnce = (): void => {
    runMailHealthCheckOnce(db, log, opts.kubeconfigPath).catch((err: unknown) => {
      log.warn({ err }, 'mail-health-scheduler: pass failed');
    });
  };
  const bootKick = setTimeout(runOnce, 180_000);
  bootKick.unref?.();
  const timer = setInterval(runOnce, intervalMs);
  timer.unref?.();
  return () => {
    clearTimeout(bootKick);
    clearInterval(timer);
  };
}
