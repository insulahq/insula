/**
 * Email notification channel — wraps the existing `sendNotificationEmail`
 * implementation in the channel interface so the registry can iterate
 * it the same way as in-app and future channels.
 *
 * Behaviour parity with the pre-channel code path is critical here:
 * the email-sender's existing logic (default SMTP relay lookup, password
 * decryption, HTML formatting) is preserved verbatim. This channel only
 * adds the availability gate and the typed DeliveryResult.
 *
 * Roadmap (docs/history/04-deployment/NOTIFICATION_ROADMAP.md, phases 2-3 (delivered)):
 *  - Phase 2: replace fire-and-forget with `notification_deliveries`
 *    audit + retry reconciler
 *  - Phase 3: consult per-user preferences before deliver() is called
 *    (preference filtering happens in the service layer, not here)
 */

import { sendNotificationEmail } from '../email-sender.js';
import { getActiveTemplate } from '../templates/service.js';
import { renderTemplateAsync } from '../templates/renderer.js';
import type { NotificationChannel, DeliveryContext, DeliveryResult } from './types.js';

interface NotificationRowWithCategory {
  readonly categoryId?: string | null;
  readonly locale?: string | null;
}

export const emailChannel: NotificationChannel = {
  id: 'email',
  /**
   * The encryption key (used to decrypt the SMTP relay's auth password)
   * is the only hard requirement for email delivery. Without it the
   * existing email-sender silently no-ops; making availability explicit
   * here lets the registry skip the channel cleanly.
   *
   * Reads `process.env.PLATFORM_ENCRYPTION_KEY` directly (the established
   * convention in this codebase — see service.ts pre-refactor and
   * app.ts startDkimScheduler). Tests override via the
   * `encryptionKey` field on DeliveryContext so isAvailable() can
   * return true regardless of process env.
   */
  isAvailable(): boolean {
    return Boolean(process.env.PLATFORM_ENCRYPTION_KEY);
  },
  async deliver(ctx: DeliveryContext): Promise<DeliveryResult> {
    const key = ctx.encryptionKey ?? process.env.PLATFORM_ENCRYPTION_KEY;
    if (!key) {
      return { status: 'skipped', reason: 'PLATFORM_ENCRYPTION_KEY not set' };
    }
    try {
      // Category-driven rendering: if the notification row carries a
      // category id, look up the active template and render it. Falls
      // back to the legacy inline-HTML path when no category is set
      // (existing notifyUser/notifyUsers call-sites).
      const cat = (ctx.notification as unknown as NotificationRowWithCategory).categoryId;
      const locale = (ctx.notification as unknown as NotificationRowWithCategory).locale ?? 'en';
      let prerendered: { subject: string; html: string } | undefined;
      if (cat) {
        const tpl = await getActiveTemplate(ctx.db, cat, 'email', locale);
        if (tpl) {
          const rendered = await renderTemplateAsync(tpl, {
            userName: ctx.notification.userId,
            title: ctx.notification.title,
            message: ctx.notification.message,
            platformName: 'Hosting Platform',
          });
          prerendered = {
            subject: rendered.subject ?? ctx.notification.title,
            html: rendered.body,
          };
        }
      }
      // sendNotificationEmail itself already silently catches and logs;
      // we wrap it again so any rejection path becomes a typed result
      // rather than an unhandled rejection at the registry level.
      await sendNotificationEmail(ctx.db, ctx.notification, key, prerendered);
      return { status: 'delivered' };
    } catch (err) {
      return {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
