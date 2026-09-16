/**
 * Channel specifications — what a channel IS, declared once.
 *
 * Why this exists
 * ---------------
 * ntfy shipped as a bare string in every category's `defaultChannels` list.
 * It has no per-user leg: `emitNtfyForEvent` publishes ONCE per event to a
 * single operator topic. Because the seed handed it to all 53 categories,
 * tenant billing events were broadcast to the operator's phone — noise for
 * the operator and tenant data on a shared channel.
 *
 * Nothing about that was a bug in ntfy. It was a bug in modelling a channel
 * as a name. A channel has properties, and routing must be derived from them
 * rather than hand-maintained per category — otherwise adding Slack, SMS or a
 * webhook repeats the same mistake, because the same list has to be edited 53
 * times and reviewed by someone who remembers why.
 */
import type { NotificationChannelId } from '@insula/api-contracts';

/**
 * Who a notification is FOR. Distinct from the panel a user logs into:
 * `mailbox_user` has no platform account at all, which is precisely why the
 * mailbox-quota warnings could never reach anyone.
 */
export type NotificationAudienceId = 'platform_admin' | 'tenant_admin' | 'mailbox_user';

export const ALL_AUDIENCES: readonly NotificationAudienceId[] = [
  'platform_admin',
  'tenant_admin',
  'mailbox_user',
];

/**
 * The subsystem a notification (or a channel) depends on.
 *
 * Used for the survivability rule: a notification must never be delivered
 * ONLY through the thing it is reporting on. "Node finished booting" routed
 * in-app waits, unread, in a panel that was unreachable for the whole outage
 * it describes — and an alert saying mail is broken must not be sent by mail.
 */
export type Subsystem =
  | 'platform'   // the API + panels themselves
  | 'mail'       // Stalwart / outbound delivery
  | 'push'       // the external push service
  | 'storage'
  | 'network'
  | 'database'
  | 'tls'
  | 'billing'
  | 'security'
  | 'compute';

/**
 * How a channel addresses a recipient.
 *
 * `broadcast` is the load-bearing value: a broadcast channel reaches an
 * audience, not a person, so it may NEVER carry tenant-scoped content. That
 * single rule is the ntfy fix stated as an invariant instead of a patch, and
 * it pre-empts the same leak in any shared Slack channel or team webhook
 * added later.
 */
export type ChannelAddressing = 'per_user' | 'per_tenant' | 'broadcast';

export interface ChannelSpec {
  readonly id: NotificationChannelId;
  /** Audiences permitted to route through this channel at all. */
  readonly audiences: readonly NotificationAudienceId[];
  readonly addressing: ChannelAddressing;
  /** Survives the platform being unreachable. */
  readonly outOfBand: boolean;
  /** The subsystem this channel itself needs in order to deliver. */
  readonly dependsOn: Subsystem;
  /** `short` channels need a truncated render, not a clipped full body. */
  readonly richness: 'full' | 'short';
}

/**
 * The registry. Total over NotificationChannelId — a new channel fails `tsc`
 * here before it can be handed to 53 categories by a seed default.
 */
export const CHANNEL_SPECS: Record<NotificationChannelId, ChannelSpec> = {
  in_app: {
    id: 'in_app',
    audiences: ['platform_admin', 'tenant_admin'],
    addressing: 'per_user',
    // The panel IS the platform. Anything reporting on platform availability
    // cannot rely on this channel.
    outOfBand: false,
    dependsOn: 'platform',
    richness: 'full',
  },
  email: {
    id: 'email',
    audiences: ['platform_admin', 'tenant_admin', 'mailbox_user'],
    addressing: 'per_user',
    outOfBand: true,
    dependsOn: 'mail',
    richness: 'full',
  },
  ntfy: {
    id: 'ntfy',
    // Operator-only, because it is a single shared topic. This is the line
    // that stops tenant events reaching the operator's phone.
    audiences: ['platform_admin'],
    addressing: 'broadcast',
    outOfBand: true,
    dependsOn: 'push',
    richness: 'short',
  },
};

export function channelSpec(id: NotificationChannelId): ChannelSpec {
  return CHANNEL_SPECS[id];
}

/** Channels a given audience may use, in registry order. */
export function channelsForAudience(audience: NotificationAudienceId): readonly NotificationChannelId[] {
  return (Object.keys(CHANNEL_SPECS) as NotificationChannelId[])
    .filter((id) => CHANNEL_SPECS[id].audiences.includes(audience));
}

/**
 * True when a channel may carry content scoped to a single tenant.
 *
 * A broadcast channel reaches everyone subscribed to it, so tenant-scoped
 * content on one is a disclosure, not a delivery.
 */
export function canCarryTenantScopedContent(id: NotificationChannelId): boolean {
  return CHANNEL_SPECS[id].addressing !== 'broadcast';
}
