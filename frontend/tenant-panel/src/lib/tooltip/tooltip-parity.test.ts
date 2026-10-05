import { describe, expect, it } from 'vitest';

/*
 * The tooltip layer is duplicated in admin-panel and tenant-panel (there is no
 * shared UI package wired into both builds). This keeps the two copies
 * byte-identical — change one, copy it to the other. This file is itself one
 * of the copies, so it runs in both panels' CI.
 */
const lib = import.meta.glob('../../../../*-panel/src/lib/tooltip/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const mount = import.meta.glob('../../../../*-panel/src/components/ui/GlobalTooltips.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/* A glob never matches the file that runs it, so this file is left out of the
   comparison on both sides (it is checked by hand when copied). */
const SELF = 'src/lib/tooltip/tooltip-parity.test.ts';
const PANEL_IN_PATH = /\/frontend\/(admin-panel|tenant-panel)\/(src\/.+)$/;
const own = /\/(admin-panel|tenant-panel)\/src\//.exec(import.meta.url)?.[1];

/**
 * Vite keys a glob match relative to THIS file: own-panel files come back as
 * `./x`, the other panel's as `../../../../tenant-panel/…`. Resolve both
 * against this file's location to `{ panel → src-relative path → source }`.
 */
function byPanel(files: Record<string, string>): Record<string, Map<string, string>> {
  const base = `file:///frontend/${own}/src/lib/tooltip/`;
  const out: Record<string, Map<string, string>> = { 'admin-panel': new Map(), 'tenant-panel': new Map() };
  for (const [key, src] of Object.entries(files)) {
    const m = PANEL_IN_PATH.exec(new URL(key, base).pathname);
    if (m && m[2] !== SELF) out[m[1]].set(m[2], src);
  }
  return out;
}

describe('tooltip layer parity between admin-panel and tenant-panel', () => {
  it('knows which panel it runs in', () => {
    expect(own).toMatch(/^(admin|tenant)-panel$/);
  });

  it.each([
    ['lib/tooltip', lib, 6],
    ['GlobalTooltips', mount, 1],
  ] as const)('%s is identical in both panels', (_name, files, count) => {
    const { 'admin-panel': admin, 'tenant-panel': tenant } = byPanel(files);
    expect(admin.size).toBeGreaterThanOrEqual(count); // the glob really matched
    expect([...tenant.keys()].sort()).toEqual([...admin.keys()].sort());
    for (const [file, src] of admin) expect(tenant.get(file), file).toBe(src);
  });
});
