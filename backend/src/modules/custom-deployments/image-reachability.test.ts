import { describe, it, expect } from 'vitest';
import { checkImageReachable } from './image-reachability.js';

const resolveTo = (r: { digest: string | null; reason: string | null }) =>
  async () => r;

describe('checkImageReachable', () => {
  it('rejects a malformed reference outright (no network call)', async () => {
    let called = false;
    const issues = await checkImageReachable('NOT A VALID IMAGE!!', 'services.web.image',
      undefined, { resolve: async () => { called = true; return { digest: null, reason: 'x' }; } });
    expect(called).toBe(false);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'error', code: 'INVALID_IMAGE_REFERENCE' });
  });

  it('passes when the registry resolves the tag', async () => {
    const issues = await checkImageReachable('nginx:1.27.3', 'services.web.image',
      undefined, { resolve: resolveTo({ digest: 'sha256:' + 'a'.repeat(64), reason: null }) });
    expect(issues).toEqual([]);
  });

  it('hard-errors on a 404 (typo / nonexistent tag)', async () => {
    const issues = await checkImageReachable('nginx:9.9.9-doesnotexist', 'services.web.image',
      undefined, { resolve: resolveTo({ digest: null, reason: 'tag not found (404)' }) });
    expect(issues[0]).toMatchObject({ severity: 'error', code: 'IMAGE_NOT_FOUND' });
  });

  it('only WARNS on access-denied (likely private) — never a false block', async () => {
    const issues = await checkImageReachable('ghcr.io/acme/private:1', 'services.web.image',
      undefined, { resolve: resolveTo({ digest: null, reason: 'registry denied access (401)' }) });
    expect(issues[0]).toMatchObject({ severity: 'warning', code: 'IMAGE_ACCESS_DENIED' });
  });

  it('only WARNS on a transient registry failure', async () => {
    for (const reason of ['registry unreachable or timed out', 'registry rate limited (429)', 'registry 503']) {
      const issues = await checkImageReachable('nginx:1.27.3', 'services.web.image',
        undefined, { resolve: resolveTo({ digest: null, reason }) });
      expect(issues[0]).toMatchObject({ severity: 'warning', code: 'IMAGE_CHECK_INCONCLUSIVE' });
    }
  });

  it('verifies a digest-pinned reference by its digest', async () => {
    let asked: string | undefined;
    const digest = 'sha256:' + 'b'.repeat(64);
    const issues = await checkImageReachable(`nginx@${digest}`, 'services.web.image', undefined, {
      resolve: async (_ref, reference) => { asked = reference; return { digest, reason: null }; },
    });
    expect(asked).toBe(digest);
    expect(issues).toEqual([]);
  });
});
