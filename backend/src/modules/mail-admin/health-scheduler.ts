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
 *   • A failure must be seen TWICE, a minute apart, before anyone is told. One
 *     failing pass is not an outage: a probe that execs into the pod or asks a
 *     resolver on the internet fails now and then for reasons that are gone a
 *     second later, and this alert says mail delivery is likely affected.
 *     The second look comes after a minute, not at the next 15-minute pass, so
 *     a real outage is announced as fast as before.
 *   • One notification PER COMPONENT, deduped into a 12h bucket, so a sustained
 *     outage alerts twice a day per component instead of every pass.
 *   • It names what failed. "1 deliverability failure — open Details" for a
 *     failure that had cleared by the time anyone opened Details told the
 *     operator nothing, and nothing else recorded which check it had been.
 */

import { getMailHealth } from './health.js';
import { resolveMailEndpoints } from './mail-endpoints.js';
import type { MailEndpointSet } from '@insula/api-contracts';
import { notifyAdminMailHealthDegraded, notifyAdminOperationalEvent } from '../notifications/events.js';
import { capacityItems, mailCapacityReader } from './health-capacity.js';
import { cappedList } from '../notifications/list-items.js';
import { MAIL_MONITORING_RESOURCE } from '../notifications/action-path.js';
import type { Database } from '../../db/index.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import { lazyNodeAlertHolds } from '../node-health/outage-hold.js';
import { describeSuppression, type JoinGraceVerdict } from '../node-health/join-grace.js';
import { withoutHeldEndpoints } from './exposure-hold.js';

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

/**
 * What the failure means for mail, as the alert's closing sentence. Most
 * components carry mail itself, so a failure likely affects delivery. The
 * standby copy and the disk headroom do not: every alert used to say "Mail
 * delivery is likely affected", which read as an outage for a standby that was
 * merely behind.
 */
export function componentImpact(key: string): string {
  switch (key) {
    case 'standby':
      return 'Mail delivery is not affected, but a failover now would lose the mail received since the newest copy.';
    case 'storage':
      return 'Mail delivery is not affected yet; a full disk would stop the mail server.';
    default:
      return 'Mail delivery is likely affected.';
  }
}

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
 *
 * `items` are the failing checks listed under it (componentProbes, or the ones
 * a second pass confirmed). Deliverability is many independent checks under one
 * name, so when they are listed the sentence only counts them; its own error
 * line ("N failures — open Details to inspect") is for the panel.
 */
export function componentDetail(key: string, component: unknown, items: readonly string[] = componentProbes(key, component)): string {
  const c = component as Record<string, unknown> | null;
  if (!c || typeof c !== 'object') return '';
  if (key === 'deliverability' && items.length > 0) {
    return ` ${items.length} failing check${items.length === 1 ? '' : 's'}:`;
  }
  const direct = typeof c.error === 'string' ? c.error : null;
  return direct ? ` ${direct}` : '';
}

/** Operator-facing names of the deliverability sub-checks. An unknown key is shown as it is. */
const DELIVERABILITY_LABELS: Record<string, string> = {
  forwardDns: 'forward DNS',
  ipv6Dns: 'IPv6 DNS',
  reverseDns: 'reverse DNS',
  blocklists: 'blocklist',
  certSanMatch: 'TLS certificate name',
  smtpBanner: 'SMTP banner',
};

const oneLine = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/** One deliverability sub-check, for the operator to read and for two passes to be compared by. */
export interface DeliverabilityCheck {
  /**
   * Which check this is — the sub-check, its address, its blocklist — and
   * nothing that can differ between two looks at the same fault. The line below
   * quotes what DNS returned, and a resolver may hand the same records back in
   * another order.
   */
  readonly id: string;
  /** A line an operator can act on. */
  readonly line: string;
}

/** The sub-checks of the deliverability component with the given severity test. */
function deliverabilityChecks(component: unknown, wanted: (probe: Record<string, unknown>) => boolean): DeliverabilityCheck[] {
  if (!component || typeof component !== 'object') return [];
  const out: DeliverabilityCheck[] = [];
  for (const [key, v] of Object.entries(component as Record<string, unknown>)) {
    for (const probe of Array.isArray(v) ? v : [v]) {
      const p = probe as Record<string, unknown> | null;
      if (!p || typeof p !== 'object' || typeof p.severity !== 'string' || !wanted(p)) continue;
      const ip = oneLine(p.ip);
      const where = ip ? `${ip}${oneLine(p.node) ? ` (${oneLine(p.node)})` : ''}` : '';
      const list = key === 'blocklists' ? oneLine(p.list) || oneLine(p.zone) || 'a blocklist' : '';
      const reason = oneLine(p.reasonTxt);
      const found = oneLine(p.actual) || oneLine(p.assertion);
      const label = DELIVERABILITY_LABELS[key] ?? key;
      const line = list && where
        ? `${where} is listed on ${list}${reason ? `: ${reason}` : ''}`
        : `${label}${where ? ` for ${where}` : ''}${found ? `: ${found}` : ''}`;
      out.push({ id: `${key}|${ip}|${list}`, line: line.slice(0, 240) });
    }
  }
  return out;
}

/** The failing deliverability sub-checks. Pure. */
export function failingChecks(component: unknown): DeliverabilityCheck[] {
  return deliverabilityChecks(component, (p) => p.severity === 'fail');
}

/**
 * What exactly is failing, one list item each; that is what makes the alert
 * actionable. For deliverability: every sub-check with severity `fail`, WITH
 * the address it is about — reverse DNS and the blocklists are checked per
 * address and come as lists, which the first version of this function did not
 * look inside, so the most common failures were the ones it could not name.
 * Warnings are not failures and are not named. For the standby and storage
 * components, the nodes behind the failure (health-capacity.ts). Pure, uncapped.
 */
export function componentProbes(key: string, component: unknown): string[] {
  if (key === 'standby' || key === 'storage') return capacityItems(key, component);
  if (key !== 'deliverability') return [];
  return failingChecks(component).map((c) => c.line);
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

/** How long after a failing pass the probes are run again before anyone is told. */
export const CONFIRM_AFTER_MS = 60_000;

/** At most this many failing checks are spelled out in one alert. */
const MAX_LISTED_CHECKS = 12;

export interface ConfirmedFailure {
  readonly key: string;
  readonly component: unknown;
  /** The failing checks to list — for deliverability, only those failing in BOTH passes. */
  readonly items: string[];
}

/**
 * The failures a second pass still shows. Pure.
 *
 * A component has to fail in both. Deliverability is a dozen independent checks
 * under one name, so there the SAME check has to fail twice: a lookup that
 * failed for one address in the first pass and a different one in the second is
 * two blips, not one fault. "The same" is the check and its address, never its
 * wording — the wording quotes DNS answers, whose order a resolver may rotate,
 * and comparing it would drop a real, persistent fault every other time. The
 * second pass's wording is what is reported.
 */
export function confirmedFailures(
  first: Record<string, unknown>,
  second: Record<string, unknown>,
): ConfirmedFailure[] {
  const before = new Map(componentsToAlert(first));
  const confirmed: ConfirmedFailure[] = [];
  for (const [key, component] of componentsToAlert(second)) {
    if (!before.has(key)) continue;
    const now = key === 'deliverability' ? failingChecks(component) : [];
    if (now.length === 0) {
      confirmed.push({ key, component, items: componentProbes(key, component) });
      continue;
    }
    const earlier = new Set(failingChecks(before.get(key)).map((c) => c.id));
    const both = now.filter((c) => earlier.has(c.id));
    if (both.length > 0) confirmed.push({ key, component, items: both.map((c) => c.line) });
  }
  return confirmed;
}

/**
 * The deliverability lookups that got no answer this pass — the checks that
 * were therefore not made, by name. Reported as skipped, never as failing.
 */
export function unansweredLookups(components: Record<string, unknown>): string[] {
  return deliverabilityChecks(components.deliverability, (p) => p.severity === 'skipped'
    && typeof p.actual === 'string' && p.actual.startsWith('lookup got no answer'))
    // What the lookup was FOR; the quoted resolver error adds nothing to a list.
    .map((c) => c.line.replace(/: lookup got no answer.*$/, ''));
}

/**
 * After this many passes in a row with unanswered lookups — an hour — the
 * operator is told that the checks are not being made. One unanswered lookup is
 * packet loss; an hour of them is a resolver this cluster cannot reach, and
 * "skipped" must not become a way for half the deliverability checks to switch
 * themselves off in silence.
 */
export const UNANSWERED_NOTICE_AFTER_PASSES = 4;

/** Passes in a row, in this process, that had unanswered lookups. The lease holder is sticky, so it is the one counting. */
let unansweredStreak = 0;

/** Test seam. */
export function resetUnansweredStreak(): void {
  unansweredStreak = 0;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/** One mail-health pass. Never throws (fire-and-forget contract). */
export async function runMailHealthCheckOnce(
  db: Database,
  log: MailHealthSchedulerLog,
  kubeconfigPath: string | undefined,
  clock: () => number = Date.now,
  wait: (ms: number) => Promise<void> = sleep,
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
  const probe = () => getMailHealth(
    { k8s, jmapBaseUrl, jmapAdminCredentials: creds, mailHostname, kubeconfigPath, endpoints, endpointsError, capacity },
    { refresh: true },
  );
  const first = await probe();
  // A check that could not be made is not a failure — and not nothing either.
  const unanswered = unansweredLookups(first.components);
  unansweredStreak = unanswered.length > 0 ? unansweredStreak + 1 : 0;
  if (unanswered.length > 0) {
    log.warn(`[mail-health] ${unanswered.length} DNS lookup(s) got no answer; those deliverability checks were not made on this pass `
      + `(${unansweredStreak} pass(es) in a row): ${unanswered.join('; ')}`);
  }
  if (unansweredStreak >= UNANSWERED_NOTICE_AFTER_PASSES) {
    await notifyAdminOperationalEvent(db, 'mail', {
      subsystem: 'Mail deliverability checks',
      objectLabel: mailHostname,
      detail: `${unanswered.length} DNS lookup${unanswered.length === 1 ? '' : 's'} of the deliverability check `
        + `${unanswered.length === 1 ? 'has' : 'have'} had no answer on ${unansweredStreak} passes in a row, so `
        + `${unanswered.length === 1 ? 'this check is' : 'these checks are'} not being made. This says nothing about the records themselves.`,
      severityLabel: 'not checked',
      recommendedAction: 'Check that platform-api can reach its DNS resolvers (Platform → DNS, or MAIL_HEALTH_EXTERNAL_DNS).',
      items: cappedList(unanswered, MAX_LISTED_CHECKS),
    }, `mail-health:unanswered:${dedupeBucket(clock())}`, MAIL_MONITORING_RESOURCE).catch((err: unknown) => {
      log.warn({ err }, 'mail-health-scheduler: unanswered-lookups notice failed');
    });
  }
  if (first.healthy) return 0;

  // Look again before telling anyone (see POLICY above).
  const firstFailing = componentsToAlert(first.components).map(([key]) => key);
  await wait(CONFIRM_AFTER_MS);
  let second: Awaited<ReturnType<typeof probe>>;
  try {
    second = await probe();
  } catch (err) {
    // Not confirmed, and not disproved either: say so and leave it to the next
    // pass, which probes afresh. Alerting on one look is what this is here to stop.
    log.warn({ err, components: firstFailing }, 'mail-health-scheduler: the second look failed to run — failure not confirmed, not alerted');
    return 0;
  }
  const confirmed = second.healthy ? [] : confirmedFailures(first.components, second.components);
  if (confirmed.length === 0) {
    log.info({ components: firstFailing }, 'mail-health-scheduler: failure gone on the second look — not alerted');
    return 0;
  }

  // An endpoint on a node that is down or still settling is that node's
  // outage, already announced (exposure-hold.ts). Nodes are only listed when
  // an exposure failure could be held.
  const holds: ReadonlyMap<string, JoinGraceVerdict> = confirmed.some((f) => f.key === 'exposure')
    ? await lazyNodeAlertHolds(k8s, new Date(clock()))()
    : new Map();
  const { alert, held } = withoutHeldEndpoints(confirmed, holds);
  for (const [node, verdict] of held) {
    log.info(`[mail-health] ${describeSuppression(node, verdict, 'mail port exposure alert')}`);
  }

  const bucket = dedupeBucket(clock());
  let fired = 0;
  for (const { key, component, items, endpoints } of alert) {
    const label = COMPONENT_LABELS[key] ?? key;
    try {
      await notifyAdminMailHealthDegraded(
        db,
        {
          component: label,
          mailHostname,
          detail: componentDetail(key, component, items),
          items: cappedList(items, MAX_LISTED_CHECKS),
          impact: componentImpact(key),
          panelUrl: '/monitoring/mail',
        },
        // Per endpoint set as well: one endpoint's alert must not swallow
        // another's that outlived its node's hold in the same bucket.
        `mail-health:${key}:${bucket}${endpoints?.length ? `:${endpoints.join(',')}` : ''}`,
      );
      fired += 1;
    } catch (err) {
      log.warn({ err, component: key }, 'mail-health-scheduler: notification failed');
    }
  }
  if (fired > 0) {
    log.info(
      { fired, hostname: mailHostname, failing: alert.map((f) => ({ component: f.key, checks: f.items })) },
      'mail-health-scheduler: mail health failures alerted',
    );
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
  // One replica checks: every pass execs into the mail server, runs the
  // deliverability probes, and alerts behind a lookup-only dedupe.
  const runOnce = (): void => {
    withSchedulerLease(db, 'mail-health-watch', intervalMs * 1.5,
      () => runMailHealthCheckOnce(db, log, opts.kubeconfigPath), { log }).catch((err: unknown) => {
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
