/**
 * CoverImage (MangaPage parity, FMD2 imCover — frmMain.lfm:962): the
 * info-card cover thumbnail with a loading skeleton and a fallback
 * placeholder. Lazy + async-decoded (§5.8 info.coverLink may be an
 * arbitrary remote URL); network/broken covers degrade to the
 * placeholder, never an empty box.
 */
import { useState, type ReactElement } from 'react';
import { BookOpen } from 'lucide-react';
import { cn } from 'cn';

export function CoverImage(props: {
  src: string;
  alt: string;
  className?: string;
}): ReactElement {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const showImage = props.src !== '' && !failed;

  return (
    <div
      data-testid="manga-cover"
      className={cn(
        'relative isolate flex size-32 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-surface text-muted-foreground',
        props.className,
      )}
    >
      {!loaded && !failed ? (
        <div aria-hidden="true" className="absolute inset-0 animate-pulse bg-surface-hover" data-testid="manga-cover-loading" />
      ) : null}
      {showImage ? (
        <img
          src={props.src}
          alt={props.alt}
          loading="lazy"
          decoding="async"
          onLoad={(): void => {
            setLoaded(true);
          }}
          onError={(): void => {
            setFailed(true);
          }}
          className={cn('size-full object-cover', loaded ? 'opacity-100' : 'opacity-0')}
        />
      ) : (
        <div role="img" aria-label={`${props.alt} (no cover)`} className="flex flex-col items-center gap-1 p-2 text-center">
          <BookOpen aria-hidden="true" className="size-8" />
          <span className="text-[10px] leading-tight">No cover</span>
        </div>
      )}
    </div>
  );
}
