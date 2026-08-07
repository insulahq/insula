/**
 * Platform-owned images the backend launches at RUNTIME (Jobs, initContainers,
 * sidecars) — resolved in ONE place.
 *
 * WHY THIS EXISTS
 *   These images never appear in a k8s manifest: the backend builds the Pod spec
 *   and puts the reference in itself. That makes them invisible to the
 *   kustomization `images:` transformer, so `pin-image-tag.sh` never covered them
 *   and every one sat on a mutable `:latest`. On a real cluster each is now
 *   supplied as an IMMUTABLE `<tag>@sha256:<digest>` through platform-config →
 *   configMapKeyRef → env, written by the image's own CI after the push
 *   (.github/scripts/pin-config-image.sh).
 *
 *   The literals below are LOCAL/DinD fallbacks only.
 *
 * WHY A TABLE INSTEAD OF `process.env.X ?? 'literal'` AT EACH CALL SITE
 *   Because that pattern had already rotted in two different ways when this was
 *   written (2026-08-07):
 *     * tenant-backup-tools was referenced from SIX modules (backup-restore
 *       executors, storage-lifecycle, tenant-bundles, mail-admin) via a
 *       module-local `TOOLS_IMAGE_DEFAULT` const with NO env read at all — the
 *       most-used image in the platform could not be repointed by an operator.
 *     * node-terminal's own comment said "overridable via NODE_TERMINAL_IMAGE
 *       env" and nothing anywhere read that variable.
 *   Both look correct at the call site. Neither was. One table means the env
 *   contract is stated once and can be asserted once.
 */

export interface PlatformImageSpec {
  /** Env var the ConfigMap value arrives on (see k8s/base/backend-deployment.yaml). */
  readonly env: string;
  /** Local/DinD fallback. Mutable by design — real clusters override it. */
  readonly fallback: string;
}

export const PLATFORM_IMAGES = {
  'tenant-backup-tools': {
    env: 'TENANT_BACKUP_TOOLS_IMAGE',
    fallback: 'ghcr.io/insulahq/insula/tenant-backup-tools:latest',
  },
  'migration-tools': {
    env: 'PLESK_MIGRATION_TOOLS_IMAGE',
    fallback: 'ghcr.io/insulahq/insula/migration-tools:latest',
  },
  'claim-validator': {
    env: 'CLAIM_VALIDATOR_IMAGE',
    fallback: 'ghcr.io/insulahq/insula/claim-validator:latest',
  },
  'node-terminal': {
    env: 'NODE_TERMINAL_IMAGE',
    fallback: 'ghcr.io/insulahq/insula/node-terminal:latest',
  },
} as const satisfies Record<string, PlatformImageSpec>;

export type PlatformImageName = keyof typeof PLATFORM_IMAGES;

/**
 * Resolve a platform image reference, env first.
 *
 * An empty or whitespace-only value counts as unset: an `optional: true`
 * configMapKeyRef whose key is missing can surface as `""`, and `""` as an image
 * reference makes the Pod unschedulable with an opaque error instead of falling
 * back to something that works.
 */
export function resolvePlatformImage(
  name: PlatformImageName,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const spec = PLATFORM_IMAGES[name];
  const configured = env[spec.env];
  return configured && configured.trim() !== '' ? configured.trim() : spec.fallback;
}
