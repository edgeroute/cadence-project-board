import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * Ported verbatim from szmidtpiotr/claude-github-issue (MIT). Every line below is
 * load-bearing against the claudecodeui host, and the reasons are not discoverable
 * from the failure modes:
 *
 * - `jsxRuntime: 'classic'` — the automatic runtime resolves `jsxDEV` from its own
 *   copy of React. Loaded into the host's React context that symbol is absent, and
 *   the plugin dies with `jsxDEV is not a function` at mount. Every .tsx file in
 *   this repo therefore imports React explicitly.
 * - `define: process.env` — the bundle runs in a browser, and any transitive
 *   reference to `process` throws `process is not defined` before mount is reached.
 * - `formats: ['es']` — the host loads the entry with a dynamic `import()` on a Blob
 *   URL, so it has to be an ES module.
 * - `external: []` — React is bundled rather than shared. The host does not
 *   guarantee it provides one.
 * - `cssCodeSplit: false` — the manifest names a single `entry` file, so a separate
 *   .css emit would never be fetched. styles.css is imported `?inline` and injected
 *   at mount instead (see src/frontend/index.tsx).
 * - `minify: false` — the bundle is committed to git, and a minified diff is
 *   unreviewable. It is ~300KB either way over a local HTTP connection.
 */
export default defineConfig({
  plugins: [react({ jsxRuntime: 'classic' })],
  define: {
    'process.env': '{}',
    'process.env.NODE_ENV': '"production"'
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/frontend/index.tsx'),
      name: 'CadenceProjectBoardPlugin',
      formats: ['es'],
      fileName: () => 'frontend.js'
    },
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      external: [],
      output: { inlineDynamicImports: true }
    },
    cssCodeSplit: false,
    minify: false,
    sourcemap: false
  }
});
