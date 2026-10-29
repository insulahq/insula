import { describe, it, expect } from 'vitest';
import { classifyNotFound, dbEngineApiError } from './db-errors.js';

describe('classifyNotFound', () => {
  // The engines' own message shapes, as the CLIs print them.
  it.each([
    ["ERROR 1146 (42S02) at line 1: Table 'school.gone' doesn't exist", 'TABLE_NOT_FOUND'],
    ['ERROR:  relation "gone" does not exist\nLINE 1: SELECT * FROM "gone"', 'TABLE_NOT_FOUND'],
    ['Error: in prepare, no such table: gone (1)', 'TABLE_NOT_FOUND'],
    ["ERROR 1049 (42000): Unknown database 'gone'", 'DATABASE_NOT_FOUND'],
    ['psql: error: connection to server on socket failed: FATAL:  database "gone" does not exist', 'DATABASE_NOT_FOUND'],
    ["ERROR 1054 (42S22) at line 1: Unknown column 'gone' in 'ORDER BY'", 'COLUMN_NOT_FOUND'],
    ['ERROR:  column "gone" does not exist', 'COLUMN_NOT_FOUND'],
    ['ERROR:  column "gone" of relation "t" does not exist', 'COLUMN_NOT_FOUND'],
    ['Parse error: no such column: gone', 'COLUMN_NOT_FOUND'],
  ])('%s → %s', (message, code) => {
    expect(classifyNotFound(message)).toBe(code);
  });

  it.each([
    "ERROR 1045 (28000): Access denied for user 'root'@'localhost'",
    "ERROR 1064 (42000) at line 1: You have an error in your SQL syntax",
    'ERROR:  duplicate key value violates unique constraint "t_pkey"',
    'Error: stepping, database is locked (5)',
  ])('leaves other failures unclassified: %s', (message) => {
    expect(classifyNotFound(message)).toBeNull();
  });
});

describe('dbEngineApiError', () => {
  it('answers 404 with a titled, non-retryable envelope for a missing object', () => {
    const err = dbEngineApiError("ERROR 1146 (42S02) at line 1: Table 'school.gone' doesn't exist");
    expect(err).toMatchObject({ code: 'TABLE_NOT_FOUND', status: 404, message: expect.stringContaining('school.gone') });
    expect(err.details).toEqual({
      operatorError: expect.objectContaining({ code: 'TABLE_NOT_FOUND', title: 'Table not found', retryable: false }),
    });
  });

  it('keeps any other failure a 500 with the engine message and the caller\'s fallback code', () => {
    expect(dbEngineApiError('ERROR 1064 (42000): syntax')).toMatchObject({ code: 'DB_EXEC_ERROR', status: 500 });
    const sqlite = dbEngineApiError('Error: database is locked', 'SQLITE_ERROR');
    expect(sqlite).toMatchObject({ code: 'SQLITE_ERROR', status: 500 });
    expect(sqlite.details).toEqual({
      operatorError: expect.objectContaining({ code: 'SQLITE_ERROR', title: 'The database returned an error' }),
    });
  });
});
