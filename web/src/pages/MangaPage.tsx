/**
 * Manga detail (§5.8): live info display + chapter list + enqueue
 * dry-run. The dry-run builds the exact `POST /api/jobs/download`
 * body per selected chapter (deterministic idempotency key, §10)
 * and previews it without sending; enqueue POSTs the same bodies.
 */
import { useState, type ChangeEvent, type ReactElement } from 'react';
import { useCreateDownloadJob, useLiveInfo } from '../api/hooks';
import { dryRunJson } from '../api/dry-run';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
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
      <EmptyState title="No manga selected">
        <p>Pick a title on the Browse page — this view needs a site module id and a manga URL.</p>
      </EmptyState>
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
      <p>
        <button
          type="button"
          onClick={(): void => {
            navigate('browse', catalogId === '' ? {} : { catalog: catalogId });
          }}
        >
          ← Back to browse
        </button>
      </p>

      {info.isPending ? <p role="status">Fetching live info…</p> : null}
      {info.isError ? <ErrorBanner error={info.error} /> : null}

      {info.data !== undefined ? (
        <article className="manga-info">
          <h2>{info.data.title}</h2>
          <dl className="info-grid">
            <dt>Alternative titles</dt>
            <dd>{info.data.altTitles || '—'}</dd>
            <dt>Authors</dt>
            <dd>{info.data.authors || '—'}</dd>
            <dt>Artists</dt>
            <dd>{info.data.artists || '—'}</dd>
            <dt>Genres</dt>
            <dd>{info.data.genres || '—'}</dd>
            <dt>Status</dt>
            <dd>{info.data.status || '—'}</dd>
            <dt>Chapters</dt>
            <dd>{info.data.numChapter}</dd>
            <dt>Summary</dt>
            <dd>{info.data.summary || '—'}</dd>
          </dl>

          <h3>Chapters ({count})</h3>
          <p>
            <button
              type="button"
              onClick={(): void => {
                setSelected([...Array(count).keys()]);
              }}
            >
              Select all
            </button>{' '}
            <button
              type="button"
              onClick={(): void => {
                setSelected([]);
              }}
            >
              Clear
            </button>{' '}
            <button
              type="button"
              onClick= {(): void => {
                void enqueue();
              }}
              disabled={selected.length === 0 || createJob.isPending}
            >
              {createJob.isPending
                ? 'Enqueueing…'
                : `Enqueue ${selected.length} chapter${selected.length === 1 ? '' : 's'}`}
            </button>
          </p>
          {createJob.isError ? <ErrorBanner error={createJob.error} /> : null}
          {createJob.isSuccess ? (
            <p role="status" aria-live="polite">
              Job <code>{createJob.data.job.id}</code> queued{createJob.data.job.idempotencyKey !== undefined ? ' (idempotency key recorded)' : ''}.
            </p>
          ) : null}

          <ul className="chapter-list">
            {[...Array(count).keys()].map((i): ReactElement => (
              <li key={chapterLinks[i] ?? i}>
                <label htmlFor={`chapter-${i}`}>
                  <input
                    id={`chapter-${i}`}
                    type="checkbox"
                    checked={selected.includes(i)}
                    onChange={(e: ChangeEvent<HTMLInputElement>): void => {
                      onCheck(i, e.target.checked);
                    }}
                  />{' '}
                  {chapters[i] ?? chapterLinks[i]}
                </label>
              </li>
            ))}
          </ul>

          <h3>Enqueue dry-run preview</h3>
          <p>
            {selected.length === 0
              ? 'Select chapters to preview the exact request bodies (nothing is sent).'
              : `${selected.length} request body(s) that enqueue would POST to /api/jobs/download:`}
          </p>
          <pre aria-label="Enqueue request preview" className="dry-run">
            {selected.length === 0 ? '(no chapters selected)' : dryRuns.join('\n\n')}
          </pre>
        </article>
      ) : null}
    </section>
  );
}
