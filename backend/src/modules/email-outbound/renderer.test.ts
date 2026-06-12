import { describe, it, expect } from 'vitest';
import {
  renderQueueOutboundToml,
  type RenderQueueOutboundInput,
} from './renderer.js';

describe('renderQueueOutboundToml', () => {
  it('returns a direct delivery config when no relay is configured', () => {
    const input: RenderQueueOutboundInput = { relays: [] };
    const toml = renderQueueOutboundToml(input);
    // Must contain a fallback direct route so Stalwart boots even
    // without any relay configured.
    expect(toml).toContain('[queue.outbound]');
    expect(toml).toContain('next-hop');
    expect(toml).toMatch(/# No relays configured|direct/);
  });

  it('renders a single Mailgun relay with auth credentials', () => {
    const input: RenderQueueOutboundInput = {
      relays: [
        {
          id: 'r1',
          name: 'Mailgun EU',
          providerType: 'mailgun',
          isDefault: 1,
          enabled: 1,
          smtpHost: 'smtp.eu.mailgun.org',
          smtpPort: 587,
          authUsername: 'postmaster@mg.example.com',
          authPassword: 'secret-password',
        },
      ],
    };
    const toml = renderQueueOutboundToml(input);
    expect(toml).toContain('[queue.outbound]');
    expect(toml).toContain('smtp.eu.mailgun.org');
    expect(toml).toContain('587');
    expect(toml).toContain('postmaster@mg.example.com');
    // Password must be on a line, not injected as a literal
    expect(toml).toContain('secret-password');
    // Should reference the relay by a stable key
    expect(toml).toContain('mailgun-eu');
  });

  it('renders multiple enabled relays as distinct next-hop sources', () => {
    const input: RenderQueueOutboundInput = {
      relays: [
        {
          id: 'r1',
          name: 'Mailgun',
          providerType: 'mailgun',
          isDefault: 1,
          enabled: 1,
          smtpHost: 'smtp.mailgun.org',
          smtpPort: 587,
          authUsername: 'user',
          authPassword: 'pw',
        },
        {
          id: 'r2',
          name: 'Postmark',
          providerType: 'postmark',
          isDefault: 0,
          enabled: 1,
          smtpHost: 'smtp.postmarkapp.com',
          smtpPort: 587,
          authUsername: 'apikey',
          authPassword: 'postmark-token',
        },
      ],
    };
    const toml = renderQueueOutboundToml(input);
    expect(toml).toContain('smtp.mailgun.org');
    expect(toml).toContain('smtp.postmarkapp.com');
    // Default relay wins for the top-level next-hop
    expect(toml).toContain('mailgun');
  });

  it('omits disabled relays', () => {
    const input: RenderQueueOutboundInput = {
      relays: [
        {
          id: 'r1',
          name: 'Mailgun',
          providerType: 'mailgun',
          isDefault: 1,
          enabled: 0, // disabled
          smtpHost: 'smtp.mailgun.org',
          smtpPort: 587,
          authUsername: 'user',
          authPassword: 'pw',
        },
      ],
    };
    const toml = renderQueueOutboundToml(input);
    expect(toml).not.toContain('smtp.mailgun.org');
  });

  it('handles direct provider type (no external relay)', () => {
    const input: RenderQueueOutboundInput = {
      relays: [
        {
          id: 'r1',
          name: 'Direct',
          providerType: 'direct',
          isDefault: 1,
          enabled: 1,
          smtpHost: null,
          smtpPort: null,
          authUsername: null,
          authPassword: null,
        },
      ],
    };
    const toml = renderQueueOutboundToml(input);
    expect(toml).toContain('[queue.outbound]');
    // Direct delivery = no SMTP relay, Stalwart does its own MX lookup
    expect(toml).toMatch(/direct|mx/);
  });

  it('escapes special TOML characters in relay names', () => {
    const input: RenderQueueOutboundInput = {
      relays: [
        {
          id: 'r1',
          name: 'Mailgun "prod"',
          providerType: 'mailgun',
          isDefault: 1,
          enabled: 1,
          smtpHost: 'smtp.mailgun.org',
          smtpPort: 587,
          authUsername: 'user',
          authPassword: 'p"w',
        },
      ],
    };
    const toml = renderQueueOutboundToml(input);
    // Password with embedded quotes must be escaped or single-quoted
    expect(toml).not.toMatch(/password = "p"w"/);
  });
});
