/**
 * ntfy leg of the dispatcher — a TOPIC BROADCAST, deliberately different
 * from the per-recipient in_app/email legs:
 *
 *   - fires ONCE PER EVENT when the category's defaultChannels include
 *     'ntfy' and a platform-scope default ntfy provider is enabled;
 *   - NOT gated by per-user preferences (an ntfy topic has no user —
 *     it's an operator integration, like a webhook);
 *   - renders the category's OWN `ntfy` template (locale 'en'), so the
 *     push text is editable, previewable, versioned and restorable in
 *     Settings → Notifications → Templates like every other channel's;
 *   - reuses the notification_deliveries queue machinery (userId NULL)
 *     so sends are async, retried, and visible in the delivery log.
 */
import crypto from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '../../../db/index.js';
import {
  notificationDeliveries,
  notificationProviders,
  systemSettings,
} from '../../../db/schema.js';
import type { NotificationCategoryResponse } from '@insula/api-contracts';
import { getActiveTemplate } from '../templates/service.js';
import { renderTemplateAsync } from '../templates/renderer.js';
import { notificationActionPath } from '../action-path.js';
import { enqueueNtfyDelivery } from '../queue/enqueue.js';

const DEDUPE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface NtfyEmitInput {
  readonly eventId: string;
  readonly category: NotificationCategoryResponse;
  readonly tenantId: string | null;
  readonly variables: Record<string, unknown>;
  readonly dedupeKey: string | undefined;
  readonly hashSalt: string;
}

export interface NtfyEmitStatus {
  readonly status: 'queued' | 'skipped';
  readonly error?: string;
}

function sha256(value: string, salt: string): string {
  return crypto.createHash('sha256').update(`${salt}::${value}`).digest('hex');
}

/** The enabled platform-default ntfy provider, or null. */
export async function getDefaultNtfyProvider(db: Database) {
  const [row] = await db
    .select()
    .from(notificationProviders)
    .where(and(
      eq(notificationProviders.channel, 'ntfy'),
      eq(notificationProviders.scope, 'platform'),
      eq(notificationProviders.isDefault, true),
      eq(notificationProviders.enabled, true),
    ))
    .limit(1);
  return row ?? null;
}

export async function emitNtfyForEvent(db: Database, input: NtfyEmitInput): Promise<NtfyEmitStatus> {
  const { category } = input;

  const provider = await getDefaultNtfyProvider(db);
  if (!provider) return { status: 'skipped', error: 'no_ntfy_provider' };

  // Per-EVENT dedupe: one ntfy delivery row per dedupeKey in the window
  // (userId IS NULL scopes the check to broadcast rows).
  if (input.dedupeKey) {
    const [dupe] = await db
      .select({ id: notificationDeliveries.id })
      .from(notificationDeliveries)
      .where(and(
        eq(notificationDeliveries.channel, 'ntfy'),
        eq(notificationDeliveries.dedupeKey, input.dedupeKey),
        isNull(notificationDeliveries.userId),
        gt(notificationDeliveries.queuedAt, new Date(Date.now() - DEDUPE_WINDOW_MS)),
      ))
      .limit(1);
    if (dupe) return { status: 'skipped', error: 'duplicate' };
  }

  // The category's own ntfy template. The in_app fallback covers the gap
  // between an upgrade landing and the boot seed pass inserting the new
  // ntfy rows (app.ts runs seedTemplatesIfMissing at startup, so in
  // practice this is only reachable if an operator deactivated the row).
  const tpl = await getActiveTemplate(db, category.id, 'ntfy', 'en')
    ?? await getActiveTemplate(db, category.id, 'in_app', 'en');
  if (!tpl) return { status: 'skipped', error: 'no_template' };
  let rendered: { subject?: string | null; body: string };
  try {
    rendered = await renderTemplateAsync(tpl, input.variables);
  } catch (err) {
    return { status: 'skipped', error: `render_failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Click-through: admin panel base URL + the same actionPath the bell
  // notification navigates to.
  const [settings] = await db
    .select({ adminPanelUrl: systemSettings.adminPanelUrl })
    .from(systemSettings)
    .limit(1);
  const actionPath = notificationActionPath({
    categoryId: category.id,
    resourceType: input.tenantId ? 'tenant' : null,
    resourceId: input.tenantId,
  });
  const clickUrl = settings?.adminPanelUrl && actionPath
    ? `${settings.adminPanelUrl.replace(/\/+$/, '')}${actionPath}`
    : null;

  const title = (rendered.subject ?? category.displayName).slice(0, 255);
  const message = rendered.body.slice(0, 4000);

  const deliveryId = crypto.randomUUID();
  await db.insert(notificationDeliveries).values({
    id: deliveryId,
    notificationId: null,
    eventId: input.eventId,
    userId: null,
    tenantId: input.tenantId,
    categoryId: category.id,
    channel: 'ntfy',
    providerId: provider.id,
    templateId: tpl.id,
    templateVersion: tpl.version,
    locale: 'en',
    status: 'queued',
    recipientHash: sha256(`ntfy:${provider.ntfyTopic ?? ''}`, input.hashSalt),
    contentHash: sha256(`${title}::${message}`, input.hashSalt),
    dedupeKey: input.dedupeKey ?? null,
    // Pre-rendered payload — the worker publishes without re-rendering
    // (double-underscore keys keep clear of Handlebars domain vars).
    eventVariables: {
      __ntfy: {
        title,
        message,
        severity: category.defaultSeverity,
        clickUrl,
        tags: [category.id.slice(0, 24)],
      },
    },
  });
  try {
    await enqueueNtfyDelivery(deliveryId);
  } catch {
    // pg-boss briefly unavailable: the row is written as status='queued'
    // and the 5-minute re-enqueue scan sweeps BOTH async channels — the
    // publish is delayed, not lost. Still report queued.
  }
  return { status: 'queued' };
}
