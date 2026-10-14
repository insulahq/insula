import PaginationBar from './PaginationBar';
import type { TableView } from '@/hooks/use-table-view';

const SMALLEST_PAGE = 20;

/**
 * The page controls under a browser-side table ({@link useTableView}).
 *
 * Absent while every row fits on the smallest page and the reader has not
 * picked another size — a pager under three rows is noise. Once they have
 * picked one it stays, so they can pick again after a search narrows the rows.
 */
export default function TablePager<T>({ view, testIdPrefix }: {
  readonly view: TableView<T>;
  readonly testIdPrefix: string;
}) {
  if (view.total <= SMALLEST_PAGE && view.pageSize === SMALLEST_PAGE) return null;
  return (
    <PaginationBar
      totalCount={view.total}
      pageSize={view.pageSize}
      pageIndex={view.pageIndex}
      hasPrevPage={view.hasPrevPage}
      hasNextPage={view.hasNextPage}
      onPrev={view.goPrev}
      onNext={view.goNext}
      onPageSizeChange={view.setPageSize}
      allowAll
      testIdPrefix={testIdPrefix}
    />
  );
}
