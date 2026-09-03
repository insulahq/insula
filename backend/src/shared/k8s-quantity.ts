/**
 * Generic Kubernetes quantity parser — the full suffix set, unit-agnostic.
 *
 * Returns a plain number in the quantity's own base unit (cores for CPU,
 * bytes for memory/storage, count for object quotas). That is deliberate:
 * this exists to COMPARE two quantities of the same resource
 * (`status.used` vs `status.hard`), where a shared base cancels out.
 *
 * Why not reuse the two parsers that already existed:
 *   - `mail-admin/mail-pvc.ts:parseQuantity` accepts only the storage
 *     suffixes and THROWS on anything else. That restriction is a safety
 *     property there and is left alone.
 *   - `shared/resource-parser.ts:parseResourceValue` needs to be told whether
 *     it is looking at CPU or memory, and only honours `m` in the CPU case.
 *
 * Neither can read a real ResourceQuota. A live tenant quota on production
 * carried `limits.memory: 107374182400m` — memory expressed in MILLI-bytes,
 * which is legal (the apiserver canonicalises whatever the client sent) and
 * which `parseQuantity` rejects outright while `parseResourceValue` would
 * silently read as 107374182400 Gi. Getting that one wrong turns a tenant
 * that is nowhere near its limit into a false "over quota" alarm, so the
 * parser has to be suffix-complete rather than caller-configured.
 *
 * Suffixes per the Kubernetes quantity spec:
 *   binary   Ki Mi Gi Ti Pi Ei      (1024^n)
 *   decimal  n  u  m  ""  k  M  G  T  P  E   (1000^n, n/u/m negative powers)
 * Scientific notation (`1e3`, `1.5E-3`) is also accepted.
 */

const BINARY: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
};

const DECIMAL: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  k: 1e3,
  // `K` is not in the spec but shows up in hand-written manifests.
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

// Number first (optionally in scientific notation), then an optional suffix.
// `E` is both an exponent marker and the exa suffix, so the numeric part is
// matched greedily and only a TRAILING alphabetic run is treated as a suffix.
const QUANTITY_RE = /^([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|[numkKMGTPE])?$/;

/**
 * Parse a Kubernetes quantity string. Returns `null` — never throws — when
 * the input is not a quantity, so a single odd value in a quota cannot break
 * the whole report.
 */
export function parseK8sQuantity(value: string): number | null {
  const m = QUANTITY_RE.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const suffix = m[2];
  if (suffix === undefined) return n;
  const factor = BINARY[suffix] ?? DECIMAL[suffix];
  if (factor === undefined) return null;
  return n * factor;
}

/**
 * Compare two quantities of the SAME resource.
 *
 * Returns null when either side is unparseable — the caller must treat that
 * as "unknown", not as "within limits". Reporting an unreadable quota as
 * healthy is how a blocked tenant stays invisible.
 */
export function compareK8sQuantities(a: string, b: string): number | null {
  const x = parseK8sQuantity(a);
  const y = parseK8sQuantity(b);
  if (x === null || y === null) return null;
  return x === y ? 0 : x < y ? -1 : 1;
}

/** used ÷ hard, or null if either is unparseable or hard is zero. */
export function quantityRatio(used: string, hard: string): number | null {
  const u = parseK8sQuantity(used);
  const h = parseK8sQuantity(hard);
  if (u === null || h === null || h === 0) return null;
  return u / h;
}
