import { defineConfig } from 'vitest/config';

/**
 * These tests had no runner at all until 2026-09-10.
 *
 * The backend's vitest is scoped with `--dir src` (its own src), and
 * ci-api-contracts.yml only built the package and checked its exports — so
 * every `*.test.ts` under packages/api-contracts was collected by nothing.
 * Four files sat there passing by never running, and one of them
 * (extra-mounts) was asserting a validation rule that had since been
 * deliberately reversed.
 *
 * Contracts are the single source of truth for every API shape in the
 * platform, so their tests are the last place that should be silently
 * skipped.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
