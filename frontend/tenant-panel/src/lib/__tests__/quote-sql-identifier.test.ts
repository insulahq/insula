import { describe, it, expect } from 'vitest';
import { quoteId, quoteSqlString } from '../quote-sql-identifier';

describe('quoteId', () => {
  it('backtick-quotes MariaDB/MySQL names and doubles an embedded backtick', () => {
    expect(quoteId('1-StudentsTb', 'mariadb')).toBe('`1-StudentsTb`');
    expect(quoteId('we`ird', 'mysql')).toBe('`we``ird`');
  });

  it('double-quotes PostgreSQL/SQLite names and doubles an embedded double quote', () => {
    expect(quoteId('order items', 'postgresql')).toBe('"order items"');
    expect(quoteId('a"b', undefined)).toBe('"a""b"');
  });
});

describe('quoteSqlString', () => {
  // MariaDB/MySQL read `\n` in a literal as a newline: `C:\new` with only `'`
  // doubled was stored as `C:`, a newline and `ew`.
  it('doubles backslashes and quotes for MariaDB/MySQL', () => {
    expect(quoteSqlString('C:\\new', 'mariadb')).toBe("'C:\\\\new'");
    expect(quoteSqlString("it's", 'mysql')).toBe("'it''s'");
  });

  it('doubles only quotes for PostgreSQL and SQLite, which take a backslash literally', () => {
    expect(quoteSqlString('C:\\new', 'postgresql')).toBe("'C:\\new'");
    expect(quoteSqlString("it's", undefined)).toBe("'it''s'");
  });
});
