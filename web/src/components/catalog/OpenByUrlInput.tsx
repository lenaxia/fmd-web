/**
 * OpenByUrlInput ([parity-sweep] M14 — FMD2 edURL paste-and-go parity,
 * pas:6609): paste a manga URL, the server resolves the module by
 * RootURL host (POST /api/info url-only) and the app navigates to the
 * manga page. Ctrl+Shift+V paste-and-go reads the clipboard directly.
 * Typed failures surface verbatim: `no_site_match` ("no site matches
 * this URL") and `ambiguous_site` (naming the candidate sites).
 */
import { useState, type FormEvent, type KeyboardEvent, type ReactElement } from 'react';
import { ExternalLink } from 'lucide-react';
import { useOpenByUrl } from '../../api/hooks';
import { ApiError } from '../../api/errors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { navigate } from '../../router';

function describeError(error: ApiError): string {
  if (error.code === 'no_site_match') {
    return 'No site matches this URL';
  }
  if (error.code === 'ambiguous_site') {
    return `Ambiguous host — ${error.message}`;
  }
  return error.message;
}

export function OpenByUrlInput(): ReactElement {
  const open = useOpenByUrl();
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  const go = async (raw: string): Promise<void> => {
    const target: string = raw.trim();
    if (target === '') {
      return;
    }
    setError('');
    try {
      const info = await open.mutateAsync({ url: target });
      navigate('manga', { module: info.moduleId, url: info.url, title: info.title });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(describeError(err));
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('open by URL failed');
      }
    }
  };

  const onPasteGo = async (): Promise<void> => {
    try {
      const text: string = await globalThis.navigator.clipboard.readText();
      if (text.trim() !== '') {
        setUrl(text.trim());
        await go(text);
      }
    } catch {
      setError('Clipboard read failed — paste into the box and press Enter');
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // Ctrl+Shift+V (FMD2 pas:6609 paste-and-go): read the clipboard and
    // navigate straight away.
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'v') {
      event.preventDefault();
      void onPasteGo();
    }
  };

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      aria-label="Open by URL form"
      data-testid="open-by-url"
      onSubmit={(event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        void go(url);
      }}
    >
      <label htmlFor="open-by-url-input" className="text-sm font-medium">
        Open by URL
      </label>
      <Input
        id="open-by-url-input"
        name="url"
        type="url"
        className="w-72"
        placeholder="Paste a manga URL… (Ctrl+Shift+V)"
        value={url}
        onChange={(e): void => {
          setUrl(e.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <Button type="submit" variant="secondary" size="sm" disabled={open.isPending}>
        <ExternalLink aria-hidden="true" />
        {open.isPending ? 'Opening…' : 'Open'}
      </Button>
      {error !== '' ? (
        <p role="alert" className="w-full text-sm text-destructive" data-testid="open-by-url-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}
