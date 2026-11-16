/**
 * App shell (§11 + design system): hash-routed SPA over the §10 pages,
 * mounted once by main.tsx inside ThemeProvider + QueryClientProvider
 * + ApiClientProvider.
 *
 * ONE layout owns the rhythm: sticky header (brand + primary nav tabs
 * matching the router + theme toggle) and a single max-w-page container
 * — pages render into it and never set their own page-level layout.
 * Styling flows exclusively from the token layer (styles/tokens.css);
 * this file knows names, not colors.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { BookOpenText, Moon, Sun } from 'lucide-react';
import { useBootstrapStatus } from './api/hooks';
import { parseHash, ROUTE_NAMES, type Route, type RouteName } from './router';
import { useTheme } from './state/theme';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { cn } from 'cn';
import { BrowsePage } from './pages/BrowsePage';
import { MangaPage } from './pages/MangaPage';
import { DownloadsPage } from './pages/DownloadsPage';
import { FavoritesPage } from './pages/FavoritesPage';
import { LibraryPage } from './pages/LibraryPage';
import { SettingsPage } from './pages/SettingsPage';

/** Primary nav = the router's top-level tabs (manga is a detail route,
 * reached from Browse entries). One product order, shared by every tab. */
const NAV_TABS: readonly { readonly name: RouteName; readonly label: string }[] = [
  { name: 'browse', label: 'Browse' },
  { name: 'favorites', label: 'Favorites' },
  { name: 'downloads', label: 'Downloads' },
  { name: 'library', label: 'Library' },
  { name: 'settings', label: 'Settings' },
];

const NAV_ROUTES: readonly RouteName[] = NAV_TABS.map((tab): RouteName => tab.name);
if (ROUTE_NAMES.some((name): boolean => name !== 'manga' && !NAV_ROUTES.includes(name))) {
  throw new Error('App shell nav is out of sync with the router (router.ts ROUTE_NAMES)');
}

function Nav(props: { current: RouteName }): ReactElement {
  return (
    <nav aria-label="Primary" className="min-w-0">
      <ul className="flex list-none items-center gap-1 overflow-x-auto p-0">
        {NAV_TABS.map((tab): ReactElement => (
          <li key={tab.name}>
            <a
              href={`#/${tab.name}`}
              aria-current={props.current === tab.name ? 'page' : undefined}
              className={cn(
                'inline-flex h-9 items-center rounded-md px-3 text-sm font-medium whitespace-nowrap',
                'text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground',
                'aria-[current=page]:bg-surface aria-[current=page]:text-foreground',
              )}
            >
              {tab.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function ThemeToggle(): ReactElement {
  const { theme, toggleTheme } = useTheme();
  const next = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <Button variant="ghost" size="icon" aria-label="Toggle theme" title={next} onClick={toggleTheme}>
      {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
    </Button>
  );
}

/**
 * D20 first-run bootstrap progress banner (§11): polls /readyz and
 * surfaces the server's stage (`reason`) until the server reports
 * ready. Hidden once ready — the compose e2e asserts both the
 * appearance (bootstrap running) and the disappearance (ready).
 */
function BootstrapBanner(): ReactElement | null {
  const status = useBootstrapStatus();
  if (status.data?.ready === true) {
    return null;
  }
  const stage = status.isError ? 'connecting to the server…' : (status.data?.reason ?? 'connecting to the server…');
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="bootstrap-status"
      className="border-b border-primary/50 bg-surface px-4 py-2 text-sm text-foreground"
    >
      First-run bootstrap running (D20) — {stage}
    </div>
  );
}

export function App(): ReactElement {
  const [route, setRoute] = useState<Route>(parseHash(globalThis.location.hash));

  useEffect((): (() => void) => {
    const onHashChange = (): void => {
      setRoute(parseHash(globalThis.location.hash));
    };
    globalThis.addEventListener('hashchange', onHashChange);
    return (): void => {
      globalThis.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col">
      <BootstrapBanner />
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur-sm">
        <div className="mx-auto flex h-14 w-full max-w-page items-center gap-3 px-4">
          <a
            href="#/browse"
            className="flex items-center gap-2 rounded-md py-1 text-sm font-semibold whitespace-nowrap"
          >
            <BookOpenText aria-hidden="true" className="size-5 text-primary" />
            <h1 className="m-0 text-base font-semibold">FMD Web</h1>
          </a>
          <div className="mx-1 hidden h-5 w-px bg-border sm:block" />
          <Nav current={route.name} />
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-page flex-1 px-4 py-6">
        {route.name === 'browse' ? <BrowsePage route={route} /> : null}
        {route.name === 'manga' ? <MangaPage route={route} /> : null}
        {route.name === 'downloads' ? <DownloadsPage /> : null}
        {route.name === 'favorites' ? <FavoritesPage /> : null}
        {route.name === 'library' ? <LibraryPage /> : null}
        {route.name === 'settings' ? <SettingsPage /> : null}
      </main>
      <Toaster position="bottom-right" />
    </div>
  );
}
