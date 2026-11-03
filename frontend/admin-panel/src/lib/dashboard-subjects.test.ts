import { describe, it, expect } from 'vitest';
import { subjectRows } from './dashboard-subjects';

describe('subjectRows', () => {
  it('one row per subject, then how many the list leaves out', () => {
    expect(subjectRows([{ name: 'a', detail: 'x' }], 3)).toEqual([['a', 'x'], ['More', '2 not shown']]);
  });
  it('no closing row when every subject is shown', () => {
    expect(subjectRows([{ name: 'a', detail: 'x' }], 1)).toEqual([['a', 'x']]);
    expect(subjectRows([], 0)).toEqual([]);
  });
});
