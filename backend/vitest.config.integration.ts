import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.integration.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ['./src/test-setup.ts'],
    // Vitest 4 flattened poolOptions — forks config is now top-level.
    pool: 'forks',
    forks: { singleFork: true },
    sequence: { concurrent: false },
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // As in vitest.config.ts: the contracts SOURCE of this checkout. In a
      // worktree, node_modules is the main checkout's, so the package would
      // resolve to the main checkout's dist and a contracts change made here
      // would be invisible to the integration tests until CI.
      '@insula/api-contracts': path.resolve(__dirname, '../packages/api-contracts/src/index.ts'),
    },
  },
});
