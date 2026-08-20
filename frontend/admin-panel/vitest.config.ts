import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/vitest-setup.ts'],
    css: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Resolve contracts from SOURCE in tests, not packages/api-contracts/dist.
      // Against dist, a stale build surfaces as "<someExport> is not a function"
      // — which reads like a product bug, not a missing build step, and is
      // invisible in CI because CI always builds fresh. See CLAUDE.md on
      // `tsc --build --force`.
      '@insula/api-contracts': path.resolve(__dirname, '../../packages/api-contracts/src/index.ts'),
    },
  },
});
