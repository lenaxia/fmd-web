/**
 * App shell (§11): hash-routed SPA over the four §10 pages, mounted
 * once by main.tsx inside QueryClientProvider + ApiClientProvider.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { useBootstrapStatus } from './api/hooks';
import { parseHash, ROUTE_NAMES, type Route, type RouteName } from './router';
import { BrowsePage } from './pages/BrowsePage';
import { MangaPage } from './pages/MangaPage';
import { DownloadsPage } from './pages/DownloadsPage';
import { FavoritesPage } from './pages/FavoritesPage';
import { LibraryPage } from './pages/LibraryPage';
import { SettingsPage } from './pages/SettingsPage';

function Nav(props: { current: RouteName }): ReactElement {
  const label: Record<RouteName, string> = {
    browse: 'Browse',
    manga: 'Manga',
    downloads: 'Downloads',
    favorites: 'Favorites',
    library: 'Library',
    settings: 'Settings',
  };
  return (
    <nav aria-label="Primary">
      <ul className="nav-list">
        {ROUTE_NAMES.map((name): ReactElement => (
          <li key={name}>
            <a href={`#/${name}`} aria-current={props.current === name ? 'page' : undefined}>
              {label[name]}
            </a>
          </li>
        ))}
      </ul>
    </nav>
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
    <div role="status" aria-live="polite" className="bootstrap-banner" data-testid="bootstrap-status">
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
    <>
      <BootstrapBanner />
      <header>
        <h1>FMD Web</h1>
        <Nav current={route.name} />
      </header>
      <main>
        {route.name === 'browse' ? <BrowsePage route={route} /> : null}
        {route.name === 'manga' ? <MangaPage route={route} /> : null}
        {route.name === 'downloads' ? <DownloadsPage /> : null}
        {route.name === 'favorites' ? <FavoritesPage /> : null}
        {route.name === 'library' ? <LibraryPage /> : null}
        {route.name === 'settings' ? <SettingsPage /> : null}
      </main>
    </>
  );
}
