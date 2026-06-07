/**
 * Fixed alternating DKIM selector pair — `dkim-1` / `dkim-2`.
 *
 * The platform uses the A/B selector pattern (the same scheme
 * Microsoft 365 uses with selector1/selector2): every domain's DKIM
 * keys live under exactly two fixed selector names, and rotation
 * flips signing to the *other* selector with a freshly generated key.
 *
 * Why fixed names instead of per-rotation timestamped selectors:
 *   - Tenants on EXTERNAL DNS configure two TXT records ONCE and
 *     never touch DNS again, no matter how often keys rotate.
 *   - The DNS surface is bounded at exactly two records per domain —
 *     no selector sprawl, no retirement bookkeeping.
 *   - Rotation is risk-free: the previous selector's TXT record stays
 *     published (and its signature stays active), so mail already in
 *     receivers' retry queues keeps verifying. The only constraint is
 *     not rotating the SAME selector twice within the mail retry
 *     horizon (~5 days) — trivially satisfied since a full A→B→A
 *     cycle requires two operator-triggered rotations.
 *
 * Selector names are DNS-safe (RFC 6376 selector syntax: letters,
 * digits, hyphen).
 */

export const DKIM_SELECTOR_A = 'dkim-1';
export const DKIM_SELECTOR_B = 'dkim-2';

export type DkimAbSelector = typeof DKIM_SELECTOR_A | typeof DKIM_SELECTOR_B;

export function isAbSelector(value: string | null | undefined): value is DkimAbSelector {
  return value === DKIM_SELECTOR_A || value === DKIM_SELECTOR_B;
}

/**
 * The selector the NEXT rotation should sign with.
 *
 * - current `dkim-1` → `dkim-2`
 * - current `dkim-2` → `dkim-1`
 * - anything else (null, legacy `dkim-<timestamp>`, Stalwart
 *   auto-created `v1-rsa-<date>`) → `dkim-1` — the first rotation of
 *   a legacy domain converges it onto the A/B pair.
 */
export function nextDkimSelector(current: string | null | undefined): DkimAbSelector {
  // Exactly TWO selectors exist by design — do not extend this to a
  // third without revisiting the rotation safety analysis in ADR-047
  // (the A/B scheme's guarantees rest on selector reuse being ≥2
  // rotations apart).
  return current === DKIM_SELECTOR_A ? DKIM_SELECTOR_B : DKIM_SELECTOR_A;
}
