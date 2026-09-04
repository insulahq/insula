// Pre-flight image validation for custom deployments.
//
// Before this, a wrong image reference (a typo, a nonexistent tag) sailed
// through validation and only surfaced minutes later as ImagePullBackOff. This
// checks, at validate/create time, that:
//   1. the reference PARSES (a garbage string is rejected outright), and
//   2. the image is REACHABLE — the registry actually has that tag/digest.
//
// Failure taxonomy is deliberate to avoid false rejections:
//   - unparseable / 404 tag-not-found  → ERROR (the user got the name wrong)
//   - 401/403 access denied, NO creds  → WARNING (likely private; attach creds)
//   - 401/403 access denied, WITH creds→ ERROR (the token itself is rejected —
//                                        the kubelet will fail the same pull)
//   - unreachable / 429 / 5xx / no-hdr → WARNING (transient; pulled at deploy)
//
// Runs creds-less by default: a public typo returns 404 (hard error) while a
// private image returns 401 (warning, never a false block). Callers may pass
// resolved pull credentials to verify private images precisely.

import { parseImageReference } from './image-reference.js';
import { resolveTagDigest } from './image-digest.js';
import type { CustomDeploymentIssue } from '@insula/api-contracts';

export interface ImageReachabilityDeps {
  /** Injectable for tests; defaults to the real registry probe. */
  readonly resolve?: typeof resolveTagDigest;
}

/**
 * Validate one image reference. Returns [] when reachable, otherwise one issue.
 * `authCreds` are used for private registries; omit for a public probe.
 */
export async function checkImageReachable(
  image: string,
  path: string,
  authCreds?: { username: string; password: string },
  deps: ImageReachabilityDeps = {},
): Promise<CustomDeploymentIssue[]> {
  const ref = parseImageReference(image);
  if (!ref) {
    return [{
      severity: 'error',
      code: 'INVALID_IMAGE_REFERENCE',
      path,
      message: `Image '${image}' is not a valid image reference.`,
      hint: 'Use the form [registry/]repository[:tag] or [registry/]repository@sha256:<digest>, e.g. `nginx:1.27.3` or `ghcr.io/acme/app@sha256:…`.',
    }];
  }

  // A tag ref is verified by tag; a digest-pinned ref by its digest (registries
  // resolve /manifests/<digest> too). parseImageReference guarantees one exists.
  const reference = ref.tag ?? ref.digest;
  if (!reference) return [];

  const resolve = deps.resolve ?? resolveTagDigest;
  const { digest, reason } = await resolve(ref, reference, authCreds ? { authCreds } : {});
  if (digest) return []; // reachable

  const r = (reason ?? 'unknown').toLowerCase();
  if (r.includes('not found') || r.includes('404')) {
    return [{
      severity: 'error',
      code: 'IMAGE_NOT_FOUND',
      path,
      message: `Image '${image}' was not found in the registry (${reason}).`,
      hint: 'Check the repository name and tag. The container cannot start until this resolves.',
    }];
  }
  if (r.includes('denied') || r.includes('401') || r.includes('403')) {
    // Denied WITH a credential attached is a different fact from denied
    // without one. Creds-less, 401 only means "this image is private", which
    // is not an error — that is why this branch warns. But if the tenant
    // supplied a token for this very registry and the registry still refuses,
    // the token is wrong, expired, or lacks read scope on the package, and the
    // kubelet will fail the pull for exactly the same reason a minute later.
    // Say so now, while the tenant is still looking at the form.
    if (authCreds) {
      return [{
        severity: 'error',
        code: 'IMAGE_CREDENTIAL_REJECTED',
        path,
        message: `The registry rejected the supplied credentials for '${image}' (${reason}).`,
        hint: 'Check the username and token, and that the token has read access to this package. A token that cannot read the image now will not be able to pull it at deploy time either.',
      }];
    }
    return [{
      severity: 'warning',
      code: 'IMAGE_ACCESS_DENIED',
      path,
      message: `Could not verify '${image}': ${reason}.`,
      hint: 'If this is a private image, attach pull credentials — otherwise the pull will fail at deploy time.',
    }];
  }
  return [{
    severity: 'warning',
    code: 'IMAGE_CHECK_INCONCLUSIVE',
    path,
    message: `Could not verify '${image}' right now: ${reason}.`,
    hint: 'The registry was unreachable or throttled; the image will be pulled when the container starts.',
  }];
}

/** Convenience: any hard error among the issues (used to gate create). */
export function hasImageError(issues: readonly CustomDeploymentIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
