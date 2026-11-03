import type { DashboardSubject } from '@insula/api-contracts';

/**
 * A warning figure's subjects as hover-card rows: one row per subject the
 * server named, then how many it left out. The figure on the tile is the
 * total; the list is capped, so without the last row a card naming five of
 * twelve would read as complete.
 */
export function subjectRows(list: readonly DashboardSubject[], total: number): Array<[string, string]> {
  const rows = list.map((s) => [s.name, s.detail] as [string, string]);
  const rest = total - list.length;
  return rest > 0 ? [...rows, ['More', `${rest} not shown`]] : rows;
}
