/**
 * Pure-function tests for the audit classifier (bundle-everything redesign).
 *
 * The classifier no longer consults a BUNDLE_SECRET_LIST — under
 * bundle-everything semantics, every Secret that isn't `denied` ends
 * up in the bundle. Category assignment is now:
 *   1. denied (delegated to secrets-denylist.ts)
 *   2. skip-at-restore (operator allowlist entry)
 *   3. tier-1-platform / tier-2-tenant / unclassified (namespace-based)
 *
 * Integration coverage (real k8s + ConfigMap CRUD) lives in
 * scripts/integration-secrets-bundle.sh.
 */

import { describe, it, expect } from 'vitest';
import type { AllowlistEntry } from '@k8s-hosting/api-contracts';
import { classify } from './secrets-audit.js';

const emptyAllowlist = new Map<string, AllowlistEntry>();
const opaque = 'Opaque';

describe('classify — bundle-everything', () => {
  describe('Rule 1 — denied (delegated to isAutoManaged)', () => {
    it('denies ServiceAccount tokens', () => {
      const r = classify({
        namespace: 'platform', name: 'default-token-abc',
        type: 'kubernetes.io/service-account-token',
        owner: null, allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('denied');
      expect(r.reason).toMatch(/ServiceAccount token/);
    });

    it('denies Helm release state', () => {
      const r = classify({
        namespace: 'kube-system', name: 'sh.helm.release.v1.cnpg.v3',
        type: 'helm.sh/release.v1', owner: null, allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('denied');
    });

    it('denies cert-manager-issued TLS by ownerReference', () => {
      const r = classify({
        namespace: 'platform', name: 'admin-panel-tls',
        type: 'kubernetes.io/tls',
        owner: { kind: 'Certificate', apiVersion: 'cert-manager.io/v1' },
        allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('denied');
    });
  });

  describe('Rule 2 — skip-at-restore (operator-marked)', () => {
    it('marks an allowlisted Secret as skip-at-restore (wins over tier)', () => {
      const allow = new Map<string, AllowlistEntry>([
        ['platform/session-cookie-key', {
          namespace: 'platform', name: 'session-cookie-key',
          reason: 'rotate on restore — old value should not survive',
          addedBy: 'admin@example.com',
          addedAt: '2026-05-19T10:00:00Z',
        }],
      ]);
      const r = classify({
        namespace: 'platform', name: 'session-cookie-key',
        type: opaque, owner: null, allowlistMap: allow,
      });
      expect(r.category).toBe('skip-at-restore');
      expect(r.reason).toMatch(/rotate on restore/);
    });

    it('denied still wins over skip-at-restore (controller-managed never bundled)', () => {
      const allow = new Map<string, AllowlistEntry>([
        ['kube-system/default-token', {
          namespace: 'kube-system', name: 'default-token',
          reason: 'forgot why', addedBy: 'op', addedAt: '2026-05-19T10:00:00Z',
        }],
      ]);
      const r = classify({
        namespace: 'kube-system', name: 'default-token',
        type: 'kubernetes.io/service-account-token',
        owner: null, allowlistMap: allow,
      });
      expect(r.category).toBe('denied');
    });
  });

  describe('Rule 3 — tier assignment by namespace', () => {
    it('platform → tier-1-platform', () => {
      const r = classify({
        namespace: 'platform', name: 'platform-jwt-secret',
        type: opaque, owner: null, allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('tier-1-platform');
    });

    it('mail → tier-1-platform', () => {
      const r = classify({
        namespace: 'mail', name: 'stalwart-secrets',
        type: opaque, owner: null, allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('tier-1-platform');
    });

    it('cnpg-system → tier-1-platform', () => {
      const r = classify({
        namespace: 'cnpg-system', name: 'cnpg-ca-secret',
        type: opaque, owner: null, allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('tier-1-platform');
    });

    it('client-acme-corp → tier-2-tenant', () => {
      const r = classify({
        namespace: 'client-acme-corp', name: 'wp-db-password',
        type: opaque, owner: null, allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('tier-2-tenant');
    });

    it('monitoring → unclassified (third-party namespace)', () => {
      const r = classify({
        namespace: 'monitoring', name: 'grafana-api-key',
        type: opaque, owner: null, allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('unclassified');
    });

    it('default → unclassified', () => {
      const r = classify({
        namespace: 'default', name: 'some-test-secret',
        type: opaque, owner: null, allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('unclassified');
    });

    it('client (without dash) is NOT tenant', () => {
      const r = classify({
        namespace: 'client', name: 'foo',
        type: opaque, owner: null, allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('unclassified');
    });
  });
});
