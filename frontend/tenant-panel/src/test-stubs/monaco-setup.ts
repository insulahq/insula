/**
 * Test stand-in for `@/lib/monaco-setup`. The real module loads Monaco's ESM
 * build, its CSS and Vite `?worker` imports, none of which jsdom can run; the
 * editor components themselves are mocked in the tests that render them.
 */
export const monaco = {};
