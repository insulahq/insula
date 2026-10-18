/**
 * k8s date-times as the code receives them: the typed client deserialises a
 * `date-time` field into a Date, a raw/custom-object read leaves it a string.
 * Both helpers take either and return null for absent or unparseable input.
 *
 * Read a PV's release time from `status.lastPhaseTransitionTime`. PVs have no
 * `status.lastTransitionTime` (that is a CONDITION field): the code that read
 * it saw null for every PV, so the Released-PV janitor never reaped anything
 * and the "Released for N days" ages were blank.
 */
export function k8sTimeMs(v: string | Date | null | undefined): number | null {
  if (v === undefined || v === null) return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** The same instant as an ISO string, for API payloads. */
export function k8sTimeIso(v: string | Date | null | undefined): string | null {
  const ms = k8sTimeMs(v);
  return ms === null ? null : new Date(ms).toISOString();
}
