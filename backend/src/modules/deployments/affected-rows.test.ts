import { describe, it, expect } from 'vitest';
import {
  affectedRowsField,
  affectedRowsMarker,
  splitRowCount,
  withMysqlRowCount,
  withSqliteRowCount,
} from './affected-rows.js';

describe('affected-rows', () => {
  it('makes a fresh marker each time', () => {
    const a = affectedRowsMarker();
    expect(a).toMatch(/^insula_affected_[0-9a-f]{16}$/);
    expect(affectedRowsMarker()).not.toBe(a);
  });

  it('splits a one-row count result off the end of the output', () => {
    expect(splitRowCount('a\tb\n1\t2\nmk\n-1\n', 'mk', '\n')).toEqual({ output: 'a\tb\n1\t2\n', count: -1 });
    expect(splitRowCount('mk\n4\n', 'mk', '\n')).toEqual({ output: '', count: 4 });
  });

  it('takes the CRLF line ends sqlite3 -csv prints', () => {
    expect(splitRowCount('name\r\nx\r\nmk\r\n0\r\n', 'mk', '\n')).toEqual({ output: 'name\r\nx\r\n', count: 0 });
  });

  it('splits a psql echo line off the end of the output', () => {
    expect(splitRowCount('name\nx\nmk 1\n', 'mk', ' ')).toEqual({ output: 'name\nx\n', count: 1 });
  });

  it('only takes the marker at the start of a line', () => {
    // A value that ends in the marker text is data, not the count.
    expect(splitRowCount('v\nxmk\n5\n', 'mk', '\n')).toEqual({ output: 'v\nxmk\n5\n', count: null });
  });

  it('returns the output whole when the count never printed', () => {
    expect(splitRowCount('a\n1\n', 'mk', '\n')).toEqual({ output: 'a\n1\n', count: null });
    expect(splitRowCount('mk :ROW_COUNT\n', 'mk', ' ')).toEqual({ output: '', count: null });
  });

  it('counts a write only when there is no result set and the count is not negative', () => {
    expect(affectedRowsField([], 0)).toEqual({ affectedRows: 0 });
    expect(affectedRowsField([], 7)).toEqual({ affectedRows: 7 });
    expect(affectedRowsField([], -1)).toEqual({});
    expect(affectedRowsField([], null)).toEqual({});
    expect(affectedRowsField(['n'], 3)).toEqual({});
  });

  it('appends the count statement on its own line', () => {
    expect(withMysqlRowCount('UPDATE t SET a = 1; -- x', 'mk')).toBe('UPDATE t SET a = 1; -- x\n;\nSELECT ROW_COUNT() AS `mk`');
    expect(withSqliteRowCount('UPDATE t SET a = 1', 'mk')).toBe(
      'UPDATE t SET a = 1\n;\nSELECT CASE WHEN total_changes() > 0 THEN changes() ELSE -1 END AS "mk"',
    );
  });

  it('leaves alone what the follow-up statement would break', () => {
    expect(withMysqlRowCount('delimiter $$\nSELECT 1$$', 'mk')).toBe('delimiter $$\nSELECT 1$$');
    expect(withSqliteRowCount('  .schema t', 'mk')).toBe('  .schema t');
  });
});
