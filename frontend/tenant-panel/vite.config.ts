import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { createRequire } from 'module';

// monaco-yaml's worker (via monaco-worker-manager) imports
// `monaco-editor/esm/vs/editor/editor.worker.js`, a path monaco-editor's
// `exports` map (since 0.55) no longer resolves. Point that deep import
// straight at the package's files. Resolved through Node so it holds for the
// hoisted workspace layout locally and in the Docker build alike.
const monacoRoot = path.resolve(path.dirname(createRequire(import.meta.url).resolve('monaco-editor')), '../..');

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
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      { find: /^monaco-editor\/esm\/vs\/(.*)$/, replacement: `${monacoRoot}/esm/vs/$1` },
    ],
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
