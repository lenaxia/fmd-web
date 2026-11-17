/**
 * SaveToDialog (favorites-parity): the pmFavorites "Change Save to"
 * action — edit the per-favorite custom finalize directory ('' resets
 * to the default library layout).
 */
import { useEffect, useState, type ReactElement } from 'react';
import { FolderInput } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useUpdateFavorite, type FavoriteT } from '../../api/hooks';

export function SaveToDialog(props: {
  readonly open: boolean;
  readonly favorite: FavoriteT | null;
  readonly onClose: () => void;
}): ReactElement {
  const { open, favorite, onClose } = props;
  const update = useUpdateFavorite();
  const [draft, setDraft] = useState('');

  // Seed the draft per opened favorite (null → next open starts empty).
  useEffect((): void => {
    setDraft(favorite?.saveTo ?? '');
  }, [favorite]);

  const close = (): void => {
    update.reset();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next): void => { if (!next) close(); }}>
      <DialogContent className="saveto-dialog max-w-md" data-testid="saveto-dialog">
        <DialogHeader>
          <DialogTitle>Change save-to — {favorite?.title ?? favorite?.url ?? ''}</DialogTitle>
          <DialogDescription>
            The per-favorite custom download directory; empty resets to the
            default library layout.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-1">
          <Input
            aria-label="Save-to directory"
            data-testid="saveto-input"
            value={draft}
            placeholder="library/<website>/<manga>"
            onChange={(event): void => setDraft(event.target.value)}
          />
          {update.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {update.error.message}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={favorite === null || update.isPending}
            data-testid="saveto-save"
            onClick={(): void => {
              if (favorite === null) {
                return;
              }
              update.mutate(
                { id: favorite.id, saveTo: draft.trim() },
                { onSuccess: close },
              );
            }}
          >
            <FolderInput aria-hidden="true" />
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
