/**
 * Theme state (design system): class-strategy theming over the token
 * layer — `html.dark` (default, this is a manga app) / `html.light`.
 *
 * Resolution order for the FIRST paint (mirrored by the pre-hydration
 * script in index.html so no flash ever occurs):
 *   persisted choice (localStorage) → prefers-color-scheme → dark.
 * The toggle persists its choice and React re-renders nothing visual
 * itself — flipping the class re-resolves every CSS variable, which
 * re-themes every utility and shadcn component at once.
 */
import { createContext, useContext, useEffect, useState, type ReactElement, type ReactNode } from 'react';

export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'fmd-web-theme';

export function resolveInitialTheme(): Theme {
  try {
    const stored = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') {
      return stored;
    }
  } catch {
    // storage unavailable (private mode &c.) — fall through to the system
  }
  if (globalThis.matchMedia?.('(prefers-color-scheme: light)').matches === true) {
    return 'light';
  }
  return 'dark';
}

export function applyThemeClass(theme: Theme): void {
  const root = globalThis.document?.documentElement;
  if (root === null || root === undefined) {
    return;
  }
  root.classList.toggle('dark', theme === 'dark');
  root.classList.toggle('light', theme === 'light');
}

interface ThemeContextValue {
  readonly theme: Theme;
  readonly toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({ theme: 'dark', toggleTheme: (): void => {} });

export function ThemeProvider(props: { children: ReactNode }): ReactElement {
  const [theme, setTheme] = useState<Theme>(resolveInitialTheme);

  useEffect((): (() => void) => {
    applyThemeClass(theme);
    try {
      globalThis.localStorage?.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // persistence best-effort only
    }
    // Follow OS changes while the user has no explicit stored choice.
    const media = globalThis.matchMedia?.('(prefers-color-scheme: light)');
    const onSystem = (event: MediaQueryListEvent): void => {
      let stored: string | null = null;
      try {
        stored = globalThis.localStorage?.getItem(THEME_STORAGE_KEY) ?? null;
      } catch {
        stored = null;
      }
      if (stored !== 'dark' && stored !== 'light') {
        const next: Theme = event.matches ? 'light' : 'dark';
        setTheme(next);
        applyThemeClass(next);
      }
    };
    media?.addEventListener('change', onSystem);
    return (): void => {
      media?.removeEventListener('change', onSystem);
    };
  }, [theme]);

  const toggleTheme = (): void => {
    setTheme((prev): Theme => (prev === 'dark' ? 'light' : 'dark'));
  };

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{props.children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
