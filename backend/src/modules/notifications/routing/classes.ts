/**
 * Notification classes — WHY the recipient is being told.
 *
 * Severity says how loud. Class decides whether a message leaves the platform
 * UI at all, which is the decision nobody was making: all 53 categories
 * shipped with all three channels enabled and only 14 had any rate limit, so
 * a certificate renewing normally emailed the customer and an SLO recovering
 * emailed AND pushed the operator 130 times a fortnight.
 *
 * Defaults derive from (class × audience) instead of 53 independent guesses,
 * so a new category gets sensible delivery for free.
 */
import type { NotificationChannelId } from '@insula/api-contracts';
import { channelsForAudience, channelSpec, type NotificationAudienceId, type Subsystem } from './channel-spec.js';

export type NotificationClass =
  | 'ambient'
  | 'record'
  | 'action'
  | 'incident'
  | 'availability'
  | 'security';

export const ALL_CLASSES: readonly NotificationClass[] = [
  'ambient', 'record', 'action', 'incident', 'availability', 'security',
];

export interface ClassPolicy {
  /** Human description, surfaced in the admin Sources screen. */
  readonly description: string;
  /** Channels this class wants, before audience and dependency filtering. */
  readonly channels: readonly NotificationChannelId[];
  /** Cannot be silenced by a user preference. */
  readonly mandatory: boolean;
  /** Eligible to be rolled into a periodic digest instead of sent individually. */
  readonly digestible: boolean;
  /** Passes through quiet hours. */
  readonly bypassesQuietHours: boolean;
  /**
   * Must be delivered out-of-band — the in-platform channel is excluded even
   * when the event's own subsystem would not have excluded it.
   */
  readonly requiresOutOfBand: boolean;
}

export const CLASS_POLICY: Record<NotificationClass, ClassPolicy> = {
  ambient: {
    description: 'For the record, never actionable, and the reader was there.',
    channels: ['in_app'],
    mandatory: false,
    digestible: true,
    bypassesQuietHours: false,
    requiresOutOfBand: false,
  },
  record: {
    description: 'A durable receipt the recipient may need later.',
    channels: ['in_app', 'email'],
    mandatory: false,
    digestible: true,
    bypassesQuietHours: false,
    requiresOutOfBand: false,
  },
  action: {
    description: 'The recipient must act or the situation degrades.',
    channels: ['in_app', 'email'],
    mandatory: false,
    digestible: true,
    bypassesQuietHours: false,
    requiresOutOfBand: false,
  },
  incident: {
    description: 'Broken now; someone must respond.',
    channels: ['in_app', 'email', 'ntfy'],
    mandatory: true,
    digestible: false,
    bypassesQuietHours: true,
    requiresOutOfBand: false,
  },
  availability: {
    // The class that exists because "node finished booting" was routed to a
    // panel that was down for the entire event it described.
    description: 'The platform’s own reachability. Never relies on the panel.',
    channels: ['in_app', 'email', 'ntfy'],
    mandatory: true,
    digestible: false,
    bypassesQuietHours: true,
    requiresOutOfBand: true,
  },
  security: {
    description: 'Identity, access and account state. Cannot be muted.',
    channels: ['in_app', 'email'],
    mandatory: true,
    digestible: false,
    bypassesQuietHours: true,
    requiresOutOfBand: false,
  },
};

export interface ResolveChannelsInput {
  readonly cls: NotificationClass;
  readonly audience: NotificationAudienceId;
  /** The subsystem the EVENT reports on, if any. */
  readonly reportsOn?: Subsystem | null;
  /** Operator override; when present it replaces the class default. */
  readonly override?: readonly NotificationChannelId[] | null;
  /** True when the payload is scoped to one tenant. */
  readonly tenantScoped?: boolean;
}

export interface ResolvedChannels {
  readonly channels: readonly NotificationChannelId[];
  /** Channels removed, with the reason — surfaced in the admin Sources screen. */
  readonly excluded: readonly { readonly channel: NotificationChannelId; readonly reason: string }[];
}

/**
 * Compose the effective channel set for one binding.
 *
 *   class defaults (or operator override)
 *     ∩ channels this audience may use
 *     − channels that depend on the subsystem the event reports on
 *     − broadcast channels when the content is tenant-scoped
 *     − the in-platform channel when the class requires out-of-band
 *
 * Every exclusion is returned with a reason rather than silently dropped: an
 * operator looking at "why did this not push?" needs an answer, and a silent
 * filter is how ntfy stayed on for three years without anyone deciding it.
 */
export function resolveChannels(input: ResolveChannelsInput): ResolvedChannels {
  const policy = CLASS_POLICY[input.cls];
  const allowedForAudience = new Set(channelsForAudience(input.audience));
  const wanted = input.override ?? policy.channels;
  const excluded: { channel: NotificationChannelId; reason: string }[] = [];
  const channels: NotificationChannelId[] = [];

  for (const id of wanted) {
    const spec = channelSpec(id);
    if (!spec) continue;

    if (!allowedForAudience.has(id)) {
      excluded.push({ channel: id, reason: `${input.audience} cannot use ${id}` });
      continue;
    }
    if (input.tenantScoped && spec.addressing === 'broadcast') {
      excluded.push({ channel: id, reason: `${id} is a broadcast channel and the content is tenant-scoped` });
      continue;
    }
    if (input.reportsOn && spec.dependsOn === input.reportsOn) {
      excluded.push({ channel: id, reason: `${id} depends on ${input.reportsOn}, which is the subsystem being reported on` });
      continue;
    }
    if (policy.requiresOutOfBand && !spec.outOfBand) {
      excluded.push({ channel: id, reason: `${input.cls} must be delivered out-of-band; ${id} is in-platform` });
      continue;
    }
    channels.push(id);
  }

  // A router that filters everything out is a router that deletes the
  // notification. Caught while generating the channel-reset migration:
  // `admin.slo_alert_resolved` is ambient (in-app only) and reported on
  // `platform`, which in_app depends on — so every channel was excluded and
  // the category resolved to ZERO channels. Silence again, arrived at from
  // the opposite direction.
  //
  // When the filters leave nothing, keep the least-bad survivor: prefer an
  // out-of-band channel the audience can actually use, and record that the
  // dependency rule was overridden so the operator can see it.
  if (channels.length === 0 && wanted.length > 0) {
    const rescue = [...allowedForAudience].find((id) => channelSpec(id).outOfBand)
      ?? [...allowedForAudience][0];
    if (rescue) {
      return {
        channels: [rescue],
        excluded: [
          ...excluded.filter((e) => e.channel !== rescue),
          { channel: rescue, reason: `kept as the only remaining channel for ${input.audience} — every other was filtered` },
        ],
      };
    }
  }

  return { channels, excluded };
}
