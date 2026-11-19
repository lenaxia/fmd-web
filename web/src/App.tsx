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
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { BookOpenText, Compass, Download as DownloadIcon, Heart, LibraryBig, Moon, Search, Settings as SettingsIcon, Sun, TriangleAlert } from 'lucide-react';
import { useBootstrapStatus } from './api/hooks';
import { navigate, parseHash, ROUTE_NAMES, type Route, type RouteName } from './router';
import { useTheme } from './state/theme';
import { requestSearchFocus } from './state/search-focus';
import { beginVisit } from './state/last-visit';
import { JobsActivityProvider, useJobsActivity, badgeLabel } from './state/jobs-activity';
import { CommandPalette } from './components/palette/CommandPalette';
import { BottomTabNav, type BottomTabDestination } from './components/patterns/BottomTabNav';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { cn } from 'cn';
import { BrowsePage } from './pages/BrowsePage';
import { MangaPage } from './pages/MangaPage';
import { AttentionPage } from './pages/AttentionPage';
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
  { name: 'attention', label: 'Attention' },
  { name: 'library', label: 'Library' },
  { name: 'settings', label: 'Settings' },
];

const NAV_ROUTES: readonly RouteName[] = NAV_TABS.map((tab): RouteName => tab.name);
if (ROUTE_NAMES.some((name): boolean => name !== 'manga' && !NAV_ROUTES.includes(name))) {
  throw new Error('App shell nav is out of sync with the router (router.ts ROUTE_NAMES)');
}

/**
 * The SAME destinations for the mobile bottom tab bar (R3: mobile and
 * desktop are equal first-class citizens — the shell adapts, the routes
 * do not). Icon-only below md, icon+label, every target on the touch
 * token; the bar itself is safe-area aware (BottomTabNav pattern).
 */
const BOTTOM_NAV_DESTINATIONS: readonly BottomTabDestination[] = NAV_TABS.map(
  (tab): BottomTabDestination => ({
    name: tab.name,
    label: tab.label,
    icon:
      tab.name === 'browse' ? <Compass aria-hidden="true" /> :
      tab.name === 'favorites' ? <Heart aria-hidden="true" /> :
      tab.name === 'downloads' ? <DownloadIcon aria-hidden="true" /> :
      tab.name === 'attention' ? <TriangleAlert aria-hidden="true" /> :
      tab.name === 'library' ? <LibraryBig aria-hidden="true" /> :
      <SettingsIcon aria-hidden="true" />,
  }),
);

function Nav(props: { current: RouteName }): ReactElement {
  // R5 arrival: the Downloads tab carries the live queue badge
  // (running+queued) + the completion dot (cleared on visit).
  const { activeCount, completionDot } = useJobsActivity();
  return (
    <nav aria-label="Primary" className="min-w-0">
      <ul className="flex list-none items-center gap-1 overflow-x-auto p-0">
        {NAV_TABS.map((tab): ReactElement => (
          <li key={tab.name}>
            <a
              href={`#/${tab.name}`}
              aria-current={props.current === tab.name ? 'page' : undefined}
              className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap',
                'text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground',
                'aria-[current=page]:bg-surface aria-[current=page]:text-foreground',
              )}
            >
              {tab.label}
              {tab.name === 'downloads' && activeCount > 0 ? (
                <span
                  data-testid="nav-downloads-badge"
                  aria-label={`${badgeLabel(activeCount)} active downloads`}
                  className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[11px] leading-none font-semibold text-primary-foreground"
                >
                  {badgeLabel(activeCount)}
                </span>
              ) : null}
              {tab.name === 'downloads' && completionDot ? (
                <span
                  data-testid="nav-downloads-dot"
                  aria-hidden="true"
                  className="size-1.5 rounded-full bg-primary"
                />
              ) : null}
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
      First-run bootstrap running: {stage}
    </div>
  );
}

/**
 * Palette affordance (R3: never keyboard-only): a visible Search
 * button in the header on EVERY viewport — icon-only on mobile (where
 * there is no Cmd key), label + kbd hint on desktop. Opens the
 * command palette (Cmd/Ctrl+K is the keyboard twin).
 */
function PaletteButton(props: { readonly onOpen: () => void }): ReactElement {
  const isApple: boolean = useMemo(
    (): boolean =>
      typeof navigator !== 'undefined' &&
      (navigator.platform === 'MacIntel' || /Mac|iPhone|iPad/.test(navigator.platform)),
    [],
  );
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="gap-1.5"
      aria-label="Open command palette"
      aria-keyshortcuts="Control+K Meta+K"
      onClick={props.onOpen}
    >
      <Search aria-hidden="true" />
      <span className="hidden text-muted-foreground sm:inline">Search</span>
      <kbd className="hidden rounded border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground md:inline-flex">
        {isApple ? '⌘K' : 'Ctrl K'}
      </kbd>
    </Button>
  );
}

/**
 * Global keyboard layer (search-first IA):
 * - '/' focuses the search-home input from ANYWHERE (except while
 *   typing in another control); if the home isn't the current route
 *   the shortcut navigates there first (back restores the context).
 * - Cmd/Ctrl+K toggles the command palette.
 */
function useGlobalShortcuts(props: {
  readonly paletteOpen: boolean;
  readonly onTogglePalette: () => void;
  readonly isSearchHomeRoute: () => boolean;
}): void {
  const { paletteOpen, onTogglePalette, isSearchHomeRoute } = props;
  useEffect((): (() => void) => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const key: string = event.key;
      if ((event.metaKey || event.ctrlKey) && (key === 'k' || key === 'K')) {
        event.preventDefault();
        onTogglePalette();
        return;
      }
      if (key === '/' && !paletteOpen) {
        const target: EventTarget | null = event.target;
        const typing: boolean =
          target instanceof HTMLElement &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT' ||
            target.isContentEditable);
        if (typing) {
          return; // '/' is a literal character in another control
        }
        event.preventDefault();
        if (!isSearchHomeRoute()) {
          navigate('browse', {});
        }
        requestSearchFocus();
      }
    };
    globalThis.window.addEventListener('keydown', onKeyDown);
    return (): void => {
      globalThis.window.removeEventListener('keydown', onKeyDown);
    };
  }, [paletteOpen, onTogglePalette, isSearchHomeRoute]);
}

export function App(): ReactElement {
  // R5 arrival: the one-shot visit stamp (previous stamp cached for
  // the away summary; rewritten to now — "updated on each visit").
  useEffect((): void => {
    beginVisit();
  }, []);

  return (
    <JobsActivityProvider>
      <AppShell />
    </JobsActivityProvider>
  );
}

function AppShell(): ReactElement {
  const [route, setRoute] = useState<Route>(parseHash(globalThis.location.hash));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { activeCount, completionDot, clearCompletionDot } = useJobsActivity();

  useEffect((): (() => void) => {
    const onHashChange = (): void => {
      setRoute(parseHash(globalThis.location.hash));
    };
    globalThis.addEventListener('hashchange', onHashChange);
    return (): void => {
      globalThis.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  // R5 arrival: VISITING Downloads clears the completion dot (also
  // when a completion fires while already on the page — no re-arm).
  useEffect((): void => {
    if (route.name === 'downloads' && completionDot) {
      clearCompletionDot();
    }
  }, [route.name, completionDot, clearCompletionDot]);

  // '/' targets the search home only when it is (or will be) the
  // active view — the site entries view, the picker (?sites=) and the
  // parity union view (?allsites=) are site-first states that the
  // shortcut deliberately leaves (back restores them).
  const isSearchHomeRoute = useCallback((): boolean => {
    const current: Route = parseHash(globalThis.location.hash);
    return (
      current.name === 'browse' &&
      current.query['site'] === undefined &&
      current.query['catalog'] === undefined &&
      current.query['allsites'] === undefined &&
      current.query['sites'] === undefined
    );
  }, []);

  const togglePalette = useCallback((): void => {
    setPaletteOpen((open): boolean => !open);
  }, []);

  useGlobalShortcuts({
    paletteOpen,
    onTogglePalette: togglePalette,
    isSearchHomeRoute,
  });

  return (
    <div className="flex min-h-screen flex-col">
      <BootstrapBanner />
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur-sm">
        <div className="mx-auto flex h-14 w-full max-w-page items-center gap-3 px-4">
          {/* Compact below md (R3): icon-only brand; the wordmark returns
           * with the top tab nav at >=md. */}
          <a
            href="#/browse"
            aria-label="FMD Web home"
            className="flex items-center gap-2 rounded-md py-1 text-sm font-semibold whitespace-nowrap max-md:min-h-touch-target max-md:min-w-touch-target md:py-1"
          >
            <BookOpenText aria-hidden="true" className="size-5 text-primary" />
            <h1 className="m-0 hidden text-base font-semibold md:block">FMD Web</h1>
          </a>
          <div className="mx-1 hidden h-5 w-px bg-border sm:block" />
          {/* Top tab nav is the >=md surface; below md the shell mounts the
           * BottomTabNav (same destinations, same routes — R3). */}
          <div className="hidden min-w-0 md:block">
            <Nav current={route.name} />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <PaletteButton onOpen={(): void => { setPaletteOpen(true); }} />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-page flex-1 px-4 py-6 max-md:pb-[calc(var(--spacing-bottom-nav)+var(--spacing-safe-bottom)+1.5rem)]">
        {route.name === 'browse' ? <BrowsePage route={route} /> : null}
        {route.name === 'manga' ? <MangaPage route={route} /> : null}
        {route.name === 'attention' ? <AttentionPage /> : null}
        {route.name === 'downloads' ? <DownloadsPage /> : null}
        {route.name === 'favorites' ? <FavoritesPage /> : null}
        {route.name === 'library' ? <LibraryPage /> : null}
        {route.name === 'settings' ? <SettingsPage /> : null}
      </main>
      <BottomTabNav
        current={route.name}
        destinations={BOTTOM_NAV_DESTINATIONS}
        badges={{ downloads: { count: activeCount, dot: completionDot } }}
      />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <Toaster position="bottom-right" />
    </div>
  );
}
