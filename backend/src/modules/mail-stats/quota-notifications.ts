/**
 * Mailbox storage-quota thresholds.
 *
 * Runs after each mail-stats reconciler cycle (~15 min). Walks every active
 * mailbox and fires exactly one notification per (mailbox, threshold).
 *
 * What was wrong before
 * --------------------
 * This module already did the hard parts — dedupe table, hysteresis, an
 * ON CONFLICT claim that is safe across concurrent reconcilers — and notified
 * NOBODY, for its entire life. It resolved recipients with a correlated
 * aggregate over `mailbox_access`, a table with **zero rows platform-wide**, so
 * every candidate hit the `skipped` branch and returned. Measured on production
 * 2026-09-14: `mailbox_quota_events` had 0 rows, four mailboxes were at or above
 * 75%, one was at 100% and bouncing mail, and 18 tenant_admin users were
 * resolvable the whole time.
 *
 * Its designated safety net — the `mail-mailbox-over-quota` SLO rule — read a
 * single global counter with no subject labels, so the operator's only signal
 * was "some mailbox, somewhere". That rule is retired; see
 * notifyAdminMailboxQuotaFleet.
 *
 * Who gets told now
 * -----------------
 *   mailbox owner  — mailed DIRECTLY at the mailbox. They have no platform
 *                    account, which is precisely why no user-id-based resolver
 *                    could ever reach them.
 *   tenant admin   — panel + email, addressed with the tenant's own name.
 *   platform admin — nothing until 100%, then ONE aggregated notification
 *                    naming every affected mailbox, tenant and contact.
 *
 * Thresholds are 80/90/99/100. 99 exists because at 100 the mail is already
 * bouncing — a warning that arrives with the failure is not a warning.
 */

import { sql } from 'drizzle-orm';
import {
  notifyMailboxQuotaThreshold,
  notifyAdminMailboxQuotaFleet,
} from '../notifications/events.js';
import type { Database } from '../../db/index.js';

/**
 * 99 is the last point at which the owner can still act. 100 is the incident.
 */
export const THRESHOLDS = [80, 90, 99, 100] as const;
export type Threshold = (typeof THRESHOLDS)[number];

/** Candidate floor — below (lowest threshold − 5) the hysteresis has nothing to do. */
const CANDIDATE_FLOOR_PCT = 75;

/** Usage must fall this far below a threshold before it can re-fire. */
const HYSTERESIS_PCT = 5;

interface MailboxRow extends Record<string, unknown> {
  mailbox_id: string;
  tenant_id: string;
  tenant_name: string;
  full_address: string;
  quota_mb: number;
  used_mb: number;
}

export function thresholdsCrossed(usedMb: number, quotaMb: number): readonly Threshold[] {
  if (quotaMb <= 0) return [];
  const pct = (usedMb / quotaMb) * 100;
  return THRESHOLDS.filter((t) => pct >= t);
}

export function percentOf(usedMb: number, quotaMb: number): number {
  if (quotaMb <= 0) return 0;
  return Math.floor((usedMb / quotaMb) * 100);
}

/**
 * Walk every mailbox at or above the candidate floor and fire notifications
 * for newly-crossed thresholds. Returns counts for logging.
 */
export async function checkQuotaThresholds(
  db: Database,
  now: Date = new Date(),
): Promise<{ fired: number; cleared: number; overQuota: number }> {
  const candidates = await db.execute<MailboxRow>(sql`
    SELECT
      m.id           AS mailbox_id,
      m.tenant_id    AS tenant_id,
      t.name         AS tenant_name,
      m.full_address AS full_address,
      m.quota_mb     AS quota_mb,
      m.used_mb      AS used_mb
    FROM mailboxes m
    JOIN tenants t ON t.id = m.tenant_id
    WHERE m.status = 'active'
      AND m.quota_mb > 0
      -- Platform plumbing is not a tenant's problem. The dmarc@ and
      -- postmaster@ intake mailboxes are 50 MB transit buffers that the
      -- report-intake reconciler reaps at 40 MB, i.e. they sit ABOVE this
      -- 75% floor by design. Without this filter, shrinking them turned
      -- every reap cycle into a quota warning to the tenant and an
      -- over-quota entry in the operator's fleet notification.
      AND m.platform_managed = FALSE
      AND (m.used_mb::numeric / m.quota_mb::numeric) * 100 >= ${CANDIDATE_FLOOR_PCT}
  `);

  const rows = candidates.rows ?? [];
  const occurredAt = now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  let fired = 0;

  // Collected for the operator's single aggregated notification. The operator
  // is deliberately NOT told about 80/90/99 — that is the tenant's business
  // until mail actually starts bouncing.
  const overQuota: MailboxRow[] = [];

  for (const row of rows) {
    const pct = percentOf(row.used_mb, row.quota_mb);
    if (pct >= 100) overQuota.push(row);

    // Claim EVERY crossed threshold, but notify for the HIGHEST one only.
    //
    // A mailbox that jumps from 78% to 95% between two reconciler passes
    // crosses 80 and 90 at once, and the loop used to send one notification
    // per crossing — two emails two seconds apart, observed on production
    // 2026-09-16 (mr.moringa@ got the 80 and the 90 back to back). The lower
    // ones still have to be CLAIMED, or they would fire on the next pass as
    // if they were new.
    let highest: number | null = null;
    for (const threshold of thresholdsCrossed(row.used_mb, row.quota_mb)) {
      // Concurrent reconcilers are safe: exactly one INSERT wins. The DO
      // UPDATE re-arms a previously cleared event; the WHERE keeps a
      // still-firing one a no-op.
      const inserted = await db.execute<{ mailbox_id: string }>(sql`
        INSERT INTO mailbox_quota_events (mailbox_id, threshold)
        VALUES (${row.mailbox_id}, ${threshold})
        ON CONFLICT (mailbox_id, threshold) DO UPDATE
          SET first_seen_at = NOW(),
              cleared_at = NULL,
              notification_id = NULL
          WHERE mailbox_quota_events.cleared_at IS NOT NULL
        RETURNING mailbox_id
      `);
      if ((inserted.rows ?? []).length === 0) continue;
      if (highest === null || threshold > highest) highest = threshold;
    }

    {
      const threshold = highest;
      if (threshold === null) continue;

      // Two audiences from one call: the tenant admins by scope, and the
      // mailbox owner by address because they have no account to resolve.
      await notifyMailboxQuotaThreshold(
        db,
        row.tenant_id,
        row.full_address,
        {
          mailboxAddress: row.full_address,
          tenantName: row.tenant_name,
          percent: String(pct),
          usedMb: String(row.used_mb),
          quotaMb: String(row.quota_mb),
          occurredAt,
        },
        {
          exceeded: threshold === 100,
          dedupeKey: `mailbox-quota:${row.mailbox_id}:${threshold}`,
        },
      );
      fired += 1;
    }
  }

  // ONE aggregated operator notification, naming everything. Deduped per UTC
  // day so a sustained condition does not re-page, and skipped entirely when
  // nothing is over quota.
  if (overQuota.length > 0) {
    const tenants = new Set(overQuota.map((r) => r.tenant_id));
    const list = overQuota
      .map((r) => `${r.full_address} (${r.tenant_name}, ${r.used_mb}/${r.quota_mb} MB)`)
      .join('; ');
    await notifyAdminMailboxQuotaFleet(
      db,
      {
        mailboxCount: String(overQuota.length),
        tenantCount: String(tenants.size),
        mailboxList: list.slice(0, 2000),
        occurredAt,
      },
      `mailbox-quota-fleet:${now.toISOString().slice(0, 10)}`,
    );
  }

  // Hysteresis: re-arm an event once usage drops meaningfully below its
  // threshold, so a mailbox hovering on the line does not re-fire every cycle.
  const clearResult = await db.execute<{ mailbox_id: string }>(sql`
    UPDATE mailbox_quota_events e
       SET cleared_at = NOW()
      FROM mailboxes m
     WHERE m.id = e.mailbox_id
       AND e.cleared_at IS NULL
       AND m.quota_mb > 0
       AND (m.used_mb::numeric / m.quota_mb::numeric) * 100 < (e.threshold - ${HYSTERESIS_PCT})
    RETURNING e.mailbox_id
  `);

  // Bounded growth. The dedupe logic reads only `cleared_at IS NULL`, so a
  // cleared row is pure audit tail — 30 days, not the 90-day domain ceiling,
  // because that ceiling is a maximum and not a target. Open rows are bounded
  // by (mailbox × threshold) and cascade away with their mailbox.
  try {
    await db.execute(sql`
      DELETE FROM mailbox_quota_events
       WHERE cleared_at IS NOT NULL
         AND cleared_at < NOW() - INTERVAL '30 days'
    `);
  } catch (err) {
    console.warn(
      '[mail-stats:quota] gc of cleared events failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  return {
    fired,
    cleared: (clearResult.rows ?? []).length,
    overQuota: overQuota.length,
  };
}
