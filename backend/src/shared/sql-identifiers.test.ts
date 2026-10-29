import { describe, it, expect } from 'vitest';
import {
  MAX_EXISTING_NAME_LENGTH,
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
