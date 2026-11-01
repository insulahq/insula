import { describe, it, expect } from 'vitest';
import { resortPlaceholder } from '@/hooks/resort-placeholder';

interface Page {
  readonly data: readonly string[];
  readonly pagination: { readonly cursor: string | null; readonly has_more: boolean; readonly total_count: number };
}

const PAGE: Page = { data: ['a', 'b'], pagination: { cursor: 'c-next', has_more: true, total_count: 4 } };

/** The query the table showed before, tagged by its own options. */
const shown = (list: unknown, sort: string | undefined, cursor?: string) =>
  ({ meta: resortPlaceholder<Page>(list, sort, cursor).meta });

describe('resortPlaceholder', () => {
  it('keeps the rows on a re-sort of the same list, without the old order\'s next-page cursor', () => {
    const { placeholderData } = resortPlaceholder<Page>({ search: 'x' }, 'name:desc', undefined);
    expect(placeholderData(PAGE, shown({ search: 'x' }, 'name:asc'))).toEqual({
      data: ['a', 'b'],
      pagination: { cursor: null, has_more: false, total_count: 4 },
    });
  });

  it('keeps the rows when the re-sort comes from a later page (the cursor is dropped with the sort)', () => {
    const { placeholderData } = resortPlaceholder<Page>({ search: 'x' }, 'name:desc', undefined);
    expect(placeholderData(PAGE, shown({ search: 'x' }, 'name:asc', 'c-3'))?.data).toEqual(['a', 'b']);
  });

  it('does not keep them for another list — a filter, search or tenant change', () => {
    const { placeholderData } = resortPlaceholder<Page>({ tenantId: 't-2' }, 'name:desc', undefined);
    expect(placeholderData(PAGE, shown({ tenantId: 't-1' }, 'name:asc'))).toBeUndefined();
  });

  it('does not keep them when only the page changes (same sort)', () => {
    const { placeholderData } = resortPlaceholder<Page>({}, 'name:asc', 'c-next');
    expect(placeholderData(PAGE, shown({}, 'name:asc'))).toBeUndefined();
    const firstPage = resortPlaceholder<Page>({}, 'name:asc', undefined);
    expect(firstPage.placeholderData(PAGE, shown({}, 'name:asc', 'c-next'))).toBeUndefined();
  });

  it('does not keep them for a request with a cursor, which a re-sort never sends', () => {
    const { placeholderData } = resortPlaceholder<Page>({}, 'name:desc', 'c-next');
    expect(placeholderData(PAGE, shown({}, 'name:asc'))).toBeUndefined();
  });

  it('keeps nothing when nothing was shown, or the previous query is not a sorted list', () => {
    const { placeholderData } = resortPlaceholder<Page>({}, 'name:desc', undefined);
    expect(placeholderData(undefined, shown({}, 'name:asc'))).toBeUndefined();
    expect(placeholderData(PAGE, undefined)).toBeUndefined();
    expect(placeholderData(PAGE, { meta: undefined })).toBeUndefined();
  });

  it('keeps a result without pagination as it is', () => {
    const { placeholderData } = resortPlaceholder<{ data: string[]; pagination?: null }>({}, 'name:desc', undefined);
    expect(placeholderData({ data: ['a'] }, shown({}, 'name:asc'))).toEqual({ data: ['a'] });
  });
});
