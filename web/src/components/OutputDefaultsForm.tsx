/**
 * OutputDefaultsForm (FMD2 Save-to options parity, the server-supported
 * subset): default archive format (zip/cbz/pdf/epub — the §7.3 packer
 * set; FMD2's None loose-images mode is DEFERRED, see UX-PARITY.md),
 * the chapter filename template (edOptionMangaCustomRename,
 * %WEBSITE%/%MANGA%/%AUTHOR%/%ARTIST%/%CHAPTER%/%NUMBERING%/%FILENAME%),
 * and the merged [parity-sweep] rename toggles (digitPadding lfm:4026,
 * removeMangaName lfm:4014, unicodeReplacement lfm:3947/4183 — the
 * server honors all of them on new jobs). The form always PUTs the
 * FULL set so a partial save never clobbers the other fields.
 * PDF quality is server-unsupported (D16 packer is DCT passthrough —
 * no re-encode) and deliberately absent — documented deferred.
 */
import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { FileArchive } from 'lucide-react';
import { useSettings, useUpdateOutputDefaults, type OutputFormatT } from '../api/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/patterns/NativeSelect';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';

const FORMAT_OPTIONS: readonly { value: OutputFormatT; label: string }[] = [
  { value: 'zip', label: 'ZIP' },
  { value: 'cbz', label: 'CBZ' },
  { value: 'pdf', label: 'PDF' },
  { value: 'epub', label: 'EPUB' },
];

/** The persisted shape's defaults (mirror of the zod schema defaults). */
const DEFAULTS = {
  format: 'cbz' as OutputFormatT,
  chapterNameTemplate: '%NUMBERING% %CHAPTER%',
  digitPadding: 0,
  removeMangaName: false,
  unicodeReplacement: false,
  unicodeReplacementChar: '_',
};

export function OutputDefaultsForm(): ReactElement {
  const settings = useSettings();
  const update = useUpdateOutputDefaults();

  const [draft, setDraft] = useState(DEFAULTS);

  // Seed the draft from the server snapshot once it lands. Partial
  // snapshots (older server / mid-rollout) fall back to the defaults —
  // the form never crashes on a missing group.
  useEffect((): void => {
    if (settings.data?.output !== undefined) {
      setDraft(settings.data.output);
    }
  }, [settings.data]);

  const server: typeof DEFAULTS | undefined = settings.data?.output;
  const dirty: boolean =
    server !== undefined &&
    (draft.format !== server.format ||
      draft.chapterNameTemplate !== server.chapterNameTemplate ||
      draft.digitPadding !== server.digitPadding ||
      draft.removeMangaName !== server.removeMangaName ||
      draft.unicodeReplacement !== server.unicodeReplacement ||
      draft.unicodeReplacementChar !== server.unicodeReplacementChar);

  if (settings.isError) {
    return (
      <section aria-label="Output defaults" className="mb-6">
        <h2 className="mb-2 text-lg font-semibold">Output defaults</h2>
        <ErrorBanner error={settings.error} />
      </section>
    );
  }

  return (
    <section aria-label="Output defaults" className="output-defaults mb-6" data-testid="output-defaults">
      <h2 className="mb-2 text-lg font-semibold">Output defaults</h2>
      <form
        className="flex flex-wrap items-end gap-4 rounded-lg border bg-surface/40 p-4"
        aria-label="Output defaults form"
        onSubmit={(event: FormEvent<HTMLFormElement>): void => {
          event.preventDefault();
          update.mutate(draft);
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="output-format" className="text-sm font-medium">
            Archive format
          </label>
          <NativeSelect
            id="output-format"
            className="w-32"
            value={draft.format}
            onChange={(e): void => {
              setDraft({ ...draft, format: e.target.value as OutputFormatT });
            }}
          >
            {FORMAT_OPTIONS.map((option): ReactElement => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">Applied to new download jobs</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="output-template" className="text-sm font-medium">
            Chapter filename template
          </label>
          <Input
            id="output-template"
            className="w-80"
            placeholder="%NUMBERING% %CHAPTER% (frozen default; empty = chapter name)"
            value={draft.chapterNameTemplate}
            onChange={(e): void => {
              setDraft({ ...draft, chapterNameTemplate: e.target.value });
            }}
          />
          <p className="text-xs text-muted-foreground">
            Placeholders: %NUMBERING% %CHAPTER% %WEBSITE% %MANGA% %AUTHOR% %ARTIST% %FILENAME%
            (%NUMBERING% = zero-padded chapter list position)
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="output-digit-padding" className="text-sm font-medium">
            Page number digits
          </label>
          <Input
            id="output-digit-padding"
            type="number"
            min={0}
            max={6}
            className="w-20"
            value={draft.digitPadding}
            onChange={(e): void => {
              const n: number = Number.parseInt(e.target.value, 10);
              setDraft({ ...draft, digitPadding: Number.isFinite(n) && n >= 0 && n <= 6 ? n : 0 });
            }}
          />
          <p className="text-xs text-muted-foreground">Archive entry name width (0 = off)</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium" id="output-rename-toggles">
            Renaming
          </span>
          <div role="group" aria-labelledby="output-rename-toggles" className="flex flex-col gap-1 text-sm">
            <label htmlFor="output-remove-manga" className="flex items-center gap-2">
              <input
                id="output-remove-manga"
                type="checkbox"
                className="size-4 accent-(--primary)"
                checked={draft.removeMangaName}
                onChange={(e): void => {
                  setDraft({ ...draft, removeMangaName: e.target.checked });
                }}
              />
              Remove manga name from chapter names
            </label>
            <label htmlFor="output-unicode" className="flex items-center gap-2">
              <input
                id="output-unicode"
                type="checkbox"
                className="size-4 accent-(--primary)"
                checked={draft.unicodeReplacement}
                onChange={(e): void => {
                  setDraft({ ...draft, unicodeReplacement: e.target.checked });
                }}
              />
              Replace non-ASCII characters with
            </label>
            <label htmlFor="output-unicode-char" className="sr-only">
              Unicode replacement character
            </label>
            <Input
              id="output-unicode-char"
              className="w-16"
              maxLength={1}
              value={draft.unicodeReplacementChar}
              onChange={(e): void => {
                setDraft({ ...draft, unicodeReplacementChar: e.target.value === '' ? '_' : e.target.value });
              }}
            />
          </div>
        </div>

        <Button type="submit" size="sm" disabled={update.isPending || !dirty}>
          <FileArchive aria-hidden="true" />
          Save output defaults
        </Button>
        {update.isSuccess && !dirty ? (
          <span role="status" className="text-xs text-muted-foreground">
            Saved
          </span>
        ) : null}
      </form>
      {update.isError ? <ErrorBanner error={update.error} /> : null}
    </section>
  );
}
