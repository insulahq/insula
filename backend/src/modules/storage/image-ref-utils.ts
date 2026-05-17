/**
 * Container image reference normalisation helpers.
 *
 * Kubelet always reports the canonical Docker form on
 * `node.status.images[].names` — e.g.
 *   `docker.io/library/nginx:latest`
 *   `docker.io/serversideup/php:8.4-fpm-nginx-alpine`
 *   `ghcr.io/foo/bar:v1`
 * Operator-typed catalog entries usually drop the registry prefix —
 *   `nginx:latest`, `serversideup/php:tag`, `ghcr.io/foo/bar:v1`.
 * Comparing the two forms with raw string equality misses every
 * Docker Hub user image, which was the 2026-05-17 reaper bug: the
 * reaper's node-presence check rejected `docker.io/serversideup/php:tag`
 * because it didn't equal the catalog's `serversideup/php:tag`, so
 * the reaper logged a no-op "success" and the image stayed on the
 * node forever.
 *
 * `canonicalImageRef` normalises any reference to the long form so
 * the comparison reduces to a single `===`.
 *
 * No dependencies — both `image-reaper.ts` and `service.ts` can
 * import this without a cycle (image-reaper.ts also imports from
 * service.ts; service.ts can't import back).
 */

/**
 * Return the canonical Docker reference for `ref`.
 *
 * Rules:
 *
 *   - bare digest (`sha256:...`)        → unchanged — kubelet reports
 *                                          bare digests as-is on
 *                                          `images[].names`; expanding
 *                                          to `docker.io/library/sha256:...`
 *                                          would silently miss every node
 *                                          presence check.
 *   - no `/`                            → `docker.io/library/<ref>`
 *   - one `/` and head has no `.`, no
 *     `:`, and isn't `localhost`        → `docker.io/<ref>`  (Docker Hub user)
 *   - otherwise (`<host>/...`,
 *     `<host>:<port>/...`,
 *     `localhost/...`,
 *     more than one `/`)                → unchanged (explicit registry)
 *
 * Tag suffixes (`:v1`) and digest suffixes (`@sha256:...`) only
 * appear after the image-name segment, so they never interact with
 * the registry-prefix logic.
 *
 * The function is total: it returns the input unchanged for empty
 * strings and any ref shape outside the documented set, so callers
 * never need to handle null.
 */
export function canonicalImageRef(ref: string): string {
  if (!ref) return ref;
  // Bare digest refs like `sha256:abc...` are reported by kubelet as-
  // is on `node.status.images[].names`. Prepending `docker.io/library/`
  // here would mean the canonical comparison silently misses the node
  // presence check for digest-only references (an unusual but valid
  // shape — e.g. a catalog entry pinned by digest with no tag at all).
  if (ref.startsWith('sha256:')) return ref;
  const slashCount = (ref.match(/\//g) ?? []).length;
  if (slashCount === 0) {
    // `nginx:latest` → `docker.io/library/nginx:latest`
    return `docker.io/library/${ref}`;
  }
  if (slashCount === 1) {
    const head = ref.slice(0, ref.indexOf('/'));
    // Docker Hub user (`serversideup/php:tag`) vs. registry+image
    // (`localhost:5000/img:tag`, `ghcr.io/foo:tag`). Heuristic: a real
    // registry hostname contains `.` (gcr.io, ghcr.io, quay.io) or `:`
    // (localhost:5000) or is literally `localhost`. Anything else is
    // treated as a Docker Hub user.
    const isRegistry = head.includes('.') || head.includes(':') || head === 'localhost';
    if (!isRegistry) {
      return `docker.io/${ref}`;
    }
  }
  return ref;
}
