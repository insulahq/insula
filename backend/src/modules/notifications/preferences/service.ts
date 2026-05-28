/**
 * Per-user notification preferences + settings.
 *
 * Two surfaces:
 *   - preferences = matrix of (categoryId, channel) → enabled bool
 *   - settings    = singleton row per user (quiet hours, locale, digest)
 *
 * Preferences merging rules (consistent with the gate at delivery time):
 *   - mandatory categories ALWAYS surface as enabled=true, isMandatory=true,
 *     regardless of any DB override that might exist for legacy reasons.
 *   - non-mandatory + no DB row = use category.defaultChannels to decide
 *     enabled per channel.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  notificationCategories,
  userNotificationPreferences,
  userNotificationSettings,
} from '../../../db/schema.js';
import type {
  UserNotificationPreferenceResponse,
  UserNotificationPreferencesResponse,
  UserNotificationSettingsResponse,
  UpdateUserNotificationPreferencesInput,
  UpdateUserNotificationSettingsInput,
} from '@k8s-hosting/api-contracts';
import type { Database } from '../../../db/index.js';

type Channel = 'in_app' | 'email';
const CHANNELS: readonly Channel[] = ['in_app', 'email'];

interface CategoryRow {
  readonly id: string;
  readonly defaultChannels: readonly string[] | null;
  readonly isMandatory: boolean;
  readonly isActive: boolean;
  readonly audience: string;
}

interface PrefRow {
  readonly categoryId: string;
  readonly channel: Channel;
  readonly enabled: boolean;
}

const DEFAULT_SETTINGS: UserNotificationSettingsResponse = {
  quietHoursStart: null,
  quietHoursEnd: null,
  timezone: null,
  digestMode: 'immediate',
  locale: 'en',
};

export async function getUserPreferences(
  db: Database,
  userId: string,
): Promise<UserNotificationPreferencesResponse> {
  // 1. Load all active categories (one round-trip).
  const categories: CategoryRow[] = await db
    .select({
      id: notificationCategories.id,
      defaultChannels: notificationCategories.defaultChannels,
      isMandatory: notificationCategories.isMandatory,
      isActive: notificationCategories.isActive,
      audience: notificationCategories.audience,
    })
    .from(notificationCategories)
    .where(eq(notificationCategories.isActive, true))
    .orderBy(asc(notificationCategories.audience), asc(notificationCategories.id));

  // 2. Load any user overrides for this user.
  const prefs: PrefRow[] = await db
    .select({
      categoryId: userNotificationPreferences.categoryId,
      channel: userNotificationPreferences.channel,
      enabled: userNotificationPreferences.enabled,
    })
    .from(userNotificationPreferences)
    .where(eq(userNotificationPreferences.userId, userId));

  const overrideMap = new Map<string, boolean>();
  for (const p of prefs) overrideMap.set(`${p.categoryId}::${p.channel}`, p.enabled);

  // 3. Materialise the merged matrix: every (category, channel) cell.
  const result: UserNotificationPreferenceResponse[] = [];
  for (const cat of categories) {
    const defaultChs = new Set((cat.defaultChannels ?? []) as Channel[]);
    for (const ch of CHANNELS) {
      const key = `${cat.id}::${ch}`;
      let enabled: boolean;
      if (cat.isMandatory) {
        enabled = true;
      } else if (overrideMap.has(key)) {
        enabled = overrideMap.get(key) === true;
      } else {
        enabled = defaultChs.has(ch);
      }
      result.push({
        categoryId: cat.id,
        channel: ch,
        enabled,
        isMandatory: cat.isMandatory,
      });
    }
  }
  return { preferences: result };
}

export async function updateUserPreferences(
  db: Database,
  userId: string,
  input: UpdateUserNotificationPreferencesInput,
): Promise<UserNotificationPreferencesResponse> {
  // Validate every updated category exists.
  const categoryIds = Array.from(new Set(input.updates.map((u) => u.categoryId)));
  const known = categoryIds.length === 0
    ? []
    : await db
        .select({ id: notificationCategories.id, isMandatory: notificationCategories.isMandatory })
        .from(notificationCategories)
        .where(inArray(notificationCategories.id, categoryIds));
  const knownIds = new Set(known.map((k) => k.id));
  const mandatorySet = new Set(known.filter((k) => k.isMandatory).map((k) => k.id));

  for (const u of input.updates) {
    if (!knownIds.has(u.categoryId)) continue; // silently drop unknown — tenants can't probe
    // Mandatory categories can't be disabled by the user. Their row is
    // not written; the merged read above will surface enabled=true regardless.
    if (mandatorySet.has(u.categoryId) && u.enabled === false) continue;

    await db
      .insert(userNotificationPreferences)
      .values({
        userId,
        categoryId: u.categoryId,
        channel: u.channel,
        enabled: u.enabled,
      })
      .onConflictDoUpdate({
        target: [userNotificationPreferences.userId, userNotificationPreferences.categoryId, userNotificationPreferences.channel],
        set: { enabled: u.enabled },
      });
  }

  return getUserPreferences(db, userId);
}

export async function getUserSettings(
  db: Database,
  userId: string,
): Promise<UserNotificationSettingsResponse> {
  const [row] = await db
    .select()
    .from(userNotificationSettings)
    .where(eq(userNotificationSettings.userId, userId))
    .limit(1);
  if (!row) return DEFAULT_SETTINGS;
  // Narrow digestMode against the API-contract enum rather than an
  // unchecked `as` cast — defends against schema drift if a future
  // migration adds a value the API doesn't yet expose.
  const DIGEST_MODES: readonly UserNotificationSettingsResponse['digestMode'][] = ['immediate', 'hourly', 'daily'];
  const digestMode: UserNotificationSettingsResponse['digestMode'] =
    DIGEST_MODES.includes(row.digestMode as UserNotificationSettingsResponse['digestMode'])
      ? (row.digestMode as UserNotificationSettingsResponse['digestMode'])
      : 'immediate';
  return {
    quietHoursStart: row.quietHoursStart ?? null,
    quietHoursEnd: row.quietHoursEnd ?? null,
    timezone: row.timezone ?? null,
    digestMode,
    locale: row.locale,
  };
}

export async function updateUserSettings(
  db: Database,
  userId: string,
  input: UpdateUserNotificationSettingsInput,
): Promise<UserNotificationSettingsResponse> {
  const existing = await getUserSettings(db, userId);
  const merged: UserNotificationSettingsResponse = {
    quietHoursStart: input.quietHoursStart !== undefined ? input.quietHoursStart : existing.quietHoursStart,
    quietHoursEnd: input.quietHoursEnd !== undefined ? input.quietHoursEnd : existing.quietHoursEnd,
    timezone: input.timezone !== undefined ? input.timezone : existing.timezone,
    digestMode: input.digestMode !== undefined ? input.digestMode : existing.digestMode,
    locale: input.locale !== undefined ? input.locale : existing.locale,
  };

  await db
    .insert(userNotificationSettings)
    .values({
      userId,
      quietHoursStart: merged.quietHoursStart,
      quietHoursEnd: merged.quietHoursEnd,
      timezone: merged.timezone,
      digestMode: merged.digestMode,
      locale: merged.locale,
    })
    .onConflictDoUpdate({
      target: userNotificationSettings.userId,
      set: {
        quietHoursStart: merged.quietHoursStart,
        quietHoursEnd: merged.quietHoursEnd,
        timezone: merged.timezone,
        digestMode: merged.digestMode,
        locale: merged.locale,
      },
    });

  return merged;
}
