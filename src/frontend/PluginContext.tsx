import React, { createContext, useContext } from 'react';
import type { PluginAPI } from './types';

const Ctx = createContext<PluginAPI | null>(null);

export const PluginProvider: React.FC<{ api: PluginAPI; children: React.ReactNode }> = ({ api, children }) => (
  <Ctx.Provider value={api}>{children}</Ctx.Provider>
);

export function usePluginAPI(): PluginAPI {
  const api = useContext(Ctx);
  if (!api) throw new Error('usePluginAPI must be used inside PluginProvider');
  return api;
}

/**
 * The host's current project path, re-read when the host says it changed.
 *
 * `api.context` is a plain object the host mutates rather than a React value, so
 * nothing re-renders on its own when the reader switches project. `onContextChange`
 * is the only signal, and forgetting to subscribe leaves the board showing the
 * previous project's cards with no indication anything moved.
 */
export function useProjectPath(): string | null {
  const api = usePluginAPI();
  const [path, setPath] = React.useState<string | null>(api.context.project?.path ?? null);
  React.useEffect(() => {
    return api.onContextChange(() => setPath(api.context.project?.path ?? null));
  }, [api]);
  return path;
}

/** The host's theme, same subscription rules as above. */
export function useTheme(): 'dark' | 'light' {
  const api = usePluginAPI();
  const [theme, setTheme] = React.useState<'dark' | 'light'>(api.context.theme);
  React.useEffect(() => {
    return api.onContextChange(() => setTheme(api.context.theme));
  }, [api]);
  return theme;
}
