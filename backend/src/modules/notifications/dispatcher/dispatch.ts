/**
 * Notification dispatcher — the new entry point for categorised events.
 *
 * Flow:
 *   1. Look up the category. Unknown → no-op (event silently dropped).
 *   2. Resolve recipients via `resolveRecipients`.
 *   3. If scope='tenant' + opts.suppressTenantNotification, skip tenant users.
 *   4. For each (recipient × channel) in the DERIVED channel set:
 *        a. Preference gate. Disabled → write status='muted', skip.
 *        b. Quiet hours (severity < critical). Active → status='muted', skip.
 *        c. Rate limit. Exceeded → status='rate_limited', skip.
 *        d. Load template. Missing → log + skip.
 *        e. Render.
 *        f. Hash recipient (sha256 over email/userId salted with PLATFORM_ENCRYPTION_KEY)
 *           and content (sha256 over rendered subject+body).
 *        g. in_app channel: INSERT notifications row + delivery row status='sent'.
 *        h. email channel: INSERT delivery row status='queued', call email-sender,
 *           update to 'sent' or 'failed'.
 *   5. Return event id, count, per-channel breakdown.
 *
 * Phase 2 will move email delivery off the request thread into a queue
 * worker; for Phase 1 it's synchronous so call-sites get clear feedback
 * during the request lifecycle.
 */
import { and, eq, gt } from 'drizzle-orm';
import crypto from 'node:crypto';
import {
  users,
  notifications,
  notificationDeliveries,
  systemSettings,
} from '../../../db/schema.js';
// Named for the mail modules, but its own docblock states it is safe to import
// anywhere in backend/src — it is the process-wide pino instance. The
// dispatcher had NO logger at all, which is why a globally muted notification
// system would otherwise be invisible.
import { mailLogger } from '../../../shared/mail-logger.js';
import { resolveRecipients, type RecipientScope } from '../recipients.js';
import { getCategory } from '../categories/service.js';
import { getActiveTemplate } from '../templates/service.js';
import { renderForDelivery } from '../templates/render-for-delivery.js';
import { recordDegradedRender, clampDegradedVars } from './degraded.js';
import { effectiveChannels, categoryMeta } from '../routing/effective-channels.js';
import {
  platformName,
  tenantIdentity,
  userDisplayName,
  normaliseDateVariables,
  resolveIdVariables,
  greetingFor,
  findIds,
} from './envelope.js';
import { CLASS_POLICY } from '../routing/classes.js';
import { isObjectMuted } from '../mutes/service.js';
import { isDigestible, queueForDigest, type DigestMode } from '../digest/service.js';
import { emitNtfyForEvent } from './ntfy.js';
import { isCategoryAllowedForUser } from '../preferences/gate.js';
import { getUserSettings } from '../preferences/service.js';
import { isInQuietHours } from '../preferences/quiet-hours.js';
import { consumeRateLimit } from '../rate-limit/service.js';
import { enqueueDelivery } from '../queue/enqueue.js';
import type {
  NotificationCategoryResponse,
  NotificationDeliveryStatus,
} from '@insula/api-contracts';
import type { Database } from '../../../db/index.js';

type Channel = 'in_app' | 'email' | 'ntfy';

export interface EmitEventOptions {
  readonly categoryId: string;
  readonly scope: RecipientScope;
  readonly variables: Record<string, unknown>;
  readonly tenantId?: string | null;
  readonly suppressTenantNotification?: boolean;
  readonly eventId?: string;
  /** Override locale for the template lookup (rare). */
  readonly localeOverride?: string;
  /**
   * Addresses for an audience with NO platform account — today, mailbox
   * owners. They receive the email leg only, because
   * channelsForAudience('mailbox_user') is ['email'] and there is no account
   * for an in-app row to live in.
   */
  readonly externalRecipients?: readonly string[];
  /** Override encryption key (tests). Production reads PLATFORM_ENCRYPTION_KEY. */
  readonly encryptionKey?: string;
  /**
   * Opaque per-recipient idempotency key. When set, the dispatcher
   * checks for an existing notifications row with the same key in the
   * last 30 days BEFORE writing — duplicates are silently skipped so
   * a scheduler tick that fires the same warning twice in a row only
   * persists one notification per user.
   *
   * Format the key as `<event-kind>:<scope-discriminator>:<bucket>`
   * e.g. `subscription-expiry:tenant-X:7d:2026-06-05` for a 7-day-out
   * warning about the 2026-06-05 expiry slot.
   */
  readonly dedupeKey?: string;
}

export interface PerChannelStatus {
  /** NULL for broadcast channels (ntfy) — there is no per-user leg. */
  readonly userId: string | null;
  readonly channel: Channel;
  readonly status: NotificationDeliveryStatus;
  readonly notificationId?: string;
  readonly error?: string;
}

export interface EmitResult {
  readonly eventId: string;
  readonly deliveryCount: number;
  readonly perChannelStatuses: readonly PerChannelStatus[];
}

function sha256(input: string, salt: string): string {
  return crypto.createHash('sha256').update(`${salt}|${input}`).digest('hex');
}

function severityIsCritical(cat: NotificationCategoryResponse): boolean {
  return cat.defaultSeverity === 'critical';
}

async function getUserEmail(db: Database, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.email ?? null;
}

/**
 * Returns true when a notification_deliveries row with this
 * (user, dedupeKey) was written in the last 30 days.
 *
 * We query notification_deliveries — NOT notifications — because the
 * deliveries table is written for every channel (in_app + email),
 * whereas the notifications table is in_app only. An email-only
 * category therefore wouldn't be deduplicated against the notifications
 * table even though the prior delivery DID happen.
 *
 * 30 days matches the notification_deliveries retention window — we
 * never dedupe against a row the GDPR purge has already deleted.
 */
async function findDedupedNotification(
  db: Database,
  userId: string,
  dedupeKey: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({ id: notificationDeliveries.id })
    .from(notificationDeliveries)
    .where(and(
      eq(notificationDeliveries.userId, userId),
      eq(notificationDeliveries.dedupeKey, dedupeKey),
      gt(notificationDeliveries.queuedAt, cutoff),
    ))
    .limit(1);
  return row != null;
}

/**
 * A delivery must know who it is for.
 *
 * Enforced here rather than as a table CHECK: `user_id` is ON DELETE SET NULL
 * so the audit row outlives a GDPR erasure, which means a HISTORICAL row
 * legitimately has neither identifier. A constraint cannot tell those apart
 * from a new row written with neither — it just aborts, as it did on DEV
 * against 164 of 458 existing rows.
 */
export function hasRecipient(input: {
  userId: string | null;
  recipientAddress?: string | null;
  channel: string;
}): boolean {
  // ntfy is a topic broadcast, not an addressed delivery.
  if (input.channel === 'ntfy') return true;
  return Boolean(input.userId) || Boolean(input.recipientAddress);
}

async function writeDelivery(
  db: Database,
  input: {
    notificationId: string | null;
    eventId: string;
    userId: string | null;
    recipientAddress?: string | null;
    tenantId: string | null;
    categoryId: string;
    channel: Channel;
    templateId: string | null;
    templateVersion: number;
    locale: string;
    status: NotificationDeliveryStatus;
    recipientHash: string | null;
    contentHash: string;
    lastError?: string;
    degradedVars?: readonly string[];
    fallbackUsed?: boolean;
    providerMessageId?: string;
    sentAt?: Date | null;
    eventVariables?: Record<string, unknown>;
    dedupeKey?: string;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date();
  if (!hasRecipient(input)) {
    // Refuse at the source. A row with no recipient is undeliverable, and
    // writing it would make the delivery log claim something was attempted.
    throw new Error(
      `notification delivery for ${input.categoryId}/${input.channel} has neither userId nor recipientAddress`,
    );
  }
  await db.insert(notificationDeliveries).values({
    id,
    notificationId: input.notificationId,
    eventId: input.eventId,
    userId: input.userId,
    recipientAddress: input.recipientAddress ?? null,
    tenantId: input.tenantId,
    categoryId: input.categoryId,
    channel: input.channel,
    recipientHash: input.recipientHash,
    contentHash: input.contentHash,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    locale: input.locale,
    status: input.status,
    attempt: input.status === 'sent' ? 1 : 0,
    maxAttempts: 6,
    lastError: input.lastError ?? null,
    // NULL means "rendered cleanly". Only a genuine contract defect writes an
    // array here, so the partial index stays small and the admin filter is
    // exactly the set of thin messages.
    degradedVars: input.degradedVars && input.degradedVars.length > 0
      ? clampDegradedVars(input.degradedVars)
      : null,
    providerMessageId: input.providerMessageId ?? null,
    sentAt: input.status === 'sent' ? now : null,
    eventVariables: input.eventVariables ?? null,
    dedupeKey: input.dedupeKey ?? null,
  });
  return id;
}

/**
 * Main dispatcher entrypoint. Returns even on per-recipient failures —
 * a single bad SMTP delivery shouldn't abort the whole fan-out.
 */
/**
 * The dedupe_key columns (notifications, notification_deliveries) are
 * varchar(128). A caller that inlines a long value (e.g. a full error reason)
 * overflows it — the delivery INSERT throws, dispatchSafe swallows it, and the
 * whole notification vanishes with no row and no log. Clamp defensively at the
 * dispatch boundary so no caller can ever silently kill a notification this way:
 * a too-long key keeps a readable prefix plus a stable hash of the whole, so it
 * fits AND stays unique/deterministic (the same input dedupes against itself).
 */
/**
 * `system_settings` is a single row keyed by this literal — the same id
 * `system-settings/service.ts` writes. Kept local rather than imported from
 * that service because importing it would pull in its 5s settings cache, and
 * bypassing that cache is the entire point of the kill-switch read below.
 */
const SYSTEM_SETTINGS_ROW_ID = 'system';

/** One child logger for this module; see the import note above. */
const dispatchLog = () => mailLogger().child({ module: 'notifications-dispatch' });

export const DEDUPE_KEY_MAX = 128;
export function clampDedupeKey(key: string | undefined): string | undefined {
  if (key === undefined || key.length <= DEDUPE_KEY_MAX) return key;
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  return `${key.slice(0, DEDUPE_KEY_MAX - hash.length - 1)}:${hash}`;
}

/**
 * Last line of defence against an id reaching a reader.
 *
 * `resolveIdVariables` cleans the VARIABLES, but a template could inline an id
 * of its own, and a caller could pass one inside a longer sentence that no
 * lookup matched. This reads the RENDERED output — the actual text the person
 * receives — which is the only place the guarantee can really be checked.
 *
 * It reports rather than blocks: a thin notification beats no notification,
 * and a silenced alert is the failure mode this whole epic exists to remove.
 */
function warnOnRenderedIds(
  categoryId: string,
  channel: string,
  subject: string | null,
  body: string,
): void {
  const leaked = [...new Set([...findIds(subject ?? ''), ...findIds(body)])];
  if (leaked.length === 0) return;
  dispatchLog().warn(
    { categoryId, channel, leakedIds: leaked },
    'notification rendered with a raw id in the text a person reads',
  );
}

export async function emitEvent(db: Database, opts: EmitEventOptions): Promise<EmitResult> {
  const eventId = opts.eventId ?? crypto.randomUUID();
  const dedupeKey = clampDedupeKey(opts.dedupeKey);
  const statuses: PerChannelStatus[] = [];

  // 1. Resolve category.
  let category: NotificationCategoryResponse;
  try {
    category = await getCategory(db, opts.categoryId);
  } catch {
    // Unknown category — drop silently (logged elsewhere if needed).
    return { eventId, deliveryCount: 0, perChannelStatuses: [] };
  }
  if (!category.isActive) {
    return { eventId, deliveryCount: 0, perChannelStatuses: [] };
  }

  // 1a. Master kill switch.
  //
  // Read straight from the row, NOT through system-settings `getSettings()`,
  // which serves a 5s cache: an operator stopping a storm must see it stop on
  // the next event, not "within five seconds, probably". A single-row read per
  // event is cheap next to the recipient and template queries below.
  //
  // Logged at WARN with the category, because a silent global mute is how a
  // platform ends up wondering why it never hears anything — the switch has to
  // be as visible in the logs as the storm it was thrown to stop.
  const [sysRow] = await db
    .select({ notificationsEnabled: systemSettings.notificationsEnabled })
    .from(systemSettings)
    .where(eq(systemSettings.id, SYSTEM_SETTINGS_ROW_ID))
    .limit(1);
  if (sysRow && sysRow.notificationsEnabled === false) {
    dispatchLog().warn(
      { categoryId: opts.categoryId, eventId },
      'notifications are globally DISABLED — event dropped without delivery',
    );
    return { eventId, deliveryCount: 0, perChannelStatuses: [] };
  }

  // 2-pre. ntfy leg — a TOPIC BROADCAST: once per EVENT, before (and
  // independent of) recipient resolution, so suppressed-tenant or
  // recipient-less events still reach the operator feed. Never throws:
  // the per-user channels must not die on a broken ntfy server.
  // Channels are DERIVED, not read. `default_channels` is the operator's
  // override; the class, the audience and the subsystem being reported on
  // still filter it. This is what stops tenant events reaching the shared
  // operator push topic and what keeps an availability alert out of a panel
  // that may be down.
  // Identity, resolved once from the data rather than left to ~50 emitters to
  // remember. A caller-supplied value still wins.
  const brand = await platformName(db);
  const identity = await tenantIdentity(db, opts.tenantId ?? null);
  const rawEnvelopeVars = normaliseDateVariables({
    tenantName: identity.tenantName,
    contactName: identity.contactName,
    // Every notification happened at a time, and the dispatcher is the one
    // place that reliably knows it. A caller with a more precise instant (the
    // moment a threshold was crossed, not the moment we got around to
    // dispatching) still wins.
    occurredAt: new Date().toISOString(),
    ...opts.variables,
  });

  // No id ever reaches a reader. Done here, once, because an emitter that
  // passes `tenantLabel: tenantId` is not a rare mistake — it is what
  // `admin.email_quota_exceeded` shipped with, and every layer below rendered
  // it faithfully all the way into the operator's inbox.
  const idResolved = await resolveIdVariables(db, rawEnvelopeVars);
  const envelopeVars = idResolved.vars;
  if (idResolved.unresolved.length > 0) {
    dispatchLog().warn(
      { categoryId: opts.categoryId, unresolved: idResolved.unresolved },
      'notification carried ids that no tenant, user, mailbox or domain could name',
    );
  }

  // Object mute: "quiet about THIS one thing until Friday". Checked before any
  // channel work so a muted object costs one indexed lookup, not a fan-out.
  // Mandatory classes are unmutable — createMute refuses them, and this is the
  // second line of defence in case a row predates that rule.
  const muteKey = typeof envelopeVars.objectLabel === 'string' ? envelopeVars.objectLabel : null;
  if (
    muteKey
    && !(categoryMeta(category.id) && CLASS_POLICY[categoryMeta(category.id)!.cls].mandatory)
    && await isObjectMuted(db, category.id, muteKey)
  ) {
    return { eventId, deliveryCount: 0, perChannelStatuses: [] };
  }

  const routed = effectiveChannels({
    categoryId: category.id,
    storedChannels: category.defaultChannels,
    tenantId: opts.tenantId ?? null,
  });
  const routedChannels = routed.channels;
  if (routed.excluded.length > 0 && process.env.NOTIFICATION_ROUTING_DEBUG === 'true') {
    for (const ex of routed.excluded) {
      // eslint-disable-next-line no-console
      console.debug(`[notifications] ${category.id}: excluded ${ex.channel} — ${ex.reason}`);
    }
  }

  if (routedChannels.includes('ntfy')) {
    const ntfySalt = opts.encryptionKey ?? process.env.PLATFORM_ENCRYPTION_KEY;
    if (ntfySalt) {
      try {
        const s = await emitNtfyForEvent(db, {
          eventId,
          category,
          tenantId: opts.tenantId ?? null,
          variables: Object.fromEntries(
            Object.entries({
              platformName: brand,
              userName: 'operator',
              tenantName: null,
              contactName: null,
              occurredAt: null,
              ...envelopeVars,
            }).map(([k, v]) => [k, v === undefined ? null : v]),
          ),
          dedupeKey,
          hashSalt: ntfySalt,
        });
        statuses.push({ userId: null, channel: 'ntfy', status: s.status === 'queued' ? 'queued' : 'skipped', error: s.error });
      } catch (err) {
        statuses.push({ userId: null, channel: 'ntfy', status: 'skipped', error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // 2. Resolve recipients.
  // suppressTenantNotification only neuters the tenant scope because
  // resolveRecipients for kind='tenant' is scoped strictly to that
  // tenant's tenant_admin users (see getTenantNotificationRecipients);
  // admin/system scopes resolve their recipients on a separate code
  // path and are unaffected by this flag.
  const allRecipients = await resolveRecipients(db, opts.scope);
  let recipients = allRecipients;
  // Suppression is about the TENANT, so it must also drop the mailbox-owner
  // leg below — that person is the tenant's, and "do not inform the tenant"
  // that still mails their mailbox owner is not suppression.
  let externalRecipients: readonly string[] = opts.externalRecipients ?? [];
  if (opts.scope.kind === 'tenant' && opts.suppressTenantNotification) {
    recipients = [];
    externalRecipients = [];
  }
  // Bail out only when there is nobody AT ALL. This used to return on an empty
  // USER list, which skipped the external leg entirely — so a mailbox owner,
  // the one audience that exists precisely because it has no platform account,
  // was silently dropped for any tenant with no resolvable admin user.
  if (recipients.length === 0 && externalRecipients.length === 0) {
    return { eventId, deliveryCount: 0, perChannelStatuses: [] };
  }

  // PLATFORM_ENCRYPTION_KEY salts the recipient/content hashes that
  // back the GDPR-compliant delivery audit. Without it the hashes are
  // brute-forceable (an attacker can enumerate known email addresses
  // against the table). Fail loud rather than silently degrade —
  // every supported deployment configures this key for SMTP relay
  // decryption anyway.
  const hashSalt = opts.encryptionKey ?? process.env.PLATFORM_ENCRYPTION_KEY;
  if (!hashSalt) {
    throw new Error('PLATFORM_ENCRYPTION_KEY is required for notification dispatch (hash salt)');
  }
  const isCritical = severityIsCritical(category);
  // Quiet hours are bypassed by CLASS, not just by severity.
  //
  // `security.password_reset` is severity=warning and class=security: a reset
  // link that waits until morning is useless, and an availability alert that
  // waits until morning describes an outage the operator slept through.
  // Severity says how loud; class says whether it can wait. Only class can
  // answer this question.
  const meta = categoryMeta(category.id);
  const classBypassesQuietHours = meta ? CLASS_POLICY[meta.cls].bypassesQuietHours : false;
  const bypassesQuietHours = isCritical || classBypassesQuietHours;

  // 3. For each recipient × channel pair.
  for (const userId of recipients) {
    const userSettings = await getUserSettings(db, userId);
    const locale = opts.localeOverride ?? userSettings.locale ?? 'en';

    // 3-pre. Idempotency check (when caller passed a dedupeKey). A
    // previously-written notifications row with the same key for this
    // user in the last 30 days means we already fired this warning —
    // skip every channel for this recipient.
    if (dedupeKey) {
      const existing = await findDedupedNotification(db, userId, dedupeKey);
      if (existing) {
        for (const channel of routedChannels) {
          statuses.push({ userId, channel, status: 'skipped', error: 'duplicate' });
        }
        continue;
      }
    }

    // Per-recipient render context. Pre-seed every COMMON_VARS key:
    // the renderer compiles in Handlebars STRICT mode, which throws on
    // ABSENT keys (present-but-undefined renders ''). Without this,
    // any template referencing the shared {{platformName}} footer —
    // i.e. every seeded email template — threw TEMPLATE_RENDER_ERROR
    // and the email silently vanished (caught live 2026-06-12 by the
    // SLO-alert E2E: zero email delivery rows cluster-wide).
    // Caller-supplied variables win over the defaults. undefined
    // values are normalised to null: strict mode tolerates both, but
    // undefined keys would be DROPPED by the JSONB round-trip through
    // notification_deliveries.event_variables and the queue worker's
    // re-render would then throw on the absent key.
    const recipientEmail = await getUserEmail(db, userId);
    const recipientName = await userDisplayName(db, userId, recipientEmail ?? null);
    const renderVars: Record<string, unknown> = Object.fromEntries(
      Object.entries({
        platformName: brand,
        userName: recipientName,
        // Operator requirement: address the person. Null collapses the
        // template's `{{#if greeting}}` block rather than rendering "Hi ,".
        greeting: greetingFor(recipientName),
        tenantName: null,
        contactName: null,
        occurredAt: null,
        ...envelopeVars,
      }).map(([k, v]) => [k, v === undefined ? null : v]),
    );

    for (const channel of routedChannels) {
      // ntfy is handled once per EVENT above (topic broadcast, no
      // per-user leg) — skip it here.
      if (channel === 'ntfy') continue;
      // 3a. Preference gate.
      const allowed = await isCategoryAllowedForUser(db, userId, category.id, channel);
      if (!allowed) {
        const contentHash = sha256(`${category.id}::muted`, hashSalt);
        await writeDelivery(db, {
          notificationId: null,
          eventId,
          userId,
          tenantId: opts.tenantId ?? null,
          categoryId: category.id,
          channel,
          templateId: null,
          templateVersion: 0,
          locale,
          status: 'muted',
          recipientHash: null,
          contentHash,
          dedupeKey: dedupeKey,
        });
        statuses.push({ userId, channel, status: 'muted' });
        continue;
      }

      // 3b. Quiet hours. Incident, Availability and Security pass through.
      if (!bypassesQuietHours && isInQuietHours(userSettings)) {
        const contentHash = sha256(`${category.id}::quiet`, hashSalt);
        await writeDelivery(db, {
          notificationId: null,
          eventId,
          userId,
          tenantId: opts.tenantId ?? null,
          categoryId: category.id,
          channel,
          templateId: null,
          templateVersion: 0,
          locale,
          status: 'muted',
          recipientHash: null,
          contentHash,
          dedupeKey: dedupeKey,
        });
        statuses.push({ userId, channel, status: 'muted' });
        continue;
      }

      // 3c. Recipient address check for channels that require one
      // (resolved once per recipient above, also feeds {{userName}}).
      // Doing it BEFORE the rate-limit check means a user with no
      // email doesn't waste their rate-limit budget every time a
      // notification fires for them.
      if (channel === 'email' && !recipientEmail) {
        const contentHash = sha256(`${category.id}::no-recipient`, hashSalt);
        await writeDelivery(db, {
          notificationId: null,
          eventId,
          userId,
          tenantId: opts.tenantId ?? null,
          categoryId: category.id,
          channel,
          templateId: null,
          templateVersion: 0,
          locale,
          status: 'skipped',
          recipientHash: null,
          contentHash,
          dedupeKey: dedupeKey,
          lastError: 'recipient_email_missing',
        });
        statuses.push({ userId, channel, status: 'skipped', error: 'recipient_email_missing' });
        continue;
      }

      // 3d. Rate limit (when category configures one).
      if (category.rateLimitWindowS !== null && category.rateLimitMax !== null) {
        const rl = await consumeRateLimit(db, {
          categoryId: category.id,
          userId,
          windowS: category.rateLimitWindowS,
          max: category.rateLimitMax,
        });
        if (!rl.allowed) {
          const contentHash = sha256(`${category.id}::rate`, hashSalt);
          await writeDelivery(db, {
            notificationId: null,
            eventId,
            userId,
            tenantId: opts.tenantId ?? null,
            categoryId: category.id,
            channel,
            templateId: null,
            templateVersion: 0,
            locale,
            status: 'rate_limited',
            recipientHash: null,
            contentHash,
            dedupeKey: dedupeKey,
          });
          statuses.push({ userId, channel, status: 'rate_limited' });
          continue;
        }
      }

      // 3e. Template lookup. Persist the miss — these used to be
      // status-array-only (dispatchSafe discards the array), which made
      // template/render problems completely invisible. `skipped` (not
      // `failed`) keeps them out of the queue worker's retry scan —
      // re-rendering the same template with the same variables is
      // deterministic, a retry can never succeed.
      const tpl = await getActiveTemplate(db, category.id, channel, locale);
      if (!tpl) {
        const contentHash = sha256(`${category.id}::no-template`, hashSalt);
        await writeDelivery(db, {
          notificationId: null,
          eventId,
          userId,
          tenantId: opts.tenantId ?? null,
          categoryId: category.id,
          channel,
          templateId: null,
          templateVersion: 0,
          locale,
          status: 'skipped',
          recipientHash: null,
          contentHash,
          dedupeKey: dedupeKey,
          lastError: 'template_not_found',
        });
        statuses.push({ userId, channel, status: 'skipped', error: 'template_not_found' });
        continue;
      }

      // 3e. Render. This CANNOT throw and CANNOT skip: a missing variable
      // degrades the message (visible placeholder + degradedVars) and an
      // unrenderable template falls back to the envelope. The previous
      // behaviour — mark `skipped`, raise nothing, retry never — lost 16
      // renewal emails to a single variable-name mismatch.
      const rendered = await renderForDelivery(tpl, renderVars, {
        fallbackTitle: category.displayName,
      });
      if (rendered.degradedVars.length > 0 || rendered.fallbackUsed) {
        recordDegradedRender(category.id, channel, rendered.degradedVars, rendered.fallbackUsed);
      }
      warnOnRenderedIds(category.id, channel, rendered.subject, rendered.body);
      // A thin delivery is still a delivery. `lastError` explains WHY it is
      // thin without demoting the row's status — the message went out, and
      // the Delivery Log needs to say what was lost from it.
      const degradeNote = rendered.fallbackUsed
        ? `render_fallback: ${rendered.fallbackReason ?? 'template unrenderable'}`.slice(0, 1000)
        : rendered.degradedVars.length > 0
          ? `missing_vars: ${clampDegradedVars(rendered.degradedVars).join(', ')}`.slice(0, 1000)
          : undefined;

      // 3g. Hash recipient + content. recipientEmail was resolved in 3c.
      const recipientHash = sha256(channel === 'email' ? (recipientEmail ?? userId) : userId, hashSalt);
      const contentHash = sha256(`${rendered.subject ?? ''}::${rendered.body}`, hashSalt);

      // 3g. in_app channel: insert the notifications row first.
      if (channel === 'in_app') {
        const notificationId = crypto.randomUUID();
        await db.insert(notifications).values({
          id: notificationId,
          userId,
          type: severityToLegacyType(category.defaultSeverity),
          title: (rendered.subject ?? category.displayName).slice(0, 255),
          message: rendered.body.slice(0, 10_000),
          resourceType: opts.tenantId ? 'tenant' : null,
          resourceId: opts.tenantId ?? null,
          categoryId: category.id,
          severity: category.defaultSeverity,
          eventId,
          locale,
          tenantId: opts.tenantId ?? null,
          dedupeKey: dedupeKey ?? null,
        });
        await writeDelivery(db, {
          notificationId,
          eventId,
          userId,
          tenantId: opts.tenantId ?? null,
          categoryId: category.id,
          channel,
          templateId: tpl.id,
          templateVersion: tpl.version,
          locale,
          status: 'sent',
          recipientHash,
          contentHash,
          dedupeKey: dedupeKey,
          degradedVars: rendered.degradedVars,
          lastError: degradeNote,
        });
        statuses.push({ userId, channel, status: 'sent', notificationId });
        continue;
      }

      // 3h-pre. Digest: hold this back instead of sending it now.
      //
      // `digest_mode` has been a stored, API-exposed, UI-rendered preference
      // that NOTHING read — a user could select "daily" and keep receiving
      // every email immediately. Only digestible classes qualify; Incident,
      // Availability and Security are never delayed, because a digest IS a
      // delay and those are the classes that cannot absorb one.
      //
      // The in-app row above is unaffected: batching a panel notification
      // helps nobody, since the panel is already a list read on demand.
      const digestMode = (userSettings.digestMode ?? 'immediate') as DigestMode;
      if (isDigestible(category.id, digestMode)) {
        await queueForDigest(db, {
          userId,
          categoryId: category.id,
          subject: rendered.subject ?? category.displayName,
          body: rendered.body,
        });
        statuses.push({ userId, channel, status: 'queued' });
        continue;
      }

      // 3h. email channel — Phase 2 async path.
      // Write the delivery row with status='queued' + event variables
      // (so the worker can re-render); enqueue the pg-boss job; return.
      // The actual SMTP send happens in queue/worker.ts which also owns
      // retry / DLQ transitions.
      const queuedDeliveryId = await writeDelivery(db, {
        notificationId: null,
        eventId,
        userId,
        tenantId: opts.tenantId ?? null,
        categoryId: category.id,
        channel,
        templateId: tpl.id,
        templateVersion: tpl.version,
        locale,
        status: 'queued',
        recipientHash,
        contentHash,
        dedupeKey: dedupeKey,
        degradedVars: rendered.degradedVars,
        lastError: degradeNote,
        // Persist the MERGED variables (defaults + caller) — the queue
        // worker re-renders from this column at send time and must see
        // the exact context the dispatcher validated here.
        eventVariables: renderVars,
      });

      try {
        // Best-effort enqueue. If pg-boss isn't started yet (e.g. unit
        // tests) the row stays queued and the periodic re-enqueue scan
        // picks it up. Failures here MUST NOT abort the dispatch loop.
        await enqueueDelivery(queuedDeliveryId);
        statuses.push({ userId, channel, status: 'queued' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        statuses.push({ userId, channel, status: 'queued', error: `enqueue_warn:${msg}` });
      }
    }
  }

  // 5. External recipients — an audience with no platform account.
  //
  // Queued through the SAME delivery table and worker as everyone else, so
  // provider resolution, credential decryption, retry, DLQ and the audit trail
  // are reused rather than reimplemented. A fourth delivery path is what this
  // overhaul removes, not something it adds.
  const externalLocale = opts.localeOverride ?? 'en';
  for (const address of externalRecipients) {
    const tpl = await getActiveTemplate(db, category.id, 'email', externalLocale);
    if (!tpl) {
      statuses.push({ userId: null, channel: 'email', status: 'skipped', error: 'template_not_found' });
      continue;
    }
    const renderVars: Record<string, unknown> = Object.fromEntries(
      Object.entries({
        platformName: brand,
        userName: address.split('@')[0],
        // Deliberately absent: a mailbox owner has no platform account, so the
        // only "name" available is the local part, and "Hi bookings," reads as
        // a broken mail merge. The operator's exception, implemented.
        greeting: null,
        tenantName: null,
        contactName: null,
        occurredAt: null,
        ...envelopeVars,
      }).map(([k, v]) => [k, v === undefined ? null : v]),
    );
    const rendered = await renderForDelivery(tpl, renderVars, { fallbackTitle: category.displayName });
    if (rendered.degradedVars.length > 0 || rendered.fallbackUsed) {
      recordDegradedRender(category.id, 'email', rendered.degradedVars, rendered.fallbackUsed);
    }
    warnOnRenderedIds(category.id, 'email', rendered.subject, rendered.body);
    const deliveryId = await writeDelivery(db, {
      notificationId: null,
      eventId,
      userId: null,
      recipientAddress: address,
      tenantId: opts.tenantId ?? null,
      categoryId: category.id,
      channel: 'email',
      templateId: tpl.id,
      templateVersion: tpl.version,
      locale: externalLocale,
      status: 'queued',
      recipientHash: sha256(address, hashSalt),
      contentHash: sha256(`${rendered.subject ?? ''}::${rendered.body}`, hashSalt),
      dedupeKey,
      degradedVars: rendered.degradedVars,
      eventVariables: renderVars,
    });
    try {
      await enqueueDelivery(deliveryId);
      statuses.push({ userId: null, channel: 'email', status: 'queued' });
    } catch (err) {
      statuses.push({ userId: null, channel: 'email', status: 'queued', error: `enqueue_warn:${err instanceof Error ? err.message : String(err)}` });
    }
  }

  return {
    eventId,
    deliveryCount: statuses.filter((s) => s.status === 'sent').length,
    perChannelStatuses: statuses,
  };
}

function severityToLegacyType(sev: NotificationCategoryResponse['defaultSeverity']): 'info' | 'warning' | 'error' | 'success' {
  switch (sev) {
    case 'info': return 'info';
    case 'warning': return 'warning';
    case 'error':
    case 'critical': return 'error';
  }
}
