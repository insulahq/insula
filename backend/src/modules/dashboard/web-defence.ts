import { sql } from 'drizzle-orm';
import type { AdminDashboardLive } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import { collect } from './section.js';

interface Logger { warn?(...a: unknown[]): void }

type WebDefence = NonNullable<AdminDashboardLive['webDefence']['data']>;

/**
 * How long the ban count may take before the tile renders without it. The
 * LAPI fetch has its own 8s abort; the tile should not wait that long, and the
 * WAF figures beside it must not fail because one source was slow.
 */
export const BAN_COUNT_TIMEOUT_MS = 2_500;

/**
 * The Web defence tile.
 *
 * `countActiveBans` is the Banned IPs list's own count (see
 * security-hardening/crowdsec-ban-list.ts). It is injected rather than
 * imported so this module stays free of the kube config, and REQUIRED so a
 * caller cannot silently fall back to some other notion of "banned" — the
 * tile used to count the WAF auto-ban scheduler's run table and reported 7
 * banned IPs beside a list holding far more.
 */
export async function buildWebDefence(
  db: Pick<Database, 'execute'>,
  countActiveBans: () => Promise<number>,
  logger?: Logger,
): Promise<WebDefence> {
  // Started first and awaited last: the LAPI round-trip overlaps the
  // database reads instead of adding to them.
  const bansPending = collect('banList', countActiveBans, { timeoutMs: BAN_COUNT_TIMEOUT_MS, logger });

  const agg = await db.execute<Record<string, number | string | null>>(sql`
    SELECT COUNT(*)::int AS blocked,
           SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END)::int AS critical,
           COUNT(DISTINCT source_ip)::int AS sources,
           MODE() WITHIN GROUP (ORDER BY rule_id) AS top_rule
      FROM waf_logs
     WHERE created_at > NOW() - INTERVAL '24 hours'
  `);
  const a = (agg.rows ?? [])[0] ?? {};

  // Who is actually hitting us, worst first. A rule id says what tripped;
  // an address says who — and only the address can be blocked, allowlisted
  // or reported upstream.
  const offenders = await db.execute<{ source_ip: string; hits: number }>(sql`
    SELECT source_ip, COUNT(*)::int AS hits
      FROM waf_logs
     WHERE created_at > NOW() - INTERVAL '24 hours' AND source_ip IS NOT NULL
     GROUP BY source_ip ORDER BY hits DESC LIMIT 3
  `);

  const recent = await db.execute<{ severity: string; message: string | null; source_ip: string | null; hostname: string | null; request_uri: string | null; created_at: string }>(sql`
    SELECT severity, message, source_ip, hostname, request_uri, created_at
      FROM waf_logs ORDER BY created_at DESC LIMIT 6
  `);

  // null, not 0, when the LAPI did not answer: "no bans" is a claim.
  const bans = await bansPending;

  return {
    blocked24h: Number(a.blocked ?? 0),
    critical24h: Number(a.critical ?? 0),
    distinctSources: Number(a.sources ?? 0),
    activeBans: bans.data,
    topOffenders: (offenders.rows ?? []).map((o) => ({
      ip: String(o.source_ip), hits: Number(o.hits),
    })),
    topRuleId: a.top_rule == null ? null : String(a.top_rule),
    wafEnabled: true,
    recent: (recent.rows ?? []).map((r) => ({
      severity: (r.severity === 'critical' ? 'critical' : 'warning') as 'warning' | 'critical',
      label: r.message ?? r.request_uri ?? 'blocked request',
      // The SOURCE of an attack is the address it came from. This carried
      // the hostname — the site being attacked — under a label saying the
      // opposite.
      source: r.source_ip ?? r.hostname ?? '—',
      at: String(r.created_at),
    })),
  };
}
