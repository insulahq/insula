import { describe, it, expect } from 'vitest';
import {
  MAX_EXISTING_DATABASE_NAME_LENGTH,
  MAX_EXISTING_NAME_LENGTH,
  pgConnInfoDbName,
  quoteAnsiIdentifier,
  quoteMysqlIdentifier,
  quotePgStringLiteral,
  unescapeMysqlBatchField,
  validateExistingName,
} from './sql-identifiers.js';

describe('validateExistingName', () => {
  // Every one of these exists in real schemas; the engines hold them all.
  it.each([
    '1-StudentsTb', 'order items', 'Größe', 'we`ird', "it's", 'a"b', 'semi;colon',
    'back\\slash', 'dash--comment', 'x$y', 'fs.files', 'L'.repeat(64),
  ])('accepts %j', (name) => {
    expect(() => validateExistingName(name, 'table')).not.toThrow();
  });

  it.each([
    ['empty', ''],
    ['NUL', 'a\0b'],
    ['too long', 'x'.repeat(MAX_EXISTING_NAME_LENGTH + 1)],
    ['an array (repeated query parameter)', ['a', 'b']],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(() => validateExistingName(value, 'table')).toThrow(expect.objectContaining({
      code: 'INVALID_TABLE_NAME', status: 400,
    }));
  });

  it('names the column kind in the error code', () => {
    expect(() => validateExistingName('', 'column')).toThrow(expect.objectContaining({ code: 'INVALID_COLUMN_NAME' }));
  });

  // Databases created outside the panel: imports, apps, other tools.
  it.each(['2024-school', '-weird', "it's db", 'host=elsewhere', 'a\\b', 'Größe', 'd'.repeat(64)])(
    'accepts the existing database name %j',
    (name) => {
      expect(() => validateExistingName(name, 'database')).not.toThrow();
    },
  );

  it('caps database names at the engines\' 64 and names the kind in the code', () => {
    expect(() => validateExistingName('d'.repeat(MAX_EXISTING_DATABASE_NAME_LENGTH + 1), 'database'))
      .toThrow(expect.objectContaining({ code: 'INVALID_DATABASE_NAME', status: 400 }));
    expect(() => validateExistingName('a\0b', 'database')).toThrow(expect.objectContaining({ code: 'INVALID_DATABASE_NAME' }));
  });
});

describe('pgConnInfoDbName', () => {
  // libpq reads a -d value containing `=` as a whole connection string.
  it('quotes the name so it can never read as connection options', () => {
    expect(pgConnInfoDbName('host=elsewhere')).toBe("dbname='host=elsewhere'");
    expect(pgConnInfoDbName("it's")).toBe("dbname='it\\'s'");
    expect(pgConnInfoDbName('a\\b')).toBe("dbname='a\\\\b'");
    expect(pgConnInfoDbName('2024-school')).toBe("dbname='2024-school'");
  });
});

describe('quoting', () => {
  it('doubles an embedded backtick for MariaDB/MySQL', () => {
    expect(quoteMysqlIdentifier('1-StudentsTb')).toBe('`1-StudentsTb`');
    expect(quoteMysqlIdentifier('we`ird')).toBe('`we``ird`');
  });

  it('doubles an embedded double quote for PostgreSQL/SQLite', () => {
    expect(quoteAnsiIdentifier('a"b')).toBe('"a""b"');
  });

  it('doubles a single quote in a PostgreSQL literal and leaves backslashes alone', () => {
    expect(quotePgStringLiteral("it's\\here")).toBe("'it''s\\here'");
  });
});

describe('unescapeMysqlBatchField', () => {
  it('undoes the --batch escapes for backslash, tab, newline and NUL', () => {
    expect(unescapeMysqlBatchField('back\\\\slash')).toBe('back\\slash');
    expect(unescapeMysqlBatchField('tab\\tx')).toBe('tab\tx');
    expect(unescapeMysqlBatchField('line\\nbreak')).toBe('line\nbreak');
    expect(unescapeMysqlBatchField('nul\\0x')).toBe('nul\0x');
  });

  it('decodes left to right, so an escaped backslash before "t" stays a backslash', () => {
    // `\\t` in batch output is a backslash followed by the letter t.
    expect(unescapeMysqlBatchField('a\\\\tb')).toBe('a\\tb');
  });

  it('leaves plain names untouched', () => {
    expect(unescapeMysqlBatchField('1-StudentsTb')).toBe('1-StudentsTb');
  });
});
