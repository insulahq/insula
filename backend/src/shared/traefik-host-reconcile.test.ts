import { describe, it, expect } from 'vitest';
import {
  rewriteHostInMatch,
  extractHostFromMatch,
  isValidPlatformHostname,
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
