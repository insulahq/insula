/**
 * One spelling per address, so two spellings of the same IP compare equal.
 *
 * IPv6 has many: `2001:DB8:0::1`, `2001:db8:0:0::1` and `2001:db8::1` are one
 * address. Settings are typed by operators and DNS providers echo their own
 * canonical form, so a comparison of raw (or merely lower-cased) strings sees
 * a live record as "not expected" — and a repair that removes stale records
 * would then withdraw it. Same canonicaliser as `canonicalContent` for AAAA.
 */
export function canonicalAddress(type: string, address: string): string {
  const a = address.trim().toLowerCase();
  if (type.toUpperCase() !== 'AAAA') return a;
  try {
    return new URL(`http://[${a}]/`).hostname.slice(1, -1);
  } catch {
    return a;
  }
}

/** `A|203.0.113.1` / `AAAA|2001:db8::1` — a map key for one address. */
export function addressKey(type: string, address: string): string {
  return `${type.toUpperCase()}|${canonicalAddress(type, address)}`;
}
