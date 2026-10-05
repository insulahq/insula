/**
 * Monaco must come from this image. `@monaco-editor/react` silently falls
 * back to cdn.jsdelivr.net when `loader.config({ monaco })` has not run, so
 * every module that renders an editor imports `@/lib/monaco-setup` first.
 */
import { describe, it, expect } from 'vitest';

const SOURCES = import.meta.glob(
  ['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}', '!/src/__tests__/**', '!/src/test-stubs/**'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

describe('Monaco is self-hosted', () => {
  it('every module that renders an editor imports the setup that bundles Monaco', () => {
    const editors = Object.entries(SOURCES).filter(([, text]) => /from '@monaco-editor\/react'/.test(text));
    expect(editors.length).toBeGreaterThan(0);
    const missing = editors
      .filter(([path]) => path !== '/src/lib/monaco-setup.ts')
      .filter(([, text]) => !/import '@\/lib\/monaco-setup';/.test(text))
      .map(([path]) => path);
    expect(missing).toEqual([]);
  });

  it('nothing configures the loader to fetch Monaco from a CDN', () => {
    const cdn = /['"`]https?:\/\/(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com)\/[^'"`]*monaco|loader\.config\(\s*\{\s*paths/;
    expect(Object.entries(SOURCES).filter(([, text]) => cdn.test(text)).map(([path]) => path)).toEqual([]);
  });
});
