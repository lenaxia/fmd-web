/**
 * PasteUrlAdd ([crystal-nectar-pricks] D1 §2 ENTER — paste-URL, the
 * universal front door): paste any site page URL; the server resolves
 * the module by RootURL host (POST /api/info url-only — the M14 seam
 * whose typed 400s no_site_match / ambiguous_site already exist), the
 * preview card shows title / cover (via the proxy seam) / alt titles,
 * and the ONE decision is follow vs follow+auto-download — never a
 * wizard, never re-asked (the one-decision add). No mode switching,
 * no site picker for the common case; the command palette's
 * "Add manga by URL" action LANDS here (state/paste-url-arm) instead
 * of building a second form.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { ClipboardPaste, Download, ExternalLink, Heart, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useFavoriteState, useModules, useOpenByUrl, type InfoT } from '../../api/hooks';
import { ApiError } from '../../api/errors';
import { coverSrc } from '../../api/cover';
import {
  consumePasteUrlArm,
  normalizePastedUrl,
  subscribePasteUrl,
} from '../../state/paste-url-arm';
import { navigate, navigateToManga } from '../../router';
import { CoverImage } from '@/components/manga/CoverImage';
import { WebsiteBadge } from '@/components/catalog/WebsiteBadge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

/** The typed failures that get HUMAN guidance (never a bare 500 page). */
interface ResolveError {
  readonly code: string;
  readonly message: string;
}

export function PasteUrlAdd(): ReactElement {
  const open = useOpenByUrl();
  const modules = useModules();
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<InfoT | undefined>(undefined);
  const [error, setError] = useState<ResolveError | undefined>(undefined);
  const [outcome, setOutcome] = useState<'added' | 'added-auto' | 'exists' | undefined>(undefined);

  // Membership + add for the RESOLVED manga ('' until the preview
  // exists — the hook disables its queries for the empty pair).
  const favorite = useFavoriteState(preview?.moduleId ?? '', preview?.url ?? '');
  const siteName: string | undefined = modules.data?.modules.find(
    (m): boolean => m.id === preview?.moduleId,
  )?.name;

  const resolve = async (raw: string): Promise<void> => {
    const target: string | undefined = normalizePastedUrl(raw);
    if (target === undefined) {
      setPreview(undefined);
      setOutcome(undefined);
      setError({
        code: 'not_a_url',
        message:
          "That doesn't look like a web address — paste the series page's full URL (e.g. https://…)",
      });
      return;
    }
    setError(undefined);
    setOutcome(undefined);
    try {
      const info = await open.mutateAsync({ url: target });
      setPreview(info);
    } catch (err: unknown) {
      setPreview(undefined);
      if (err instanceof ApiError) {
        setError({ code: err.code, message: err.message });
      } else if (err instanceof Error) {
        setError({ code: 'internal_error', message: err.message });
      } else {
        setError({ code: 'internal_error', message: 'resolving the URL failed' });
      }
    }
  };

  // Palette arm channel: a pending arm (the palette navigated here
  // first) is consumed at mount; live arms (already on the home) fire
  // immediately. resolveRef keeps the effect wired to the latest
  // closure without re-subscribing per render.
  const resolveRef = useRef<(raw: string) => Promise<void>>((): Promise<void> => {
    return Promise.resolve();
  });
  useEffect((): void => {
    resolveRef.current = resolve;
  });
  useEffect((): (() => void) => {
    const onArm = (armed: string): void => {
      setUrl(armed);
      void resolveRef.current(armed);
    };
    const armed = consumePasteUrlArm();
    if (armed !== undefined) {
      onArm(armed);
    }
    return subscribePasteUrl(onArm);
  }, []);

  const follow = async (autoDownload: boolean): Promise<void> => {
    if (preview === undefined) {
      return;
    }
    try {
      await favorite.add({
        title: preview.title,
        ...(autoDownload ? { autoDownload: true } : {}),
      });
      setOutcome(autoDownload ? 'added-auto' : 'added');
      toast.success(`Followed ${preview.title} — it's in your Favorites now.`);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === 'conflict') {
        setOutcome('exists');
        toast.message(`${preview.title} is already in your Favorites.`);
      } else if (err instanceof ApiError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ code: 'internal_error', message: 'following failed' });
      }
    }
  };

  const resolved: boolean = outcome !== undefined || favorite.isFavorited;
  const resolving: boolean = open.isPending;

  const onPasteClick = async (): Promise<void> => {
    try {
      const text: string = await globalThis.navigator.clipboard.readText();
      if (normalizePastedUrl(text) !== undefined) {
        setUrl(text.trim());
        void resolve(text);
      } else {
        setError({
          code: 'not_a_url',
          message: 'The clipboard holds no URL — paste into the box and press Preview.',
        });
      }
    } catch {
      setError({
        code: 'not_a_url',
        message: 'Clipboard read failed — paste into the box and press Preview.',
      });
    }
  };

  return (
    <section aria-label="Add manga by URL" className="mx-auto mb-6 max-w-2xl" data-testid="paste-url-add">
      <form
        className="flex flex-wrap items-center gap-2"
        // noValidate: native type=url validation would swallow the
        // submit for scheme-less pastes ('site.example/x') with a
        // browser bubble instead of OUR guidance — normalizePastedUrl
        // owns the verdict here.
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>): void => {
          event.preventDefault();
          void resolve(url);
        }}
      >
        <label htmlFor="paste-url-input" className="text-sm font-medium">
          Add by URL
        </label>
        <Input
          id="paste-url-input"
          name="url"
          type="url"
          className="min-w-0 flex-1"
          placeholder="Paste any manga series URL — the site is detected automatically"
          value={url}
          onChange={(e): void => {
            setUrl(e.target.value);
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={resolving}
          onClick={(): void => {
            void onPasteClick();
          }}
        >
          <ClipboardPaste aria-hidden="true" />
          Paste
        </Button>
        <Button type="submit" size="sm" disabled={resolving}>
          {resolving ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          {resolving ? 'Resolving…' : 'Preview'}
        </Button>
      </form>

      {error !== undefined ? (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm"
          data-testid="paste-url-error"
          data-error-code={error.code}
        >
          {error.code === 'no_site_match' ? (
            <>
              <p className="font-medium">No site matches this URL.</p>
              <p className="mt-1 text-muted-foreground">
                It must be a series page on a site fmd-web has a module for — check what's
                supported, then paste the page URL from there.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={(): void => {
                  navigate('browse', { sites: '1' });
                }}
              >
                Browse supported sites
              </Button>
            </>
          ) : error.code === 'ambiguous_site' ? (
            <>
              <p className="font-medium">This host is shared by more than one site.</p>
              <p className="mt-1 text-muted-foreground">
                Candidates: {error.message}. Open the site you meant and paste its page URL, or
                search for the title instead.
              </p>
            </>
          ) : (
            <p>{error.message}</p>
          )}
        </div>
      ) : null}

      {resolving ? (
        <p role="status" aria-live="polite" className="mt-3 text-sm text-muted-foreground">
          Resolving the URL and fetching title info…
        </p>
      ) : null}

      {preview !== undefined ? (
        <Card className="mt-3" data-testid="paste-url-preview">
          <CardContent className="flex max-md:flex-col flex-row gap-4 pt-6">
            <CoverImage
              src={coverSrc(preview.moduleId, preview.coverLink) ?? ''}
              alt={`${preview.title} cover`}
              testId="paste-url-cover"
              className="size-24"
            />
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-base font-semibold">{preview.title}</h3>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {siteName !== undefined ? <WebsiteBadge siteName={siteName} siteId={preview.moduleId} /> : null}
                <span className="text-xs text-muted-foreground">
                  {String(preview.numChapter)} chapter{preview.numChapter === 1 ? '' : 's'}
                  {preview.status !== '' ? ` · ${preview.status}` : ''}
                </span>
              </div>
              {preview.altTitles !== '' ? (
                <p className="mt-1 text-sm text-muted-foreground" data-testid="paste-url-alt-titles">
                  {preview.altTitles}
                </p>
              ) : null}
              {preview.authors !== '' ? (
                <p className="mt-1 text-sm text-muted-foreground">by {preview.authors}</p>
              ) : null}

              {resolved ? (
                <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="paste-url-done">
                  <p role="status" className="text-sm font-medium text-success">
                    {outcome === 'added-auto'
                      ? 'Followed — new chapters will download automatically.'
                      : outcome === 'exists' || favorite.isFavorited
                        ? 'Already in your Favorites.'
                        : 'Followed.'}
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={(): void => {
                      navigate('favorites', {});
                    }}
                  >
                    <Heart aria-hidden="true" />
                    Open Favorites
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={(): void => {
                      navigateToManga({
                        module: preview.moduleId,
                        url: preview.url,
                        title: preview.title,
                      });
                    }}
                  >
                    <ExternalLink aria-hidden="true" />
                    Open manga page
                  </Button>
                </div>
              ) : (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={favorite.isMutating}
                    data-testid="paste-url-follow"
                    onClick={(): void => {
                      void follow(false);
                    }}
                  >
                    <Heart aria-hidden="true" />
                    {favorite.isMutating ? 'Following…' : 'Follow'}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={favorite.isMutating}
                    data-testid="paste-url-follow-auto"
                    onClick={(): void => {
                      void follow(true);
                    }}
                  >
                    <Download aria-hidden="true" />
                    Follow + auto-download
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    one decision — the scheduler checks for new chapters from here on
                  </span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
