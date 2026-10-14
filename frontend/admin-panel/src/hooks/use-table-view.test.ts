import { describe, it, expect } from 'vitest';
import { viewRows, ALL_ROWS, type TableViewQuery } from './use-table-view';

interface Row { readonly name: string; readonly sent: number }

const ROWS: readonly Row[] = Array.from({ length: 45 }, (_, i) => ({ name: `domain-${i + 1}.test`, sent: (i * 7) % 45 }));

const query = (over: Partial<TableViewQuery<Row>> = {}): TableViewQuery<Row> => ({
  search: '', searchText: (r) => r.name, sortKey: 'name', sortDirection: 'asc',
  pageIndex: 0, pageSize: 20, ...over,
});

describe('viewRows', () => {
  it('pages the sorted rows, so page 2 continues page 1', () => {
    const p1 = viewRows(ROWS, query({ sortKey: 'sent', sortDirection: 'desc' }));
    const p2 = viewRows(ROWS, query({ sortKey: 'sent', sortDirection: 'desc', pageIndex: 1 }));
    expect(p1.rows).toHaveLength(20);
    expect(p1.total).toBe(45);
    expect(p1.pageCount).toBe(3);
    expect(p1.rows[19].sent).toBeGreaterThanOrEqual(p2.rows[0].sent);
  });

  it('searches every row, not only the page shown, and counts the matches', () => {
    // domain-41 … domain-45 sort onto the last page by name; the search finds them from page 1.
    const v = viewRows(ROWS, query({ search: 'DOMAIN-4' }));
    expect(v.rows.map((r) => r.name)).toEqual([
      'domain-4.test', 'domain-40.test', 'domain-41.test', 'domain-42.test', 'domain-43.test', 'domain-44.test', 'domain-45.test',
    ]);
    expect(v.total).toBe(7);
  });

  it('shows every row on one page for All', () => {
    const v = viewRows(ROWS, query({ pageSize: ALL_ROWS, pageIndex: 2 }));
    expect(v.rows).toHaveLength(45);
    expect(v.pageIndex).toBe(0);
    expect(v.pageCount).toBe(1);
  });

  it('falls back to the last page when a search leaves fewer pages than the one asked for', () => {
    const v = viewRows(ROWS, query({ search: 'domain-1', pageIndex: 2 }));
    expect(v.pageIndex).toBe(0);
    expect(v.rows.length).toBe(v.total);
    expect(v.total).toBeGreaterThan(0);
  });

  it('reads a column through its accessor when the row has no such field', () => {
    const v = viewRows(ROWS, query({ sortKey: 'length', accessors: { length: (r) => r.name.length }, sortDirection: 'desc', pageSize: ALL_ROWS }));
    expect(v.rows[0].name.length).toBe(Math.max(...ROWS.map((r) => r.name.length)));
  });
});
