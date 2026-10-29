/**
 * Engine errors from a tenant database, as the SQL Manager reports them.
 *
 * "This table / database / column does not exist" is the caller asking for
 * something that is not there — usually renamed or dropped since the panel
 * loaded its list — so it answers 404 with a code the panel can name, not a
 * 500 that reads as a platform fault (and counts as one in error rates).
 * Everything else stays a 500 carrying the engine's own message.
 *
 * Patterns are the engines' fixed message shapes; the message itself is
 * passed through untouched as the detail.
 */

import { OPERATOR_ERROR_CODES, type OperatorError } from '@insula/api-contracts';
import { ApiError } from '../../shared/errors.js';

type NotFoundCode =
  | typeof OPERATOR_ERROR_CODES.DATABASE_NOT_FOUND
  | typeof OPERATOR_ERROR_CODES.TABLE_NOT_FOUND
  | typeof OPERATOR_ERROR_CODES.COLUMN_NOT_FOUND;

interface NotFoundRule {
  readonly code: NotFoundCode;
  readonly pattern: RegExp;
}

const NOT_FOUND_RULES: readonly NotFoundRule[] = [
  // Column first: PostgreSQL's `column "c" of relation "t" does not exist` also
  // contains the relation pattern.
  // MariaDB/MySQL: ERROR 1054 (42S22): Unknown column 'c' in 'order clause'
  // PostgreSQL:    ERROR:  column "c" does not exist
  // SQLite:        no such column: c
  { code: OPERATOR_ERROR_CODES.COLUMN_NOT_FOUND, pattern: /\bERROR 1054\b|\bcolumn "[^"]*"(?: of relation "[^"]*")? does not exist|\bno such column\b/ },
  // MariaDB/MySQL: ERROR 1049 (42000): Unknown database 'x'
  // PostgreSQL:    FATAL:  database "x" does not exist
  { code: OPERATOR_ERROR_CODES.DATABASE_NOT_FOUND, pattern: /\bERROR 1049\b|\bdatabase "[^"]*" does not exist/ },
  // MariaDB/MySQL: ERROR 1146 (42S02): Table 'db.t' doesn't exist
  // PostgreSQL:    ERROR:  relation "t" does not exist
  // SQLite:        no such table: t
  { code: OPERATOR_ERROR_CODES.TABLE_NOT_FOUND, pattern: /\bERROR 1146\b|\brelation "[^"]*" does not exist|\bno such table\b/ },
];

const NOT_FOUND_ENVELOPE: Record<NotFoundCode, { readonly title: string; readonly remediation: string }> = {
  DATABASE_NOT_FOUND: {
    title: 'Database not found',
    remediation: 'It may have been renamed or dropped since the list was loaded. Reload the page and pick it again.',
  },
  TABLE_NOT_FOUND: {
    title: 'Table not found',
    // SQLite also says "no such table" when a view or trigger refers to a dropped one.
    remediation: 'It may have been renamed or dropped since the list was loaded, or a view or trigger may still refer to one that was. Reload the table list and pick it again.',
  },
  COLUMN_NOT_FOUND: {
    title: 'Column not found',
    remediation: 'It may have been renamed or dropped. Reload the table and try again.',
  },
};

/** The not-found code an engine message describes, or null for any other failure. */
export function classifyNotFound(message: string): NotFoundCode | null {
  return NOT_FOUND_RULES.find((rule) => rule.pattern.test(message))?.code ?? null;
}

/**
 * The ApiError for a failed engine command. `fallbackCode` is the 500 code
 * for anything that is not a not-found (DB_EXEC_ERROR for the network
 * engines, SQLITE_ERROR for SQLite files). Both carry an OperatorError so the
 * panel renders a title instead of the bare code.
 */
export function dbEngineApiError(
  message: string,
  fallbackCode: typeof OPERATOR_ERROR_CODES.DB_EXEC_ERROR | typeof OPERATOR_ERROR_CODES.SQLITE_ERROR = OPERATOR_ERROR_CODES.DB_EXEC_ERROR,
): ApiError {
  const notFound = classifyNotFound(message);
  if (notFound) {
    const { title, remediation } = NOT_FOUND_ENVELOPE[notFound];
    const operatorError: OperatorError = { code: notFound, title, detail: message, remediation: [remediation], retryable: false };
    return new ApiError(notFound, message, 404, { operatorError });
  }
  const operatorError: OperatorError = {
    code: fallbackCode,
    title: 'The database returned an error',
    detail: message,
    remediation: ['Read the database\'s message above, correct the query or the data, then retry.'],
    retryable: true,
  };
  return new ApiError(fallbackCode, message, 500, { operatorError });
}
