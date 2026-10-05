/**
 * One spelling per address, so two decisions for the same host never count
 * (or group) as two addresses: `2001:DB8:0:0::1`, `2001:db8::0:1` and
 * `2001:0db8::1` are one host. IPv6 is rendered in the RFC 5952 form
 * (lowercase, no leading zeros, the longest zero run as `::`); an
 * IPv4-mapped address (`::ffff:203.0.113.5`) is the IPv4 host it maps.
 * Runs in the browser too — no `node:net`.
 */

function parseIpv4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return out.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? out : null;
}

/** Eight 16-bit groups, or null when `s` is not an IPv6 address. */
function parseIpv6(s: string): number[] | null {
  let text = s.toLowerCase();
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.')) {
    const v4 = parseIpv4(text.slice(lastColon + 1));
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    text = `${text.slice(0, lastColon + 1)}x`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const g of part.split(':')) {
      if (g === 'x') { groups.push(...tail); continue; }
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !rest) return null;
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  return [...head, ...Array<number>(Math.max(0, missing)).fill(0), ...rest];
}

function formatIpv6(groups: readonly number[]): string {
  // Longest run of two or more zero groups (first one on a tie) becomes `::`.
  let best = -1; let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i += 1; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > bestLen && j - i >= 2) { best = i; bestLen = j - i; }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

/** Canonical spelling of an IP address or CIDR; anything else is returned unchanged. */
export function canonicalIp(value: string): string {
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  const addr = slash < 0 ? trimmed : trimmed.slice(0, slash);
  const suffix = slash < 0 ? '' : trimmed.slice(slash);
  const v4 = parseIpv4(addr);
  if (v4) return `${v4.join('.')}${suffix}`;
  const v6 = parseIpv6(addr);
  if (!v6) return value;
  const mapped = v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff;
  if (mapped && (suffix === '' || Number(suffix.slice(1)) >= 96)) {
    const host = `${v6[6] >> 8}.${v6[6] & 255}.${v6[7] >> 8}.${v6[7] & 255}`;
    return suffix === '' ? host : `${host}/${Number(suffix.slice(1)) - 96}`;
  }
  return `${formatIpv6(v6)}${suffix}`;
}
