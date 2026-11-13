import { describe, expect, it } from 'vitest';
import type { EventDispatchResult, HttpAbortHandle, LuaModuleDescriptor } from '@fmd/contract';
import { DeadlineAbortHandle, createDeadlineCells } from '../../../src/engine/lua/abort.js';
import { createLuaHost } from '../../../src/engine/lua/host.js';
import { createMemoryLogger } from '../../../src/engine/lua/logger.js';
import { createDeadlineController } from '../../../src/engine/events/deadline.js';
import { createContractDispatcher } from '../../../src/engine/events/dispatcher.js';
import { CONTRACT_BINDING_ROWS } from './contract-rows.js';

/**
 * §5.2 event dispatcher contract tests: the binding table comes from
 * contract.json (15 rows), codes for the first three, booleans for the
 * 11, SaveImage returns a string, PAGENUMBER is the only read-back
 * global, URL is never read back, and the right status-constant table is
 * bound per row. Deadline expiry fails the event through the injected
 * abort handle and interrupts a blocking sleep. All offline.
 */

async function makeModule(
  source: string,
  fileName = 'test-module.lua',
  deadlineMs?: number,
): Promise<{
  descriptor: LuaModuleDescriptor;
  dispatch: (event: string, context?: Record<string, unknown>) => EventDispatchResult;
  logger: ReturnType<typeof createMemoryLogger>;
}> {
  const logger = createMemoryLogger();
  const host = createLuaHost(logger);
  const modules = await host.registry.loadFile(fileName, source);
  const descriptor = modules[0] as LuaModuleDescriptor;
  const engine = await host.createEngine();
  await engine.loadModule(fileName);
  const cells = createDeadlineCells();
  const abort = new DeadlineAbortHandle(cells);
  const deadline = createDeadlineController(cells);
  const dispatcher = createContractDispatcher(engine, abort, logger, deadline, undefined, deadlineMs);
  return {
    descriptor,
    logger,
    dispatch: (event, context = {}) => dispatcher.dispatch(descriptor, event, context as never),
  };
}

function moduleWithHandlers(handlers: Record<string, string>): string {
  const assignments = Object.entries(handlers)
    .map(([event, fn]) => `  m.On${event} = '${fn}'`)
    .join('\n');
  return `
function Init()
  local m = NewWebsiteModule()
  m.ID = '1234567890abcdef1234567890abcdef'
  m.Name = 'DispatchTest'
  m.RootURL = 'https://dispatchtest.example'
${assignments}
end
`;
}

/** Injected-abort-handle spy: counts abort() calls, shares Terminated state. */
class TrackingAbortHandle extends DeadlineAbortHandle {
  abortCalls = 0;
  abortReasons: string[] = [];

  override abort(reason?: string): void {
    this.abortCalls += 1;
    this.abortReasons.push(reason ?? '');
    super.abort(reason);
  }
}

describe('EventDispatcher (§5.2) — return protocol driven by contract.json', () => {
  it('the contract.json table has exactly the 15 rows with correct shapes', () => {
    expect(CONTRACT_BINDING_ROWS.length).toBe(15);
    const codeRows = CONTRACT_BINDING_ROWS.filter((r) => r.returns === 'code');
    const booleanRows = CONTRACT_BINDING_ROWS.filter((r) => r.returns === 'boolean');
    const stringRows = CONTRACT_BINDING_ROWS.filter((r) => r.returns === 'string');
    expect(codeRows.map((r) => r.event)).toEqual([
      'GetDirectoryPageNumber',
      'GetNameAndLink',
      'GetInfo',
    ]);
    expect(booleanRows.length).toBe(11);
    expect(stringRows.map((r) => r.event)).toEqual(['SaveImage']);
    // MODULE bound for every event; PAGENUMBER the only read-back; URL never
    for (const row of CONTRACT_BINDING_ROWS) {
      expect(row.globals[0]).toBe('MODULE');
      if (row.readBack.length > 0) {
        expect(row.readBack).toEqual(['PAGENUMBER']);
        expect(row.event).toBe('GetDirectoryPageNumber');
      }
      expect(row.globals).not.toContain('ACCOUNT');
    }
  });

  it('code events: GetDirectoryPageNumber/GetNameAndLink/GetInfo return codes', async () => {
    const { dispatch } = await makeModule(
      moduleWithHandlers({
        GetDirectoryPageNumber: 'GetDirectoryPageNumber',
        GetNameAndLink: 'GetNameAndLink',
        GetInfo: 'GetInfo',
      }) + `
function GetDirectoryPageNumber()
  PAGENUMBER = 7
  return no_error
end
function GetNameAndLink()
  NAMES.Add('name-1'); LINKS.Add('link-1')
  return no_error
end
function GetInfo()
  MANGAINFO.Title = 'Title from GetInfo'
  return information_not_found
end
`,
    );
    const page = dispatch('GetDirectoryPageNumber', { pageNumber: 1 });
    expect(page).toEqual({
      kind: 'code',
      value: 0,
      readBack: { PAGENUMBER: 7 }, // read-back: PAGENUMBER is read after the call
    });

    const names = dispatch('GetNameAndLink', { url: '2' });
    expect(names).toEqual({ kind: 'code', value: 0, readBack: {} });

    const info = dispatch('GetInfo', { url: 'https://x.example/manga/1' });
    expect(info).toEqual({ kind: 'code', value: 2, readBack: {} });
  });

  it('PAGENUMBER read-back reports nil as null when the handler unsets it', async () => {
    const { dispatch } = await makeModule(
      moduleWithHandlers({ GetDirectoryPageNumber: 'GetDirectoryPageNumber' }) +
        `
function GetDirectoryPageNumber()
  PAGENUMBER = nil
  return no_error
end
`,
    );
    const result = dispatch('GetDirectoryPageNumber', { pageNumber: 3 });
    expect(result).toEqual({ kind: 'code', value: 0, readBack: { PAGENUMBER: null } });
  });

  it('all 11 boolean events return booleans (nil result reads false)', async () => {
    const booleanEvents = [
      'BeforeUpdateList', 'AfterUpdateList', 'TaskStart', 'GetPageNumber',
      'GetImageURL', 'BeforeDownloadImage', 'DownloadImage', 'AfterImageSaved',
      'Login', 'AccountState', 'CheckSite',
    ] as const;
    for (const event of booleanEvents) {
      const fnName = `Impl_${event}`;
      const { dispatch } = await makeModule(moduleWithHandlers({ [event]: fnName }) + `
function ${fnName}()
  return true
end
`);
      const result = dispatch(event);
      expect(result).toEqual({ kind: 'boolean', value: true });
    }
  });

  it('boolean events returning nothing read false', async () => {
    const { dispatch } = await makeModule(moduleWithHandlers({ TaskStart: 'TaskStart' }) + `
function TaskStart()
end
`);
    expect(dispatch('TaskStart')).toEqual({ kind: 'boolean', value: false });
  });

  it('SaveImage returns a string', async () => {
    const { dispatch } = await makeModule(moduleWithHandlers({ SaveImage: 'SaveImage' }) + `
function SaveImage()
  return 'renamed-001.jpg'
end
`);
    expect(dispatch('SaveImage', { path: '/tmp/library', fileName: '001.jpg' })).toEqual({
      kind: 'string',
      value: 'renamed-001.jpg',
    });
  });

  it('URL is push-only: host-side values survive, module writes are not read back', async () => {
    const { dispatch } = await makeModule(moduleWithHandlers({ GetPageNumber: 'GetPageNumber' }) + `
function GetPageNumber()
  URL = 'module-mutated-url'  -- URL is never read back (§5.2)
  TASK.PageNumber = 5
  return false
end
`);
    const result = dispatch('GetPageNumber', { url: 'https://site.example/ch-1' });
    expect(result).toEqual({ kind: 'boolean', value: false });
    // no readBack key in the result at all
    expect(Object.keys(result)).not.toContain('readBack');
  });

  it('binds net-status constants for the code rows (values match contract.json)', async () => {
    const rows = CONTRACT_BINDING_ROWS.filter((r) => r.constants === 'net-status');
    expect(rows.map((r) => r.event)).toEqual([
      'GetDirectoryPageNumber',
      'GetNameAndLink',
      'GetInfo',
    ]);
    for (const row of rows) {
      const { dispatch } = await makeModule(moduleWithHandlers({ [row.event]: 'Impl' }) + `
function Impl()
  return no_error + net_problem + information_not_found
end
`);
      const result = dispatch(row.event);
      // 0 + 1 + 2 — proves all three constants were bound with contract values
      const readBack = row.readBack.includes('PAGENUMBER') ? { PAGENUMBER: 0 } : {};
      expect(result).toEqual({ kind: 'code', value: 3, readBack });
    }
  });

  it('binds account-status constants for Login/AccountState/CheckSite', async () => {
    const rows = CONTRACT_BINDING_ROWS.filter((r) => r.constants === 'account-status');
    expect(rows.map((r) => r.event)).toEqual(['Login', 'AccountState', 'CheckSite']);
    for (const row of rows) {
      const { dispatch } = await makeModule(moduleWithHandlers({ [row.event]: 'Impl' }) + `
function Impl()
  if asUnknown == 0 and asChecking == 1 and asValid == 2 and asInvalid == 3 then
    return true
  end
  return false
end
`);
      expect(dispatch(row.event)).toEqual({ kind: 'boolean', value: true });
    }
  });

  it('binds none of the constants for rows with constants=none', async () => {
    const rows = CONTRACT_BINDING_ROWS.filter((r) => r.constants === 'none');
    expect(rows.length).toBe(9);
    const { dispatch } = await makeModule(moduleWithHandlers({ TaskStart: 'TaskStart' }) + `
function TaskStart()
  return no_error == nil
end
`);
    // no_error was never bound for this row
    expect(dispatch('TaskStart')).toEqual({ kind: 'boolean', value: true });
  });

  it('binds exactly the row globals (TASK/MANGAINFO/UPDATELIST shapes)', async () => {
    const { dispatch } = await makeModule(
      moduleWithHandlers({
        GetDirectoryPageNumber: 'GetDirectoryPageNumber',
        TaskStart: 'TaskStart',
        GetInfo: 'GetInfo',
      }) + `
function GetDirectoryPageNumber()
  UPDATELIST.CurrentDirectoryPageNumber = 12
  UPDATELIST.UpdateStatusText('scanning')
  PAGENUMBER = UPDATELIST.CurrentDirectoryPageNumber
  return no_error
end
function TaskStart()
  if TASK.ChapterLinks == nil or TASK.PageLinks == nil then return false end
  TASK.PageNumber = 3
  return TASK.Link == 'chapter-link' and TASK.CurrentDownloadChapterPtr == 1
end
function GetInfo()
  MANGAINFO.ChapterLinks.Add('/ch/1')
  MANGAINFO.ChapterNames.Add('Chapter 1')
  MANGAINFO.Artist = 'typo must no-op'
  return no_error
end
`,
    );
    expect(dispatch('GetDirectoryPageNumber', { pageNumber: 0 })).toEqual({
      kind: 'code',
      value: 0,
      readBack: { PAGENUMBER: 12 },
    });
    expect(
      dispatch('TaskStart', {
        // read-only fields are host-pushed; modules read them
        // (TASK.Link string + CurrentDownloadChapterPtr int per contract.json taskFields)
      }),
    ).toEqual({ kind: 'boolean', value: false }); // TASK.Link not seeded by this dispatcher test

    const info = dispatch('GetInfo', { url: 'https://site.example/manga/x' });
    expect(info).toEqual({ kind: 'code', value: 0, readBack: {} });
  });

  it('MODULE is bound every event and reads back descriptor state', async () => {
    const { dispatch } = await makeModule(moduleWithHandlers({ CheckSite: 'CheckSite' }) + `
function CheckSite()
  return MODULE ~= nil and MODULE.ID == '1234567890abcdef1234567890abcdef'
    and MODULE.Name == 'DispatchTest' and MODULE.RootURL == 'https://dispatchtest.example'
end
`);
    expect(dispatch('CheckSite')).toEqual({ kind: 'boolean', value: true });
  });

  it('throws EventNotBoundError for unknown events or unbound modules', async () => {
    const good = await makeModule(moduleWithHandlers({ TaskStart: 'TaskStart' }) + `
function TaskStart() return true end
`);
    expect(() => good.dispatch('NoSuchEvent')).toThrow(/event not bound/);

    const empty = await makeModule(`
function Init()
  local m = NewWebsiteModule()
  m.ID = 'aaaabbbbccccddddaaaabbbbccccdddd'
  m.Name = 'NoHandlers'
  m.RootURL = 'https://x.example'
end
`);
    expect(() => empty.dispatch('TaskStart')).toThrow(/does not bind a handler/);
  });

  it('a Lua error inside the handler fails the event (timedOut=false)', async () => {
    const { dispatch } = await makeModule(moduleWithHandlers({ TaskStart: 'TaskStart' }) + `
function TaskStart()
  error('module blew up')
end
`);
    const result = dispatch('TaskStart');
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.timedOut).toBe(false);
      expect(result.reason).toContain('module blew up');
    }
  });

  it('gcCollect steps after the threshold without breaking dispatch', async () => {
    const { dispatch } = await makeModule(moduleWithHandlers({ CheckSite: 'CheckSite' }) + `
function CheckSite() return true end
`);
    for (let i = 0; i < 20; i += 1) {
      expect(dispatch('CheckSite')).toEqual({ kind: 'boolean', value: true });
    }
  });
});

describe('Event deadline (§4) — watchdog, abort handle, interruptible sleep', () => {
  it('fails an event that exceeds the deadline and calls the injected abort handle', async () => {
    const source = `
function Init()
  local m = NewWebsiteModule()
  m.ID = 'ffffffffffffffffffffffffffffffff'
  m.Name = 'SlowEvent'
  m.RootURL = 'https://slow.example'
  m.OnTaskStart = 'TaskStart'
end
function TaskStart()
  sleep(10000) -- way beyond the deadline
  return true
end
`;
    const logger = createMemoryLogger();
    const host = createLuaHost(logger);
    const descriptor = (await host.registry.loadFile('slow.lua', source))[0] as LuaModuleDescriptor;
    const engine = await host.createEngine();
    await engine.loadModule('slow.lua');
    const cells = createDeadlineCells();
    const abort = new TrackingAbortHandle(cells);
    const deadline = createDeadlineController(cells);
    const dispatcher = createContractDispatcher(engine, abort, logger, deadline, undefined, 150);

    const started = Date.now();
    const result = dispatcher.dispatch(descriptor, 'TaskStart');
    const elapsed = Date.now() - started;

    expect(result).toEqual({
      kind: 'failed',
      reason: expect.stringContaining('deadline'),
      timedOut: true,
    });
    // the blocking sleep was interrupted well before its 10s completion
    expect(elapsed).toBeLessThan(5000);
    expect(elapsed).toBeGreaterThanOrEqual(100);
    // the injected abort handle was called
    expect(abort.abortCalls).toBe(1);
    expect(abort.terminated).toBe(true);
    deadline.dispose();
    await engine.dispose();
    await host.dispose();
  });

  it('the deadline abort is visible as HTTP.Terminated semantics inside the event', async () => {
    const source = `
function Init()
  local m = NewWebsiteModule()
  m.ID = 'eeee1111222233334444555566667777'
  m.Name = 'TerminateProbe'
  m.RootURL = 'https://probe.example'
  m.OnTaskStart = 'TaskStart'
end
function TaskStart()
  sleep(30000) -- interrupted at the deadline
  return HTTP.Terminated
end
`;
    const logger = createMemoryLogger();
    const host = createLuaHost(logger);
    const descriptor = (await host.registry.loadFile('probe.lua', source))[0] as LuaModuleDescriptor;
    const engine = await host.createEngine();
    await engine.loadModule('probe.lua');
    const cells = createDeadlineCells();
    const abort = new TrackingAbortHandle(cells);
    const deadline = createDeadlineController(cells);
    const dispatcher = createContractDispatcher(engine, abort, logger, deadline, undefined, 120);
    // the sleep is interrupted by the watchdog, the run then sees
    // expired-token → failed even though Lua would have returned true
    const result = dispatcher.dispatch(descriptor, 'TaskStart');
    expect(result).toEqual({
      kind: 'failed',
      reason: expect.stringContaining('deadline'),
      timedOut: true,
    });
    expect(abort.abortCalls).toBe(1);
    deadline.dispose();
    await engine.dispose();
    await host.dispose();
  });

  it('an event within its deadline completes and the watchdog is cancelled', async () => {
    const source = `
function Init()
  local m = NewWebsiteModule()
  m.ID = 'dddd1111222233334444555566667777'
  m.Name = 'QuickEvent'
  m.RootURL = 'https://quick.example'
  m.OnCheckSite = 'CheckSite'
end
function CheckSite()
  sleep(20)
  return true
end
`;
    const logger = createMemoryLogger();
    const host = createLuaHost(logger);
    const descriptor = (await host.registry.loadFile('quick.lua', source))[0] as LuaModuleDescriptor;
    const engine = await host.createEngine();
    await engine.loadModule('quick.lua');
    const cells = createDeadlineCells();
    const abort = new TrackingAbortHandle(cells);
    const deadline = createDeadlineController(cells);
    const dispatcher = createContractDispatcher(engine, abort, logger, deadline, undefined, 5000);
    const result = dispatcher.dispatch(descriptor, 'CheckSite');
    expect(result).toEqual({ kind: 'boolean', value: true });
    expect(abort.abortCalls).toBe(0);
    expect(abort.terminated).toBe(false);
    deadline.dispose();
    await engine.dispose();
    await host.dispose();
  });
});

describe('sleep + print base globals (§5.1)', () => {
  it('sleep truly blocks the worker thread', async () => {
    const logger = createMemoryLogger();
    const host = createLuaHost(logger);
    const source = `
function Init()
  local m = NewWebsiteModule()
  m.ID = 'cccc1111222233334444555566667777'
  m.Name = 'Sleeper'
  m.RootURL = 'https://sleep.example'
  m.OnCheckSite = 'CheckSite'
end
function CheckSite()
  sleep(120)
  return true
end
`;
    await host.registry.loadFile('sleeper.lua', source);
    const descriptor = (await host.registry.loadFile('sleeper.lua', source))[0] as LuaModuleDescriptor;
    const engine = await host.createEngine();
    await engine.loadModule('sleeper.lua');
    const cells = createDeadlineCells();
    const abort: HttpAbortHandle = new DeadlineAbortHandle(cells);
    const deadline = createDeadlineController(cells);
    const dispatcher = createContractDispatcher(engine, abort, logger, deadline, undefined, 60000);
    const started = Date.now();
    expect(dispatcher.dispatch(descriptor, 'CheckSite')).toEqual({ kind: 'boolean', value: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
    deadline.dispose();
    await engine.dispose();
    await host.dispose();
  });

  it('print routes to the structured logger with the module id', async () => {
    const logger = createMemoryLogger();
    const host = createLuaHost(logger);
    const source = `
function Init()
  local m = NewWebsiteModule()
  m.ID = 'bbbb1111222233334444555566667777'
  m.Name = 'Printer'
  m.RootURL = 'https://printer.example'
  m.OnCheckSite = 'CheckSite'
end
function CheckSite()
  print('event message', 1, true)
  return true
end
`;
    await host.registry.loadFile('printer-event.lua', source);
    const descriptor = (await host.registry.loadFile('printer-event.lua', source))[0] as LuaModuleDescriptor;
    const engine = await host.createEngine();
    await engine.loadModule('printer-event.lua');
    const cells = createDeadlineCells();
    const abort = new DeadlineAbortHandle(cells);
    const deadline = createDeadlineController(cells);
    const dispatcher = createContractDispatcher(engine, abort, logger, deadline);
    dispatcher.dispatch(descriptor, 'CheckSite');
    const record = logger.records.find((r) => r.message === 'event message\t1\ttrue');
    expect(record).toBeDefined();
    expect(record?.moduleId).toBe('bbbb1111222233334444555566667777');
    expect(record?.level).toBe('log');
    deadline.dispose();
    await engine.dispose();
    await host.dispose();
  });
});
