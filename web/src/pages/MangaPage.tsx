/**
 * Manga detail (§5.8): live info display + chapter list + enqueue
 * dry-run. The dry-run builds the exact `POST /api/jobs/download`
 * body per selected chapter (deterministic idempotency key, §10)
 * and previews it without sending; enqueue POSTs the same bodies.
 *
 * FMD2 info-pane parity (frmMain.lfm pcInfo/tsInfoManga): cover
 * thumbnail with loading anim (imCover :962), btReadOnline (:3060),
 * btAddToFavorites (:2797, round-trips through the favorites list),
 * the full pmChapterList toolbar (lfm:1649-1703 — filter/hide/sort/
 * invert/select-new/tinting) and the enqueue extras row
 * (cbAddAsStopped :1110 + edSaveTo, pas:5613).
 */
import { useEffect, useMemo, useState, type ChangeEvent, type ReactElement } from 'react';
import { ArrowLeft, ExternalLink, Heart, HeartOff, ListPlus } from 'lucide-react';
import { useCreateDownloadJob, useDownloadedSet, useFavoriteState, useLiveInfo, useTitleFiles } from '../api/hooks';
import { dryRunJson } from '../api/dry-run';
import {
  DEFAULT_CHAPTER_VIEW_OPTIONS,
  invertSelection,
  isDownloadedChapter,
  selectNewIndices,
  visibleChapterIndices,
  type ChapterViewOptions,
} from '../state/chapter-view-state';
import { coverSrc } from '../api/cover';
import { FilesSection } from '@/components/library/FilesSection';
import { CoverImage } from '@/components/manga/CoverImage';
import { ChapterToolbar } from '@/components/manga/ChapterToolbar';
import { EnqueueOptions, loadSaveTo, type EnqueueExtras } from '@/components/manga/EnqueueOptions';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';
import { ListPanel } from '@/components/patterns/ListPanel';
import { PageHeader } from '@/components/patterns/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from 'cn';
import { hasInAppHistory, navigate, type Route } from '../router';
import { pushRecentManga } from '../state/recents';

export function MangaPage(props: { route: Route }): ReactElement {
  const moduleId = props.route.query['module'] ?? '';
  const url = props.route.query['url'] ?? '';
  const title = props.route.query['title'] ?? '';
  const catalogId = props.route.query['catalog'] ?? '';

  const info = useLiveInfo(moduleId === '' ? undefined : moduleId, url === '' ? undefined : url);
  const downloaded = useDownloadedSet(info);
  // [file-state] verified truth per chapter link (lazy stat-verification
  // server-side; missing = ledger entry whose file is gone).
  const titleFiles = useTitleFiles(
    moduleId === '' ? undefined : moduleId,
    url === '' ? undefined : url,
    title !== '' ? { manga: title } : {},
  );
  const fileStates = useMemo((): Map<string, 'downloaded' | 'missing'> => {
    const map = new Map<string, 'downloaded' | 'missing'>();
    for (const entry of titleFiles.data?.files ?? []) {
      if (entry.chapterLink !== undefined) {
        map.set(entry.chapterLink, entry.state);
      }
    }
    return map;
  }, [titleFiles.data]);
  const favorite = useFavoriteState(moduleId, url);
  const [selected, setSelected] = useState<readonly number[]>([]);
  const [view, setView] = useState<ChapterViewOptions>(DEFAULT_CHAPTER_VIEW_OPTIONS);
  const [extras, setExtras] = useState<EnqueueExtras>({ paused: false, saveTo: '' });
  const createJob = useCreateDownloadJob();

  // Recents plumbing (search home + command palette): every opened
  // manga feeds the shared recent-manga store — the deep-link params
  // EXACTLY as this page received them, so a palette re-open replays
  // the same route. Re-opens move to the front (deduped, capped).
  useEffect((): void => {
    if (moduleId !== '' && url !== '' && title !== '') {
      pushRecentManga({
        moduleId,
        url,
        title,
        ...(catalogId !== '' ? { catalogId } : {}),
      });
    }
  }, [moduleId, url, title, catalogId]);

  // Per-manga save-to recall (FMD2 persists the override per favorite).
  useEffect((): void => {
    const stored = loadSaveTo(moduleId, url);
    if (stored !== '') {
      setExtras((prev) => ({ ...prev, saveTo: stored }));
    }
  }, [moduleId, url]);

  if (moduleId === '' || url === '') {
    return (
      <section aria-label="Manga detail">
        <PageHeader title="Manga" description="Live info, chapters and the enqueue dry-run." />
        <EmptyState title="No manga selected">
          <p>Pick a title on the Browse page; this view needs a site module id and a manga URL.</p>
        </EmptyState>
      </section>
    );
  }

  const chapters = info.data?.chapterNames ?? [];
  const chapterLinks = info.data?.chapterLinks ?? [];
  const count = Math.min(chapters.length, chapterLinks.length);
  // [file-state] the Files section + verified chapter badges: live
  // chapter labels keyed by link (the lazy-verified server truth rides
  // the same query the section consumes).
  const chapterLabels = new Map<string, string>();
  for (let i = 0; i < count; i += 1) {
    const link = chapterLinks[i];
    const name = chapters[i];
    if (link !== undefined && name !== undefined) {
      chapterLabels.set(link, name);
    }
  }
  const visible = visibleChapterIndices({ chapterNames: chapters, chapterLinks, downloaded, options: view });
  const enqueueExtras = {
    ...(extras.paused ? { paused: true as const } : {}),
    ...(extras.saveTo !== '' ? { saveTo: extras.saveTo } : {}),
  };
  const dryRuns = [...selected]
    .sort((a, b): number => a - b)
    .filter((i): boolean => i >= 0 && i < count)
    .map((i): string =>
      dryRunJson({
        moduleId,
        mangaUrl: url,
        ...(title !== '' ? { mangaTitle: title } : {}),
        chapterLink: chapterLinks[i] ?? '',
        ...(chapters[i] !== undefined ? { chapterName: chapters[i] } : {}),
        ...enqueueExtras,
      }),
    );

  const onCheck = (index: number, checked: boolean): void => {
    setSelected((prev) => (checked ? [...prev, index] : prev.filter((i): boolean => i !== index)));
  };

  const enqueue = async (): Promise<void> => {
    for (const i of [...selected].sort((a, b): number => a - b)) {
      const link = chapterLinks[i];
      if (link === undefined) continue;
      await createJob.mutateAsync({
        moduleId,
        mangaUrl: url,
        ...(title !== '' ? { mangaTitle: title } : {}),
        chapterLink: link,
        ...(chapters[i] !== undefined ? { chapterName: chapters[i] } : {}),
        ...enqueueExtras,
      });
    }
  };

  const toggleFavorite = (): void => {
    void (favorite.isFavorited
      ? favorite.remove()
      : favorite.add({ title: info.data?.title ?? title }));
  };

  return (
    <section aria-label="Manga detail">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 mb-2"
        onClick={(): void => {
          // Back-context chain (UX audit M-1): the recorded origin wins
          // (entry rows stamp `from=` with the full origin hash — site
          // list, facets and all), then in-app history (covers origin
          // paths that navigate without the helper, e.g. the favorites
          // row), then the legacy deep-link fallback (catalog site
          // list / search home).
          const from = props.route.query['from'] ?? '';
          if (from.startsWith('#/')) {
            globalThis.location.hash = from;
            return;
          }
          if (hasInAppHistory() && globalThis.history.length > 1) {
            globalThis.history.back();
            return;
          }
          navigate('browse', catalogId === '' ? {} : { catalog: catalogId });
        }}
      >
        <ArrowLeft aria-hidden="true" />
        ← Back to browse
      </Button>

      {info.isPending ? (
        // [UX-AUDIT M-6] skeleton card mirroring the loaded layout
        // (cover block + metadata lines) so the page's primary content
        // has a structure preview instead of a bare text line.
        <p role="status" aria-live="polite" className="sr-only">
          Fetching live info…
        </p>
      ) : null}
      {info.isPending ? (
        <Card className="mb-6" data-testid="manga-skeleton">
          <CardContent className="flex max-md:flex-col flex-row gap-6 pt-6">
            <Skeleton className="h-40 w-32 shrink-0 rounded-md" aria-hidden="true" />
            <div className="min-w-0 flex-1 space-y-2" aria-hidden="true">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          </CardContent>
        </Card>
      ) : null}
      {info.isError ? <ErrorBanner error={info.error} /> : null}

      {info.data !== undefined ? (
        <article className="manga-info">
          <PageHeader title={info.data.title} description={info.data.summary || undefined} />

          <Card className="mb-6">
            {/* [UX-AUDIT M-4] on phones the cover stacks ABOVE the
             * metadata (max-md:flex-col) — a 128px cover + 24px gap
             * left only ~200px for the whole definition list. */}
            <CardContent className="flex max-md:flex-col flex-row gap-6 pt-6">
              <CoverImage src={coverSrc(info.data.moduleId, info.data.coverLink) ?? ''} alt={`${info.data.title} cover`} />
              <div className="min-w-0 flex-1">
                {/* Null placeholders (UX audit M-2): sparse fields render
                 * words, never bare punctuation. The four data fields
                 * show a muted "Unknown"; the two long-form fields
                 * (alternative titles, summary) are OMITTED when empty
                 * — an "Unknown summary" row is pure noise. Pinned by
                 * web/test/manga-parity.test.tsx. */}
                <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm">
                  {info.data.altTitles !== '' ? (
                    <>
                      <dt className="font-medium text-muted-foreground">Alternative titles</dt>
                      <dd>{info.data.altTitles}</dd>
                    </>
                  ) : null}
                  <dt className="font-medium text-muted-foreground">Authors</dt>
                  <dd>{info.data.authors !== '' ? info.data.authors : <span className="text-muted-foreground">Unknown</span>}</dd>
                  <dt className="font-medium text-muted-foreground">Artists</dt>
                  <dd>{info.data.artists !== '' ? info.data.artists : <span className="text-muted-foreground">Unknown</span>}</dd>
                  <dt className="font-medium text-muted-foreground">Genres</dt>
                  <dd>{info.data.genres !== '' ? info.data.genres : <span className="text-muted-foreground">Unknown</span>}</dd>
                  <dt className="font-medium text-muted-foreground">Status</dt>
                  <dd>{info.data.status !== '' ? info.data.status : <span className="text-muted-foreground">Unknown</span>}</dd>
                  <dt className="font-medium text-muted-foreground">Chapters</dt>
                  <dd>{info.data.numChapter}</dd>
                  {info.data.summary !== '' ? (
                    <>
                      <dt className="font-medium text-muted-foreground">Summary</dt>
                      <dd className="max-w-prose text-muted-foreground">{info.data.summary}</dd>
                    </>
                  ) : null}
                </dl>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {info.data.url !== '' ? (
                    <a
                      href={info.data.url}
                      target="_blank"
                      rel="noopener"
                      className="inline-flex h-8 max-md:min-h-touch-target items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-surface-hover"
                    >
                      <ExternalLink aria-hidden="true" className="size-4" />
                      Read online
                    </a>
                  ) : null}
                  <Button
                    type="button"
                    variant={favorite.isFavorited ? 'secondary' : 'default'}
                    size="sm"
                    aria-pressed={favorite.isFavorited}
                    onClick={toggleFavorite}
                    disabled={favorite.isMutating}
                  >
                    {favorite.isFavorited ? <HeartOff aria-hidden="true" /> : <Heart aria-hidden="true" />}
                    {favorite.isFavorited ? 'In favorites' : 'Add to favorites'}
                  </Button>
                </div>
                {favorite.error !== null ? <div className="mt-2"><ErrorBanner error={favorite.error} /></div> : null}
              </div>
            </CardContent>
          </Card>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold">Chapters ({count})</h3>
            <Button
              type="button"
              size="sm"
              onClick={(): void => {
                void enqueue();
              }}
              disabled={selected.length === 0 || createJob.isPending}
            >
              <ListPlus aria-hidden="true" />
              {createJob.isPending
                ? 'Enqueueing…'
                : `Enqueue ${selected.length} chapter${selected.length === 1 ? '' : 's'}`}
            </Button>
          </div>

          <ChapterToolbar
            className="mb-3"
            options={view}
            visibleCount={visible.length}
            downloadedCount={info.data.downloaded.length}
            favorited={favorite.isFavorited}
            onOptionsChange={setView}
            onSelectAll={(): void => {
              setSelected([...new Set([...selected, ...visible])].sort((a, b): number => a - b));
            }}
            onClear={(): void => {
              setSelected([]);
            }}
            onInvert={(): void => {
              setSelected(invertSelection(selected, visible));
            }}
            onSelectNew={(): void => {
              setSelected(selectNewIndices(chapterLinks, downloaded, favorite.isFavorited));
            }}
          />

          <EnqueueOptions
            className="mb-3"
            moduleId={moduleId}
            url={url}
            extras={extras}
            onExtrasChange={setExtras}
          />

          {createJob.isError ? <ErrorBanner error={createJob.error} /> : null}
          {createJob.isSuccess ? (
            <p role="status" aria-live="polite" className="mb-3 text-sm">
              Job <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">{createJob.data.job.id}</code> queued
              {createJob.data.job.paused === true ? ' (paused; resume it from Downloads)' : ''}
              {createJob.data.job.idempotencyKey !== undefined ? ' (idempotency key recorded)' : ''}.
            </p>
          ) : null}

          <ListPanel
            className="chapter-list rounded-lg border"
            ariaLabel="Chapters"
            items={visible}
            itemKey={(i): string => chapterLinks[i] ?? String(i)}
            rowClassName="py-0.5"
            renderItem={(i): ReactElement => {
              const link = chapterLinks[i] ?? '';
              const isDownloaded = isDownloadedChapter(link, downloaded);
              // [file-state] the verified truth wins when loaded: a
              // ledger chapter whose file is gone shows 'missing'; a
              // chapter with no ledger entry stays badge-less
              // (not_downloaded — FMD2 parity, the muted row).
              const verifiedState = fileStates.get(link);
              const badgeState: 'downloaded' | 'missing' | null = titleFiles.isSuccess
                ? (verifiedState ?? (isDownloaded ? 'downloaded' : null))
                : isDownloaded
                  ? 'downloaded'
                  : null;
              return (
                <div
                  data-downloaded={isDownloaded ? 'true' : undefined}
                  data-file-state={badgeState ?? undefined}
                  className={cn(
                    'flex min-h-row items-center gap-2.5 rounded-md px-2 text-sm transition-colors hover:bg-surface-hover',
                    isDownloaded && 'bg-primary/5',
                  )}
                >
                  <label
                    htmlFor={`chapter-${i}`}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5"
                  >
                    <input
                      id={`chapter-${i}`}
                      type="checkbox"
                      className="size-4 accent-(--primary)"
                      checked={selected.includes(i)}
                      onChange={(e: ChangeEvent<HTMLInputElement>): void => {
                        onCheck(i, e.target.checked);
                      }}
                    />{' '}
                    <span className={cn('min-w-0 flex-1 truncate', isDownloaded && 'text-muted-foreground')}>
                      {chapters[i] ?? chapterLinks[i]}
                    </span>
                  </label>
                  {badgeState !== null ? (
                    <span
                      data-state={badgeState}
                      title={
                        badgeState === 'missing'
                          ? 'Marked downloaded in the ledger, but the file is not at its recorded path (see Files)'
                          : undefined
                      }
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                        badgeState === 'downloaded' ? 'bg-primary/10 text-primary' : 'bg-destructive/15 text-destructive',
                      )}
                    >
                      {badgeState}
                    </span>
                  ) : null}
                </div>
              );
            }}
          />

          <FilesSection
            moduleId={moduleId}
            url={url}
            mangaTitle={title || info.data.title}
            chapterLabels={chapterLabels}
          />

          <Separator className="my-6" />
          <h3 className="text-lg font-semibold">Enqueue dry-run preview</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {selected.length === 0
              ? 'Select chapters to preview the exact request bodies (nothing is sent).'
              : `${selected.length} request body(s) that enqueue would POST to /api/jobs/download:`}
          </p>
          <pre
            aria-label="Enqueue request preview"
            className="mt-2 overflow-x-auto rounded-lg border bg-surface p-3 font-mono text-xs whitespace-pre-wrap"
          >
            {selected.length === 0 ? '(no chapters selected)' : dryRuns.join('\n\n')}
          </pre>
        </article>
      ) : null}
    </section>
  );
}
