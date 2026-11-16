/**
 * ProgressToast (design system pattern): long-running action feedback
 * on sonner — loading → success/error transitions with an optional
 * determinate Progress bar rendered INSIDE the toast. Used for the
 * Settings sync actions (and any future bulk enqueue); pinned inline
 * status regions (role="status") stay untouched wherever e2e asserts
 * them, so this is strictly additive.
 */
import type { ReactElement } from 'react';
import { toast } from 'sonner';
import { Progress } from '@/components/ui/progress';

export interface ProgressToastHandle {
  readonly id: string | number;
}

function body(message: string, progress?: number): ReactElement {
  return (
    <span className="flex w-full flex-col gap-2">
      <span>{message}</span>
      {progress !== undefined ? <Progress value={progress} aria-label={`${Math.round(progress)}%`} /> : null}
    </span>
  );
}

export const progressToast = {
  /** Start (or restart) a loading toast; keep the handle for the outcome. */
  start(message: string, progress?: number): ProgressToastHandle {
    return { id: toast.loading(body(message, progress)) };
  },
  /** Update the message/progress of a running toast. */
  update(handle: ProgressToastHandle, message: string, progress?: number): void {
    toast.loading(body(message, progress), { id: handle.id });
  },
  /** Resolve the toast as success. */
  done(handle: ProgressToastHandle, message: string): void {
    toast.success(message, { id: handle.id });
  },
  /** Resolve the toast as failure. */
  fail(handle: ProgressToastHandle, message: string): void {
    toast.error(message, { id: handle.id });
  },
};
