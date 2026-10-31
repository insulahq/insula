import { describe, it, expect, vi } from 'vitest';
import {
  rewriteHostInMatch,
  extractHostFromMatch,
  isValidPlatformHostname,
  reconcileCertificateDnsName,
} from './traefik-host-reconcile.js';

describe('rewriteHostInMatch', () => {
  it('swaps the host in a bare Host() rule', () => {
    expect(rewriteHostInMatch('Host(`stalwart.old.test`)', 'stalwart.new.test')).toBe(
      'Host(`stalwart.new.test`)',
    );
  });

  it('preserves every other matcher (PathPrefix / Path / && / ||)', () => {
    const match =
      'Host(`stalwart.old.test`) && (PathPrefix(`/jmap`) || Path(`/.well-known/jmap`))';
    expect(rewriteHostInMatch(match, 'stalwart.new.test')).toBe(
      'Host(`stalwart.new.test`) && (PathPrefix(`/jmap`) || Path(`/.well-known/jmap`))',
    );
  });

  it('rewrites EVERY Host token (multi-host catch-all)', () => {
    expect(rewriteHostInMatch('Host(`a.old.test`) || Host(`b.old.test`)', 'x.new.test')).toBe(
      'Host(`x.new.test`) || Host(`x.new.test`)',
    );
  });

  it('leaves a match with no Host token untouched', () => {
    expect(rewriteHostInMatch('PathPrefix(`/c/`)', 'x.new.test')).toBe('PathPrefix(`/c/`)');
  });
});

describe('extractHostFromMatch', () => {
  it('returns the first host', () => {
    expect(extractHostFromMatch('Host(`tunnels.example.test`)')).toBe('tunnels.example.test');
    expect(
      extractHostFromMatch('Host(`a.example.test`) && PathPrefix(`/x`)'),
    ).toBe('a.example.test');
  });

  it('returns null when there is no Host token', () => {
    expect(extractHostFromMatch('PathPrefix(`/c/`)')).toBeNull();
  });
});

describe('isValidPlatformHostname', () => {
  it('accepts valid multi-label FQDNs', () => {
    for (const h of ['stalwart.example.test', 'tunnels.a.b.example.com', 'mail.example.org']) {
      expect(isValidPlatformHostname(h)).toBe(true);
    }
  });

  it('rejects single-label, empty, and injection-shaped values', () => {
    for (const h of ['', 'localhost', 'bad_underscore.test', 'x`)||Host(`evil.com', 'has space.test']) {
      expect(isValidPlatformHostname(h)).toBe(false);
    }
  });
});

describe('reconcileCertificateDnsName — renewal schedule', () => {
  // The Certificates this reconciles come from `reconcile: disabled` seed
  // manifests, so Flux never moves an existing one off `renewBefore: 720h`.
  const log = { info: vi.fn(), warn: vi.fn() };
  const certWith = (spec: Record<string, unknown>) => {
    const patch = vi.fn(async () => ({}));
    const custom = {
      getNamespacedCustomObject: vi.fn(async () => ({
        metadata: { annotations: { 'kustomize.toolkit.fluxcd.io/reconcile': 'disabled' } },
        spec: { dnsNames: ['suspended.example.test'], ...spec },
      })),
      patchNamespacedCustomObject: patch,
    };
    return { custom: custom as never, patch };
  };
  const ref = { namespace: 'platform', name: 'platform-suspended-page' };

  it('moves a certificate on a fixed renewBefore to the policy share, removing renewBefore', async () => {
    const { custom, patch } = certWith({ renewBefore: '720h' });
    const r = await reconcileCertificateDnsName(custom, ref, 'suspended.example.test', log);
    expect(r?.patched).toBe(true);
    const body = (patch.mock.calls[0] as unknown as [{ body: { spec: Record<string, unknown> } }])[0].body;
    // null deletes the field in a merge patch: cert-manager refuses both at once.
    expect(body.spec).toEqual({ dnsNames: ['suspended.example.test'], renewBefore: null, renewBeforePercentage: 33 });
  });

  it('leaves a certificate already on the policy alone', async () => {
    const { custom, patch } = certWith({ renewBeforePercentage: 33 });
    const r = await reconcileCertificateDnsName(custom, ref, 'suspended.example.test', log);
    expect(r?.patched).toBe(false);
    expect(patch).not.toHaveBeenCalled();
  });
});
