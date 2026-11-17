/**
 * EntryRow (design system pattern): the one row anatomy behind catalog
 * entries, favorites, library files and job rows — leading / title /
 * meta / badges / trailing actions on a shared density token. Passing
 * `onClick` renders the whole row as the button (Browse catalog rows
 * are the canonical example); otherwise it is a static row container.
 *
 * forwardRef: the row <li> is the HoverCardTrigger asChild anchor for
 * the metadata popover (browse-list polish) — a plain function
 * component would silently drop the ref and floating-ui would never
 * position the popover.
 */
import { forwardRef, type LiHTMLAttributes, type MouseEventHandler, type ReactElement, type ReactNode } from 'react';
import { cn } from 'cn';

/** `data-*` hooks (data-job-id, data-favorite-id, …) ride on the <li>. */
export type RowDataAttributes = { readonly [key: `data-${string}`]: string | undefined };

export interface EntryRowProps extends Omit<LiHTMLAttributes<HTMLLIElement>, 'title' | 'onClick'> {
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly leading?: ReactNode;
  readonly badges?: ReactNode;
  readonly trailing?: ReactNode;
  readonly onClick?: MouseEventHandler<HTMLButtonElement>;
  readonly buttonClassName?: string;
  readonly ariaLabel?: string;
  readonly data?: RowDataAttributes;
  readonly disabled?: boolean;
}

export const EntryRow = forwardRef<HTMLLIElement, EntryRowProps>(function EntryRow(props, forwardedRef): ReactElement {
  const { title, meta, leading, badges, trailing, onClick, buttonClassName, data, disabled, ...liRest } = props;

  if (onClick !== undefined) {
    return (
      <li {...liRest} {...data} ref={forwardedRef} className={cn('min-h-row flex items-stretch', liRest.className)}>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={props.ariaLabel}
          className={cn(
            'flex flex-1 flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left',
            'transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            disabled === true ? 'pointer-events-none opacity-50' : '',
            buttonClassName,
          )}
        >
          <span className="flex w-full flex-wrap items-center gap-2">
            {leading}
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
            {badges}
          </span>
          {meta !== undefined ? <span className="text-xs text-muted-foreground">{meta}</span> : null}
        </button>
        {trailing}
      </li>
    );
  }

  return (
    <li
      {...liRest}
      {...data}
      ref={forwardedRef}
      className={cn('flex min-h-row flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2', liRest.className)}
    >
      {leading}
      <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
        <span className="flex w-full flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium">{title}</span>
          {badges}
        </span>
        {meta !== undefined ? <span className="text-xs text-muted-foreground">{meta}</span> : null}
      </span>
      {trailing}
    </li>
  );
});
