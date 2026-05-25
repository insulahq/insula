import { describe, it, expect } from 'vitest';
import {
  restoreTierForNamespace,
  CRITICAL_TIER_1_SECRETS,
  findMissingCriticalSecrets,
  TIER_1_PLATFORM_NAMESPACES,
} from './secrets-tiers.js';

describe('restoreTierForNamespace', () => {
  it('classifies platform-owned namespaces as tier-1-platform', () => {
    expect(restoreTierForNamespace('platform')).toBe('tier-1-platform');
    expect(restoreTierForNamespace('mail')).toBe('tier-1-platform');
    expect(restoreTierForNamespace('cnpg-system')).toBe('tier-1-platform');
    expect(restoreTierForNamespace('cert-manager')).toBe('tier-1-platform');
  });

  it('classifies tenant namespaces as tier-2-tenant', () => {
    expect(restoreTierForNamespace('client-abc')).toBe('tier-2-tenant');
    expect(restoreTierForNamespace('client-deadbeef')).toBe('tier-2-tenant');
  });

  it('classifies everything else as unclassified', () => {
    expect(restoreTierForNamespace('monitoring')).toBe('unclassified');
    expect(restoreTierForNamespace('kube-system')).toBe('unclassified');
    expect(restoreTierForNamespace('')).toBe('unclassified');
  });
});

describe('CRITICAL_TIER_1_SECRETS', () => {
  // The DR mechanism is built on the assumption that these two
  // Secrets always travel with the bundle. If this test fails, audit
  // any callsite of secrets-bundle.ts that might silently exclude
  // them — the bundle is unrestorable without these keys.
  it('lists both critical Secrets in `platform` namespace', () => {
    expect(CRITICAL_TIER_1_SECRETS).toContain('platform/platform-secrets');
    expect(CRITICAL_TIER_1_SECRETS).toContain('platform/backup-target-key');
  });

  it('every critical Secret has a tier-1 namespace by the sweep rule', () => {
    for (const key of CRITICAL_TIER_1_SECRETS) {
      const ns = key.split('/')[0];
      expect(TIER_1_PLATFORM_NAMESPACES.has(ns)).toBe(true);
    }
  });
});

describe('findMissingCriticalSecrets', () => {
  it('returns empty when all critical Secrets are in the manifest', () => {
    const manifest = [
      { namespace: 'platform', name: 'platform-secrets' },
      { namespace: 'platform', name: 'backup-target-key' },
      { namespace: 'mail', name: 'stalwart-admin-creds' },
    ];
    expect(findMissingCriticalSecrets(manifest)).toEqual([]);
  });

  it('returns the missing keys as `<ns>/<name>` strings', () => {
    const manifest = [
      { namespace: 'platform', name: 'platform-secrets' },
      // backup-target-key intentionally missing
    ];
    expect(findMissingCriticalSecrets(manifest)).toEqual([
      'platform/backup-target-key',
    ]);
  });

  it('returns all critical keys when the manifest is empty', () => {
    expect(findMissingCriticalSecrets([])).toEqual([
      'platform/platform-secrets',
      'platform/backup-target-key',
    ]);
  });
});
