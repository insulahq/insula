/**
 * Server-side sorting for cursor-paginated lists
 * (docs/architecture/API_PAGINATION_STRATEGY.md: `sort=field:asc|desc`, an
 * allow-list of fields per endpoint, `INVALID_SORT_FIELD` otherwise).
 *
 * Every paginated list used to order by `created_at` whatever `sort` said, and
 * the panels sorted only the page they had received: clicking a column header
 * on a 20-row page ordered those 20 rows, not the list. Sorting has to happen
 * where all the rows are.
 *
 * Keyset pagination over the sort key, tie-broken by id: a page continues
 * exactly where the previous one ended, whatever the key. The cursor carries
 * the key as Postgres renders it (`::text`), so a timestamp keeps its
 * microseconds — a JS Date round trip cut them to milliseconds, and a row
 * sharing the millisecond was skipped or shown twice. NULL keys sort last in
 * both directions.
 */
import { sql, type SQL, type AnyColumn } from 'drizzle-orm';
import { ApiError } from './errors.js';
import { decodeCursor, encodeCursor } from './pagination.js';

/** How a key compares, and what it is cast back to from the cursor. */
export type SortKind = 'text' | 'numeric' | 'timestamp' | 'timestamptz' | 'boolean';

export interface SortField {
  /** The column, or an expression over the query's tables (a joined name). */
  readonly expr: AnyColumn | SQL;
  readonly kind: SortKind;
}

/** API sort field (camelCase, as the panels name columns) → how to order by it. */
export type SortFields = Readonly<Record<string, SortField>>;

export interface ListSort {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

const CAST: Record<SortKind, string> = {
  text: 'text',
  numeric: 'numeric',
  timestamp: 'timestamp',
  timestamptz: 'timestamptz',
  boolean: 'boolean',
};

/** What a cursor's key must look like for each kind — Postgres `::text` renderings. */
const VALUE_SHAPE: Record<SortKind, RegExp> = {
  text: /^[\s\S]{0,2048}$/,
  numeric: /^-?\d{1,30}(\.\d{1,30})?$/,
  timestamp: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/,
  timestamptz: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/,
  boolean: /^(true|false)$/,
};

/** Row ids are uuids or similar; nothing else may reach the id comparison. */
const CURSOR_ID = /^[A-Za-z0-9_-]{1,64}$/;

const camel = (s: string): string => s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/**
 * The sort a request asked for. `raw` is the `sort` query value (absent →
 * `fallback`). A field the endpoint does not allow is a 400, not a silent
 * fallback: a panel sending a column the server cannot sort must find out.
 */
export function resolveListSort(raw: string | undefined, fields: SortFields, fallback: ListSort): ListSort {
  if (raw === undefined || raw.trim() === '') return fallback;
  const [rawField = '', rawDir = 'asc'] = raw.split(':');
  const field = camel(rawField.trim());
  if (!Object.prototype.hasOwnProperty.call(fields, field)) {
    throw new ApiError(
      'INVALID_SORT_FIELD',
      `Cannot sort by '${rawField}' on this endpoint`,
      400,
      { allowed: Object.keys(fields) },
    );
  }
  if (rawDir !== 'asc' && rawDir !== 'desc') {
    throw new ApiError('INVALID_SORT_FIELD', `Sort direction must be asc or desc, not '${rawDir}'`, 400);
  }
  return { field, direction: rawDir };
}

/**
 * The value rows are ordered by: case-insensitive for text, as the panels
 * compare (cast first — an enum column has no lower()).
 */
function keyOf(f: SortField): SQL {
  return f.kind === 'text' ? sql`lower((${f.expr})::text)` : sql`${f.expr}`;
}

/** ORDER BY: the key (NULLs last either way), then id in the same direction. */
export function listOrderBy(sort: ListSort, fields: SortFields, id: AnyColumn): SQL[] {
  const key = keyOf(fields[sort.field]);
  return sort.direction === 'asc'
    ? [sql`${key} ASC NULLS LAST`, sql`${id} ASC`]
    : [sql`${key} DESC NULLS LAST`, sql`${id} DESC`];
}

/** Select this as `sortKey` so the last row of a page can become the cursor. */
export function listSortKeySelect(sort: ListSort, fields: SortFields): SQL<string | null> {
  return sql<string | null>`(${keyOf(fields[sort.field])})::text`;
}

interface CursorKey {
  readonly f: string;
  readonly d: 'asc' | 'desc';
  readonly v: string | null;
}

/** The cursor that continues after `last` under `sort`. */
export function encodeListCursor(
  resource: string,
  sort: ListSort,
  last: { readonly id: string; readonly sortKey: string | null },
): string {
  const key: CursorKey = { f: sort.field, d: sort.direction, v: last.sortKey };
  return encodeCursor({ resource, sort: JSON.stringify(key), id: last.id });
}

/**
 * WHERE condition for the rows after `cursor`, or undefined on the first page.
 * A cursor minted under a different sort (or for another resource) is refused
 * rather than misread — the panels start from page one when the sort changes.
 */
export function listCursorCondition(
  cursor: string | undefined,
  resource: string,
  sort: ListSort,
  fields: SortFields,
  id: AnyColumn,
): SQL | undefined {
  if (!cursor) return undefined;
  const decoded = decodeCursor(cursor);
  let key: CursorKey;
  try {
    key = JSON.parse(decoded.sort) as CursorKey;
  } catch {
    throw invalidCursor();
  }
  // The cursor is client-held: everything in it is checked before it reaches
  // SQL, so a tampered one is a 400, never a Postgres cast error (500).
  if (key === null || typeof key !== 'object' || typeof key.f !== 'string'
    || (key.v !== null && typeof key.v !== 'string')) throw invalidCursor();
  if (decoded.resource !== resource || key.f !== sort.field || key.d !== sort.direction) throw invalidCursor();
  if (typeof decoded.id !== 'string' || !CURSOR_ID.test(decoded.id)) throw invalidCursor();

  const field = fields[sort.field];
  if (key.v !== null && !VALUE_SHAPE[field.kind].test(key.v)) throw invalidCursor();
  const k = keyOf(field);
  const after = sort.direction === 'asc' ? sql`>` : sql`<`;
  if (key.v === null) {
    // Inside the NULL tail: only NULL keys remain, ordered by id.
    return sql`(${k} IS NULL AND ${id} ${after} ${decoded.id})`;
  }
  const v = sql`CAST(${key.v} AS ${sql.raw(CAST[field.kind])})`;
  return sql`(${k} ${after} ${v} OR (${k} = ${v} AND ${id} ${after} ${decoded.id}) OR ${k} IS NULL)`;
}

function invalidCursor(): ApiError {
  return new ApiError(
    'INVALID_CURSOR',
    'Pagination cursor is invalid or was made for a different sort',
    400,
    undefined,
    'Restart pagination from the beginning',
  );
}

/** Drop the helper column from rows before they are returned. */
export function withoutSortKey<T extends { sortKey?: unknown }>(rows: readonly T[]): Array<Omit<T, 'sortKey'>> {
  return rows.map(({ sortKey: _k, ...rest }) => rest);
}
