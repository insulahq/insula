/**
 * Scheduled mail-server health watch (2026-08).
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
import { resolveServerNodeIps, resolveServerNodeIpv6s } from './server-node-ips.js';
import { notifyAdminMailHealthDegraded } from '../notifications/events.js';
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
  if (key === 'deliverability') {
    // Name the failing sub-probes; that is what makes this one actionable
    // (e.g. "certSanMatch" is the self-signed-cert case).
    const failing: string[] = [];
    for (const [k, v] of Object.entries(c)) {
      const probe = v as Record<string, unknown> | null;
      if (probe && typeof probe === 'object' && probe.severity === 'fail') failing.push(k);
    }
    if (failing.length > 0) return ` Failing probes: ${failing.join(', ')}.`;
  }
  return '';
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
  } catch {
    mailHostname = null;
  }
  // No mail hostname configured → mail is not set up on this cluster. Alerting
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

  const [serverNodeIps, serverNodeIpv6s] = await Promise.all([
    resolveServerNodeIps(k8s, db).catch(() => [] as string[]),
    resolveServerNodeIpv6s(k8s, db).catch(() => [] as string[]),
  ]);

  // refresh:true — the on-demand cache would otherwise let this scheduler
  // re-read a stale response and alert (or stay silent) on old data.
  const health = await getMailHealth(
    { k8s, jmapBaseUrl, jmapAdminCredentials: creds, mailHostname, kubeconfigPath, serverNodeIps, serverNodeIpv6s },
    { refresh: true },
  );
  if (health.healthy) return 0;

  const bucket = dedupeBucket(clock());
  let fired = 0;
  for (const [key, component] of Object.entries(health.components)) {
    const c = component as { healthy?: boolean } | undefined;
    // `healthy !== false` covers both ok and absent-in-this-response
    // (deliverability is optional in the contract for older backends).
    if (!c || c.healthy !== false) continue;
    const label = COMPONENT_LABELS[key] ?? key;
    try {
      await notifyAdminMailHealthDegraded(
        db,
        {
          component: label,
          mailHostname,
          detail: componentDetail(key, component),
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
