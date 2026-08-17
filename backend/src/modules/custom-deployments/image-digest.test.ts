import { describe, it, expect, vi } from 'vitest';
import { resolveTagDigest, digestChanged, extractDigest } from './image-digest.js';
import type { ParsedImageReference } from './image-reference.js';

const REF: ParsedImageReference = {
  registryHost: 'docker.io',
  repository: 'library/nginx',
  tag: '1.27',
  digest: null,
};

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;

function res(status: number, headers: Record<string, string> = {}): Response {
  return { status, headers: new Headers(headers) } as unknown as Response;
}

describe('resolveTagDigest', () => {
  it('returns the digest from Docker-Content-Digest', async () => {
    const fetchImpl = vi.fn(async () => res(200, { 'docker-content-digest': DIGEST_A }));
    const r = await resolveTagDigest(REF, '1.27', { fetchImpl: fetchImpl as never });
    expect(r.digest).toBe(DIGEST_A);
    expect(r.reason).toBeNull();
  });

  // Without the manifest-list Accept types a registry hands back the legacy
  // schema, whose digest differs from what the kubelet resolves — every hourly
  // check would then look like "the image changed" and roll the pods forever.
  it('asks for manifest-list/index types, not just single-arch', async () => {
    const fetchImpl = vi.fn(async () => res(200, { 'docker-content-digest': DIGEST_A }));
    await resolveTagDigest(REF, '1.27', { fetchImpl: fetchImpl as never });
    const accept = String((fetchImpl.mock.calls[0][1] as RequestInit).headers?.['accept' as never]);
    expect(accept).toContain('manifest.list.v2+json');
    expect(accept).toContain('image.index.v1+json');
  });

  it('maps docker.io to the distribution host', async () => {
    const fetchImpl = vi.fn(async () => res(200, { 'docker-content-digest': DIGEST_A }));
    await resolveTagDigest(REF, '1.27', { fetchImpl: fetchImpl as never });
    expect(String(fetchImpl.mock.calls[0][0])).toContain('registry-1.docker.io');
  });

  it('falls back to GET when the registry rejects HEAD', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(405))
      .mockResolvedValueOnce(res(200, { 'docker-content-digest': DIGEST_A }));
    const r = await resolveTagDigest(REF, '1.27', { fetchImpl: fetchImpl as never });
    expect(r.digest).toBe(DIGEST_A);
    expect((fetchImpl.mock.calls[0][1] as RequestInit).method).toBe('HEAD');
    expect((fetchImpl.mock.calls[1][1] as RequestInit).method).toBe('GET');
  });

  // Every failure path must yield null. A thrown error would take the whole
  // scheduler pass down; a fabricated digest would roll pods for no reason.
  it.each([
    [401, 'denied'],
    [403, 'denied'],
    [404, 'not found'],
    [429, 'rate limited'],
    [500, 'registry 500'],
    [418, 'unexpected status'],
  ])('returns null for HTTP %i', async (status) => {
    const fetchImpl = vi.fn(async () => res(status));
    const r = await resolveTagDigest(REF, '1.27', { fetchImpl: fetchImpl as never });
    expect(r.digest).toBeNull();
    expect(r.reason).toBeTruthy();
  });

  it('returns null when the digest header is missing', async () => {
    const fetchImpl = vi.fn(async () => res(200));
    const r = await resolveTagDigest(REF, '1.27', { fetchImpl: fetchImpl as never });
    expect(r.digest).toBeNull();
    expect(r.reason).toMatch(/omitted/);
  });

  it('rejects a malformed digest instead of trusting it', async () => {
    const fetchImpl = vi.fn(async () => res(200, { 'docker-content-digest': 'sha256:nope' }));
    const r = await resolveTagDigest(REF, '1.27', { fetchImpl: fetchImpl as never });
    expect(r.digest).toBeNull();
  });

  it('never throws when the network does', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const r = await resolveTagDigest(REF, '1.27', { fetchImpl: fetchImpl as never });
    expect(r.digest).toBeNull();
    expect(r.reason).toMatch(/unreachable|timed out/);
  });
});

describe('extractDigest', () => {
  it('pulls the digest out of a kubelet imageID', () => {
    expect(extractDigest(`nginx@${DIGEST_A}`)).toBe(DIGEST_A);
  });
  it('handles the docker-pullable:// prefix kubelet sometimes emits', () => {
    expect(extractDigest(`docker-pullable://nginx@${DIGEST_A}`)).toBe(DIGEST_A);
  });
  it('is null for a plain tag reference', () => {
    expect(extractDigest('nginx:1.27')).toBeNull();
  });
  it('is null for a truncated digest', () => {
    expect(extractDigest('nginx@sha256:abc')).toBeNull();
  });
});

// THE safety property. "We could not tell" must never be read as "it changed",
// or one bad hour at a registry rolls every auto-update workload on the
// platform — repeatedly, since a failed probe never resolves to a match.
describe('digestChanged', () => {
  it('is true only when both are known AND differ', () => {
    expect(digestChanged(`nginx@${DIGEST_A}`, DIGEST_B)).toBe(true);
  });
  it('is false when they match', () => {
    expect(digestChanged(`nginx@${DIGEST_A}`, DIGEST_A)).toBe(false);
  });
  it('is false when the registry digest is unknown', () => {
    expect(digestChanged(`nginx@${DIGEST_A}`, null)).toBe(false);
  });
  it('is false when nothing is running yet', () => {
    expect(digestChanged(null, DIGEST_A)).toBe(false);
  });
  it('is false when the running reference carries no digest', () => {
    expect(digestChanged('nginx:1.27', DIGEST_A)).toBe(false);
  });
  it('ignores case and whitespace from the registry header', () => {
    expect(digestChanged(`nginx@${DIGEST_A}`, ` ${DIGEST_A.toUpperCase()} `)).toBe(false);
  });
});
