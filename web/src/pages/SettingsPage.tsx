/**
 * Settings (§9/§10): module registry with capability + known-broken
 * badges (§5.10, D3), per-module options editor (combobox INDEX
 * semantics) + cookies editor, sync buttons (modules / all catalogs),
 * and the D20 first-run bootstrap empty state with surfaced progress.
 *
 * v0.3.1 Websites rebuild (tsk-skilled-tabby-blooms): the module list
 * is a FACETED registry view — LANGUAGE (FMD2 categories with the
 * -Scanlation suffix collapsed), H-STATUS and NEEDS SETUP chips with
 * live counts + text search, all URL-synced (?q=&lang=&h=&setup=,
 * chips push / typing replaces — back-navigation restores the
 * selection). The registry is sorted by (category, name) client-side
 * so each category renders ONE header with its true count (the
 * v0.3.0 adjacent-equals grouping over registration-ordered rows
 * split languages into "English (1)" shards — the "only 1 english
 * site" misread). Global Enable/Disable-all bulk controls scope to
 * the CURRENT filtered selection (ids[] write) with a confirm on the
 * destructive direction; the global proxy editor lives in an
 * inline-expandable box (ProxySettings).
 *
 * Design-system retrofit: PageHeader + toolbar Buttons (with sonner
 * progress toasts — additive, distinct from the pinned inline status
 * texts) + the virtualized module list. The registry is 454 sites in
 * production — ListPanel virtualizes it above the threshold while
 * fixture-sized lists stay plain DOM.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { RefreshCw, RotateCw, X } from 'lucide-react';
import {
  useModules,
  useProvisionCatalog,
  useSyncAllCatalogs,
  useSyncModules,
  useUpdateModule,
  type ModuleSummaryT,
  type ProxySettingsT,
} from '../api/hooks';
import { AccountsSection } from '../components/AccountsSection';
import { ApiTokenSection } from '../components/ApiTokenSection';
import { CapabilityBadges } from '../components/CapabilityBadges';
import { GlobalBulkControls, CategoryBulkControls } from '../components/ModuleListControls';
import { ModuleFacets } from '../components/settings/ModuleFacets';
import { OutputDefaultsForm } from '../components/OutputDefaultsForm';
import { FavoritesSettingsForm } from '../components/FavoritesSettingsForm';
import { ImportFromFmd2Card } from '../components/settings/ImportFromFmd2Card';
import { ProxySettingsSection } from '../components/ProxySettings';
import {
  AboutSection,
  DiagnosticsSection,
  FilenamePolicySection,
  PerformanceSection,
  RetentionSection,
} from '../components/settings/ParitySweepSections';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';
import { ListPanel } from '@/components/patterns/ListPanel';
import { PageHeader } from '@/components/patterns/PageHeader';
import { progressToast, type ProgressToastHandle } from '@/components/patterns/ProgressToast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/patterns/NativeSelect';
import { OptionsEditor } from '../components/OptionsEditor';
import { navigate, replaceRoute } from '../router';
import { useRoute } from '../state/use-route';
import {
  facetCounts,
  filterModules,
  languageOf,
  parseModuleFilter,
  serializeModuleFilter,
  type ModuleFilterState,
} from '../state/module-facets';

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i): boolean => v === b[i]);
}

/**
 * Section wayfinding (UX audit T-1/T-2): the page is one long scroll
 * by design (every section stays in flow — printable, findable,
 * screen-reader heading-jump friendly); this registry drives the
 * STICKY section nav that makes each section one click away from
 * anywhere. The Websites registry is FIRST (T-2): it is the page's
 * main job — 454 sites — while the rarely-touched global forms follow.
 * `?section=` is the URL-as-truth anchor (deep-linkable, back/forward
 * restores the jump); section ids are stable API for e2e/docs.
 */
const SETTINGS_SECTIONS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'websites', label: 'Websites' },
  { id: 'proxy', label: 'Proxy' },
  { id: 'api-token', label: 'API token' },
  { id: 'performance', label: 'Performance' },
  { id: 'retention', label: 'Retention' },
  { id: 'filename-policy', label: 'Filename policy' },
  { id: 'output', label: 'Output' },
  { id: 'favorites', label: 'Favorites' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'about', label: 'About' },
];

const SETTINGS_SECTION_IDS: readonly string[] = SETTINGS_SECTIONS.map((s): string => s.id);

/** Anchor wrapper id for a section (`settings-section-<id>`). */
export function settingsSectionAnchor(id: string): string {
  return `settings-section-${id}`;
}

const EMPTY_PROXY: ProxySettingsT = { type: '', host: '', port: '', user: '', pass: '' };

function ModuleProxyEditor(props: { module: ModuleSummaryT }): ReactElement {
  const update = useUpdateModule();
  const [override, setOverride] = useState(props.module.proxy !== null);
  const [draft, setDraft] = useState<ProxySettingsT>(props.module.proxy ?? EMPTY_PROXY);

  const save = (): void => {
    // unchecked = inherit the global config (explicit null clears the override)
    update.mutate({ id: props.module.id, proxy: override ? draft : null });
  };

  return (
    <form
      className="proxy-override-form mt-3 grid max-w-md grid-cols-[max-content_1fr] content-center gap-x-4 gap-y-2"
      aria-label={`Proxy override for ${props.module.name}`}
      onSubmit={(event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        save();
      }}
    >
      <label htmlFor={`proxy-override-${props.module.id}`} className="col-span-2 flex items-center gap-2 text-sm font-medium">
        <input
          id={`proxy-override-${props.module.id}`}
          type="checkbox"
          className="size-4 accent-(--primary)"
          checked={override}
          onChange={(e): void => {
            setOverride(e.target.checked);
          }}
        />{' '}
        Module proxy override {override ? '' : '(inherits the global proxy)'}
      </label>
      {override ? (
        <>
          <label htmlFor={`proxy-type-${props.module.id}`} className="text-sm font-medium leading-9">Type</label>
          <NativeSelect
            id={`proxy-type-${props.module.id}`}
            value={draft.type}
            onChange={(e): void => {
              const type = e.target.value as ProxySettingsT['type'];
              setDraft(type === '' ? EMPTY_PROXY : { ...draft, type });
            }}
          >
            <option value="">none</option>
            <option value="HTTP">HTTP</option>
            <option value="SOCKS4">SOCKS4</option>
            <option value="SOCKS5">SOCKS5</option>
          </NativeSelect>
          <label htmlFor={`proxy-host-${props.module.id}`} className="text-sm font-medium leading-9">Host</label>
          <Input
            id={`proxy-host-${props.module.id}`}
            value={draft.host}
            onChange={(e): void => {
              setDraft({ ...draft, host: e.target.value });
            }}
          />
          <label htmlFor={`proxy-port-${props.module.id}`} className="text-sm font-medium leading-9">Port</label>
          <Input
            id={`proxy-port-${props.module.id}`}
            value={draft.port}
            onChange={(e): void => {
              setDraft({ ...draft, port: e.target.value });
            }}
          />
        </>
      ) : null}
      <div className="col-start-2 mt-2">
        <Button type="submit" size="sm" disabled={update.isPending}>
          Save module proxy
        </Button>
      </div>
    </form>
  );
}

function ModuleEditor(props: { module: ModuleSummaryT; onDone: () => void }): ReactElement {
  const update = useUpdateModule();
  const [cookies, setCookies] = useState('');
  return (
    <div className="module-editor mt-3 rounded-lg border bg-surface/40 p-4" aria-label={`Editor for ${props.module.name}`}>
      <OptionsEditor
        module={props.module}
        saving={update.isPending}
        onSave={(values): void => {
          update.mutate({ id: props.module.id, options: values });
        }}
      />
      <form
        className="cookies-form mt-3 flex flex-col items-start gap-2"
        aria-label={`Cookies for ${props.module.name}`}
        onSubmit={(event: FormEvent<HTMLFormElement>): void => {
          event.preventDefault();
          update.mutate({ id: props.module.id, cookies });
        }}
      >
        <label htmlFor={`cookies-${props.module.id}`} className="text-sm font-medium">
          Cookies <span className="option-hint text-xs font-normal text-muted-foreground">(Cookie header string; User-Agent options live above)</span>
        </label>
        <textarea
          id={`cookies-${props.module.id}`}
          rows={2}
          className="w-full max-w-md rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs max-md:text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
          value={cookies}
          onChange={(e): void => {
            setCookies(e.target.value);
          }}
        />
        <Button type="submit" size="sm" variant="secondary" disabled={update.isPending || cookies === ''}>
          Save cookies
        </Button>
      </form>
      <ModuleProxyEditor module={props.module} />
      {update.isError ? <ErrorBanner error={update.error} /> : null}
      {update.isSuccess ? (
        <p role="status" aria-live="polite" className="mt-3 text-sm text-muted-foreground">
          {/* [UX-AUDIT T-5] the module NAME, never the raw hex id. */}
          Saved. Module <span className="font-medium">{props.module.name}</span> updated
          {update.data.enabled ? '' : ' (disabled)'}.
        </p>
      ) : null}
      <Button type="button" variant="outline" size="sm" className="mt-3" onClick={(): void => { props.onDone(); }}>
        <X aria-hidden="true" />
        Close
      </Button>
    </div>
  );
}

/**
 * Per-site 'Re-sync catalog' (FMD2 update-list parity): the existing
 * POST /api/sync/catalog/:id behind a progress toast; only offered for
 * sites with an INSTALLED catalog (installing a missing one is the
 * Browse picker's auto-provision flow).
 */
function ResyncCatalogButton(props: { module: ModuleSummaryT }): ReactElement | null {
  const provision = useProvisionCatalog();
  const toast = useRef<ProgressToastHandle | null>(null);
  if (!props.module.catalogInstalled) {
    return null;
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7"
      disabled={provision.isPending}
      aria-label={`Re-sync catalog for ${props.module.name}`}
      data-testid={`resync-catalog-${props.module.id}`}
      onClick={(): void => {
        toast.current = progressToast.start(`Re-syncing ${props.module.name} catalog…`);
        provision.mutate({ moduleId: props.module.id }, {
          onSuccess: (data): void => {
            if (toast.current !== null) {
              const state: string = data.result.state;
              progressToast.done(
                toast.current,
                `${props.module.name} catalog ${state === 'failed' ? 'sync FAILED' : `sync ${state}`}`,
              );
            }
          },
          onError: (): void => {
            if (toast.current !== null) {
              progressToast.fail(toast.current, `${props.module.name} catalog sync failed`);
            }
          },
        });
      }}
    >
      <RotateCw aria-hidden="true" />
      {provision.isPending ? 'Syncing…' : 'Re-sync catalog'}
    </Button>
  );
}

function ModuleRow(props: {
  readonly module: ModuleSummaryT;
  /** Accounts-section cookies link-out: open + scroll to the editor. */
  readonly forceOpen: boolean;
  readonly onForceOpenHandled: () => void;
}): ReactElement {
  const update = useUpdateModule();
  const [open, setOpen] = useState(false);

  // The accounts card's "Cookies…" link-out opens the editor and
  // scrolls the row into view (the editor keeps its own state).
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect((): void => {
    if (props.forceOpen) {
      setOpen(true);
      rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      props.onForceOpenHandled();
    }
  }, [props]);
  const editorOpen: boolean = open || props.forceOpen;

  return (
    <div className="module-row w-full" id={`module-row-${props.module.id}`} ref={rowRef}>
      <div className="module-head flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
        <label htmlFor={`enabled-${props.module.id}`} className="flex items-center gap-2 text-sm font-medium max-md:min-h-touch-target">
          <input
            id={`enabled-${props.module.id}`}
            type="checkbox"
            className="size-4 accent-(--primary)"
            checked={props.module.enabled}
            onChange={(e): void => {
              update.mutate({ id: props.module.id, enabled: e.target.checked });
            }}
          />{' '}
          {props.module.name}
        </label>
        <span className="module-meta text-xs text-muted-foreground">
          {props.module.category} · {props.module.rootURL}
        </span>
        <CapabilityBadges module={props.module} />
        <ResyncCatalogButton module={props.module} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto h-7"
          aria-expanded={editorOpen}
          onClick={(): void => {
            setOpen((prev) => !prev);
          }}
        >
          {editorOpen ? 'Hide options' : 'Configure'}
        </Button>
      </div>
      {update.isError ? <ErrorBanner error={update.error} /> : null}
      {editorOpen ? <ModuleEditor module={props.module} onDone={(): void => setOpen(false)} /> : null}
    </div>
  );
}

export function SettingsPage(): ReactElement {
  const modules = useModules();
  const syncModules = useSyncModules();
  const syncCatalogs = useSyncAllCatalogs();

  const moduleToast = useRef<ProgressToastHandle | null>(null);
  const catalogToast = useRef<ProgressToastHandle | null>(null);

  const [openEditorFor, setOpenEditorFor] = useState<string | null>(null);

  // The live hash is the facet/filter truth (App owns routing; this
  // subscription keeps ?q/?lang/?h/?setup pure under typing + back/
  // forward — the same URL-sync channel the site picker uses).
  const route = useRoute({ name: 'settings', query: {} });

  // ── section wayfinding (T-1): ?section= is the anchor truth ──────
  // A nav chip click PUSHES the section into the URL (back/forward
  // restore the jump) and scrolls; the effect covers the OTHER
  // hashchange sources (deep links, back/forward into a sectioned
  // URL). Manual scrolling never rewrites the URL — wayfinding is
  // click-driven only, no history noise.
  const activeSection: string = SETTINGS_SECTION_IDS.includes(route.query.section ?? '')
    ? (route.query.section ?? '')
    : '';
  useEffect((): void => {
    if (activeSection === '') {
      return;
    }
    document
      .getElementById(settingsSectionAnchor(activeSection))
      ?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    // `modules.isPending` is a REQUIRED dep: on a cold deep link the
    // first run lands while the module-list loading stub is mounted
    // (the section anchors do not exist yet — the scroll no-ops), and
    // re-firing on the pending→ready flip is what performs the scroll
    // once the real sections render. Without it the deep link lands
    // at scroll-0 (review-blocker reproduction).
  }, [activeSection, modules.isPending]);

  const list = modules.data?.modules ?? [];
  const bootstrapRunning = syncModules.isPending || syncCatalogs.isPending;

  const runSyncModules = (): void => {
    moduleToast.current = progressToast.start('Module sync running…');
    syncModules.mutate(undefined, {
      onSuccess: (data): void => {
        if (moduleToast.current !== null) {
          progressToast.done(moduleToast.current, `Module sync complete: ${data.summary.totalModules} modules`);
        }
      },
      onError: (): void => {
        if (moduleToast.current !== null) {
          progressToast.fail(moduleToast.current, 'Module sync failed');
        }
      },
    });
  };

  const runSyncCatalogs = (): void => {
    catalogToast.current = progressToast.start('Catalog sync running…');
    syncCatalogs.mutate(undefined, {
      onSuccess: (data): void => {
        if (catalogToast.current !== null) {
          progressToast.done(catalogToast.current, `Catalog sync complete: ${data.results.length} catalog(s)`);
        }
      },
      onError: (): void => {
        if (catalogToast.current !== null) {
          progressToast.fail(catalogToast.current, 'Catalog sync failed');
        }
      },
    });
  };

  if (modules.isPending) {
    return (
      <section aria-label="Settings">
        <PageHeader title="Settings" description="Module registry, accounts, output defaults and sync." />
        <p role="status" className="text-sm text-muted-foreground">Loading modules…</p>
      </section>
    );
  }
  if (modules.isError) {
    return (
      <section aria-label="Settings">
        <PageHeader title="Settings" description="Module registry, accounts, output defaults and sync." />
        <ErrorBanner error={modules.error} />
      </section>
    );
  }

  if (list.length === 0) {
    return (
      <section aria-label="Settings">
        <PageHeader title="Settings" description="Module registry, accounts, output defaults and sync." />
        <EmptyState
          title="No modules registered yet"
          action={
            <Button
              type="button"
              onClick={(): void => {
                runSyncModules();
              }}
              disabled={syncModules.isPending}
            >
              <RefreshCw aria-hidden="true" />
              {syncModules.isPending ? 'Syncing modules…' : 'Run module sync now'}
            </Button>
          }
        >
          <p>
            First-run bootstrap: with an empty data dir the server auto-triggers module and
            catalog sync, and progress shows here. If the registry is still empty, trigger it
            manually:
          </p>
          {syncModules.isPending ? <p role="status">Module sync running…</p> : null}
          {syncModules.isSuccess ? (
            <>
              <p role="status" aria-live="polite">
                Module sync finished: {syncModules.data.summary.registeredFiles}/
                {syncModules.data.summary.totalFiles} files registered,{' '}
                {syncModules.data.summary.totalModules} modules.
              </p>
              {syncModules.data.summary.failures.length > 0 ? (
                <p role="status">
                  {String(syncModules.data.summary.failures.length)} upstream-broken file(s) tolerated;
                  see the full list under Settings after the registry loads.
                </p>
              ) : null}
            </>
          ) : null}
          {syncModules.isError ? <ErrorBanner error={syncModules.error} /> : null}
        </EmptyState>
      </section>
    );
  }

  // ── faceted module list (Settings→Websites rebuild) ────────────────
  // Facet state lives in the URL (?q=&lang=&h=&setup=): chip clicks
  // PUSH (back/forward restore the selection), typing REPLACES (no
  // history spam) — the site picker's ?cats= channel, one facet
  // language app-wide. Unknown lang values drop against the registry
  // (a shared URL never filters to a mismatched registry).
  const validLangs: readonly string[] = [
    ...new Set(list.map((m): string => m.category.trim()).map(languageOf)),
  ];
  const filter = parseModuleFilter(route.query, validLangs);
  const writeFilter = (next: ModuleFilterState, mode: 'push' | 'replace' = 'push'): void => {
    const query = serializeModuleFilter(next);
    if (mode === 'push') {
      navigate('settings', query);
    } else {
      replaceRoute('settings', query);
    }
  };
  const onFacetsChange = (next: ModuleFilterState): void => {
    // Typing carries q only → REPLACE (shareable URL, no history
    // spam); chip toggles are discrete facet changes → PUSH
    // (back/forward restore the selection).
    if (next.q !== filter.q && arraysEqual(next.lang, filter.lang) && arraysEqual(next.h, filter.h) && arraysEqual(next.setup, filter.setup)) {
      writeFilter(next, 'replace');
      return;
    }
    writeFilter(next, 'push');
  };

  const counts = facetCounts(list, filter);
  const filtered = filterModules(list, filter);
  const filterActive: boolean =
    filter.q !== '' || filter.lang.length > 0 || filter.h.length > 0 || filter.setup.length > 0;

  // ONE ListPanel stays virtualized for production-sized registries
  // (perf contract: 1000 modules); the category headers ride along as
  // interleaved list rows carrying the bulk controls (FMD2 tree
  // nodes). GROUPING FIX: the registry arrives in REGISTRATION order
  // (directory walk — categories interleave), so the list is sorted
  // by (category, name) client-side FIRST: one header per category
  // with its TRUE count (the v0.3.0 adjacent-equals bug split e.g.
  // English into dozens of "English (1)" headers — the "only 1
  // english site" misread). Raw registry rows with an EMPTY category
  // group as 'Unknown' (27 production sites ship categoryless).
  const categoryLabel = (category: string): string => (category.trim() === '' ? 'Unknown' : category);
  const sorted = [...filtered].sort((a, b): number => {
    const byCategory: number = categoryLabel(a.category).localeCompare(categoryLabel(b.category));
    return byCategory !== 0 ? byCategory : a.name.localeCompare(b.name);
  });
  type ModuleListRow =
    | { readonly kind: 'header'; readonly category: string; readonly label: string; count: number }
    | { readonly kind: 'module'; readonly module: ModuleSummaryT };
  const rows: ModuleListRow[] = [];
  let currentHeader:
    | { readonly kind: 'header'; readonly category: string; readonly label: string; count: number }
    | undefined;
  for (const module of sorted) {
    const label = categoryLabel(module.category);
    if (currentHeader === undefined || currentHeader.label !== label) {
      currentHeader = { kind: 'header', category: module.category, label, count: 0 };
      rows.push(currentHeader);
    }
    currentHeader.count += 1;
    rows.push({ kind: 'module', module });
  }

  return (
    <section aria-label="Settings">
      <PageHeader
        title="Settings"
        description="Module registry, accounts, output defaults and sync."
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={(): void => {
                runSyncModules();
              }}
              disabled={bootstrapRunning}
            >
              <RefreshCw aria-hidden="true" />
              {syncModules.isPending ? 'Syncing modules…' : 'Sync modules'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={(): void => {
                runSyncCatalogs();
              }}
              disabled={bootstrapRunning}
            >
              <RefreshCw aria-hidden="true" />
              {syncCatalogs.isPending ? 'Syncing catalogs…' : 'Sync all catalogs'}
            </Button>
          </>
        }
      />

      {syncModules.isError ? <ErrorBanner error={syncModules.error} /> : null}
      {syncCatalogs.isError ? <ErrorBanner error={syncCatalogs.error} /> : null}
      {syncModules.isSuccess ? (
        <>
          {/* [UX-AUDIT T-6] the sync-summary wall collapsed to a one-line
           * status + a <details> for the technical detail (tree SHA,
           * file counts); FAILURES stay expanded and visible. */}
          <p role="status" aria-live="polite" className="mb-1 text-sm text-muted-foreground">
            Module sync complete: {syncModules.data.summary.totalModules} modules.
          </p>
          <details className="sync-summary mb-2 text-sm text-muted-foreground" data-testid="module-sync-details">
            <summary className="cursor-pointer">Sync details</summary>
            <p className="mt-1">
              {syncModules.data.summary.registeredFiles}/{syncModules.data.summary.totalFiles}{' '}
              files registered, {syncModules.data.summary.failedFiles} failed (tree{' '}
              {syncModules.data.summary.treeSha.slice(0, 10)}).
            </p>
          </details>
          {syncModules.data.summary.failures.length > 0 ? (
            <div className="sync-failures">
              <p>
                {String(syncModules.data.summary.failures.length)} upstream-broken file(s) tolerated (excluded
                from the registry):
              </p>
              <ul aria-label="Tolerated broken module files">
                {syncModules.data.summary.failures.map((failure): ReactElement => (
                  <li key={failure.file}>
                    <code>{failure.file}</code>: {failure.error}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
      {syncCatalogs.isSuccess ? (
        <>
          <p role="status" aria-live="polite" className="mb-1 text-sm text-muted-foreground">
            Catalog sync complete: {syncCatalogs.data.results.length} catalog(s).
          </p>
          <details className="sync-summary mb-3 text-sm text-muted-foreground" data-testid="catalog-sync-details">
            <summary className="cursor-pointer">Catalog sync details</summary>
            <p className="mt-1">
              {syncCatalogs.data.results.map((r): string => `${r.id.slice(0, 8)}: ${r.state}`).join(', ')}.
            </p>
          </details>
        </>
      ) : null}

      {/* Section wayfinding (UX audit T-1): sticky under the app header,
       * horizontally scrollable on mobile (R3 touch targets via the
       * site-chip base class), ?section= as the anchor truth. Chip
       * styling is the app-wide facet-chip pattern (ModuleFacets/
       * SiteFilterChips) — one design language. */}
      <nav
        aria-label="Settings sections"
        data-testid="settings-section-nav"
        className="sticky top-14 z-30 -mx-4 mb-4 border-b bg-background/95 px-4 py-2 backdrop-blur-sm"
      >
        <ul className="m-0 flex list-none items-center gap-1.5 overflow-x-auto p-0">
          {SETTINGS_SECTIONS.map(
            (section): ReactElement => (
              <li key={section.id}>
                <button
                  type="button"
                  data-testid={`settings-section-link-${section.id}`}
                  className={
                    activeSection === section.id
                      ? 'site-chip max-md:min-h-touch-target whitespace-nowrap rounded-full border border-transparent bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors'
                      : 'site-chip max-md:min-h-touch-target whitespace-nowrap rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground'
                  }
                  aria-current={activeSection === section.id ? 'true' : undefined}
                  onClick={(): void => {
                    // PUSH (back/forward restore the jump); the facet
                    // params ride along so the registry filters survive
                    // a wayfinding hop and back.
                    navigate('settings', {
                      ...serializeModuleFilter(filter),
                      section: section.id,
                    });
                    document
                      .getElementById(settingsSectionAnchor(section.id))
                      ?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  {section.label}
                </button>
              </li>
            ),
          )}
        </ul>
      </nav>

      {/* Websites registry FIRST (UX audit T-2): the page's main job —
       * every site with facets + bulk controls — above the global
       * forms, so the default view is the content users come for. */}
      <div id={settingsSectionAnchor('websites')} className="scroll-mt-28">
        <h2 className="mb-2 mt-6 text-lg font-semibold">Websites ({list.length})</h2>
        <ModuleFacets
          filter={filter}
          counts={counts}
          onChange={onFacetsChange}
          resultCount={filtered.length}
          totalCount={list.length}
        />
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {filterActive
              ? `Bulk controls operate on the ${String(filtered.length)} filtered sites`
              : 'Bulk controls operate on every site'}
          </span>
          <GlobalBulkControls
            busy={bootstrapRunning}
            targetIds={filtered.map((m): string => m.id)}
            filtered={filterActive}
            scopeLabel={filterActive ? `${String(filtered.length)} filtered sites` : 'all sites'}
          />
        </div>
        {filtered.length === 0 ? (
          <EmptyState title="No modules match the filters">
            <p>No module name, id or category matches the current search and facet selection.</p>
          </EmptyState>
        ) : (
          <ListPanel
            className="module-list"
            ariaLabel="Site modules"
            items={rows}
            itemKey={(row): string => (row.kind === 'header' ? `category:${row.label}` : row.module.id)}
            rowClassName="module-row"
            renderItem={(row): ReactElement =>
              row.kind === 'header' ? (
                <CategoryBulkControls
                  category={row.category}
                  label={row.label}
                  count={row.count}
                  busy={bootstrapRunning}
                />
              ) : (
                <ModuleRow
                  module={row.module}
                  forceOpen={openEditorFor === row.module.id}
                  onForceOpenHandled={(): void => setOpenEditorFor(null)}
                />
              )
            }
          />
        )}
      </div>

      <div id={settingsSectionAnchor('proxy')} className="scroll-mt-28">
        <ProxySettingsSection />
      </div>

      {/* R4 single app-wide API token (Settings → API) */}
      <div id={settingsSectionAnchor('api-token')} className="scroll-mt-28">
        <ApiTokenSection />
      </div>

      {/* [parity-sweep] audit M2/M4/M10/M12/M13 groups */}
      <div id={settingsSectionAnchor('performance')} className="scroll-mt-28">
        <PerformanceSection />
      </div>
      <div id={settingsSectionAnchor('retention')} className="scroll-mt-28">
        <RetentionSection />
      </div>
      <div id={settingsSectionAnchor('filename-policy')} className="scroll-mt-28">
        <FilenamePolicySection />
      </div>

      <div id={settingsSectionAnchor('output')} className="scroll-mt-28">
        <OutputDefaultsForm />
      </div>

      <div id={settingsSectionAnchor('favorites')} className="scroll-mt-28">
        <FavoritesSettingsForm />
      </div>

      <div id={settingsSectionAnchor('import')} className="scroll-mt-28">
        <ImportFromFmd2Card />
      </div>

      <div id={settingsSectionAnchor('accounts')} className="scroll-mt-28">
        <AccountsSection
          modules={list}
          onOpenCookies={(moduleId): void => {
            // Clear the whole filter so the target row is guaranteed
            // visible before the forced scroll (replace: a programmatic
            // jump, not a user filter action).
            replaceRoute('settings', {});
            setOpenEditorFor(moduleId);
          }}
        />
      </div>

      {/* Reference + troubleshooting close the page. */}
      <div id={settingsSectionAnchor('diagnostics')} className="scroll-mt-28">
        <DiagnosticsSection />
      </div>
      <div id={settingsSectionAnchor('about')} className="scroll-mt-28">
        <AboutSection />
      </div>
    </section>
  );
}
