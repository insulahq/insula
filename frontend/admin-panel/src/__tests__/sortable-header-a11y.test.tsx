import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import SortableHeader from '@/components/ui/SortableHeader';

// Sorting is not mouse-only: Tab reaches a header, Enter or Space sorts, and
// assistive tech is told which column sorts which way.
function renderHeader(onSort = vi.fn(), current = 'name') {
  render(
    <table><thead><tr>
      <SortableHeader label="Name" sortKey="name" currentKey={current} direction="asc" onSort={onSort} />
      <SortableHeader label="Size" sortKey="size" currentKey={current} direction="asc" onSort={onSort} />
    </tr></thead></table>,
  );
  return onSort;
}

describe('SortableHeader accessibility', () => {
  it('is reachable with Tab and sorts on Enter and Space', async () => {
    const user = userEvent.setup();
    const onSort = renderHeader();
    await user.tab();
    expect(screen.getByTestId('sort-name')).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.tab();
    await user.keyboard(' ');
    expect(onSort.mock.calls).toEqual([['name'], ['size']]);
  });

  it('is a column header that says how it sorts', () => {
    renderHeader();
    expect(screen.getByTestId('sort-name')).toHaveAttribute('scope', 'col');
    expect(screen.getByTestId('sort-name')).toHaveAttribute('aria-sort', 'ascending');
    expect(screen.getByTestId('sort-size')).toHaveAttribute('aria-sort', 'none');
  });
});
