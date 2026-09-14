import { describe, it, expect } from 'vitest';
import { resolveChannels, CLASS_POLICY, ALL_CLASSES } from './classes.js';
import {
  CHANNEL_SPECS,
  channelsForAudience,
  canCarryTenantScopedContent,
  ALL_AUDIENCES,
} from './channel-spec.js';

describe('channel specs', () => {
  it('bars ntfy for every audience except the operator', () => {
    // The live leak: ntfy is ONE shared topic with no per-user leg, and the
    // seed handed it to all 53 categories, so tenant billing events were
    // pushed to the operator's phone.
    expect(CHANNEL_SPECS.ntfy.audiences).toEqual(['platform_admin']);
    expect(channelsForAudience('tenant_admin')).not.toContain('ntfy');
    expect(channelsForAudience('mailbox_user')).not.toContain('ntfy');
  });

  it('gives a mailbox user email only — they have no platform account', () => {
    expect(channelsForAudience('mailbox_user')).toEqual(['email']);
  });

  it('marks broadcast channels as unable to carry tenant-scoped content', () => {
    expect(canCarryTenantScopedContent('ntfy')).toBe(false);
    expect(canCarryTenantScopedContent('email')).toBe(true);
    expect(canCarryTenantScopedContent('in_app')).toBe(true);
  });

  it('knows in_app is the only in-platform channel', () => {
    expect(CHANNEL_SPECS.in_app.outOfBand).toBe(false);
    expect(CHANNEL_SPECS.email.outOfBand).toBe(true);
    expect(CHANNEL_SPECS.ntfy.outOfBand).toBe(true);
  });
});

describe('resolveChannels — class defaults', () => {
  it('keeps ambient inside the platform UI', () => {
    // admin.slo_alert_resolved lives here: 130 deliveries a fortnight, each
    // emailed AND pushed, to say something stopped being broken.
    const r = resolveChannels({ cls: 'ambient', audience: 'platform_admin' });
    expect(r.channels).toEqual(['in_app']);
  });

  it('gives a record an email copy but never a push', () => {
    const r = resolveChannels({ cls: 'record', audience: 'tenant_admin' });
    expect(r.channels).toEqual(['in_app', 'email']);
  });

  it('gives an incident every channel the audience can use', () => {
    const r = resolveChannels({ cls: 'incident', audience: 'platform_admin' });
    expect(r.channels).toEqual(['in_app', 'email', 'ntfy']);
  });

  it('drops ntfy from a tenant incident without failing the delivery', () => {
    const r = resolveChannels({ cls: 'incident', audience: 'tenant_admin' });
    expect(r.channels).toEqual(['in_app', 'email']);
    expect(r.excluded.map((e) => e.channel)).toContain('ntfy');
  });
});

describe('resolveChannels — the channel must outlive the event', () => {
  it('refuses in_app for an availability event', () => {
    // "Node finished booting" was routed in-app, to a panel unreachable for
    // the entire outage it describes.
    const r = resolveChannels({ cls: 'availability', audience: 'platform_admin' });
    expect(r.channels).not.toContain('in_app');
    expect(r.channels).toEqual(['email', 'ntfy']);
    expect(r.excluded.find((e) => e.channel === 'in_app')?.reason).toMatch(/out-of-band/);
  });

  it('refuses email for an event reporting on mail', () => {
    // An alert saying mail is broken must not be sent by mail.
    const r = resolveChannels({ cls: 'incident', audience: 'platform_admin', reportsOn: 'mail' });
    expect(r.channels).not.toContain('email');
    expect(r.channels).toContain('ntfy');
    expect(r.excluded.find((e) => e.channel === 'email')?.reason).toMatch(/depends on mail/);
  });

  it('refuses push for an event reporting on the push transport', () => {
    const r = resolveChannels({ cls: 'incident', audience: 'platform_admin', reportsOn: 'push' });
    expect(r.channels).not.toContain('ntfy');
    expect(r.channels).toContain('email');
  });

  it('still leaves at least one channel when a dependency is excluded', () => {
    for (const reportsOn of ['platform', 'mail', 'push'] as const) {
      const r = resolveChannels({ cls: 'incident', audience: 'platform_admin', reportsOn });
      expect(r.channels.length, `incident reporting on ${reportsOn} has no channel left`)
        .toBeGreaterThan(0);
    }
  });
});

describe('resolveChannels — tenant-scoped content', () => {
  it('never puts tenant-scoped content on a broadcast channel', () => {
    const r = resolveChannels({
      cls: 'incident',
      audience: 'platform_admin',
      tenantScoped: true,
    });
    expect(r.channels).not.toContain('ntfy');
    expect(r.excluded.find((e) => e.channel === 'ntfy')?.reason).toMatch(/broadcast/);
  });

  it('allows the same event on push when it is not tenant-scoped', () => {
    const r = resolveChannels({ cls: 'incident', audience: 'platform_admin', tenantScoped: false });
    expect(r.channels).toContain('ntfy');
  });
});

describe('resolveChannels — operator override', () => {
  it('honours an override but still applies the safety filters', () => {
    // An operator may narrow or widen the channel set; they may NOT put tenant
    // data on a broadcast topic or route an availability event in-app.
    const r = resolveChannels({
      cls: 'availability',
      audience: 'tenant_admin',
      override: ['in_app', 'email', 'ntfy'],
    });
    expect(r.channels).toEqual(['email']);
  });
});

describe('class policy totality', () => {
  it('declares a policy for every class', () => {
    for (const c of ALL_CLASSES) {
      expect(CLASS_POLICY[c], `no policy for ${c}`).toBeDefined();
      expect(CLASS_POLICY[c].channels.length).toBeGreaterThan(0);
    }
  });

  it('gives every audience at least one usable channel', () => {
    for (const a of ALL_AUDIENCES) {
      expect(channelsForAudience(a).length, `${a} has no channel`).toBeGreaterThan(0);
    }
  });

  it('makes security and incident unmutable', () => {
    expect(CLASS_POLICY.security.mandatory).toBe(true);
    expect(CLASS_POLICY.incident.mandatory).toBe(true);
    expect(CLASS_POLICY.availability.mandatory).toBe(true);
  });
});

describe('resolveChannels — never silences a category', () => {
  // Found while generating the channel-reset migration, not by reasoning:
  // admin.slo_alert_resolved is ambient (in_app only) and was marked as
  // reporting on `platform`, which in_app depends on — so every channel was
  // filtered and the category resolved to ZERO. The router had reinvented
  // silence from the opposite direction.
  it('keeps a channel when every filter would otherwise exclude all of them', () => {
    const r = resolveChannels({ cls: 'ambient', audience: 'platform_admin', reportsOn: 'platform' });
    expect(r.channels.length).toBe(1);
    expect(r.excluded.find((e) => e.channel === r.channels[0])?.reason).toMatch(/only remaining/);
  });

  it('resolves a non-empty channel set for EVERY class × audience × subsystem', () => {
    const SUBSYSTEMS = ['platform', 'mail', 'push', 'storage', 'network',
      'database', 'tls', 'billing', 'security', 'compute', null] as const;
    for (const cls of ALL_CLASSES) {
      for (const audience of ALL_AUDIENCES) {
        for (const reportsOn of SUBSYSTEMS) {
          const r = resolveChannels({ cls, audience, reportsOn, tenantScoped: audience !== 'platform_admin' });
          expect(r.channels.length, `${cls}/${audience}/${reportsOn} resolved to nothing`)
            .toBeGreaterThan(0);
        }
      }
    }
  });
});
