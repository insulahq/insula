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

describe('reportsOn means "this channel may be unreachable"', () => {
  // Found on the live DEV database, not in review. Marking the mailbox-quota
  // categories as reporting on `mail` excluded the EMAIL channel from them —
  // which would have silenced the mailbox owner the feature exists to reach,
  // because a full mailbox does not make the mail SYSTEM unreachable. Quite
  // the opposite: mail has to work in order to say so.
  it('keeps email for a quota event, which needs a working mail system to deliver', () => {
    const r = resolveChannels({ cls: 'action', audience: 'tenant_admin', reportsOn: null, tenantScoped: true });
    expect(r.channels).toContain('email');
  });

  it('still drops email when the mail TRANSPORT is the subject', () => {
    const r = resolveChannels({ cls: 'incident', audience: 'platform_admin', reportsOn: 'mail' });
    expect(r.channels).not.toContain('email');
  });
});

describe('every seeded category resolves to something sane', () => {
  it('no category is silenced, and no tenant category reaches the shared push topic', async () => {
    // The assertion that would have caught both DEV findings before deploy:
    // seven categories seeded with every channel (ntfy on tenant events), and
    // ten with a reportsOn that excluded their only useful channel.
    const { ALL_CATEGORIES } = await import('../categories/seed.js');
    for (const c of ALL_CATEGORIES) {
      const audience = c.audience === 'admin' ? 'platform_admin' as const : 'tenant_admin' as const;
      const r = resolveChannels({
        cls: c.cls, audience, reportsOn: c.reportsOn, tenantScoped: audience === 'tenant_admin',
      });
      expect(r.channels.length, `${c.id} resolved to NO channel`).toBeGreaterThan(0);
      if (audience === 'tenant_admin') {
        expect(r.channels, `${c.id} is tenant-facing and reaches the operator push topic`)
          .not.toContain('ntfy');
      }
    }
  });
});

describe('quiet hours are a CLASS decision, not a severity one', () => {
  // security.password_reset is severity=warning. Gating the bypass on severity
  // alone let a password-reset link wait until morning, and an availability
  // alert describe an outage the operator slept through. Severity says how
  // loud; class says whether it can wait.
  it('lets security, incident and availability through', () => {
    for (const cls of ['security', 'incident', 'availability'] as const) {
      expect(CLASS_POLICY[cls].bypassesQuietHours, `${cls} should bypass`).toBe(true);
    }
  });

  it('holds ambient, record and action back', () => {
    for (const cls of ['ambient', 'record', 'action'] as const) {
      expect(CLASS_POLICY[cls].bypassesQuietHours, `${cls} should NOT bypass`).toBe(false);
    }
  });

  it('bypasses for a warning-severity security category', async () => {
    const { ALL_CATEGORIES } = await import('../categories/seed.js');
    const reset = ALL_CATEGORIES.find((c) => c.id === 'security.password_reset')!;
    expect(reset.defaultSeverity).not.toBe('critical'); // the trap
    expect(CLASS_POLICY[reset.cls].bypassesQuietHours).toBe(true);
  });
});
