import { describe, it, expect } from 'vitest';
import { headingLabels, labelCells, hasRowSpan, layoutTables, resetTables } from './phone-layout';

function table(html: string): HTMLTableElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.querySelector('table') as HTMLTableElement;
}

describe('headingLabels', () => {
  it('reads each heading once per column it spans, from the last heading row', () => {
    const t = table(`<table><thead>
      <tr><th colspan="3">Group</th></tr>
      <tr><th><input type="checkbox"></th><th> Host <span>name</span> </th><th colspan="2">Traffic</th></tr>
    </thead><tbody></tbody></table>`);
    // A select-all checkbox labels nothing; whitespace inside a heading collapses.
    expect(headingLabels(t)).toEqual(['', 'Host name', 'Traffic', 'Traffic']);
  });

  it('is empty without a heading row', () => {
    expect(headingLabels(table('<table><tbody><tr><td>a</td></tr></tbody></table>'))).toEqual([]);
  });
});

describe('labelCells', () => {
  it('puts each column heading on its body cells, and none on a cell spanning columns', () => {
    const t = table(`<table><thead><tr><th>Rule</th><th>Host</th><th></th></tr></thead><tbody>
      <tr><td>942100</td><td>shop.example.test</td><td><button>Ban</button></td></tr>
      <tr><td colspan="3">No events</td></tr>
    </tbody></table>`);
    labelCells(t);
    const [row, empty] = Array.from(t.tBodies[0].rows);
    expect(Array.from(row.cells).map((c) => c.getAttribute('data-label'))).toEqual(['Rule', 'Host', null]);
    expect(empty.cells[0].hasAttribute('data-label')).toBe(false);
  });

  it("titles each card with the row's first labelled cell, past a checkbox column", () => {
    const t = table(`<table><thead><tr><th><input type="checkbox"></th><th>Tenant</th><th>Status</th></tr></thead>
      <tbody><tr><td><input type="checkbox"></td><td>Acme</td><td>Active</td></tr></tbody></table>`);
    labelCells(t);
    const cells = Array.from(t.tBodies[0].rows[0].cells);
    expect(cells.map((c) => c.hasAttribute('data-primary'))).toEqual([false, true, false]);
    // The checkbox before the title sits beside it; nothing after the title is a lead.
    expect(cells.map((c) => c.hasAttribute('data-lead'))).toEqual([true, false, false]);
  });

  it('follows a heading that changed, and drops a label whose heading went blank', () => {
    const t = table(`<table><thead><tr><th>Old</th><th>Gone</th></tr></thead>
      <tbody><tr><td>1</td><td>2</td></tr></tbody></table>`);
    labelCells(t);
    const [first, second] = t.tHead!.rows[0].cells;
    first.textContent = 'New';
    second.textContent = '';
    labelCells(t);
    const cells = t.tBodies[0].rows[0].cells;
    expect(cells[0].getAttribute('data-label')).toBe('New');
    expect(cells[1].hasAttribute('data-label')).toBe(false);
  });
});

describe('hasRowSpan', () => {
  it('finds a row-spanning cell anywhere in the table', () => {
    expect(hasRowSpan(table('<table><tbody><tr><td rowspan="2">a</td><td>b</td></tr><tr><td>c</td></tr></tbody></table>'))).toBe(true);
    expect(hasRowSpan(table('<table><tbody><tr><td>a</td></tr></tbody></table>'))).toBe(false);
  });
});

describe('layoutTables', () => {
  it('unstacks every table off a phone', () => {
    const t = table('<table data-stack=""><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>');
    layoutTables(document, false);
    expect(t.hasAttribute('data-stack')).toBe(false);
  });

  it('never stacks a table that opted out or spans rows', () => {
    const kept = table('<table data-mobile-table="keep" data-stack=""><tbody><tr><td>1</td></tr></tbody></table>');
    const spanned = table('<table data-stack=""><tbody><tr><td rowspan="2">1</td></tr><tr></tr></tbody></table>');
    layoutTables(document, true);
    expect(kept.hasAttribute('data-stack')).toBe(false);
    expect(spanned.hasAttribute('data-stack')).toBe(false);
  });

  it('labels cells on a phone and keeps a table stacked once it was', () => {
    // jsdom has no layout, so nothing measures as overflowing: a table is only
    // stacked here because it already was, which must survive a re-run.
    const t = table('<table data-stack=""><thead><tr><th>Name</th></tr></thead><tbody><tr><td>x</td></tr></tbody></table>');
    layoutTables(document, true);
    expect(t.hasAttribute('data-stack')).toBe(true);
    expect(t.tBodies[0].rows[0].cells[0].getAttribute('data-label')).toBe('Name');
    resetTables(document);
    expect(t.hasAttribute('data-stack')).toBe(false);
  });
});
