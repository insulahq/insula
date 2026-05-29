/**
 * Notification dispatcher — the new entry point for categorised events.
 *
 * Flow:
 *   1. Look up the category. Unknown → no-op (event silently dropped).
 *   2. Resolve recipients via `resolveRecipients`.
 *   3. If scope='tenant' + opts.suppressTenantNotification, skip tenant users.
 *   4. For each (recipient × channel) in category.defaultChannels:
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
} from '../../../db/schema.js';
import { resolveRecipients, type RecipientScope } from '../recipients.js';
import { getCategory } from '../categories/service.js';
import { getActiveTemplate } from '../templates/service.js';
import { renderTemplateAsync } from '../templates/renderer.js';
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

type Channel = 'in_app' | 'email';

export interface EmitEventOptions {
  readonly categoryId: string;
  readonly scope: RecipientScope;
  readonly variables: Record<string, unknown>;
  readonly tenantId?: string | null;
  readonly suppressTenantNotification?: boolean;
  readonly eventId?: string;
  /** Override locale for the template lookup (rare). */
  readonly localeOverride?: string;
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
  readonly userId: string;
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

async function writeDelivery(
  db: Database,
  input: {
    notificationId: string | null;
    eventId: string;
    userId: string;
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
    providerMessageId?: string;
    sentAt?: Date | null;
    eventVariables?: Record<string, unknown>;
    dedupeKey?: string;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(notificationDeliveries).values({
    id,
    notificationId: input.notificationId,
    eventId: input.eventId,
    userId: input.userId,
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
export async function emitEvent(db: Database, opts: EmitEventOptions): Promise<EmitResult> {
  const eventId = opts.eventId ?? crypto.randomUUID();
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

  // 2. Resolve recipients.
  // suppressTenantNotification only neuters the tenant scope because
  // resolveRecipients for kind='tenant' is scoped strictly to that
  // tenant's tenant_admin users (see getTenantNotificationRecipients);
  // admin/system scopes resolve their recipients on a separate code
  // path and are unaffected by this flag.
  const allRecipients = await resolveRecipients(db, opts.scope);
  let recipients = allRecipients;
  if (opts.scope.kind === 'tenant' && opts.suppressTenantNotification) {
    recipients = [];
  }
  if (recipients.length === 0) {
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

  // 3. For each recipient × channel pair.
  for (const userId of recipients) {
    const userSettings = await getUserSettings(db, userId);
    const locale = opts.localeOverride ?? userSettings.locale ?? 'en';

    // 3-pre. Idempotency check (when caller passed a dedupeKey). A
    // previously-written notifications row with the same key for this
    // user in the last 30 days means we already fired this warning —
    // skip every channel for this recipient.
    if (opts.dedupeKey) {
      const existing = await findDedupedNotification(db, userId, opts.dedupeKey);
      if (existing) {
        for (const channel of category.defaultChannels) {
          statuses.push({ userId, channel, status: 'skipped', error: 'duplicate' });
        }
        continue;
      }
    }

    for (const channel of category.defaultChannels) {
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
          dedupeKey: opts.dedupeKey,
        });
        statuses.push({ userId, channel, status: 'muted' });
        continue;
      }

      // 3b. Quiet hours (critical bypasses).
      if (!isCritical && isInQuietHours(userSettings)) {
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
          dedupeKey: opts.dedupeKey,
        });
        statuses.push({ userId, channel, status: 'muted' });
        continue;
      }

      // 3c. Resolve recipient address up-front for channels that
      // require one. Doing it BEFORE the rate-limit check means a
      // user with no email doesn't waste their rate-limit budget
      // every time a notification fires for them.
      const recipientEmail = channel === 'email' ? await getUserEmail(db, userId) : null;
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
          dedupeKey: opts.dedupeKey,
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
            dedupeKey: opts.dedupeKey,
          });
          statuses.push({ userId, channel, status: 'rate_limited' });
          continue;
        }
      }

      // 3e. Template lookup.
      const tpl = await getActiveTemplate(db, category.id, channel, locale);
      if (!tpl) {
        statuses.push({ userId, channel, status: 'skipped', error: 'template_not_found' });
        continue;
      }

      // 3e. Render.
      let rendered;
      try {
        rendered = await renderTemplateAsync(tpl, opts.variables);
      } catch (err) {
        statuses.push({
          userId,
          channel,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

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
          dedupeKey: opts.dedupeKey ?? null,
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
          dedupeKey: opts.dedupeKey,
        });
        statuses.push({ userId, channel, status: 'sent', notificationId });
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
        dedupeKey: opts.dedupeKey,
        eventVariables: opts.variables,
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
