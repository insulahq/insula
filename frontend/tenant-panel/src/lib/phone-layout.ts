/**
 * Phone layout for tables and tab strips, below Tailwind's `sm` (640 px).
 *
 * Tables: one that does not fit its box on a phone is shown as one card per
 * row, each cell on its own line after its column's heading. The headings come
 * from the table's <thead>, copied onto the body cells as `data-label` here;
 * index.css lays out `table[data-stack]`. The row's first labelled cell is its
 * card's title (`data-primary`): full width, without its heading, since that is
 * what names the row; unlabelled cells before it (a checkbox, a colour swatch)
 * are its leads (`data-lead`) and sit beside the title rather than on a line of
 * their own. A table that fits stays a table, so a short two-column table is
 * left alone.
 *
 * Done once for every table, not per page: the panels have dozens of
 * hand-written tables, and a per-table phone variant is how one gets missed.
 * A table opts out with `data-mobile-table="keep"`; it must then sit in an
 * `overflow-x-auto` box, which it scrolls inside.
 *
 * A stacked table stays stacked until the viewport width changes. Unstacking
 * it to measure again would shorten the page for a moment, and the scroll
 * container clamps its scroll position to the shorter page: every poll that
 * refreshed the rows would jump the operator back up the page.
 *
 * Tab strips (`data-tab-strip`, laid out by index.css): when the active tab
 * changes and sits outside the strip's visible part, the strip scrolls it into
 * the middle, so a deep link to the ninth tab does not open on a strip showing
 * the first three.
 */

export const PHONE_QUERY = '(max-width: 639.98px)';

const STACK = 'data-stack';
const LABEL = 'data-label';
const PRIMARY = 'data-primary';
const LEAD = 'data-lead';

/** The text of each column's heading, by column index (a colspan heading covers several). */
export function headingLabels(table: HTMLTableElement): string[] {
  const head = table.tHead;
  const row = head?.rows[head.rows.length - 1];
  if (!row) return [];
  const labels: string[] = [];
  for (const th of Array.from(row.cells)) {
    // A select-all checkbox is not a label for the row's checkbox.
    const text = th.querySelector('input') ? '' : (th.textContent ?? '').replace(/\s+/g, ' ').trim();
    for (let i = 0; i < th.colSpan; i += 1) labels.push(text);
  }
  return labels;
}

function setFlag(cell: Element, name: string, value: string | null): void {
  if (value === null) {
    if (cell.hasAttribute(name)) cell.removeAttribute(name);
  } else if (cell.getAttribute(name) !== value) {
    cell.setAttribute(name, value);
  }
}

/**
 * Copies each column's heading onto its body cells, and marks each row's first
 * labelled cell as its title and the unlabelled cells before it as its leads.
 * A cell spanning columns gets no label.
 */
export function labelCells(table: HTMLTableElement): void {
  const labels = headingLabels(table);
  const sections = [...Array.from(table.tBodies), ...(table.tFoot ? [table.tFoot] : [])];
  for (const section of sections) {
    for (const row of Array.from(section.rows)) {
      let col = 0;
      let titled = false;
      for (const cell of Array.from(row.cells)) {
        const label = cell.colSpan === 1 ? (labels[col] ?? '') : '';
        setFlag(cell, LABEL, label || null);
        setFlag(cell, PRIMARY, label && !titled ? '' : null);
        setFlag(cell, LEAD, !label && !titled && cell.colSpan === 1 ? '' : null);
        if (label) titled = true;
        col += cell.colSpan;
      }
    }
  }
}

/** Row-spanning cells have no single row to stack into. */
export function hasRowSpan(table: HTMLTableElement): boolean {
  return Array.from(table.rows).some((row) => Array.from(row.cells).some((cell) => cell.rowSpan > 1));
}

/** The nearest ancestor that clips or scrolls sideways: the box the table must fit. */
function clipBox(table: HTMLElement): HTMLElement | null {
  for (let el = table.parentElement; el; el = el.parentElement) {
    if (getComputedStyle(el).overflowX !== 'visible') return el;
  }
  return null;
}

function overflows(table: HTMLTableElement): boolean {
  const box = clipBox(table);
  const right = table.getBoundingClientRect().right;
  if (!box) return right > document.documentElement.clientWidth + 1;
  const style = getComputedStyle(box);
  const inner = box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  return table.offsetWidth > inner + 1 || right > box.getBoundingClientRect().right + 1;
}

/** Stacks the tables that do not fit on a phone; with `phone` false, unstacks every table. */
export function layoutTables(root: ParentNode, phone: boolean): void {
  for (const table of Array.from(root.querySelectorAll('table'))) {
    if (!phone || table.dataset.mobileTable === 'keep' || hasRowSpan(table)) {
      if (table.hasAttribute(STACK)) table.removeAttribute(STACK);
      continue;
    }
    labelCells(table);
    // offsetParent is null while the table is hidden: nothing to measure yet.
    if (!table.hasAttribute(STACK) && table.offsetParent !== null && overflows(table)) {
      table.setAttribute(STACK, '');
    }
  }
}

/** Forget every stacking decision, to measure again at a new viewport width. */
export function resetTables(root: ParentNode): void {
  for (const table of Array.from(root.querySelectorAll(`table[${STACK}]`))) table.removeAttribute(STACK);
}

const shownTab = new WeakMap<Element, Element>();

/** Scrolls each strip's active tab into the middle when it changed and is out of view. */
export function revealActiveTabs(root: ParentNode): void {
  for (const strip of Array.from(root.querySelectorAll<HTMLElement>('[data-tab-strip]'))) {
    const active = strip.querySelector('[aria-selected="true"], [aria-current]:not([aria-current="false"])');
    if (!active || shownTab.get(strip) === active) continue;
    shownTab.set(strip, active);
    if (strip.scrollWidth <= strip.clientWidth) continue;
    const s = strip.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    if (a.left >= s.left && a.right <= s.right) continue;
    strip.scrollLeft += a.left + a.width / 2 - (s.left + s.width / 2);
  }
}
