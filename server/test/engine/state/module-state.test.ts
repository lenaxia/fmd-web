import { describe, expect, it } from 'vitest';
import {
  AsyncMutex,
  AsyncRWLock,
  LockHoldTracker,
  PerKeyMutexPool,
  hostOf,
} from '../../../src/engine/state/locks.js';
import {
  BypassGate,
  HostConnectionLimiter,
  ModuleStateService,
  parseCookieText,
} from '../../../src/engine/state/module-state.js';
import { InMemoryModuleStatePersistence } from '../../../src/engine/state/persistence.js';

function defer<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Race a promise against a deadlock watchdog — the failure is a deadlock. */
async function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`DEADLOCK: ${what} did not finish within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe('lock primitives (§5.3)', () => {
  it('AsyncMutex.tryAcquire = TryEnterCriticalSection: never waits', async () => {
    const m = new AsyncMutex();
    const release = m.tryAcquire();
    expect(release).not.toBeNull();
    expect(m.isLocked).toBe(true);
    expect(m.tryAcquire()).toBeNull(); // TryEnter fails while held
    release?.();
    expect(m.isLocked).toBe(false);
    const release2 = m.tryAcquire();
    expect(release2).not.toBeNull();
    release2?.();
  });

  it('AsyncMutex queues waiters FIFO', async () => {
    const m = new AsyncMutex();
    const order: string[] = [];
    const release = (await m.acquire());
    const t1 = m.runExclusive(async () => {
      order.push('first-waiter');
    });
    const t2 = m.runExclusive(async () => {
      order.push('second-waiter');
    });
    expect(m.waiting).toBe(2);
    release();
    await Promise.all([t1, t2]);
    expect(order).toEqual(['first-waiter', 'second-waiter']);
  });

  it('AsyncRWLock: concurrent readers share; writer waits for all readers', async () => {
    const lock = new AsyncRWLock();
    const r1 = await lock.read();
    const r2 = await lock.read();
    const r3 = await lock.read();
    expect(lock.readerCount).toBe(3); // readers run concurrently
    let writerRan = false;
    const w = lock.runWrite(() => {
      writerRan = true;
    });
    expect(lock.writerQueued).toBe(true);
    expect(writerRan).toBe(false);
    r1();
    r2();
    expect(writerRan).toBe(false); // still one reader left
    r3();
    await w;
    expect(writerRan).toBe(true);
  });

  it('AsyncRWLock: a queued writer bars new readers (write-preferring)', async () => {
    const lock = new AsyncRWLock();
    const r1 = await lock.read();
    let writerRan = false;
    const w = lock.runWrite(() => {
      writerRan = true;
    });
    const readerGranted = defer();
    const r2 = lock.read().then((release) => {
      readerGranted.resolve();
      return release;
    });
    expect(writerRan).toBe(false);
    r1();
    await w; // queued writer runs FIRST
    expect(writerRan).toBe(true);
    await readerGranted.promise; // …then the barred reader
    await r2;
  });

  it('PerKeyMutexPool: same key serializes, different keys run concurrently', async () => {
    const pool = new PerKeyMutexPool();
    const events: string[] = [];
    const gateA = defer();
    const inA = defer();
    const inB = defer();
    const gateB = defer();

    const t1 = pool.runExclusive('key-a', async () => {
      events.push('a1-start');
      inA.resolve();
      await gateA.promise;
      events.push('a1-end');
    });
    const t2 = pool.runExclusive('key-a', async () => {
      events.push('a2-start');
    });
    const t3 = pool.runExclusive('key-b', async () => {
      events.push('b1-start');
      inB.resolve();
      await gateB.promise;
      events.push('b1-end');
    });

    await inA.promise;
    await inB.promise; // key-b proceeds while key-a is held
    gateB.resolve();
    await t3;
    expect(events).toEqual(['a1-start', 'b1-start', 'b1-end']);
    gateA.resolve();
    await t1;
    await t2;
    expect(events).toEqual(['a1-start', 'b1-start', 'b1-end', 'a1-end', 'a2-start']);
    expect(pool.forKey('key-a')).toBe(pool.forKey('key-a')); // one mutex per key
    expect(pool.forKey('key-a')).not.toBe(pool.forKey('key-b'));
  });

  it('HostConnectionLimiter: per-host slots, FIFO, host-independent, 0 = unlimited', async () => {
    const limiter = new HostConnectionLimiter(0);
    limiter.setHostLimit('example.com', 2);
    const r1 = await limiter.acquire('https://example.com/a');
    const r2 = await limiter.acquire('https://example.com/b');
    expect(limiter.activeFor('example.com')).toBe(2);
    let granted = false;
    const third = limiter.acquire('https://example.com/c').then((release) => {
      granted = true;
      return release;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(granted).toBe(false); // third slot waits
    r1(); // FIFO hand-off
    const r3 = await third;
    expect(granted).toBe(true);
    // A different host is unlimited (default 0) and never queues.
    const other = await limiter.acquire('https://other.org/x');
    other();
    r2();
    r3();
    expect(limiter.activeFor('example.com')).toBe(0);
  });

  it('BypassGate: TryEnter semantics with explicit leave', () => {
    const gate = new BypassGate();
    expect(gate.tryEnter()).toBe(true);
    expect(gate.busy).toBe(true);
    expect(gate.tryEnter()).toBe(false); // concurrent loser
    gate.leave();
    expect(gate.tryEnter()).toBe(true);
    expect(gate.entries).toBe(2);
  });

  it('hostOf strips scheme/port/path/auth and lowercases', () => {
    expect(hostOf('https://Example.com:8080/manga?page=2')).toBe('example.com');
    expect(hostOf('http://user@pass@Sub.Host.Org/path#frag')).toBe('sub.host.org');
    expect(hostOf('//bare.host/x')).toBe('bare.host');
  });

  it('parseCookieText parses FMD2 "; "-joined settings cookies', () => {
    expect(parseCookieText('a=1; b=2')).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
    expect(parseCookieText('')).toEqual([]);
    expect(parseCookieText('novalue; a=1')).toEqual([['a', '1']]);
  });
});

describe('ModuleStateService — one shared instance per module (§5.3)', () => {
  it('forModule returns THE same bundle per module, distinct across modules', async () => {
    const service = new ModuleStateService();
    const a1 = await service.forModule('mod-a');
    const a2 = await service.forModule('mod-a');
    const b = await service.forModule('mod-b');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(service.moduleIds.sort()).toEqual(['mod-a', 'mod-b']);
  });

  it('cookie jar: RW-locked snapshot-on-read, mutations isolated from old snapshots', async () => {
    const service = new ModuleStateService();
    const state = await service.forModule('mod');
    await state.cookies.write((jar) => {
      jar.set('a', '1');
      jar.set('b', '2');
    });
    const snap1 = await state.cookies.snapshot();
    expect(snap1.count).toBe(2);
    expect(snap1.requestHeader).toBe('a=1; b=2');
    expect(snap1.settingsText).toBe('a=1;b=2'); // FMD2 Settings.HTTP.Cookies form
    await state.cookies.write((jar) => {
      jar.set('a', 'mutated');
      jar.remove('b');
    });
    expect(snap1.entries['a']).toBe('1'); // old snapshot untouched
    const snap2 = await state.cookies.snapshot();
    expect(snap2.entries['a']).toBe('mutated');
    expect(snap2.entries['b']).toBeUndefined();
    state.cookies.addServerCookie('sid=xyz; Path=/; HttpOnly');
    expect(state.cookies.get('SID')).toBe('xyz'); // case-insensitive
  });

  it('storage: per-key KV with Text (TStrings) round-trip', async () => {
    const service = new ModuleStateService();
    const state = await service.forModule('mod');
    state.storage.set('reload', 'true');
    state.storage.set('session', 'abc');
    expect(state.storage.getOrEmpty('reload')).toBe('true');
    expect(state.storage.getOrEmpty('missing')).toBe('');
    const text = state.storage.text;
    const other = await service.forModule('mod2');
    other.storage.text = text;
    expect(other.storage.snapshot()).toEqual(state.storage.snapshot());
  });

  it('settings: copy-on-read — snapshots are frozen copies', async () => {
    const service = new ModuleStateService();
    const state = await service.forModule('mod');
    state.settings.setOption('mirror', 'http://mirror1');
    await state.settings.setCookies('old=1');
    const snap = await state.settings.snapshot();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.options)).toBe(true);
    state.settings.setOption('mirror', 'http://mirror2');
    expect(snap.options['mirror']).toBe('http://mirror1'); // old copy untouched
    const snap2 = await state.settings.snapshot();
    expect(snap2.options['mirror']).toBe('http://mirror2');
  });

  it('account: mutex-guarded transactions with status enum', async () => {
    const service = new ModuleStateService();
    const state = await service.forModule('mod');
    await state.account.runExclusive((account) => {
      account.enabled = true;
      account.username = 'user';
      account.password = 'pass';
      account.status = 2; // asValid
    });
    const snap = await state.account.snapshot();
    expect(snap).toEqual({ enabled: true, username: 'user', password: 'pass', cookies: '', status: 2 });
    const proj = await service.snapshot('mod');
    expect(proj.accountStatus).toBe('asValid');
  });

  it('snapshot() projects the §9 module_state row', async () => {
    const service = new ModuleStateService();
    const state = await service.forModule('mod');
    await state.cookies.write((jar) => jar.set('k', 'v'));
    const proj = await service.snapshot('mod');
    expect(proj).toMatchObject({
      moduleId: 'mod',
      cookieCount: 1,
      accountStatus: 'asUnknown',
      bypassBusy: false,
    });
    expect(proj.storageKeys).toEqual([]);
  });
});

describe('lock-held-during-callback detector (§5.3)', () => {
  it('tracker sees holds inside lock scopes and reports labels', async () => {
    const tracker = new LockHoldTracker();
    const mutex = new AsyncMutex(tracker, 'cookies:mod');
    tracker.assertIdle('outside'); // no throw
    const release = await mutex.acquire();
    expect(tracker.activeCount()).toBe(1);
    expect(tracker.activeLabels()).toEqual(['cookies:mod']);
    expect(() => tracker.assertIdle('inside-scope')).toThrow(/lock held across user callback.*cookies:mod/);
    release();
    tracker.assertIdle('after-release');
    expect(tracker.activeCount()).toBe(0);
  });

  it('NEGATIVE CONTROL: a wrapper that holds a lock across a callback is detected', async () => {
    // Proves the detector is not vacuous: deliberately break the policy.
    const service = new ModuleStateService();
    const state = await service.forModule('mod');
    const brokenUserCallback = () => {
      service.tracker.assertIdle('user-callback'); // must throw
    };
    await expect(
      state.cookies.write(async () => {
        await new Promise((r) => setTimeout(r, 5));
        brokenUserCallback();
      }),
    ).rejects.toThrow(/lock held across user callback/);
  });

  it('the state service itself never holds a lock across a user callback', async () => {
    const service = new ModuleStateService();
    const state = await service.forModule('mod');
    // The user-callback pattern (bypass executor / SaveImage): state ops
    // complete BEFORE the callback runs; the callback sees zero holds.
    await state.cookies.write((jar) => jar.set('w', '1'));
    await state.storage.runExclusive('k', (current) => `${current ?? ''}x`);
    const userCallback = () => {
      service.tracker.assertIdle('bypass-executor');
      service.tracker.assertIdle('save-image');
    };
    expect(() => userCallback()).not.toThrow();
    expect(await state.cookies.snapshot()).toMatchObject({ count: 1 });
  });
});

describe('≥8 parallel same-module events over the shared service (D12, AC1)', () => {
  const WORKERS = 12;

  it('12 concurrent events share cookies/Storage without deadlock, observing each other', async () => {
    const service = new ModuleStateService();
    const state = await service.forModule('image-module');
    state.limiter.setHostLimit('example.com', 4); // bounded slots → real queueing

    // Each event runs in its own detector context: the lock-held-during-
    // callback assertion is per execution path (a concurrent worker holding
    // a state lock is legitimate — D12).
    const runOne = async (i: number): Promise<void> =>
      service.tracker.inContext(async () => {
        // 1. per-host limiter slot (mirrors the download pipeline)
        const releaseSlot = await state.limiter.acquire(`https://example.com/img-${i}.webp`);
        try {
          // 2. merge a distinctive cookie into the shared jar (RW write)
          await state.cookies.write((jar) => jar.set(`w${i}`, `v${i}`));
          // 3. read-modify-write the shared Storage under the per-key mutex
          await state.storage.transact('seq', (current) => String(Number(current ?? '0') + 1));
          // 4. observe the jar: own cookie ALWAYS present; others' presence is
          //    timing-dependent (ordering-agnostic — asserted after join).
          const snap = await state.cookies.snapshot();
          expect(snap.entries[`w${i}`]).toBe(`v${i}`);
          expect(snap.count).toBeGreaterThanOrEqual(1);
          // 5. user-callback injection point — THIS path holds no lock here
          service.tracker.assertIdle(`worker-${i}-user-callback`);
        } finally {
          releaseSlot();
        }
      });

    const all = withDeadline(
      Promise.all(Array.from({ length: WORKERS }, (_, i) => runOne(i))),
      5000,
      '12 same-module events',
    );
    await expect(all).resolves.toBeDefined();

    const finalJar = await state.cookies.snapshot();
    expect(finalJar.count).toBe(WORKERS);
    for (let i = 0; i < WORKERS; i += 1) {
      expect(finalJar.entries[`w${i}`]).toBe(`v${i}`); // every worker observed
    }
    expect(state.storage.get('seq')).toBe(String(WORKERS)); // per-key mutex held the count exact
    service.tracker.assertGloballyIdle('after 12 parallel events'); // no lock leaked
    expect(service.tracker.activeCount()).toBe(0);
  });

  it('concurrent cookie writes under the RW lock all land (last-writer-wins per name)', async () => {
    const service = new ModuleStateService();
    const state = await service.forModule('mod');
    const writers = Array.from({ length: 16 }, (_, i) =>
      state.cookies.write((jar) => {
        jar.set(`c${i % 4}`, `w${i}`); // 16 writers, 4 names → contention
      }),
    );
    await withDeadline(Promise.all(writers), 5000, '16 RW cookie writers');
    const snap = await state.cookies.snapshot();
    expect(snap.count).toBe(4);
    // Each name holds SOME writer's value — consistent, never torn.
    for (let n = 0; n < 4; n += 1) {
      expect(snap.entries[`c${n}`]).toMatch(/^w\d+$/);
    }
  });
});

describe('service persistence wiring (§9 module_state)', () => {
  it('flush() writes a row per loaded module; peek() does not create', async () => {
    const persistence = new InMemoryModuleStatePersistence();
    const service = new ModuleStateService({ persistence });
    const state = await service.forModule('mod');
    // Settings cookies are the persisted form (§9) — the interceptor keeps
    // them in sync with the jar on bypass; here we set them directly.
    await state.cookies.write((jar) => jar.set('a', '1'));
    await state.settings.setCookies('a=1');
    await state.settings.setUserAgent('UA/2.0');
    state.storage.set('k', 'v');
    await service.flush();
    expect(persistence.size).toBe(1);
    expect(persistence.row('mod')).toEqual({
      cookies: 'a=1',
      ua: 'UA/2.0',
      enabled: true,
      options: {},
      storage: { k: 'v' },
    });
    expect(service.peek('nope')).toBeUndefined();
    expect(service.moduleIds).toEqual(['mod']);
  });

  it('without persistence configured, flush/persist are silent no-ops', async () => {
    const service = new ModuleStateService();
    const state = await service.forModule('mod');
    await expect(state.persist()).resolves.toBeUndefined();
    await expect(service.flush()).resolves.toBeUndefined();
  });
});
