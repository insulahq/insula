/**
 * Scheduled DNSBL / blocklist watch (mail monitoring, 2026-07).
 *
 * The deliverability probe (probeDeliverability) already checks each
 * server-role sending IP against 8 DNSBLs, but only ON DEMAND when an
 * admin opens Monitoring → Mail → Deliverability. Getting the sending IP
 * blocklisted is a serious, silent deliverability event — this scheduler
 * runs the same probe hourly and fires an admin notification per listing.
 *
 * Only `fail`/`warning`-severity listings alert (Spamhaus/Barracuda/
 * SpamCop/SORBS/PSBL/Mailspike); `advisory` lists (UCEPROTECT L1,
 * Backscatterer — noisy / paid-delist) stay visible in the UI but don't
 * page the operator. Dedupe is the dispatcher's (admin, dedupeKey); the
 * day-bucket key re-fires at most once per (ip,list) per day while listed.
 */

import { probeDeliverability } from './deliverability.js';
import { resolveServerNodeIps } from './server-node-ips.js';
import { resolveDefaultMailHost } from './mail-acme-override-route.js';
import { notifyAdminMailBlocklisted } from '../notifications/events.js';
import type { Database } from '../../db/index.js';

export interface BlocklistSchedulerLog {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/** One blocklist check pass. Never throws (fire-and-forget contract). */
export async function runBlocklistCheckOnce(
  db: Database,
  log: BlocklistSchedulerLog,
  kubeconfigPath: string | undefined,
): Promise<number> {
  // Resolve the sending IPs (via the shared resolver the deliverability
  // route uses) + the mail hostname. Any missing precondition → skip.
  let k8s: { core: { listNode: (q?: object) => Promise<unknown> } };
  try {
    const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
    k8s = createK8sClients(kubeconfigPath);
  } catch {
    return 0; // no kube client (local dev) — nothing to probe.
  }

  const [hostname, serverNodeIps] = await Promise.all([
    resolveDefaultMailHost(db),
    resolveServerNodeIps(k8s, db).catch(() => [] as string[]),
  ]);
  if (!hostname || serverNodeIps.length === 0) return 0;

  const component = await probeDeliverability({ hostname, serverNodeIps });
  const listed = component.blocklists.filter(
    (b) => b.listed && (b.severity === 'fail' || b.severity === 'warning'),
  );
  if (listed.length === 0) return 0;

  const dayBucket = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let fired = 0;
  for (const b of listed) {
    try {
      await notifyAdminMailBlocklisted(
        db,
        {
          ip: b.ip,
          list: b.list,
          severity: b.severity,
          lookupUrl: b.lookupUrl ?? undefined,
        },
        `blocklist:${b.ip}:${b.zone}:${dayBucket}`,
      );
      fired += 1;
    } catch (err) {
      log.warn({ err, ip: b.ip, list: b.list }, 'blocklist-scheduler: notification failed');
    }
  }
  if (fired > 0) {
    log.info({ fired, ips: [...new Set(listed.map((b) => b.ip))] }, 'blocklist-scheduler: DNSBL listings alerted');
  }
  return fired;
}

/**
 * Start the hourly blocklist watch. Returns a stop function for onClose.
 * Kicks ~2min after boot (let the cluster settle) then hourly.
 */
export function startMailBlocklistScheduler(
  db: Database,
  log: BlocklistSchedulerLog,
  opts: { kubeconfigPath?: string; intervalMs?: number } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? 3_600_000;
  const runOnce = (): void => {
    runBlocklistCheckOnce(db, log, opts.kubeconfigPath).catch((err: unknown) => {
      log.warn({ err }, 'blocklist-scheduler: pass failed');
    });
  };
  const bootKick = setTimeout(runOnce, 120_000);
  bootKick.unref?.();
  const timer = setInterval(runOnce, intervalMs);
  timer.unref?.();
  return () => {
    clearTimeout(bootKick);
    clearInterval(timer);
  };
}
