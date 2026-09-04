/**
 * Tests for the archive Job's Stalwart image resolution.
 *
 * Why this has its own test file: the constant it replaces sat at v0.16.5 while
 * the server ran v0.16.14 — eleven releases of silent drift. The export/import
 * binary reads the server's own RocksDB store, so "matches whatever is actually
 * running" is the invariant worth pinning down, and the fallback path must stay
 * a fallback (a resolver that quietly always returns the literal would look
 * identical in production until the day it didn't).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  resolveStalwartImage,
  resolveRocksdbCheckpointImage,
  ROCKSDB_SECONDARY_IMAGE_FALLBACK,
} from './archive.js';

type AppsStub = Parameters<typeof resolveStalwartImage>[0];

function appsReturning(containers: Array<{ name?: string; image?: string }>): AppsStub {
  return {
    readNamespacedDeployment: vi.fn(async () => ({
      spec: { template: { spec: { containers } } },
    })),
  } as unknown as AppsStub;
}

const FALLBACK = 'docker.io/stalwartlabs/stalwart:v0.16.20';

describe('resolveStalwartImage', () => {
  it('uses the image the live Deployment is actually running', async () => {
    const apps = appsReturning([{ name: 'stalwart', image: 'docker.io/stalwartlabs/stalwart:v0.99.0' }]);
    await expect(resolveStalwartImage(apps, {})).resolves.toBe(
      'docker.io/stalwartlabs/stalwart:v0.99.0',
    );
  });

  it('picks the stalwart container, not merely the first one', async () => {
    // The mail pod carries sidecars (rsyncd) and init containers; taking
    // containers[0] would ship the archive Job an rsync image.
    const apps = appsReturning([
      { name: 'rsyncd', image: 'ghcr.io/insulahq/insula/rsyncd:latest' },
      { name: 'stalwart', image: 'docker.io/stalwartlabs/stalwart:v0.16.20' },
    ]);
    await expect(resolveStalwartImage(apps, {})).resolves.toBe(
      'docker.io/stalwartlabs/stalwart:v0.16.20',
    );
  });

  it('falls back to matching on the image name when the container is renamed', async () => {
    const apps = appsReturning([
      { name: 'sidecar', image: 'ghcr.io/x/y:1' },
      { name: 'mail', image: 'docker.io/stalwartlabs/stalwart:v0.16.15' },
    ]);
    await expect(resolveStalwartImage(apps, {})).resolves.toBe(
      'docker.io/stalwartlabs/stalwart:v0.16.15',
    );
  });

  it('honours an explicit STALWART_IMAGE override without touching the cluster', async () => {
    const apps = appsReturning([{ name: 'stalwart', image: 'docker.io/stalwartlabs/stalwart:v0.1.0' }]);
    await expect(
      resolveStalwartImage(apps, { STALWART_IMAGE: 'registry.example.test/stalwart:pinned' }),
    ).resolves.toBe('registry.example.test/stalwart:pinned');
    expect((apps as unknown as { readNamespacedDeployment: ReturnType<typeof vi.fn> }).readNamespacedDeployment)
      .not.toHaveBeenCalled();
  });

  it('falls back and WARNS when the Deployment cannot be read', async () => {
    const warn = vi.fn();
    const apps = {
      readNamespacedDeployment: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    } as unknown as AppsStub;
    await expect(resolveStalwartImage(apps, {}, { warn })).resolves.toBe(FALLBACK);
    expect(warn).toHaveBeenCalled();
  });

  it('falls back and WARNS when no stalwart container is present', async () => {
    const warn = vi.fn();
    const apps = appsReturning([{ name: 'rsyncd', image: 'ghcr.io/insulahq/insula/rsyncd:latest' }]);
    await expect(resolveStalwartImage(apps, {}, { warn })).resolves.toBe(FALLBACK);
    expect(warn).toHaveBeenCalled();
  });

  it('keeps the SOURCE fallback in lockstep with the deployment manifest', async () => {
    // The whole point of the change: that literal must not drift from the pin
    // again. Compare the value the RESOLVER actually returns (drive it down the
    // fallback path) against the manifest — comparing the test file's own copy
    // of the string would pass while the source drifted, which is precisely the
    // failure mode this guards.
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const manifest = await fs.readFile(
      path.resolve(here, '../../../../k8s/base/stalwart-mail/stalwart/deployment.yaml'),
      'utf8',
    );
    const pinned = manifest.match(/image:\s*(docker\.io\/stalwartlabs\/stalwart:[^\s]+)/)?.[1];
    expect(pinned, 'no stalwart image found in deployment.yaml').toBeTruthy();

    const unreadable = {
      readNamespacedDeployment: vi.fn(async () => {
        throw new Error('forced fallback');
      }),
    } as unknown as AppsStub;
    const sourceFallback = await resolveStalwartImage(unreadable, {}, { warn: vi.fn() });
    expect(sourceFallback).toBe(pinned);
  });
});

/**
 * The mail-archive CHECKPOINT image (initContainer #1 of the no_downtime path,
 * which is DEFAULT_ARCHIVE_MODE — so this runs on every operator-triggered
 * archive, against the live mail store).
 *
 * Same drift concern as the Stalwart resolver above, one level worse: this
 * binary opens the live RocksDB directly. On a real cluster the value comes from
 * platform-config as an immutable `:<tag>@sha256:<digest>` written by the
 * image's own CI; the literal below is a local/DinD fallback. A resolver that
 * quietly always returned the fallback would look identical in production until
 * the day the ConfigMap wiring broke and every archive silently ran `:latest`.
 */
describe('resolveRocksdbCheckpointImage', () => {
  it('uses the digest-pinned reference the ConfigMap supplies', () => {
    const pinned =
      'ghcr.io/insulahq/insula/rocksdb-secondary-checkpoint:20260807103130-abc1234' +
      '@sha256:1111111111111111111111111111111111111111111111111111111111111111';
    expect(
      resolveRocksdbCheckpointImage({ ROCKSDB_SECONDARY_CHECKPOINT_IMAGE: pinned }),
    ).toBe(pinned);
  });

  it('falls back to the in-code default when the env var is absent', () => {
    expect(resolveRocksdbCheckpointImage({})).toBe(ROCKSDB_SECONDARY_IMAGE_FALLBACK);
  });

  it('treats an empty or whitespace-only value as unset', () => {
    // An unset ConfigMap key (optional: true) can surface as "" rather than
    // undefined; "" as an image reference would make the Job unschedulable with
    // an opaque error instead of falling back.
    expect(resolveRocksdbCheckpointImage({ ROCKSDB_SECONDARY_CHECKPOINT_IMAGE: '' })).toBe(
      ROCKSDB_SECONDARY_IMAGE_FALLBACK,
    );
    expect(resolveRocksdbCheckpointImage({ ROCKSDB_SECONDARY_CHECKPOINT_IMAGE: '   ' })).toBe(
      ROCKSDB_SECONDARY_IMAGE_FALLBACK,
    );
  });

  it('the fallback is a real reference, and is the ONLY mutable one we ship', () => {
    // If this literal ever gains a digest, the pin wiring has been superseded and
    // this test should be updated deliberately rather than silently.
    expect(ROCKSDB_SECONDARY_IMAGE_FALLBACK).toMatch(
      /^ghcr\.io\/insulahq\/insula\/rocksdb-secondary-checkpoint:latest$/,
    );
  });
});
