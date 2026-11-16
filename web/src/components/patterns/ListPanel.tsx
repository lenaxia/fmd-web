/**
 * ListPanel (design system pattern) — THE list container every feature
 * composes: one spacing/divider rhythm, and virtualization above the
 * VIRTUALIZE_THRESHOLD so the 454-site registry and 50k+ catalog rows
 * scroll at 60fps while fixture-sized lists keep the plain DOM (and
 * jsdom unit tests) on the simplest possible path.
 *
 * Both branches render the SAME a11y shape: a `role="list"` element
 * whose children are `<li>` rows supplied by `renderItem` — e2e class
 * hooks (`.job-list`, `.catalog-list`, …) ride along via `className`.
 *
 * Virtualized branch: @tanstack/react-virtual with dynamic measurement
 * (`measureElement`) — rows are absolutely positioned; the container
 * keeps native scrolling, focus and hit-testing.
 */
import { useRef, type LiHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from 'cn';

/** Above this many rows the panel virtualizes (jsdom never crosses it). */
export const VIRTUALIZE_THRESHOLD = 100;

/** Default row height estimate (px) — matches the `--spacing-row` token. */
export const DEFAULT_ROW_SIZE = 44;

export interface ListPanelProps<T> {
  readonly items: readonly T[];
  readonly renderItem: (item: T, index: number) => ReactNode;
  readonly itemKey: (item: T, index: number) => string;
  readonly className?: string;
  readonly rowClassName?: string;
  readonly ariaLabel?: string;
  /** Virtualized-branch scroll container height (CSS length). */
  readonly viewportHeight?: string;
  readonly estimateSize?: (index: number) => number;
  readonly header?: ReactNode;
  readonly footer?: ReactNode;
  readonly liProps?: (
    item: T,
    index: number,
  ) => LiHTMLAttributes<HTMLLIElement> & { readonly [key: `data-${string}`]: string | undefined };
}

export function ListPanel<T>(props: ListPanelProps<T>): ReactElement {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualized = props.items.length > VIRTUALIZE_THRESHOLD;
  const estimateSize = props.estimateSize ?? ((): number => DEFAULT_ROW_SIZE);

  const virtualizer = useVirtualizer({
    count: props.items.length,
    getScrollElement: (): HTMLDivElement | null => (virtualized ? parentRef.current : null),
    estimateSize,
    overscan: 12,
  });

  const listClasses = cn('w-full list-none', props.className);

  return (
    <div className="w-full">
      {props.header !== undefined ? props.header : null}
      {virtualized ? (
        <div
          ref={parentRef}
          className={cn('overflow-y-auto rounded-lg border', props.viewportHeight ?? 'max-h-[70vh]')}
          data-virtualized="true"
        >
          <ul
            className={listClasses}
            aria-label={props.ariaLabel}
            style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
          >
            {virtualizer.getVirtualItems().map((virtualRow): ReactElement => {
              const item = props.items[virtualRow.index];
              if (item === undefined) {
                return <li key={virtualRow.key} />;
              }
              const liProps = props.liProps?.(item, virtualRow.index);
              return (
                <li
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  {...liProps}
                  className={cn(
                    'absolute top-0 left-0 w-full border-b border-border/60 px-3',
                    liProps?.className,
                    props.rowClassName,
                  )}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {props.renderItem(item, virtualRow.index)}
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <ul className={cn(listClasses, 'divide-y divide-border/60')} aria-label={props.ariaLabel}>
          {props.items.map((item, index): ReactElement => {
            const liProps = props.liProps?.(item, index);
            return (
              <li
                key={props.itemKey(item, index)}
                {...liProps}
                className={cn('px-1 py-0.5', liProps?.className, props.rowClassName)}
              >
                {props.renderItem(item, index)}
              </li>
            );
          })}
        </ul>
      )}
      {props.footer !== undefined ? props.footer : null}
    </div>
  );
}
