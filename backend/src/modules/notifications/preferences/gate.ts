/**
 * Per-recipient delivery gate.
 *
 * The dispatcher calls `isCategoryAllowedForUser(db, userId, categoryId, channel)`
 * once per (recipient × channel) tuple. Returns false → dispatcher
 * writes a `notification_deliveries` row with status='muted' and skips.
 *
 * Order of precedence:
 *   1. Category not found / inactive   → false
 *   2. Category mandatory + channel in (in_app, email) → true (no opt-out)
 *   3. User has explicit row in user_notification_preferences → that value
 *   4. Else → category.defaultChannels includes the channel ? true : false
 */
import { and, eq } from 'drizzle-orm';
import {
  notificationCategories,
  userNotificationPreferences,
} from '../../../db/schema.js';
import type { Database } from '../../../db/index.js';

type Channel = 'in_app' | 'email';

export async function isCategoryAllowedForUser(
  db: Database,
  userId: string,
  categoryId: string,
  channel: Channel,
): Promise<boolean> {
  const [cat] = await db
    .select({
      id: notificationCategories.id,
      defaultChannels: notificationCategories.defaultChannels,
      isMandatory: notificationCategories.isMandatory,
      isActive: notificationCategories.isActive,
    })
    .from(notificationCategories)
    .where(eq(notificationCategories.id, categoryId))
    .limit(1);
  if (!cat || !cat.isActive) return false;

  // Mandatory categories override user opt-out, BUT only for the two
  // channels covered by the legal-basis assumption baked into our
  // category seed (`gdpr_basis = 'contract' | 'legitimate_interest'`).
  // SMS / push / other channels (added in Phase 2+) require explicit
  // consent regardless of category mandatory status — otherwise a
  // "mandatory security.password_changed" notification could fire an
  // SMS without the user ever opting in to SMS, which fails GDPR
  // consent rules. Future channels MUST opt into this whitelist.
  if (cat.isMandatory && (channel === 'in_app' || channel === 'email')) return true;

  const [pref] = await db
    .select({ enabled: userNotificationPreferences.enabled })
    .from(userNotificationPreferences)
    .where(and(
      eq(userNotificationPreferences.userId, userId),
      eq(userNotificationPreferences.categoryId, categoryId),
      eq(userNotificationPreferences.channel, channel),
    ))
    .limit(1);

  if (pref) return pref.enabled === true;

  const defaultChannels = (cat.defaultChannels ?? []) as Channel[];
  return defaultChannels.includes(channel);
}
