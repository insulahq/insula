// Resolve an image TAG to the digest the registry currently serves for it.
//
// This is what makes "auto-update" mean something precise. The updates pill
// (update-checker.ts) answers a different question — "is there a newer TAG?" —
// by listing tags and comparing semver. Auto-update deliberately never moves a
// tenant across a version boundary, so it needs the other question: "has the
// tag they already pinned been republished?"
//
//   GET/HEAD https://<registry>/v2/<repository>/manifests/<tag>
//     Accept: <the four manifest media types>
//   → 200 with `Docker-Content-Digest: sha256:…`
//
// The Accept header matters. Without it registries default to the legacy v1
// schema and return a DIFFERENT digest than the one the kubelet resolves,
// which would make every check look like "the image changed" and roll the
// tenant's pods every hour, forever.
//
// HEAD is tried first (no body, cheapest); some registries — notably older
// GitLab and Harbor builds — answer HEAD with 405, so we fall back to GET.
//
// Failure is always `null`, never a throw: a registry being down must not roll
// a workload, and must not take the scheduler with it.

import {
  DOCKER_HUB_INDEX_HOST,
  fetchBearerToken,
  isRealmUrlBlocked,
  timedFetch,
} from './update-checker.js';
import type { ParsedImageReference } from './image-reference.js';

const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Manifest media types, widest first. A multi-arch image is an index/list;
 * asking only for the single-arch types makes a registry either 404 or hand
 * back a per-arch manifest whose digest is NOT the one `image:tag` resolves to.
 */
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export interface ResolveDigestOptions {
  readonly authCreds?: { username: string; password: string };
  readonly fetchImpl?: typeof fetch;
}

export interface DigestResolution {
  /** `sha256:…`, or null when the registry could not be consulted. */
  readonly digest: string | null;
  /** Human-readable cause when digest is null. Surfaced in logs only. */
  readonly reason: string | null;
}

/** `sha256:` + 64 lowercase hex. Anything else is a hostile/garbage header. */
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export async function resolveTagDigest(
  ref: ParsedImageReference,
  tag: string,
  opts: ResolveDigestOptions = {},
): Promise<DigestResolution> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const host = ref.registryHost === 'docker.io' ? DOCKER_HUB_INDEX_HOST : ref.registryHost;
  const url = `https://${host}/v2/${ref.repository}/manifests/${encodeURIComponent(tag)}`;

  // SSRF: `host` comes from the TENANT's image reference, and this runs at
  // validate/create time, so `image: 169.254.169.254/x:1` or
  // `image: kubernetes.default.svc/x:1` would otherwise make platform-api
  // issue a request into the cluster from a pod with broad reach. The
  // WWW-Authenticate realm below has been guarded since it was written; the
  // manifest URL itself was not — the same validator now covers both.
  //
  // Until 2026-09-04 CRS 934110/934190 caught part of this at the edge by
  // accident. That family is now excluded on the custom-deployment endpoints
  // (a compose file legitimately contains internal hostnames), so this is the
  // only control left. Do not remove it.
  if (isRealmUrlBlocked(url)) {
    return { digest: null, reason: 'registry host is not a public address' };
  }

  const headers = { accept: MANIFEST_ACCEPT };

  const read = async (method: 'HEAD' | 'GET'): Promise<Response | null> => {
    try {
      const first = await timedFetch(fetchImpl, url, { method, headers }, REQUEST_TIMEOUT_MS);
      if (first.status !== 401) return first;
      const wwwAuth = first.headers.get('www-authenticate');
      if (!wwwAuth) return first;
      // fetchBearerToken carries the SSRF / PAT-exfiltration guard on the
      // realm URL — do not bypass it with a hand-rolled token exchange.
      const token = await fetchBearerToken(fetchImpl, wwwAuth, opts.authCreds);
      if (!token) return first;
      return await timedFetch(
        fetchImpl,
        url,
        { method, headers: { ...headers, authorization: `Bearer ${token}` } },
        REQUEST_TIMEOUT_MS,
      );
    } catch {
      return null;
    }
  };

  let res = await read('HEAD');
  // 405/501: registry refuses HEAD on manifests. 400 shows up on a few
  // proxies that mishandle a body-less manifest request.
  if (res && (res.status === 405 || res.status === 501 || res.status === 400)) {
    res = await read('GET');
  }
  if (!res) return { digest: null, reason: 'registry unreachable or timed out' };

  if (res.status === 401 || res.status === 403) {
    return { digest: null, reason: `registry denied access (${res.status})` };
  }
  if (res.status === 404) return { digest: null, reason: 'tag not found (404)' };
  if (res.status === 429) return { digest: null, reason: 'registry rate limited (429)' };
  if (res.status >= 500) return { digest: null, reason: `registry ${res.status}` };
  if (res.status !== 200) return { digest: null, reason: `unexpected status ${res.status}` };

  const digest = res.headers.get('docker-content-digest');
  if (!digest) {
    // Rare but real: some registries omit the header on GET. Without it we
    // cannot compare anything, and guessing would roll pods for no reason.
    return { digest: null, reason: 'registry omitted Docker-Content-Digest' };
  }
  const normalised = digest.trim().toLowerCase();
  if (!DIGEST_RE.test(normalised)) {
    return { digest: null, reason: 'registry returned a malformed digest' };
  }
  return { digest: normalised, reason: null };
}

/**
 * Compare a registry digest against what the pods are actually running.
 *
 * `runningImageId` is `containerStatuses[].imageID`, which the status
 * reconciler already records into custom_deployment_image_audit. Its shape is
 * `<repo>@sha256:…` (sometimes `docker-pullable://<repo>@sha256:…`), so the
 * digest has to be extracted rather than compared whole.
 *
 * Returns false when either side is unknown — "we could not tell" must never
 * be treated as "it changed", or an unreachable registry would roll every
 * auto-update workload on the platform every hour.
 */
export function digestChanged(runningImageId: string | null, registryDigest: string | null): boolean {
  if (!runningImageId || !registryDigest) return false;
  const running = extractDigest(runningImageId);
  if (!running) return false;
  return running !== registryDigest.trim().toLowerCase();
}

/** Pull the `sha256:…` out of an imageID / pinned reference. Null if absent. */
export function extractDigest(imageId: string): string | null {
  const at = imageId.lastIndexOf('sha256:');
  if (at === -1) return null;
  const candidate = imageId.slice(at).trim().toLowerCase();
  return DIGEST_RE.test(candidate) ? candidate : null;
}
