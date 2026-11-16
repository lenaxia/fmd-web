/**
 * FilterBar (design system pattern): the toolbar rhythm above every
 * list. Desktop renders it inline; on mobile (< md) it collapses into
 * a Sheet side panel (the vendored Radix-dialog sheet) so filter
 * controls never duplicate in the DOM — a single instance rendered in
 * whichever chrome the viewport picked (jsdom/unit tests always take
 * the inline branch: no matchMedia layout).
 */
import type { ReactElement, ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useMediaQuery } from '@/state/use-media-query';

export function FilterBar(props: {
  ariaLabel?: string;
  className?: string;
  children: ReactNode;
}): ReactElement {
  const isMobile = useMediaQuery('(max-width: 767px)');

  if (isMobile) {
    return (
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="outline" size="sm" className="mb-4">
            <SlidersHorizontal aria-hidden="true" />
            Filters
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-72 overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Filters</SheetTitle>
          </SheetHeader>
          <div
            role="group"
            aria-label={props.ariaLabel}
            className={cn('flex flex-col items-stretch gap-3 px-1 pb-6', props.className)}
          >
            {props.children}
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div
      role="group"
      aria-label={props.ariaLabel}
      className={cn('mb-4 flex flex-wrap items-center gap-x-3 gap-y-2', props.className)}
    >
      {props.children}
    </div>
  );
}
