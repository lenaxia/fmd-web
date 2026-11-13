import { describe, expect, it } from 'vitest';
import { openSession } from './harness.js';
import { compareOrUpdateGolden } from './golden.js';

/**
 * E2E seed flow 6 — Tapas TotalDirectory / PAGENUMBER semantics: the
 * module sets `MODULE.TotalDirectory = #DirectoryPages` (= 2, the static
 * category count) and binds NO OnGetDirectoryPageNumber handler — so the
 * host update engine never dispatches the event and the directory page
 * count stays at the FMD2 default of 1 (uUpdateThread.pas:197-206:
 * `TotalDirectoryPage[FWorkPtr] := 1; if Assigned(OnGetDirectoryPageNumber)
 * ...`). The golden records the descriptor facts (Init options, event
 * bindings, TotalDirectory) and the host guard, and proves the §5.2
 * GetDirectoryPageNumber environment (UPDATELIST binding, PAGENUMBER
 * read-back) on EHentai/Hentai2Read which bind real handlers.
 */

describe('seed flow: Tapas TotalDirectory / PAGENUMBER semantics', () => {
  it('exposes TotalDirectory, no handler guard and the Init option surface', async () => {
    const session = await openSession({
      moduleFile: 'modules/Tapas.lua',
      responses: [],
    });
    try {
      expect(session.descriptor.id).toBe('9f2d722f3e90432ba913d5bdddc048b4');
      expect(session.descriptor.name).toBe('Tapas');
      expect(session.descriptor.rootURL).toBe('https://tapas.io');

      // TotalDirectory = #DirectoryPages = 2 ('COMIC', 'MATURE_COMIC')
      expect(session.descriptor.totalDirectory).toBe(2);

      // the module binds NO GetDirectoryPageNumber handler
      expect(session.descriptor.eventHandlers['GetDirectoryPageNumber']).toBeUndefined();
      // but binds these real handlers
      expect(session.descriptor.eventHandlers['GetNameAndLink']).toBe('GetNameAndLink');
      expect(session.descriptor.eventHandlers['GetInfo']).toBe('GetInfo');
      expect(session.descriptor.eventHandlers['GetPageNumber']).toBe('GetPageNumber');

      // Init option surface: showpaidchapters checkbox, default false
      const showPaid = session.descriptor.options.find((o) => o.name === 'showpaidchapters');
      expect(showPaid?.kind).toBe('checkbox');
      expect(showPaid?.defaultValue).toBe(false);

      // host guard: dispatching the unbound event raises EventNotBoundError
      // (FMD2 only wires the dispatcher when the module assigns a handler;
      // uUpdateThread keeps the page count at 1)
      let notBound: unknown;
      try {
        session.dispatch('GetDirectoryPageNumber');
      } catch (error) {
        notBound = (error as Error).message;
      }
      expect(notBound).toContain('GetDirectoryPageNumber');
      expect(notBound).toContain('does not bind a handler');
      const hostDefaultPageCount = 1; // uUpdateThread.pas:198

      compareOrUpdateGolden('tapas-totaldirectory', {
        module: 'Tapas',
        moduleId: session.descriptor.id,
        descriptor: {
          rootURL: session.descriptor.rootURL,
          totalDirectory: session.descriptor.totalDirectory,
          eventHandlers: session.descriptor.eventHandlers,
          options: session.descriptor.options,
        },
        hostSemantics: {
          noGetDirectoryPageNumberHandler: notBound,
          hostDefaultPageCount,
          pagenumberReadBackProvenOn: 'ehentai/hentai2read flows (real handlers)',
        },
        httpRequests: session.resolver.requests,
      });
    } finally {
      await session.dispose();
    }
  });
});
