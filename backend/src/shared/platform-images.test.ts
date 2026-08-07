/**
 * The runtime-image table.
 *
 * This exists because the per-call-site `process.env.X ?? 'literal'` pattern had
 * already failed twice, silently, in ways that look correct when you read them:
 *   * tenant-backup-tools was a bare const in SIX modules with no env read at
 *     all — the most-used image in the platform could not be repointed;
 *   * node-terminal's comment promised NODE_TERMINAL_IMAGE was honoured and
 *     nothing read it.
 * Neither would fail a build, a test, or a deploy. They just quietly ignored the
 * operator. So the contract gets asserted rather than described.
 */
import { describe, it, expect } from 'vitest';
import {
  PLATFORM_IMAGES,
  resolvePlatformImage,
  type PlatformImageName,
} from './platform-images.js';

const NAMES = Object.keys(PLATFORM_IMAGES) as PlatformImageName[];

describe('resolvePlatformImage', () => {
  it.each(NAMES)('%s honours its env var', (name) => {
    const pinned =
      `ghcr.io/insulahq/insula/${name}:abc1234` +
      '@sha256:2222222222222222222222222222222222222222222222222222222222222222';
    expect(resolvePlatformImage(name, { [PLATFORM_IMAGES[name].env]: pinned })).toBe(pinned);
  });

  it.each(NAMES)('%s falls back when unset', (name) => {
    expect(resolvePlatformImage(name, {})).toBe(PLATFORM_IMAGES[name].fallback);
  });

  it.each(NAMES)('%s treats empty/whitespace as unset', (name) => {
    // An `optional: true` configMapKeyRef whose key is missing can surface as ""
    // — which as an image reference makes the Pod unschedulable with an opaque
    // error rather than falling back to something that runs.
    const env = PLATFORM_IMAGES[name].env;
    expect(resolvePlatformImage(name, { [env]: '' })).toBe(PLATFORM_IMAGES[name].fallback);
    expect(resolvePlatformImage(name, { [env]: '  ' })).toBe(PLATFORM_IMAGES[name].fallback);
  });

  it('trims a stray newline from the ConfigMap value', () => {
    // YAML block scalars and hand-edits both produce trailing whitespace; an
    // untrimmed reference fails to pull with a confusing "invalid reference".
    expect(
      resolvePlatformImage('node-terminal', { NODE_TERMINAL_IMAGE: ' ghcr.io/x/y:1 \n' }),
    ).toBe('ghcr.io/x/y:1');
  });

  it('every env var is unique — a collision would silently alias two images', () => {
    const envs = NAMES.map((n) => PLATFORM_IMAGES[n].env);
    expect(new Set(envs).size).toBe(envs.length);
  });

  it('every fallback is a fully-qualified ghcr reference', () => {
    // A bare name resolves to docker.io on a real cluster and ImagePullBackOffs
    // — that exact bug shipped for file-manager and was only caught on the
    // prod-mirror staging in 2026-06.
    for (const n of NAMES) {
      expect(PLATFORM_IMAGES[n].fallback).toMatch(/^ghcr\.io\/insulahq\/insula\/[a-z-]+:.+$/);
    }
  });
});
