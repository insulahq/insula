/**
 * The subscription's end as the tenant reads it, as a long date in their
 * locale. Null for a plan that never expires. Settings and the dashboard
 * header both show it.
 */
export function formatRenewalDate(expiresAt: string | null | undefined): string | null {
  if (!expiresAt) return null;
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}
