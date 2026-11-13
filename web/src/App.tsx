/**
 * App shell (§11): hash-routed SPA over the four §10 pages, mounted
 * once by main.tsx inside QueryClientProvider + ApiClientProvider.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { ApiClientProvider } from './api/context';
import { parseHash, ROUTE_NAMES, type Route, type RouteName } from './router';
import { BrowsePage } from './pages/BrowsePage';
import { MangaPage } from './pages/MangaPage';
import { DownloadsPage } from './pages/DownloadsPage';
import { SettingsPage } from './pages/SettingsPage';

function Nav(props: { current: RouteName }): ReactElement {
  const label: Record<RouteName, string> = {
    browse: 'Browse',
    manga: 'Manga',
    downloads: 'Downloads',
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
    <ApiClientProvider>
      <header>
        <h1>FMD Web</h1>
        <Nav current={route.name} />
      </header>
      <main>
        {route.name === 'browse' ? <BrowsePage route={route} /> : null}
        {route.name === 'manga' ? <MangaPage route={route} /> : null}
        {route.name === 'downloads' ? <DownloadsPage /> : null}
        {route.name === 'settings' ? <SettingsPage /> : null}
      </main>
    </ApiClientProvider>
  );
}
