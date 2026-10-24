import { describe, it, expect } from 'vitest';

// Every instant on screen reads in the viewer's zone, through LocalTime or
// formatLocalInstant. Cutting an ISO string shows the UTC wall clock with no
// zone named, which is how WAF events and backup tables came to disagree with
// the filters next to them.
const sources = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const NOT_DISPLAY = new Set([
  // a download file name
  '/src/components/LogViewer.tsx',
]);

const UTC_CUT = [
  /toISOString\(\)\.(slice|replace|substring|split)\(/,
  /(At|Until|_at|_until)\??\.slice\(0, ?1[069]\)/,
];

describe('no instant is shown as a cut UTC string', () => {
  it('every source file formats times through the local-time helpers', () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !/\.test\.tsx?$|\/__tests__\//.test(path) && !NOT_DISPLAY.has(path))
      .flatMap(([path, text]) => text.split('\n')
        .map((line, i) => ({ path, line: i + 1, text: line.trim() }))
        .filter(({ text: l }) => UTC_CUT.some((re) => re.test(l))));
    expect(offenders).toEqual([]);
  });

  it('still sees the source tree', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
  });
});
