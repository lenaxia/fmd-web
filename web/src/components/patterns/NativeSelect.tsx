/**
 * NativeSelect (design system pattern support): a token-styled native
 * <select>. The e2e/jest-dom suites drive several selects through
 * native semantics (selectOption, option roles, INDEX round-trips in
 * the module options editor) — those stay native by design; this gives
 * them the exact look of the vendored Radix Select trigger without its
 * behavior. Visual parity, behavioral neutrality.
 */
import type { ReactElement, SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from 'cn';

export function NativeSelect(props: SelectHTMLAttributes<HTMLSelectElement>): ReactElement {
  const { className, children, ...rest } = props;
  return (
    <div className={cn('relative', className)}>
      <select
        {...rest}
        className="h-9 w-full appearance-none rounded-md border border-input bg-transparent px-3 pr-8 text-base shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 max-md:h-touch-target md:text-sm"
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}
