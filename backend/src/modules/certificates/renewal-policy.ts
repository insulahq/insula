/**
 * When a certificate the platform obtains is renewed, and when a panel may
 * call it "expiring". Both are FRACTIONS OF THE CERTIFICATE'S OWN LIFETIME,
 * never fixed day counts.
 *
 * Fixed day counts are what broke: cert-manager renewed at `renewBefore: 360h`
 * (15 days left) while the panels turned a certificate orange at 30 days
 * left, so every healthy certificate sat orange for the last 15 days of each
 * cycle. And public lifetimes keep shrinking — Let's Encrypt's default
 * profile is moving from 90 to 64 and then 45 days, and its opt-in profiles
 * already issue 45- and 6-day certificates — so any absolute number is wrong
 * for some lifetime.
 *
 * Let's Encrypt advises renewing two thirds of the way through a
 * certificate's life. cert-manager does that from the issued certificate's
 * real notBefore/notAfter with `renewBeforePercentage`, whatever lifetime the
 * CA chose. "Expiring" starts only once HALF of that renewal window has
 * passed without a new certificate: a renewal that works is never seen, one
 * that keeps failing is, with half the window still left to fix it.
 *
 *   lifetime   renews at (left)   orange below (left)
 *   90 days    ~30 days           ~15 days
 *   64 days    ~21 days           ~10.5 days
 *   45 days    ~15 days           ~7.4 days
 *    6 days    ~2 days            ~1 day
 *
 * `ci-cert-renewal-window-check.sh` fails any Certificate the platform writes
 * with an absolute `renewBefore`.
 */

/**
 * What `ssl_certificates.certificate` / `private_key_encrypted` hold for a
 * cert-manager certificate (the PEM lives in its Secret). Any other value is a
 * certificate someone uploaded — renewed by nobody, whatever the domain's
 * auto-renew flag says.
 */
export const MANAGED_CERT_PLACEHOLDER = '# Managed by cert-manager';

/** cert-manager `spec.renewBeforePercentage` for every certificate the platform obtains from an ACME CA. */
export const RENEW_BEFORE_PERCENTAGE = 33;

/** A certificate is "expiring" once less than this share of its lifetime remains: half the renewal window gone. */
export const EXPIRING_REMAINING_FRACTION = RENEW_BEFORE_PERCENTAGE / 100 / 2;

/**
 * A certificate nobody renews automatically (uploaded by hand) gets a fixed
 * heads-up: someone has to obtain and upload its successor.
 */
export const MANUAL_CERT_EXPIRING_DAYS = 30;

/**
 * Lifetime assumed for an auto-renewed certificate whose start is not known
 * yet — a row written before `not_before` was recorded, until the next status
 * sweep fills it in (minutes). The longest lifetime Let's Encrypt issues: its
 * warning point (~15 days left) still sits below the renewal point of every
 * lifetime from 45 days up, so even the guess does not flag a healthy
 * certificate.
 */
const ASSUMED_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export type CertExpiryState = 'valid' | 'expiring' | 'expired';

export interface CertValidity {
  readonly notBefore: Date | null;
  readonly notAfter: Date | null;
}

/**
 * Whether a certificate is valid, expiring (needs attention) or expired.
 * Null when its expiry is not known.
 */
export function certificateExpiryState(
  cert: CertValidity,
  opts: { readonly autoRenewed: boolean; readonly now: Date },
): CertExpiryState | null {
  if (!cert.notAfter) return null;
  const end = cert.notAfter.getTime();
  const now = opts.now.getTime();
  if (end <= now) return 'expired';
  const remaining = end - now;
  if (!opts.autoRenewed) {
    return remaining < MANUAL_CERT_EXPIRING_DAYS * DAY_MS ? 'expiring' : 'valid';
  }
  const start = cert.notBefore?.getTime();
  const lifetime = start !== undefined && start < end ? end - start : ASSUMED_LIFETIME_MS;
  return remaining < lifetime * EXPIRING_REMAINING_FRACTION ? 'expiring' : 'valid';
}

/** cert-manager Certificate spec fields that schedule renewal. */
export function renewalSpec(): { readonly renewBeforePercentage: number } {
  return { renewBeforePercentage: RENEW_BEFORE_PERCENTAGE };
}
