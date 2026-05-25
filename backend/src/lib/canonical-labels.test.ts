import { describe, expect, it } from 'vitest';
import {
  CANONICAL_LABEL_KEYS,
  PLATFORM_API_MANAGER,
  buildCanonicalLabels,
  tenantOwnerLabel,
  tenantStoragePvcLabels,
  tenantStoragePvcLabelsFromNamespace,
} from './canonical-labels.js';

describe('buildCanonicalLabels', () => {
  it('emits the four canonical keys when canonicalName is supplied', () => {
    const labels = buildCanonicalLabels({
      role: 'tenant-storage',
      owner: 'tenant-abc12345',
      canonicalName: 'tenant-acme-abc12345-storage',
    });

    expect(labels).toEqual({
      [CANONICAL_LABEL_KEYS.role]: 'tenant-storage',
      [CANONICAL_LABEL_KEYS.owner]: 'tenant-abc12345',
      [CANONICAL_LABEL_KEYS.canonicalName]: 'tenant-acme-abc12345-storage',
      [CANONICAL_LABEL_KEYS.managedBy]: PLATFORM_API_MANAGER,
    });
  });

  it('omits canonical-name when not supplied (CNPG-instance case)', () => {
    const labels = buildCanonicalLabels({
      role: 'system-db',
      owner: 'system',
    });

    expect(labels).toEqual({
      [CANONICAL_LABEL_KEYS.role]: 'system-db',
      [CANONICAL_LABEL_KEYS.owner]: 'system',
      [CANONICAL_LABEL_KEYS.managedBy]: PLATFORM_API_MANAGER,
    });
    expect(labels).not.toHaveProperty(CANONICAL_LABEL_KEYS.canonicalName);
  });

  it('always sets managed-by to platform-api', () => {
    const labels = buildCanonicalLabels({ role: 'mail-blob-store', owner: 'mail' });
    expect(labels[CANONICAL_LABEL_KEYS.managedBy]).toBe('platform-api');
  });

  it('uses the bare-prefix label form (single-label DNS-1123 subdomain)', () => {
    const labels = buildCanonicalLabels({ role: 'mail-blob-store', owner: 'mail' });
    for (const key of Object.keys(labels)) {
      expect(key.startsWith('platform/')).toBe(true);
      // Bare prefix: NO dot before the slash — single-label DNS-1123 subdomain.
      expect(key.split('/')[0]).toBe('platform');
      expect(key.split('/')[0]).not.toContain('.');
    }
  });
});

describe('tenantOwnerLabel', () => {
  it('strips dashes and takes the first 8 hex chars', () => {
    expect(tenantOwnerLabel('abc12345-678a-9bcd-ef01-23456789abcd')).toBe(
      'tenant-abc12345',
    );
  });

  it('handles a UUID with no dashes idempotently', () => {
    expect(tenantOwnerLabel('abc123456789abcdefghijklmnop')).toBe(
      'tenant-abc12345',
    );
  });
});

describe('tenantStoragePvcLabels', () => {
  it('builds the full canonical set for a tenant PVC', () => {
    const labels = tenantStoragePvcLabels(
      'abc12345-678a-9bcd-ef01-23456789abcd',
      'tenant-acme-abc12345',
    );

    expect(labels).toEqual({
      [CANONICAL_LABEL_KEYS.role]: 'tenant-storage',
      [CANONICAL_LABEL_KEYS.owner]: 'tenant-abc12345',
      [CANONICAL_LABEL_KEYS.canonicalName]: 'tenant-acme-abc12345-storage',
      [CANONICAL_LABEL_KEYS.managedBy]: PLATFORM_API_MANAGER,
    });
  });
});

describe('tenantStoragePvcLabelsFromNamespace', () => {
  it('extracts the 8-hex owner short-id from the canonical namespace form', () => {
    const labels = tenantStoragePvcLabelsFromNamespace('tenant-acme-abc12345');
    expect(labels[CANONICAL_LABEL_KEYS.owner]).toBe('tenant-abc12345');
    expect(labels[CANONICAL_LABEL_KEYS.canonicalName]).toBe(
      'tenant-acme-abc12345-storage',
    );
  });

  it('falls back to tenant-unknown when namespace does not match the canonical form', () => {
    const labels = tenantStoragePvcLabelsFromNamespace('garbage-ns');
    expect(labels[CANONICAL_LABEL_KEYS.owner]).toBe('tenant-unknown');
  });

  it('handles slugs that themselves contain 8-hex-looking groups (anchors at end)', () => {
    // Slug 'abc12345' should NOT be picked up as the owner ID — only the
    // trailing 8 hex chars after the last hyphen.
    const labels = tenantStoragePvcLabelsFromNamespace(
      'tenant-abc12345-deadbeef',
    );
    expect(labels[CANONICAL_LABEL_KEYS.owner]).toBe('tenant-deadbeef');
  });
});
