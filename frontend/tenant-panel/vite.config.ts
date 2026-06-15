import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Force a single React instance. The workspace package
    // `@insula/ui-restore-cart` is built standalone and (in the Docker
    // build) gets its own `node_modules/react` from its devDependencies.
    // Without dedupe, Vite bundles that second copy into the package's
    // chunk; its hooks dispatcher is null, so any hook in RestoreCartLayout
    // (e.g. useState) crashes with "Cannot read properties of null
    // (reading 'useState')" — which broke the /backups/restore page.
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
