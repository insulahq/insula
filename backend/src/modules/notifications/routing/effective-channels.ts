/**
 * The one place the dispatcher asks "which channels does this event use?"
 *
 * `notification_categories.default_channels` is an operator-editable column.
 * It is treated as an OVERRIDE of the class default, not as the final word —
 * the safety filters still apply to it, so an operator cannot put tenant data
 * on a broadcast topic or route an availability event into a panel that may be
 * unreachable. Those are invariants, not preferences.
 *
 * Class and subsystem stay code-owned (categories/seed.ts) rather than stored:
 * they are structural facts about the event, and a stored copy would need a
 * backfill on every change and could drift from the emitter that produces it.
 */
import { ALL_CATEGORIES } from '../categories/seed.js';
import { resolveChannels, type NotificationClass, type ResolvedChannels } from './classes.js';
import type { NotificationAudienceId, Subsystem } from './channel-spec.js';
import type { NotificationChannelId } from '@insula/api-contracts';

interface CategoryMeta {
  readonly cls: NotificationClass;
  readonly reportsOn: Subsystem | null;
  readonly audience: NotificationAudienceId;
}

function audienceOf(seedAudience: string): NotificationAudienceId {
  // The seed's two-value `audience` predates the three-audience model.
  // `mailbox_user` is never a category-level audience — it is a binding on
  // specific mailbox events, resolved at emit time.
  return seedAudience === 'admin' ? 'platform_admin' : 'tenant_admin';
}

const META: ReadonlyMap<string, CategoryMeta> = new Map(
  ALL_CATEGORIES.map((c) => [c.id, {
    cls: c.cls,
    reportsOn: c.reportsOn,
    audience: audienceOf(c.audience),
  }]),
);

export function categoryMeta(categoryId: string): CategoryMeta | undefined {
  return META.get(categoryId);
}

export interface EffectiveChannelsInput {
  readonly categoryId: string;
  /** The stored, operator-editable list. Treated as an override. */
  readonly storedChannels: readonly string[];
  /** Present when the event concerns exactly one tenant. */
  readonly tenantId?: string | null;
  /** Explicit audience override, for events bound to a non-default audience. */
  readonly audience?: NotificationAudienceId;
}

/**
 * Resolve the channels an event should actually use.
 *
 * Falls back to the stored list verbatim for a category with no code-side
 * metadata — an unknown category is not a reason to deliver nothing.
 */
export function effectiveChannels(input: EffectiveChannelsInput): ResolvedChannels {
  const meta = META.get(input.categoryId);
  if (!meta) {
    return {
      channels: input.storedChannels as readonly NotificationChannelId[],
      excluded: [],
    };
  }
  return resolveChannels({
    cls: meta.cls,
    audience: input.audience ?? meta.audience,
    reportsOn: meta.reportsOn,
    override: input.storedChannels as readonly NotificationChannelId[],
    // A tenant-scoped payload must never reach a broadcast channel, whatever
    // the category's own audience says.
    tenantScoped: Boolean(input.tenantId),
  });
}
