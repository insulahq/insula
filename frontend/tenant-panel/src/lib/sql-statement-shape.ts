/**
 * String literals, quoted identifiers and comments, which can hold a `;` or
 * the word UPDATE without being a statement boundary or an UPDATE. Doubled
 * quotes and backslash escapes stay inside their literal.
 */
const SQL_NOT_CODE = /'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|`(?:[^`]|``)*`|--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//g;

/**
 * What the result message needs to know about the SQL that ran. Every engine
 * reports the LAST statement's count, so a query with more than one says whose
 * count it is. Read with literals and comments blanked out, so a value such as
 * `'<?php echo 1; ?>'` is not taken for a second statement.
 */
export function statementShape(sql: string): { readonly several: boolean; readonly hasUpdate: boolean } {
  const code = sql.replace(SQL_NOT_CODE, ' ').trim().replace(/;\s*$/, '');
  return { several: /;\s*\S/.test(code), hasUpdate: /(^|;)\s*update\s/i.test(code) };
}
