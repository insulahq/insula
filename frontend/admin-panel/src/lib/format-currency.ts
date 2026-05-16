/**
 * Format a monetary amount using the platform's global currency setting.
 *
 * Backed by `Intl.NumberFormat` so the symbol, decimal separator, and
 * placement come from the host locale + currency code (USD → "$1.50",
 * EUR → "€1,50" in de-DE). Returns "—" for non-finite inputs so callers
 * can pass `plan.monthlyPriceUsd` (a Drizzle numeric string) without
 * pre-parsing.
 *
 * The `currency` argument is the ISO 4217 code from system settings
 * (`useSystemSettings().data?.data.currency`). If it's malformed,
 * `Intl.NumberFormat` throws — we fall back to `<CODE> <amount>` rather
 * than crashing the render.
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

/**
 * Common ISO 4217 codes shown in the System Settings currency selector.
 * Operators can still PATCH any 3-letter uppercase code via the API;
 * this list is a UX shortcut, not an allowlist.
 */
export const COMMON_CURRENCIES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'USD', label: 'USD — US Dollar' },
  { code: 'EUR', label: 'EUR — Euro' },
  { code: 'GBP', label: 'GBP — British Pound' },
  { code: 'CHF', label: 'CHF — Swiss Franc' },
  { code: 'JPY', label: 'JPY — Japanese Yen' },
  { code: 'CAD', label: 'CAD — Canadian Dollar' },
  { code: 'AUD', label: 'AUD — Australian Dollar' },
  { code: 'NZD', label: 'NZD — New Zealand Dollar' },
  { code: 'ZAR', label: 'ZAR — South African Rand' },
  { code: 'NAD', label: 'NAD — Namibian Dollar' },
  { code: 'SEK', label: 'SEK — Swedish Krona' },
  { code: 'NOK', label: 'NOK — Norwegian Krone' },
  { code: 'DKK', label: 'DKK — Danish Krone' },
  { code: 'INR', label: 'INR — Indian Rupee' },
  { code: 'BRL', label: 'BRL — Brazilian Real' },
];
