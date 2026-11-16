/**
 * Manga detail (§5.8): live info display + chapter list + enqueue
 * dry-run. The dry-run builds the exact `POST /api/jobs/download`
 * body per selected chapter (deterministic idempotency key, §10)
 * and previews it without sending; enqueue POSTs the same bodies.
 *
 * Design-system retrofit: PageHeader + info Card + ListPanel
 * chapters + token-styled controls. Behavior, labels, ids and the
 * dry-run preview are unchanged — visual-only.
 */
import { useState, type ChangeEvent, type ReactElement } from 'react';
import { ArrowLeft, CheckCheck, Eraser, ListPlus } from 'lucide-react';
import { useCreateDownloadJob, useLiveInfo } from '../api/hooks';
import { dryRunJson } from '../api/dry-run';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';
import { ListPanel } from '@/components/patterns/ListPanel';
import { PageHeader } from '@/components/patterns/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { navigate, type Route } from '../router';

export function MangaPage(props: { route: Route }): ReactElement {
  const moduleId = props.route.query['module'] ?? '';
  const url = props.route.query['url'] ?? '';
  const title = props.route.query['title'] ?? '';
  const catalogId = props.route.query['catalog'] ?? '';

  const info = useLiveInfo(moduleId === '' ? undefined : moduleId, url === '' ? undefined : url);
  const [selected, setSelected] = useState<readonly number[]>([]);
  const createJob = useCreateDownloadJob();

  if (moduleId === '' || url === '') {
    return (
      <section aria-label="Manga detail">
        <PageHeader title="Manga" description="Live info, chapters and the enqueue dry-run." />
        <EmptyState title="No manga selected">
          <p>Pick a title on the Browse page — this view needs a site module id and a manga URL.</p>
        </EmptyState>
      </section>
    );
  }

  const chapters = info.data?.chapterNames ?? [];
  const chapterLinks = info.data?.chapterLinks ?? [];
  const count = Math.min(chapters.length, chapterLinks.length);
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
      });
    }
  };

  return (
    <section aria-label="Manga detail">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 mb-2"
        onClick={(): void => {
          navigate('browse', catalogId === '' ? {} : { catalog: catalogId });
        }}
      >
        <ArrowLeft aria-hidden="true" />
        ← Back to browse
      </Button>

      {info.isPending ? <p role="status" className="text-sm text-muted-foreground">Fetching live info…</p> : null}
      {info.isError ? <ErrorBanner error={info.error} /> : null}

      {info.data !== undefined ? (
        <article className="manga-info">
          <PageHeader title={info.data.title} description={info.data.summary || undefined} />

          <Card className="mb-6">
            <CardContent className="pt-6">
              <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm">
                <dt className="font-medium text-muted-foreground">Alternative titles</dt>
                <dd>{info.data.altTitles || '—'}</dd>
                <dt className="font-medium text-muted-foreground">Authors</dt>
                <dd>{info.data.authors || '—'}</dd>
                <dt className="font-medium text-muted-foreground">Artists</dt>
                <dd>{info.data.artists || '—'}</dd>
                <dt className="font-medium text-muted-foreground">Genres</dt>
                <dd>{info.data.genres || '—'}</dd>
                <dt className="font-medium text-muted-foreground">Status</dt>
                <dd>{info.data.status || '—'}</dd>
                <dt className="font-medium text-muted-foreground">Chapters</dt>
                <dd>{info.data.numChapter}</dd>
                <dt className="font-medium text-muted-foreground">Summary</dt>
                <dd className="max-w-prose text-muted-foreground">{info.data.summary || '—'}</dd>
              </dl>
            </CardContent>
          </Card>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold">Chapters ({count})</h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={(): void => {
                setSelected([...Array(count).keys()]);
              }}
            >
              <CheckCheck aria-hidden="true" />
              Select all
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={(): void => {
                setSelected([]);
              }}
            >
              <Eraser aria-hidden="true" />
              Clear
            </Button>
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
          {createJob.isError ? <ErrorBanner error={createJob.error} /> : null}
          {createJob.isSuccess ? (
            <p role="status" aria-live="polite" className="mb-3 text-sm">
              Job <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">{createJob.data.job.id}</code> queued{createJob.data.job.idempotencyKey !== undefined ? ' (idempotency key recorded)' : ''}.
            </p>
          ) : null}

          <ListPanel
            className="chapter-list rounded-lg border"
            ariaLabel="Chapters"
            items={[...Array(count).keys()]}
            itemKey={(i): string => chapterLinks[i] ?? String(i)}
            rowClassName="py-0.5"
            renderItem={(i): ReactElement => (
              <label htmlFor={`chapter-${i}`} className="flex min-h-row cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm transition-colors hover:bg-surface-hover">
                <input
                  id={`chapter-${i}`}
                  type="checkbox"
                  className="size-4 accent-(--primary)"
                  checked={selected.includes(i)}
                  onChange={(e: ChangeEvent<HTMLInputElement>): void => {
                    onCheck(i, e.target.checked);
                  }}
                />{' '}
                {chapters[i] ?? chapterLinks[i]}
              </label>
            )}
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
