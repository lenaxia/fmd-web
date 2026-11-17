/**
 * CommandPalette (Cmd/Ctrl+K, R5 web-native IA): the vendored cmdk
 * dialog (components/ui/command.tsx) composed over existing surfaces —
 * NO new API. Four action families:
 *
 *   Navigate      — the five top-level routes
 *   Sites         — jump-to-site: searches the FULL module registry by
 *                   name or category (all 454, not just enabled — but
 *                   only enabled, non-broken rows are selectable, the
 *                   same gating as the site picker) → opens its entries
 *   Recent manga  — the shared recents store (localStorage, capped +
 *                   deduped; cleared from the search home rows)
 *   Actions       — 'Sync all catalogs', 'Check favorites for new
 *                   chapters', 'Toggle theme'
 *
 * Ephemeral BY DESIGN: the palette's open state and query are React
 * state — never URL-synced (the query resets on every open; only the
 * executed action writes the URL). Radix Dialog owns the focus trap +
 * Esc; cmdk owns the combobox semantics (input role=combobox, list
 * role=listbox, items role=option) and arrow-key selection.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  BookOpenText,
  Bookmark,
  Download,
  Heart,
  Library,
  RefreshCw,
  Search,
  Settings,
} from 'lucide-react';
import { toast } from 'sonner';
import { navigate, type RouteName } from '../../router';
import { useFavoritesCheckBatch, useModules, useSyncAllCatalogs } from '../../api/hooks';
import { promptInstall, useInstallAvailability } from '../../state/pwa-install';
import { useRecentManga, type RecentManga } from '../../state/recents';
import { useTheme } from '../../state/theme';
import { siteRowDisabledReason } from '@/components/SiteRow';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';

/** Registry search hits rendered per query (the 454-row list stays fast). */
const SITE_RESULTS_CAP = 20;

const NAV_ITEMS: readonly {
  readonly name: RouteName;
  readonly label: string;
  readonly icon: typeof BookOpenText;
}[] = [
  { name: 'browse', label: 'Browse', icon: BookOpenText },
  { name: 'favorites', label: 'Favorites', icon: Heart },
  { name: 'downloads', label: 'Downloads', icon: Download },
  { name: 'library', label: 'Library', icon: Library },
  { name: 'settings', label: 'Settings', icon: Settings },
];

function matchModule(
  module: { readonly name: string; readonly category: string },
  needle: string,
): boolean {
  if (needle === '') return true;
  return (
    module.name.toLowerCase().includes(needle) ||
    module.category.toLowerCase().includes(needle)
  );
}

function openRecentManga(manga: RecentManga): void {
  navigate('manga', {
    module: manga.moduleId,
    url: manga.url,
    title: manga.title,
    ...(manga.catalogId !== undefined ? { catalog: manga.catalogId } : {}),
  });
}

export function CommandPalette(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement {
  // Ephemeral query — resets on every open (never URL-synced).
  const [query, setQuery] = useState('');
  useEffect((): void => {
    if (props.open) {
      setQuery('');
    }
  }, [props.open]);

  const modules = useModules();
  const recentManga = useRecentManga();
  const syncAll = useSyncAllCatalogs();
  const checkFavorites = useFavoritesCheckBatch();
  const { toggleTheme } = useTheme();
  // R5 arrival: the install action exists ONLY when the browser fired
  // beforeinstallprompt (hidden on iOS Safari/Firefox by design).
  const install = useInstallAvailability();

  const close = (): void => {
    props.onOpenChange(false);
  };

  const runAndClose = (action: () => void): void => {
    action();
    close();
  };

  // Jump-to-site: the FULL registry searched by name/category — the
  // whole 454, one flat list capped per query (registry order).
  const needle: string = query.trim().toLowerCase();
  const siteHits = useMemo(
    (): readonly {
      readonly id: string;
      readonly name: string;
      readonly category: string;
      readonly enabled: boolean;
      readonly brokenReason: string | undefined;
    }[] =>
      (modules.data?.modules ?? [])
        .filter((module): boolean => matchModule(module, needle))
        .slice(0, SITE_RESULTS_CAP)
        .map((module): {
          readonly id: string;
          readonly name: string;
          readonly category: string;
          readonly enabled: boolean;
          readonly brokenReason: string | undefined;
        } => ({
          id: module.id,
          name: module.name,
          category: module.category,
          enabled: module.enabled,
          brokenReason: siteRowDisabledReason(module),
        })),
    [modules.data, needle],
  );

  const onSyncAll = (): void => {
    toast.message('Syncing all catalogs…');
    syncAll.mutate(undefined, {
      onSuccess: (result): void => {
        const updated = result.results.filter((row): boolean => row.state === 'updated').length;
        toast.success(`Catalog sync finished — ${String(updated)} updated`);
      },
      onError: (): void => {
        toast.error('Catalog sync failed');
      },
    });
  };

  const onCheckFavorites = (): void => {
    toast.message('Checking favorites for new chapters…');
    checkFavorites.mutate('all', {
      onSuccess: (result): void => {
        const withNew = result.results.filter((row): boolean => row.newChapters.length > 0).length;
        toast.success(`Favorites check finished — ${String(withNew)} with new chapters`);
      },
      onError: (): void => {
        toast.error('Favorites check failed');
      },
    });
  };

  return (
    <CommandDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Command palette"
      description="Search commands, sites and recent manga."
    >
      <CommandInput
        placeholder="Type a command, a site, or a title…"
        value={query}
        onValueChange={setQuery}
        data-testid="palette-input"
      />
      <CommandList data-testid="palette-list">
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Navigate">
          {NAV_ITEMS.map((item): ReactElement => {
            const Icon = item.icon;
            return (
              <CommandItem
                key={item.name}
                value={`Go to ${item.label}`}
                onSelect={(): void => {
                  runAndClose((): void => {
                    navigate(item.name, {});
                  });
                }}
                data-testid={`palette-nav-${item.name}`}
              >
                <Icon aria-hidden="true" />
                {item.label}
              </CommandItem>
            );
          })}
        </CommandGroup>

        {recentManga.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Recent manga">
              {recentManga.map((manga): ReactElement => (
                <CommandItem
                  key={`${manga.moduleId}-${manga.url}`}
                  value={`Open ${manga.title}`}
                  onSelect={(): void => {
                    runAndClose((): void => {
                      openRecentManga(manga);
                    });
                  }}
                  data-testid="palette-recent-manga"
                >
                  <Bookmark aria-hidden="true" />
                  <span className="max-w-80 truncate">{manga.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {needle !== '' ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Sites">
              {siteHits.map((site): ReactElement => (
                <CommandItem
                  key={site.id}
                  value={`Open ${site.name} (${site.category})`}
                  disabled={!site.enabled || site.brokenReason !== undefined}
                  onSelect={(): void => {
                    runAndClose((): void => {
                      navigate('browse', { site: site.id });
                    });
                  }}
                  data-testid="palette-site"
                >
                  <Search aria-hidden="true" />
                  <span>{site.name}</span>
                  <span className="text-xs text-muted-foreground">{site.category}</span>
                  {!site.enabled || site.brokenReason !== undefined ? (
                    <span className="text-xs text-muted-foreground">unavailable</span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        <CommandSeparator />
        <CommandGroup heading="Actions">
          {install.available && !install.installed ? (
            <CommandItem
              value="Install app"
              onSelect={(): void => {
                runAndClose((): void => {
                  void promptInstall().then((outcome): void => {
                    if (outcome === 'accepted') {
                      toast.success('FMD Web installed — find it on your home screen / desktop.');
                    } else if (outcome === 'dismissed') {
                      toast.message('Install dismissed — the browser re-offers after its cooldown.');
                    }
                  });
                });
              }}
              data-testid="palette-action-install-app"
            >
              <Download aria-hidden="true" />
              Install app
            </CommandItem>
          ) : null}
          <CommandItem
            value="Sync all catalogs"
            onSelect={(): void => {
              runAndClose(onSyncAll);
            }}
            data-testid="palette-action-sync-all"
          >
            <RefreshCw aria-hidden="true" />
            Sync all catalogs
          </CommandItem>
          <CommandItem
            value="Check favorites for new chapters"
            onSelect={(): void => {
              runAndClose(onCheckFavorites);
            }}
            data-testid="palette-action-check-favorites"
          >
            <Heart aria-hidden="true" />
            Check favorites for new chapters
          </CommandItem>
          <CommandItem
            value="Toggle theme"
            onSelect={(): void => {
              runAndClose((): void => {
                toggleTheme();
              });
            }}
            data-testid="palette-action-toggle-theme"
          >
            <Settings aria-hidden="true" />
            Toggle theme
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
