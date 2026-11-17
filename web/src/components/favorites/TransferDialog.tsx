/**
 * TransferDialog (favorites-parity): the frmTransferFavorites ADAPT for
 * ONE favorite (the row-menu entry point): target-site picker, the
 * valid/invalid mapping preview (catalog title match + GetInfo dry-run
 * — reasons: no-catalog / not-found / get-info-failed) and the
 * clear-downloaded-chapter-list-and-reload checkbox (tag-100 re-ingest
 * of the live target-site list).
 */
import { useState, type ReactElement } from 'react';
import { ArrowRightLeft, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { NativeSelect } from '@/components/patterns/NativeSelect';
import { ErrorBanner } from '@/components/patterns/ErrorBanner';
import {
  useTransferFavorite,
  useTransferPreview,
  type FavoriteT,
  type FavoriteTransferPreviewT,
} from '../../api/hooks';
import type { ModuleSummaryT } from '../../api/hooks';

function previewReasonText(reason: string | undefined): string {
  switch (reason) {
    case 'no-catalog':
      return 'no catalog installed for the target site';
    case 'get-info-failed':
      return 'the target link did not resolve live (GetInfo failed)';
    case 'not-found':
      return 'the title was not found on the target site';
    default:
      return 'no mapping';
  }
}

export function TransferDialog(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly favorite: FavoriteT | null;
  /** Candidate target modules (the enabled site list). */
  readonly modules: readonly ModuleSummaryT[];
  readonly onTransferred: () => void;
}): ReactElement {
  const { open, onClose, favorite, modules, onTransferred } = props;
  const [targetModuleId, setTargetModuleId] = useState('');
  const [clearDownloadedList, setClearDownloadedList] = useState(false);
  const [preview, setPreview] = useState<FavoriteTransferPreviewT | null>(null);
  const previewQuery = useTransferPreview();
  const transfer = useTransferFavorite();

  const runPreview = (moduleId: string): void => {
    setTargetModuleId(moduleId);
    setPreview(null);
    if (moduleId !== '' && favorite !== null) {
      previewQuery.mutate(
        { id: favorite?.id ?? "", targetModuleId: moduleId },
        { onSuccess: setPreview },
      );
    }
  };

  const close = (): void => {
    setTargetModuleId('');
    setPreview(null);
    setClearDownloadedList(false);
    previewQuery.reset();
    transfer.reset();
    onClose();
  };

  const apply = (): void => {
    if (preview === null || !preview.valid) {
      return;
    }
    transfer.mutate(
      {
        id: favorite?.id ?? "",
        targetModuleId,
        clearDownloadedList,
      },
      {
        onSuccess: (): void => {
          onTransferred();
          close();
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next): void => { if (!next) close(); }}>
      <DialogContent className="transfer-dialog max-w-lg" data-testid="transfer-dialog">
        <DialogHeader>
          <DialogTitle>
            Transfer website — {favorite?.title ?? favorite?.url ?? ""}
          </DialogTitle>
          <DialogDescription>
            frmTransferFavorites parity: pick the target site; the title is
            matched against its catalog and dry-run live before anything moves.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-1">
          <label className="flex items-center gap-2 text-sm font-medium">
            Transfer to
            <NativeSelect
              value={targetModuleId}
              onChange={(event): void => runPreview(event.target.value)}
              aria-label="Target website"
              data-testid="transfer-target-select"
              className="max-w-xs flex-1"
            >
              <option value="">select a website…</option>
              {modules
                .filter((module): boolean => favorite === null || module.id !== favorite.moduleId)
                .map((module): ReactElement => (
                  <option key={module.id} value={module.id}>
                    {module.name}
                  </option>
                ))}
            </NativeSelect>
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            disabled={targetModuleId === ''}
            data-testid="transfer-preview-button"
            onClick={(): void => runPreview(targetModuleId)}
          >
            <Search aria-hidden="true" />
            Check mapping
          </Button>

          {previewQuery.isPending ? (
            <p role="status" className="text-sm text-muted-foreground" data-testid="transfer-preview-loading">
              Resolving the title on the target site…
            </p>
          ) : null}
          {previewQuery.isError && preview === null ? (
            <ErrorBanner error={previewQuery.error} />
          ) : null}
          {preview !== null ? (
            <div
              role="status"
              data-testid={`transfer-preview-${preview.valid ? 'valid' : 'invalid'}`}
              className="rounded-md border px-3 py-2 text-sm"
            >
              {preview.valid ? (
                <>
                  <p className="font-medium text-primary">
                    Valid mapping found
                  </p>
                  <p className="break-all text-muted-foreground" data-testid="transfer-preview-url">
                    {preview.matchedTitle} → {preview.targetUrl}
                  </p>
                </>
              ) : (
                <p className="font-medium text-destructive" data-testid="transfer-preview-reason">
                  Invalid mapping — {previewReasonText(preview.reason)}
                </p>
              )}
            </div>
          ) : null}

          <label className="flex items-center gap-2 text-sm max-md:min-h-touch-target" data-testid="transfer-clear-label">
            <Checkbox
              checked={clearDownloadedList}
              onCheckedChange={(value): void => setClearDownloadedList(value === true)}
              data-testid="transfer-clear-checkbox"
            />
            Clear downloaded chapter list and reload from server
          </label>
          {transfer.isError ? <ErrorBanner error={transfer.error} /> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={preview === null || !preview.valid || transfer.isPending}
            data-testid="transfer-apply"
            onClick={apply}
          >
            <ArrowRightLeft aria-hidden="true" />
            {transfer.isPending ? 'Transferring…' : 'Transfer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
