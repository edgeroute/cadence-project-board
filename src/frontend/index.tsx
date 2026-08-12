import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PluginProvider } from './PluginContext';
import { App } from './App';
import type { PluginAPI } from './types';
// `?inline` gives the CSS as a string rather than emitting a second file. The manifest
// names one `entry`, so a separate stylesheet would never be fetched — see vite.config.
import stylesRaw from './styles.css?inline';

// Injected once per document, not once per mount: the host mounts and unmounts the tab
// as the reader moves between tabs, and appending a <style> each time would leave a
// growing stack of identical rules behind.
const STYLE_ID = 'cpb-plugin-styles';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = stylesRaw;
  document.head.appendChild(el);
}

// Keyed by container so a remount into the same element reuses its root. Calling
// `createRoot` twice on one node is a React warning and two trees fighting over it.
const roots = new WeakMap<HTMLElement, Root>();

export function mount(container: HTMLElement, api: PluginAPI): void {
  let root = roots.get(container);
  if (!root) {
    root = createRoot(container);
    roots.set(container, root);
  }
  root.render(
    <PluginProvider api={api}>
      <App />
    </PluginProvider>
  );
}

export function unmount(container: HTMLElement): void {
  const root = roots.get(container);
  if (root) {
    root.unmount();
    roots.delete(container);
  }
}
