/**
 * Format a monetary amount using the platform's global currency setting.
 * Mirrors `frontend/admin-panel/src/lib/format-currency.ts` — kept as a
 * sibling copy because the two panels are independent build targets.
 * See the admin-panel file for full docs.
 */
export function formatCurrency(
  amount: number | string | null | undefined,
  currency: string,
  locale?: string,
): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const n = typeof amount === 'string' ? Number.parseFloat(amount) : amount;
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}
