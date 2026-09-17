/**
 * Every active ISO 4217 code, as a floor under whatever the JS runtime offers.
 *
 * `Intl.supportedValuesOf('currency')` is the natural source and needs no
 * maintenance, but it is not complete and not stable across engines: it
 * returned 159 codes in the DEV cluster's Chromium and 162 in Node 22 on the
 * same day, and neither included **VED** — a currency Venezuela actually
 * circulates. It also still lists codes ISO has withdrawn (HRK, CUC, SLL, ZWL).
 *
 * That is fine for formatting, which is what the API was designed for, but not
 * for a picker: the selector has no free-text entry, so a code the engine
 * happens to omit is one the operator simply cannot choose. The union of both
 * lists is complete on every engine, never *loses* a code the runtime knows,
 * and costs a list that ISO amends roughly twice a decade.
 *
 * Includes the nine "funds" codes (BOV, CHE, CHW, CLF, COU, MXV, USN, UYI,
 * UYW). They are ISO-active and cost nothing to carry; an operator searching
 * for a currency to bill in will never meet them, since they sort in by code
 * and carry their own names.
 *
 * Source: ISO 4217 published list, current 2026-09.
 */
export const ISO_4217_ACTIVE: readonly string[] = [
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN',
  'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BOV',
  'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHE', 'CHF',
  'CHW', 'CLF', 'CLP', 'CNY', 'COP', 'COU', 'CRC', 'CUP', 'CVE', 'CZK',
  'DJF', 'DKK', 'DOP', 'DZD', 'EGP', 'ERN', 'ETB', 'EUR', 'FJD', 'FKP',
  'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD', 'HKD', 'HNL',
  'HTG', 'HUF', 'IDR', 'ILS', 'INR', 'IQD', 'IRR', 'ISK', 'JMD', 'JOD',
  'JPY', 'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT',
  'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'LYD', 'MAD', 'MDL', 'MGA', 'MKD',
  'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MXV', 'MYR',
  'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'OMR', 'PAB', 'PEN',
  'PGK', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR', 'RON', 'RSD', 'RUB', 'RWF',
  'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS', 'SRD',
  'SSP', 'STN', 'SVC', 'SYP', 'SZL', 'THB', 'TJS', 'TMT', 'TND', 'TOP',
  'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UGX', 'USD', 'USN', 'UYI', 'UYU',
  'UYW', 'UZS', 'VED', 'VES', 'VND', 'VUV', 'WST', 'XAF', 'XCD', 'XCG',
  'XDR', 'XOF', 'XPF', 'YER', 'ZAR', 'ZMW', 'ZWG',
];
