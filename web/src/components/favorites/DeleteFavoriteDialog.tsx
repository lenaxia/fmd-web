/**
 * DeleteFavoriteDialog (favorites-parity): the FMD2 delete confirmation
 * for favorites — the visible Remove button and the row-menu Delete
 * both route here (FMD2 asks before removing a favorite).
 */
import type { ReactElement } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useDeleteFavorite, type FavoriteT } from '../../api/hooks';

export function DeleteFavoriteDialog(props: {
  readonly favorite: FavoriteT | null;
  readonly onClose: () => void;
}): ReactElement {
  const { favorite, onClose } = props;
  const remove = useDeleteFavorite();

  return (
    <Dialog open={favorite !== null} onOpenChange={(next): void => { if (!next) onClose(); }}>
      <DialogContent className="delete-favorite-dialog max-w-sm" data-testid="delete-favorite-dialog">
        <DialogHeader>
          <DialogTitle>Remove favorite?</DialogTitle>
          <DialogDescription>
            {favorite === null
              ? ''
              : `${favorite.title ?? favorite.url}. The downloaded chapters ledger is kept; only the favorite row is removed.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={favorite === null || remove.isPending}
            data-testid="delete-favorite-confirm"
            onClick={(): void => {
              if (favorite === null) {
                return;
              }
              remove.mutate(favorite.id, { onSuccess: onClose });
            }}
          >
            <Trash2 aria-hidden="true" />
            {remove.isPending ? 'Removing…' : 'Remove favorite'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
