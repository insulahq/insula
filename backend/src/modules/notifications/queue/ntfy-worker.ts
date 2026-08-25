/**
 * pg-boss worker for `notifications.send-ntfy` — publishes broadcast
 * deliveries (userId NULL, channel 'ntfy') to the provider's topic.
 *
 * The dispatcher pre-renders title/message into
 * `event_variables.__ntfy`, so this worker does NO template work: load
 * row → load provider → decrypt secret → publish → mark sent/failed.
 * Retry/backoff mirrors the email worker (decideRetry + re-enqueue);
 * PERMANENT publish errors (401/403/404/400 — bad token, missing
 * topic ACL) go straight to DLQ: retrying a bad credential only spams
 * the log.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../../../db/index.js';
import { notificationDeliveries, notificationProviders } from '../../../db/schema.js';
import { decrypt } from '../../oidc/crypto.js';
import { publishNtfy, NtfyPublishError, type NtfyProviderConfig } from '../ntfy/publisher.js';
import { NOTIFICATIONS_NTFY_QUEUE, type NotificationSendJob } from './types.js';
import { getBoss, type BossLike } from './bootstrap.js';
import { decideRetry } from './retry.js';
import { enqueueNtfyDelivery } from './enqueue.js';
import { NTFY_DEFAULT_SERVER_URL, type NotificationSeverity } from '@insula/api-contracts';

export interface NtfyWorkerOptions {
  readonly db: Database;
  readonly boss?: BossLike;
  /** Injection seam for tests. */
  readonly publish?: typeof publishNtfy;
  readonly encryptionKey?: string;
}

interface NtfyPayload {
  title: string;
  message: string;
  severity: NotificationSeverity;
  clickUrl?: string | null;
  tags?: string[];
}

export async function processNtfyDelivery(
  deliveryId: string,
  opts: NtfyWorkerOptions,
): Promise<{ status: 'sent' | 'failed' | 'dlq' | 'skipped'; error?: string }> {
  const { db } = opts;
  const [row] = await db.select({
    id: notificationDeliveries.id,
    channel: notificationDeliveries.channel,
    status: notificationDeliveries.status,
    attempt: notificationDeliveries.attempt,
    providerId: notificationDeliveries.providerId,
    eventVariables: notificationDeliveries.eventVariables,
  })
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.id, deliveryId))
    .limit(1);

  if (!row) return { status: 'skipped', error: 'delivery_not_found' };
  if (row.status !== 'queued' && row.status !== 'failed') {
    return { status: 'skipped', error: `terminal_status:${row.status}` };
  }
  if (row.channel !== 'ntfy') return { status: 'skipped', error: 'channel_not_ntfy' };

  const payload = (row.eventVariables as { __ntfy?: NtfyPayload } | null)?.__ntfy;
  if (!payload?.title || !payload.message) {
    return await fail(db, row.id, row.attempt + 1, 'ntfy_payload_missing', opts, true);
  }
  if (!row.providerId) {
    return await fail(db, row.id, row.attempt + 1, 'provider_id_missing', opts, true);
  }

  const [provider] = await db.select()
    .from(notificationProviders)
    .where(eq(notificationProviders.id, row.providerId))
    .limit(1);
  if (!provider || !provider.enabled) {
    return await fail(db, row.id, row.attempt + 1, provider ? 'provider_disabled' : 'provider_not_found', opts, true);
  }
  if (!provider.ntfyTopic) {
    return await fail(db, row.id, row.attempt + 1, 'provider_topic_missing', opts, true);
  }

  const encryptionKey = opts.encryptionKey ?? process.env.PLATFORM_ENCRYPTION_KEY;
  const authMethod = (provider.ntfyAuthMethod ?? 'none') as NtfyProviderConfig['authMethod'];
  let token: string | null = null;
  let password: string | null = null;
  try {
    if (authMethod === 'token' && provider.ntfyTokenEncrypted && encryptionKey) {
      token = decrypt(provider.ntfyTokenEncrypted, encryptionKey);
    }
    if (authMethod === 'basic' && provider.authPasswordEncrypted && encryptionKey) {
      password = decrypt(provider.authPasswordEncrypted, encryptionKey);
    }
  } catch {
    return await fail(db, row.id, row.attempt + 1, 'credential_decrypt_failed', opts, true);
  }

  await db.update(notificationDeliveries)
    .set({ status: 'sending' })
    .where(eq(notificationDeliveries.id, deliveryId));

  const cfg: NtfyProviderConfig = {
    serverUrl: provider.ntfyServerUrl ?? NTFY_DEFAULT_SERVER_URL,
    topic: provider.ntfyTopic,
    authMethod,
    token,
    username: provider.authUsername,
    password,
  };

  try {
    const publish = opts.publish ?? publishNtfy;
    const { messageId } = await publish(cfg, {
      title: payload.title,
      message: payload.message,
      severity: payload.severity,
      clickUrl: payload.clickUrl ?? null,
      tags: payload.tags ?? [],
    });
    await db.update(notificationDeliveries)
      .set({ status: 'sent', sentAt: new Date(), providerMessageId: messageId, lastError: null })
      .where(eq(notificationDeliveries.id, deliveryId));
    return { status: 'sent' };
  } catch (err) {
    const permanent = err instanceof NtfyPublishError && err.permanent;
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    return await fail(db, row.id, row.attempt + 1, reason, opts, permanent);
  }
}

async function fail(
  db: Database,
  deliveryId: string,
  newAttempt: number,
  reason: string,
  opts: NtfyWorkerOptions,
  permanent: boolean,
): Promise<{ status: 'failed' | 'dlq'; error: string }> {
  const decision = permanent
    ? { status: 'dlq' as const, nextAttemptAt: null }
    : decideRetry(newAttempt);
  const update: Record<string, unknown> = {
    status: decision.status,
    attempt: newAttempt,
    lastError: reason,
    nextAttemptAt: decision.nextAttemptAt,
  };
  if (decision.status === 'dlq') update.failedAt = new Date();
  await db.update(notificationDeliveries)
    .set(update)
    .where(eq(notificationDeliveries.id, deliveryId));

  if (decision.status === 'failed' && decision.nextAttemptAt) {
    try {
      await enqueueNtfyDelivery(
        deliveryId,
        { startAfter: decision.nextAttemptAt, singletonKey: `delivery:${deliveryId}:retry:${newAttempt}` },
        opts.boss,
      );
    } catch {
      // Retry scheduling failed (pg-boss hiccup) — the re-enqueue scan
      // picks up status='failed' rows past next_attempt_at.
    }
  }
  return { status: decision.status, error: reason };
}

/** Register the ntfy worker. Call once at app startup (after getBoss). */
export async function startNtfyWorker(opts: NtfyWorkerOptions): Promise<void> {
  const boss = opts.boss ?? await getBoss();
  await boss.work<NotificationSendJob>(
    NOTIFICATIONS_NTFY_QUEUE,
    { teamSize: 2, teamConcurrency: 2, batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) {
        // eslint-disable-next-line no-await-in-loop
        await processNtfyDelivery(job.data.deliveryId, opts);
      }
    },
  );
}
