const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The JSON merge patch that turns `before` into `after`. Pure.
 *
 * A value computed as "the object as it should be", with keys deleted, cannot
 * be sent as is: a merge patch keeps every key it does not mention (RFC 7396
 * removes only a key set to null). A workload with any other affinity rule
 * kept its required pin to the node being left (nodes/service.ts
 * stripHostnamePin). Arrays are replaced whole, as RFC 7396 does.
 */
export function toMergePatch(before: unknown, after: unknown): unknown {
  if (after === null || after === undefined) return null;
  if (!isPlainObject(before) || !isPlainObject(after)) return after;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(before)) {
    if (before[k] !== undefined && after[k] === undefined) out[k] = null;
  }
  for (const [k, v] of Object.entries(after)) {
    if (v !== undefined) out[k] = toMergePatch(before[k], v);
  }
  return out;
}
