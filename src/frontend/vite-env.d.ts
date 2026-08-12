/// <reference types="vite/client" />

// Vite's `?inline` query returns the compiled CSS as a string. Without this
// declaration TypeScript resolves the import to `any` under some configs and to an
// error under `isolatedModules` — see src/frontend/index.tsx for why the CSS has to
// arrive as a string rather than as a second emitted file.
declare module '*.css?inline' {
  const css: string;
  export default css;
}
