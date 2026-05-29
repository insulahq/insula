/**
 * Email send worker.
 *
 * Triggered by pg-boss when a `notifications.send-email` job arrives.
 * The job payload is just `{ deliveryId }` — everything else lives on
 * the `notification_deliveries` row.
 *
 * Lifecycle for a single delivery:
 *
 *   queued                                       (written by dispatcher)
 *     │ worker claims via pg-boss
 *     ▼
 *   sending                                      (status update before SMTP)
 *     │
 *     ├── success ──► sent      (sentAt = now)
 *     │
 *     └── failure ──┬── attempt < maxAttempts ──► failed
 *                   │     re-enqueue with startAfter = nextAttemptAt
 *                   │
 *                   └── attempt >= maxAttempts ──► dlq  (no re-enqueue)
 *
 * Idempotency: if the worker is invoked for a delivery whose status is
 * not `queued` / `failed`, it no-ops (a duplicate job or a manual retry
 * already advanced the row).
 *
 * The worker re-renders from the stored `eventVariables` + the
 * (category, channel, locale)-keyed template — same path the dispatcher
 * uses synchronously for in_app. This decouples the queued payload
 * from the rendered output (no PII in the queue).
 */
import { eq } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import { notificationCategories, notificationDeliveries, users } from '../../../db/schema.js';
import { renderTemplateAsync } from '../templates/renderer.js';
import { getTemplate } from '../templates/service.js';
import { getProviderForCategoryEmail } from '../providers/service.js';
import { decrypt } from '../../oidc/crypto.js';
import { decideRetry } from './retry.js';
import { enqueueDelivery } from './enqueue.js';
import { getBoss, type BossLike } from './bootstrap.js';
import { NOTIFICATIONS_EMAIL_QUEUE, type NotificationSendJob } from './types.js';
import type { Database } from '../../../db/index.js';

/**
 * Worker SMTP send shape — test-injectable so the unit tests don't open
 * actual SMTP connections.
 */
export interface ProviderSendInput {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly authUsername: string | null;
  readonly authPassword: string | null;
  readonly fromAddress: string;
  readonly fromName: string | null;
  readonly to: string;
  readonly subject: string;
  readonly html: string;
}

export type WorkerSendFn = (input: ProviderSendInput) => Promise<void>;

const defaultSend: WorkerSendFn = async (input) => {
  const transport = nodemailer.createTransport({
    host: input.host,
    port: input.port,
    secure: input.secure,
    auth: input.authUsername ? { user: input.authUsername, pass: input.authPassword ?? '' } : undefined,
  });
  const fromHeader = input.fromName ? `"${input.fromName}" <${input.fromAddress}>` : input.fromAddress;
  await transport.sendMail({ from: fromHeader, to: input.to, subject: input.subject, html: input.html });
};

export interface WorkerOptions {
  readonly db: Database;
  readonly encryptionKey?: string;
  /** Override the renderer for tests. */
  readonly render?: typeof renderTemplateAsync;
  /** Override the sender for tests. */
  readonly send?: WorkerSendFn;
  /** Override the boss for tests. */
  readonly boss?: BossLike;
}

interface DeliveryRow {
  id: string;
  userId: string | null;
  categoryId: string;
  channel: 'in_app' | 'email';
  templateId: string | null;
  locale: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  eventVariables: Record<string, unknown> | null;
}

/**
 * Process a single delivery job. Exported so the integration harness
 * can drive it directly without going through pg-boss.
 */
export async function processDelivery(
  deliveryId: string,
  opts: WorkerOptions,
): Promise<{ status: 'sent' | 'failed' | 'dlq' | 'skipped'; error?: string }> {
  const { db } = opts;

  // 1. Claim — load + verify status. Idempotent: skip if not queued/failed.
  // Drizzle's row inference returns string | null for the enum-typed
  // `channel` column, but at the SQL layer the only legal values are
  // 'in_app' | 'email' (channel_id_enum). We narrow with a runtime
  // check below rather than an unsafe cast.
  const rows = await db.select({
    id: notificationDeliveries.id,
    userId: notificationDeliveries.userId,
    categoryId: notificationDeliveries.categoryId,
    channel: notificationDeliveries.channel,
    templateId: notificationDeliveries.templateId,
    locale: notificationDeliveries.locale,
    status: notificationDeliveries.status,
    attempt: notificationDeliveries.attempt,
    maxAttempts: notificationDeliveries.maxAttempts,
    eventVariables: notificationDeliveries.eventVariables,
  })
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.id, deliveryId))
    .limit(1);
  const raw = rows[0];
  const row: DeliveryRow | undefined = raw == null ? undefined : {
    id: raw.id,
    userId: raw.userId,
    categoryId: raw.categoryId,
    channel: raw.channel === 'email' ? 'email' : 'in_app',
    templateId: raw.templateId,
    locale: raw.locale,
    status: raw.status,
    attempt: raw.attempt,
    maxAttempts: raw.maxAttempts,
    eventVariables: raw.eventVariables ?? null,
  };

  if (!row) {
    return { status: 'skipped', error: 'delivery_not_found' };
  }
  if (row.status !== 'queued' && row.status !== 'failed') {
    return { status: 'skipped', error: `terminal_status:${row.status}` };
  }
  if (row.channel !== 'email') {
    return { status: 'skipped', error: 'channel_not_email' };
  }
  if (!row.templateId) {
    return { status: 'skipped', error: 'template_id_missing' };
  }

  // 2. Mark sending.
  await db.update(notificationDeliveries)
    .set({ status: 'sending' })
    .where(eq(notificationDeliveries.id, deliveryId));

  // 3. Re-render template.
  try {
    let tpl;
    try {
      tpl = await getTemplate(db, row.templateId);
    } catch {
      return await markFailedOrDlq(db, row.id, row.attempt + 1, 'template_not_found', opts);
    }
    if (!tpl) {
      return await markFailedOrDlq(db, row.id, row.attempt + 1, 'template_not_found', opts);
    }
    const render = opts.render ?? renderTemplateAsync;
    const rendered = await render(tpl, row.eventVariables ?? {});

    // 4. Look up recipient email.
    if (!row.userId) {
      return await markFailedOrDlq(db, row.id, row.attempt + 1, 'user_id_missing', opts);
    }
    const [u] = await db.select({ email: users.email })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);
    if (!u?.email) {
      return await markFailedOrDlq(db, row.id, row.attempt + 1, 'recipient_email_missing', opts);
    }

    // 5. Look up the notification provider for this category. Phase 5
    //    introduces a per-source override (notification_categories
    //    .email_provider_id). If the override is set but disabled the
    //    function returns null and we surface a distinct error reason
    //    so the operator can see the override is the blocker (security
    //    review 2026-05-29 MEDIUM-2: do NOT silently fall through).
    const provider = await getProviderForCategoryEmail(db, row.categoryId);
    if (!provider) {
      // We need to distinguish "no default" vs "override disabled".
      // Query the category to see if an override is set; that's the
      // signal the operator routed this elsewhere.
      const [cat] = await db.select({
        emailProviderId: notificationCategories.emailProviderId,
      })
        .from(notificationCategories)
        .where(eq(notificationCategories.id, row.categoryId))
        .limit(1);
      const reason = cat?.emailProviderId
        ? 'override_provider_unavailable'
        : 'no_default_notification_provider';
      return await markFailedOrDlq(db, row.id, row.attempt + 1, reason, opts);
    }
    if (!provider.smtpHost) {
      return await markFailedOrDlq(db, row.id, row.attempt + 1, 'provider_smtp_host_missing', opts);
    }

    // 6. Decrypt provider auth password (when set).
    const encryptionKey = opts.encryptionKey ?? process.env.PLATFORM_ENCRYPTION_KEY;
    if (!encryptionKey) {
      return await markFailedOrDlq(db, row.id, row.attempt + 1, 'platform_encryption_key_missing', opts);
    }
    let authPassword: string | null = null;
    if (provider.authPasswordEncrypted) {
      try {
        authPassword = decrypt(provider.authPasswordEncrypted, encryptionKey);
      } catch {
        return await markFailedOrDlq(db, row.id, row.attempt + 1, 'provider_password_decrypt_failed', opts);
      }
    }

    // 7. Send.
    const sender = opts.send ?? defaultSend;
    await sender({
      host: provider.smtpHost,
      port: provider.smtpPort,
      secure: provider.smtpSecure,
      authUsername: provider.authUsername ?? null,
      authPassword,
      fromAddress: provider.fromAddress,
      fromName: provider.fromName ?? null,
      to: u.email,
      subject: rendered.subject ?? '',
      html: rendered.body,
    });

    // 7. Success.
    await db.update(notificationDeliveries)
      .set({ status: 'sent', sentAt: new Date(), attempt: row.attempt + 1 })
      .where(eq(notificationDeliveries.id, deliveryId));
    return { status: 'sent' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return await markFailedOrDlq(db, row.id, row.attempt + 1, msg, opts);
  }
}

async function markFailedOrDlq(
  db: Database,
  deliveryId: string,
  newAttempt: number,
  reason: string,
  opts: WorkerOptions,
): Promise<{ status: 'failed' | 'dlq'; error: string }> {
  const decision = decideRetry(newAttempt);
  const update: Record<string, unknown> = {
    status: decision.status,
    attempt: newAttempt,
    lastError: reason,
    nextAttemptAt: decision.nextAttemptAt,
  };
  if (decision.status === 'dlq') {
    update.failedAt = new Date();
  }
  await db.update(notificationDeliveries)
    .set(update)
    .where(eq(notificationDeliveries.id, deliveryId));

  if (decision.status === 'failed' && decision.nextAttemptAt) {
    // Re-enqueue with startAfter so the worker picks it up after the
    // backoff window. singletonKey dedupes against a concurrent
    // retry-scheduler scan.
    await enqueueDelivery(
      deliveryId,
      { startAfter: decision.nextAttemptAt, singletonKey: `delivery:${deliveryId}:retry:${newAttempt}` },
      opts.boss,
    );
  }
  return { status: decision.status, error: reason };
}

/**
 * Register the pg-boss worker that consumes
 * `notifications.send-email` jobs. Call once at app startup.
 */
export async function startEmailWorker(opts: WorkerOptions): Promise<void> {
  const boss = opts.boss ?? await getBoss();
  await boss.work<NotificationSendJob>(
    NOTIFICATIONS_EMAIL_QUEUE,
    { teamSize: 4, teamConcurrency: 4, batchSize: 1 },
    async (jobs) => {
      // pg-boss can hand us a batch; process serially for predictability.
      for (const job of jobs) {
        // eslint-disable-next-line no-await-in-loop
        await processDelivery(job.data.deliveryId, opts);
      }
    },
  );
}
