import { describe, it, expect } from 'vitest';
import { imageIsOnRegistry } from './service.js';

/**
 * Guards the create-time pre-flight against handing a tenant's PAT to the
 * wrong registry.
 *
 * The probe authenticates by answering the registry's own WWW-Authenticate
 * challenge, so passing the supplied credential to EVERY service in a compose
 * stack would send a `ghcr.io` token to Docker Hub's auth realm the moment a
 * stack mixed registries — which is the normal case (`ghcr.io/acme/app` next
 * to `redis:7`). The rendered dockerconfigjson Secret is already host-scoped;
 * these assert the pre-flight matches it.
 */
describe('imageIsOnRegistry', () => {
  it('matches an explicit host', () => {
    expect(imageIsOnRegistry('ghcr.io/acme/app:1.4', 'ghcr.io')).toBe(true);
    expect(imageIsOnRegistry('registry.example.test/acme/app:1', 'registry.example.test')).toBe(true);
  });

  // The whole point: a ghcr PAT must never travel to Docker Hub.
  it('does NOT match a different host', () => {
    expect(imageIsOnRegistry('redis:7-alpine', 'ghcr.io')).toBe(false);
    expect(imageIsOnRegistry('docker.io/library/redis:7', 'ghcr.io')).toBe(false);
    expect(imageIsOnRegistry('ghcr.io/acme/app:1', 'quay.io')).toBe(false);
    expect(imageIsOnRegistry('registry.example.test/a/b:1', 'registry.other.test')).toBe(false);
  });

  // A bare `redis:7` normalises to docker.io, and operators type any of the
  // three Docker Hub names — a real Docker Hub credential must still apply.
  it.each([
    ['redis:7-alpine', 'docker.io'],
    ['redis:7-alpine', 'index.docker.io'],
    ['redis:7-alpine', 'registry-1.docker.io'],
    ['docker.io/library/redis:7', 'index.docker.io'],
    ['owner/app:1', 'docker.io'],
  ])('treats %s and %s as the same registry', (image, host) => {
    expect(imageIsOnRegistry(image, host)).toBe(true);
  });

  it('is case- and whitespace-insensitive on the supplied host', () => {
    expect(imageIsOnRegistry('ghcr.io/acme/app:1', '  GHCR.io ')).toBe(true);
  });

  // Port-bearing hosts are a distinct registry from the same name on :443.
  it('treats a port suffix as part of the host', () => {
    expect(imageIsOnRegistry('registry.example.test:5000/a/b:1', 'registry.example.test:5000')).toBe(true);
    expect(imageIsOnRegistry('registry.example.test:5000/a/b:1', 'registry.example.test')).toBe(false);
  });

  // Fail CLOSED: an unparseable reference must not be treated as a match, or a
  // garbage image string would leak the token to whatever the probe resolves.
  it('returns false for an unparseable image reference', () => {
    expect(imageIsOnRegistry('', 'ghcr.io')).toBe(false);
    expect(imageIsOnRegistry('!!not a ref!!', 'ghcr.io')).toBe(false);
  });
});
