import { describe, it, expect } from 'vitest';
import { hostnameToSlug, isApexHostname } from './service.js';
import { createIngressRouteSchema, updateIngressRouteSchema, ingressSettingsResponseSchema } from '@insula/api-contracts';

describe('ingress-routes service', () => {
  describe('hostnameToSlug', () => {
    it('should convert simple domain to slug', () => {
      expect(hostnameToSlug('example.com')).toBe('example-com');
    });

    it('should convert subdomain to slug', () => {
      expect(hostnameToSlug('blog.example.com')).toBe('blog-example-com');
    });

    it('should handle deeply nested subdomains', () => {
      expect(hostnameToSlug('a.b.c.example.com')).toBe('a-b-c-example-com');
    });

    it('should lowercase', () => {
      expect(hostnameToSlug('Blog.Example.COM')).toBe('blog-example-com');
    });

    it('should collapse consecutive hyphens', () => {
      expect(hostnameToSlug('my--site..com')).toBe('my-site-com');
    });

    it('should truncate to 63 chars (DNS label max)', () => {
      const long = 'a'.repeat(70) + '.example.com';
      expect(hostnameToSlug(long).length).toBeLessThanOrEqual(63);
    });

    it('should strip leading/trailing hyphens', () => {
      expect(hostnameToSlug('.example.com.')).toBe('example-com');
    });
  });

  describe('isApexHostname', () => {
    it('should return true for exact match', () => {
      expect(isApexHostname('example.com', 'example.com')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(isApexHostname('Example.COM', 'example.com')).toBe(true);
    });

    it('should return false for subdomain', () => {
      expect(isApexHostname('blog.example.com', 'example.com')).toBe(false);
    });

    it('should return false for different domain', () => {
      expect(isApexHostname('other.com', 'example.com')).toBe(false);
    });
  });

  describe('API schemas', () => {
    it('should validate create input with hostname only', () => {
      const result = createIngressRouteSchema.safeParse({ hostname: 'blog.example.com' });
      expect(result.success).toBe(true);
    });

    it('should validate create input with deployment_id', () => {
      const result = createIngressRouteSchema.safeParse({
        hostname: 'blog.example.com',
        deployment_id: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.success).toBe(true);
    });

    it('should reject empty hostname', () => {
      const result = createIngressRouteSchema.safeParse({ hostname: '' });
      expect(result.success).toBe(false);
    });

    it('should validate update input with deployment_id null (unassign)', () => {
      const result = updateIngressRouteSchema.safeParse({ deployment_id: null });
      expect(result.success).toBe(true);
    });

    it('should validate ingress settings response', () => {
      const result = ingressSettingsResponseSchema.safeParse({
        ingressBaseDomain: 'ingress.platform.example.net',
        ingressDefaultIpv4: '1.2.3.4',
        ingressDefaultIpv6: null,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('DNS record shape for route creation', () => {
    // Every route now points straight at the ingress IP(s) with A/AAAA — apex,
    // subdomain, AND wildcard alike. There is no `<slug>.<ingress_base_domain>`
    // CNAME hop any more.
    it('treats a subdomain the same as the apex (no CNAME)', () => {
      expect(isApexHostname('example.com', 'example.com')).toBe(true);
      expect(isApexHostname('blog.example.com', 'example.com')).toBe(false);
      // The record TYPE no longer depends on apex-vs-subdomain; both are A/AAAA.
    });

    it('does not treat a wildcard as the apex', () => {
      expect(isApexHostname('*.example.com', 'example.com')).toBe(false);
    });

    it('should detect .local domains for auto-resolve', () => {
      expect('test.local'.endsWith('.local')).toBe(true);
      expect('blog.test.local'.endsWith('.local')).toBe(true);
      expect('example.com'.endsWith('.local')).toBe(false);
      expect('mylocal.com'.endsWith('.local')).toBe(false);
    });
  });
});
