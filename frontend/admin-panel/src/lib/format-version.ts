/**
 * Render a platform version for display.
 *
 * Two rules, both from operator feedback:
 *
 *   A version always carries its leading `v`. The tags, the release assets and
 *   the deployment columns all say `v2026.9.31`; the platform-version surfaces
 *   said `2026.9.31`, so the same number looked like two different things
 *   depending on where you read it.
 *
 *   Idempotent. Some callers already hold a `v`-prefixed string (a git tag),
 *   and `vv2026.9.31` is worse than either.
 */
export function formatVersion(
  version: string | null | undefined,
  fallback = 'unknown',
): string {
  const trimmed = version?.trim();
  if (!trimmed) return fallback;
  return /^v/i.test(trimmed) ? trimmed : `v${trimmed}`;
}
