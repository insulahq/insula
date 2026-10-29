import { describe, it, expect } from 'vitest';
import { quoteId } from '../quote-sql-identifier';

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
