/**
 * Stalwart 0.16 principals-sync reconciler.
 *
 * Polls Stalwart every 5 minutes for ALL principals, then reconciles
 * the platform's `mailboxes` and `email_domains` cache tables against
 * Stalwart's truth.
 *
 * Reconciliation rules:
 *   - If a mailbox/domain exists in Stalwart but not in the platform DB
 *     → log a warning (could be a manual admin action). No auto-create.
 *   - If a mailbox/domain exists in the platform DB but not in Stalwart
 *     → mark as lifecycle_status='orphan' for operator review (no auto-
 *     delete — operator must decide).
 *   - If a platform row has stalwartPrincipalId=null/stalwartDomainId=null
 *     but the email address / domain name matches a Stalwart principal
 *     → backfill the ID column so future deletes/updates use JMAP directly.
 *
 * Ownership model:
 *   Stalwart is the source of truth for existence. The platform DB is a
 *   cache / projection. The reconciler NEVER deletes platform rows; it only
 *   adds metadata (stalwart*Id backfill) and sets a flag for operator review.
 *
 * Disable with STALWART_PRINCIPALS_SYNC_DISABLE=true (e.g. during bootstrap).
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mailboxes, emailDomains, domains, mailDriftItems, users, notifications } from '../../db/schema.js';
import {
  getJmapSession,
  principalGet,
  type JmapAccountId,
  type StalwartPrincipal,
} from './client.js';
import type { CoreV1Api } from '@kubernetes/client-node';
import type { Database } from '../../db/index.js';
import { mailLogger } from '../../shared/mail-logger.js';
import { readStalwartMasterUser, MASTER_USER_FALLBACK } from '../mail-admin/stalwart-master-user.js';

const log = mailLogger().child({ module: 'stalwart-principals-sync' });

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Stable synthetic platform_row_id for the (single) webmail master-user drift
// item — it is not a platform DB row, so it needs a fixed natural key so
// reconcileDriftItems upserts/resolves the one row instead of inserting dupes.
const MASTER_DRIFT_ROW_ID = '__webmail_master_user__';

export interface PrincipalsSyncOptions {
  readonly intervalMs?: number;
  readonly baseUrl?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** k8s CoreV1Api for reading the master-user FQDN from mail-secrets (master detector). */
  readonly core?: CoreV1Api | null;
}

export interface PrincipalsSyncHandle {
  start(): void;
  stop(): void;
  runOnce(): Promise<SyncResult>;
}

export interface SyncResult {
  readonly mailboxesBackfilled: number;
  readonly domainsBackfilled: number;
  readonly mailboxOrphansMarked: number;
  readonly domainOrphansLogged: number;
  readonly errors: readonly string[];
}

/**
 * Build the principals-sync scheduler. Call `start()` after the DB is ready.
 */
export function createPrincipalsSyncScheduler(
  db: Database,
  options: PrincipalsSyncOptions = {},
): PrincipalsSyncHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const baseUrl = options.baseUrl;
  const env = options.env ?? process.env;
  const core = options.core ?? null;

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function runCycle(): Promise<SyncResult> {
    if (running) {
      return {
        mailboxesBackfilled: 0,
        domainsBackfilled: 0,
        mailboxOrphansMarked: 0,
        domainOrphansLogged: 0,
        errors: ['skipped: previous cycle still running'],
      };
    }
    running = true;
    try {
      return await syncPrincipals({ db, baseUrl, env, core });
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer !== null) return;
      // Random initial-jitter (0..intervalMs) so N platform-api replicas
      // don't all run their sync cycle in lockstep. Code-review
      // MEDIUM-2 fix (2026-05-03): without this, 3 replicas all hit
      // Stalwart at the same minute every 5 minutes — 3× JMAP load
      // peaks. Jittering smooths it across the 5-minute window.
      const initialDelay = Math.floor(Math.random() * intervalMs);
      // Track the jitter-window setTimeout in `timer` so stop() can
      // cancel it before the first cycle fires; once the first cycle
      // runs we re-assign `timer` to the periodic setInterval handle.
      // clearInterval/clearTimeout are interchangeable in Node for
      // both handle kinds, so a single `timer` slot is sufficient.
      timer = setTimeout(() => {
        // Release the just-fired setTimeout handle before kicking off the
        // first cycle. If stop() runs while runCycle()'s promise chain is
        // suspended (await tick), it sees `timer === null` and the early
        // return on the next start() prevents a double-start. The next
        // line then re-installs the periodic interval — also stop()able.
        timer = null;
        void runCycle().catch((err) => {
          log.error({ err: err instanceof Error ? err.message : String(err) }, 'initial cycle failed');
        });
        timer = setInterval(() => {
          void runCycle().catch((err) => {
            log.error({ err: err instanceof Error ? err.message : String(err) }, 'cycle failed');
          });
        }, intervalMs);
      }, initialDelay) as unknown as ReturnType<typeof setInterval>;
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    runOnce: runCycle,
  };
}

// ── Core reconciliation ───────────────────────────────────────────────────────

async function syncPrincipals(params: {
  db: Database;
  baseUrl?: string;
  env: NodeJS.ProcessEnv;
  core?: CoreV1Api | null;
}): Promise<SyncResult> {
  const { db, baseUrl, env, core } = params;

  const errors: string[] = [];

  // 1. Resolve JMAP account ID
  let accountId: JmapAccountId;
  try {
    const session = await getJmapSession(baseUrl, env);
    const id = session.primaryAccounts['urn:ietf:params:jmap:principals'];
    if (!id) throw new Error('No principals account in JMAP session');
    accountId = id;
  } catch (err) {
    errors.push(`JMAP session failed: ${err instanceof Error ? err.message : String(err)}`);
    return { mailboxesBackfilled: 0, domainsBackfilled: 0, mailboxOrphansMarked: 0, domainOrphansLogged: 0, errors };
  }

  // 2. Fetch all principals from Stalwart (individual + domain)
  let allPrincipals: readonly StalwartPrincipal[];
  try {
    const result = await principalGet({
      accountId,
      ids: null,
      properties: ['id', 'name', 'type', 'emails'],
      baseUrl,
      env,
    });
    allPrincipals = result.list;
  } catch (err) {
    errors.push(`Principal/get failed: ${err instanceof Error ? err.message : String(err)}`);
    return { mailboxesBackfilled: 0, domainsBackfilled: 0, mailboxOrphansMarked: 0, domainOrphansLogged: 0, errors };
  }

  // Build lookup maps from Stalwart's data
  const stalwartMailboxByEmail = new Map<string, string>(); // email → principalId
  const stalwartDomainByName = new Map<string, string>();   // domainName → principalId

  for (const p of allPrincipals) {
    if (!p.id) continue;
    if (p.type === 'individual') {
      // Stalwart (v0.16.x) returns an individual's address in `name` and does
      // NOT populate the `emails` array on Principal/get — so the prior
      // `p.emails`-only mapping was ALWAYS empty, falsely flagging every
      // mailbox as "missing from Stalwart" (drift false-positive). Map by
      // `name` (the canonical address, exactly as domains map by name one
      // branch down); keep `emails` for forward-compat if a future Stalwart
      // starts returning it.
      if (p.name) stalwartMailboxByEmail.set(p.name.toLowerCase(), p.id);
      for (const email of p.emails ?? []) {
        stalwartMailboxByEmail.set(email.toLowerCase(), p.id);
      }
    } else if (p.type === 'domain') {
      stalwartDomainByName.set(p.name.toLowerCase(), p.id);
    }
  }

  let mailboxesBackfilled = 0;
  let domainsBackfilled = 0;
  let mailboxOrphansMarked = 0;
  let domainOrphansLogged = 0;

  // Collect drift items detected this tick so we can (a) UPSERT them
  // into mail_drift_items, (b) mark previously-active items resolved if
  // they're no longer in drift, (c) detect NEW items for admin alert
  // fan-out. Each item: kind + platform_row_id is the natural key.
  const driftThisTick: Array<{
    kind: 'mailbox' | 'domain' | 'master-user';
    expectedName: string;
    expectedStalwartId: string;
    platformRowId: string;
    notes?: string;
  }> = [];

  // ── C: webmail master-user detector ──────────────────────────────────────
  // The Stalwart master user (`master@mail.<domain>`) is what Bulwark +
  // Roundcube authenticate as to impersonate tenant mailboxes. If it goes
  // missing, ALL webmail login/impersonation silently breaks (the rest of
  // Stalwart is fine, so nothing else alerts). It is NOT a platform DB row, so
  // it's invisible to the mailbox/domain reconcile below — detect it here and
  // raise an ACTIONABLE drift item (one stable row, fixed platformRowId).
  // NB: MUST run after `stalwartMailboxByEmail` is populated above (it looks
  // the master up in that map) — do not hoist this block above the principal loop.
  try {
    const masterFqdn = (await readStalwartMasterUser(core ?? null)).trim().toLowerCase();
    // Skip when we only have the compiled-in fallback (no k8s/secret) — we
    // can't know the real master FQDN, so don't false-alarm.
    if (masterFqdn && masterFqdn !== MASTER_USER_FALLBACK.toLowerCase()) {
      if (!stalwartMailboxByEmail.has(masterFqdn)) {
        driftThisTick.push({
          kind: 'master-user',
          expectedName: masterFqdn,
          expectedStalwartId: '',
          platformRowId: MASTER_DRIFT_ROW_ID,
          notes:
            'Webmail master user is missing from Stalwart — Bulwark/Roundcube '
            + 'login + impersonation are broken for ALL mailboxes until it is '
            + 'recreated. Remediate: POST /api/v1/admin/mail/rotate-webmail-master '
            + '(super_admin) — it recreates the master principal and re-syncs '
            + 'mail-secrets. No tenant data is affected.',
        });
        log.warn({ masterFqdn }, 'webmail master user missing from Stalwart — drift recorded (impersonation broken)');
      }
    }
  } catch (err) {
    errors.push(`master-user check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Reconcile mailboxes
  try {
    const platformMailboxes = await db
      .select({
        id: mailboxes.id,
        fullAddress: mailboxes.fullAddress,
        stalwartPrincipalId: mailboxes.stalwartPrincipalId,
      })
      .from(mailboxes);

    for (const row of platformMailboxes) {
      const stalwartId = stalwartMailboxByEmail.get(row.fullAddress.toLowerCase());

      if (!stalwartId) {
        // Platform row exists, Stalwart doesn't know about it
        if (row.stalwartPrincipalId !== null) {
          // Previously synced — now gone from Stalwart. Persist drift
          // (replaces the prior log-only behaviour which was operationally
          // invisible). The mail_drift_items table is the source of truth
          // for the admin UI + notification fan-out below.
          log.warn({
            mailboxId: row.id,
            fullAddress: row.fullAddress,
            stalwartPrincipalId: row.stalwartPrincipalId,
          }, 'mailbox exists in platform DB but not in Stalwart — drift recorded');
          driftThisTick.push({
            kind: 'mailbox',
            expectedName: row.fullAddress,
            expectedStalwartId: row.stalwartPrincipalId,
            platformRowId: row.id,
          });
          mailboxOrphansMarked++;
        }
        // If stalwartPrincipalId is null AND not in Stalwart → genuinely missing;
        // leave alone (may be a dev/test row with no mail stack).
        continue;
      }

      // Backfill: platform has no stalwartPrincipalId but Stalwart knows this mailbox
      if (!row.stalwartPrincipalId) {
        await db
          .update(mailboxes)
          .set({ stalwartPrincipalId: stalwartId })
          .where(eq(mailboxes.id, row.id));
        mailboxesBackfilled++;
      }
    }
  } catch (err) {
    errors.push(`Mailbox reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Reconcile email_domains
  try {
    const platformDomains = await db
      .select({
        id: emailDomains.id,
        domainId: emailDomains.domainId,
        stalwartDomainId: emailDomains.stalwartDomainId,
        domainName: domains.domainName,
      })
      .from(emailDomains)
      .innerJoin(domains, eq(domains.id, emailDomains.domainId));

    for (const row of platformDomains) {
      const stalwartId = stalwartDomainByName.get(row.domainName.toLowerCase());

      if (!stalwartId) {
        if (row.stalwartDomainId !== null) {
          log.warn({
            emailDomainId: row.id,
            domainName: row.domainName,
            stalwartDomainId: row.stalwartDomainId,
          }, 'email domain exists in platform DB but not in Stalwart — drift recorded');
          driftThisTick.push({
            kind: 'domain',
            expectedName: row.domainName,
            expectedStalwartId: row.stalwartDomainId,
            platformRowId: row.id,
          });
          domainOrphansLogged++;
        }
        continue;
      }

      if (!row.stalwartDomainId) {
        await db
          .update(emailDomains)
          .set({ stalwartDomainId: stalwartId })
          .where(eq(emailDomains.id, row.id));
        domainsBackfilled++;
      }
    }
  } catch (err) {
    errors.push(`Domain reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5. Persist drift state + alert admins on NEW items.
  try {
    const newItems = await reconcileDriftItems(db, driftThisTick);
    if (newItems.length > 0) {
      await emitDriftNotification(db, newItems);
    }
  } catch (err) {
    errors.push(`drift persistence failed: ${err instanceof Error ? err.message : String(err)}`);
    log.error({ err }, 'mail-drift: failed to persist drift items');
  }

  if (mailboxesBackfilled > 0 || domainsBackfilled > 0 || errors.length > 0) {
    log.info({
      mailboxesBackfilled,
      domainsBackfilled,
      mailboxOrphans: mailboxOrphansMarked,
      domainOrphans: domainOrphansLogged,
      errors: errors.length,
    }, 'reconcile cycle complete');
  }

  return { mailboxesBackfilled, domainsBackfilled, mailboxOrphansMarked, domainOrphansLogged, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// Drift persistence + admin alerting
//
// The platform_db / Stalwart drift surface is the operator's safety net
// against silent data-loss caused by failed mail-stack failovers (the
// 2026-05-25 staging incident — see migration 0032 header). Pre-2026-05-27
// the sync logged warnings; post-fix it persists drift to mail_drift_items
// and notifies admins so the issue surfaces in the UI, not just logs.
// ─────────────────────────────────────────────────────────────────────────────

interface DriftTickItem {
  readonly kind: 'mailbox' | 'domain' | 'master-user';
  readonly expectedName: string;
  readonly expectedStalwartId: string;
  readonly platformRowId: string;
  readonly notes?: string;
}

/**
 * Upsert active drift items + mark previously-active items resolved
 * when no longer detected this tick. Returns the items that were NEW
 * this tick (so the caller can emit a notification).
 *
 * Semantics:
 *   - Item already-active and re-seen: bump last_seen_at, leave first_detected_at alone.
 *   - Item not previously tracked (or previously resolved): INSERT new row,
 *     return it in the `newItems` list.
 *   - Item previously active but not seen this tick: mark resolved_via='reappeared'.
 *     (The platform DB row is no longer in drift — either Stalwart recovered
 *     the entry or the platform row was deleted.)
 */
async function reconcileDriftItems(
  db: Database,
  thisTick: ReadonlyArray<DriftTickItem>,
): Promise<ReadonlyArray<DriftTickItem>> {
  // 1. Load currently-active rows from the table.
  const active = await db
    .select({
      id: mailDriftItems.id,
      kind: mailDriftItems.kind,
      platformRowId: mailDriftItems.platformRowId,
    })
    .from(mailDriftItems)
    .where(isNull(mailDriftItems.resolvedAt));

  const activeKey = new Set(active.map((r) => `${r.kind}:${r.platformRowId}`));
  const tickKey = new Set(thisTick.map((r) => `${r.kind}:${r.platformRowId}`));

  // 2. Newly-detected items: insert + collect for notification.
  const newItems: DriftTickItem[] = [];
  for (const item of thisTick) {
    const key = `${item.kind}:${item.platformRowId}`;
    if (activeKey.has(key)) {
      // Bump last_seen_at on the existing active row.
      await db
        .update(mailDriftItems)
        .set({ lastSeenAt: sql`now()` })
        .where(and(
          eq(mailDriftItems.kind, item.kind),
          eq(mailDriftItems.platformRowId, item.platformRowId),
          isNull(mailDriftItems.resolvedAt),
        ));
    } else {
      // Brand-new drift (or re-occurrence after resolved). Insert.
      await db.insert(mailDriftItems).values({
        id: randomUUID(),
        kind: item.kind,
        expectedName: item.expectedName,
        expectedStalwartId: item.expectedStalwartId,
        platformRowId: item.platformRowId,
        notes: item.notes ?? null,
      });
      newItems.push(item);
    }
  }

  // 3. Items that WERE active but disappeared from drift → resolved.
  const resolvedRowIds = active
    .filter((r) => !tickKey.has(`${r.kind}:${r.platformRowId}`))
    .map((r) => r.id);
  if (resolvedRowIds.length > 0) {
    await db
      .update(mailDriftItems)
      .set({ resolvedAt: sql`now()`, resolvedVia: 'reappeared' })
      .where(inArray(mailDriftItems.id, resolvedRowIds));
  }

  return newItems;
}

/**
 * Fan out one notification per super_admin/admin when NEW drift items
 * appear this tick. One summary notification per detection cycle, not
 * per-item — so an operator who's been ignoring a 5-item drift for
 * weeks doesn't get 5 new notifications every 5 min.
 */
async function emitDriftNotification(
  db: Database,
  newItems: ReadonlyArray<DriftTickItem>,
): Promise<void> {
  const admins = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.roleName, ['super_admin', 'admin']));
  if (admins.length === 0) return;

  const masterItem = newItems.find((i) => i.kind === 'master-user');
  const mailboxCount = newItems.filter((i) => i.kind === 'mailbox').length;
  const domainCount = newItems.filter((i) => i.kind === 'domain').length;

  // The master-user is a platform-wide outage (ALL webmail login/impersonation
  // broken), so it gets its own urgent, single-action notification rather than
  // being folded into the per-mailbox/domain drift summary.
  let title: string;
  let message: string;
  if (masterItem) {
    title = 'Webmail master user missing — ALL webmail login/impersonation is broken';
    message =
      `The Stalwart master user (${masterItem.expectedName}) — which Bulwark + `
      + `Roundcube authenticate as to open every tenant mailbox — is missing from `
      + `Stalwart. Until it is recreated, NO mailbox can log into webmail or be `
      + `impersonated (other mail functions are unaffected).\n\n`
      + `Remediate: Admin UI → Email → Data Drift → "Recreate webmail master", or `
      + `POST /api/v1/admin/mail/rotate-webmail-master (super_admin). No tenant `
      + `mail data is affected.`;
    if (mailboxCount > 0 || domainCount > 0) {
      message += `\n\n(Also new this cycle: ${mailboxCount} mailbox + ${domainCount} domain drift item(s).)`;
    }
  } else {
    const parts: string[] = [];
    if (domainCount > 0) parts.push(`${domainCount} tenant Stalwart Domain${domainCount === 1 ? '' : 's'}`);
    if (mailboxCount > 0) parts.push(`${mailboxCount} mailbox principal${mailboxCount === 1 ? '' : 's'}`);
    const summary = parts.join(' + ');
    const sample = newItems.slice(0, 3).map((i) => i.expectedName).join(', ');
    const more = newItems.length > 3 ? ` (+${newItems.length - 3} more)` : '';
    title = `Mail data drift detected: ${summary} missing from Stalwart`;
    message =
      `The principals-sync reconciler found platform DB rows referencing ` +
      `Stalwart entries that no longer exist. Likely cause: a failed mail-stack ` +
      `failover (the silent-loss path was patched 2026-05-27; this alert exists ` +
      `to surface PRE-EXISTING drift from before that fix).\n\n` +
      `New drift this cycle: ${sample}${more}\n\n` +
      `Inspect via Admin UI → Email → Data Drift. Each item offers two ` +
      `remediation options: restore the entire Stalwart datastore from a ` +
      `snapshot (preserves DKIM + mailbox contents), or recreate the missing ` +
      `entry empty (new DKIM, no messages — last resort).`;
  }

  for (const a of admins) {
    try {
      await db.insert(notifications).values({
        id: randomUUID(),
        userId: a.id,
        type: 'warning',
        title,
        message,
        resourceType: 'mail_drift',
      });
    } catch (err) {
      log.warn({ err, userId: a.id }, 'mail-drift: failed to write admin notification');
    }
  }
}
