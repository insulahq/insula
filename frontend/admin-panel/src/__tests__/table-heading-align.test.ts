import { describe, it, expect } from 'vitest';
import css from '../index.css?raw';

// The browser centres a <th>, and Tailwind's preflight leaves it so: every
// heading without its own class sat in the middle of a left-aligned column (the
// WAF auto-ban dry run, the WAF events, most sortable tables). One base rule
// puts headings left; a class on a heading (text-right on a number column) still
// wins, because utilities outrank the base layer. jsdom does not apply the
// stylesheet, so this pins the rule itself.
describe('table headings are left-aligned by default', () => {
  it('the base layer aligns th left', () => {
    // The base block alone, up to its closing brace at the start of a line.
    const start = css.indexOf('@layer base {');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = css.slice(start, css.indexOf('\n}', start));
    expect(block).toMatch(/\n\s*th\s*\{\s*text-align:\s*left;\s*\}/);
  });
});
