import type { Readable } from 'node:stream';
import { PassThrough } from 'node:stream';

/**
 * Streaming helpers shared by the packers (§7.3 discipline): bounded
 * chunked writes with backpressure, close/error awaiting, and raw
 * stream copies. Nothing here ever accumulates a whole stream in
 * memory — that is the D16 commitment the packers are built on.
 */

/** A manually settled promise (deferred). */
export class Deferred<T> {
  readonly promise: Promise<T>;
  private resolveFn!: (value: T) => void;
  private rejectFn!: (error: unknown) => void;
  private settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
    // Losing side of a race must never surface as an unhandled rejection.
    this.promise.catch(() => undefined);
  }

  resolve(value: T): void {
    if (!this.settled) {
      this.settled = true;
      this.resolveFn(value);
    }
  }

  reject(error: unknown): void {
    if (!this.settled) {
      this.settled = true;
      this.rejectFn(error);
    }
  }

  get isSettled(): boolean {
    return this.settled;
  }
}

/**
 * Write one chunk honoring backpressure: when the stream's buffer is
 * full the returned promise resolves once it drains ('drain' event).
 */
export function writeChunk(
  out: NodeJS.WritableStream,
  chunk: Uint8Array | string,
): Promise<void> {
  const stream = out as NodeJS.WriteStream & { write(chunk: Uint8Array | string): boolean };
  if (!stream.write(chunk)) {
    return new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: unknown): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        stream.removeListener('drain', onDrain);
        stream.removeListener('error', onError);
      };
      stream.on('drain', onDrain);
      stream.on('error', onError);
    });
  }
  return Promise.resolve();
}

/** Resolve when the stream closed; reject on stream error. */
export function waitForClose(stream: NodeJS.ReadableStream | NodeJS.WritableStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const s = stream as NodeJS.EventEmitter;
    const onClose = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: unknown): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      s.removeListener('close', onClose);
      s.removeListener('error', onError);
    };
    s.on('close', onClose);
    s.on('error', onError);
  });
}

/**
 * Copy `source` into `out` chunk-by-chunk (backpressure honored).
 * Returns the copied byte count; the source is destroyed on failure.
 */
export async function copyStream(
  source: Readable,
  out: NodeJS.WritableStream,
): Promise<number> {
  let copied = 0;
  try {
    for await (const chunk of source) {
      const bytes = chunk as Buffer;
      copied += bytes.length;
      await writeChunk(out, bytes);
    }
    return copied;
  } catch (error) {
    source.destroy();
    throw error;
  }
}

/** An infinite stalled stream — the watchdog drill's fake-slow input. */
export function createStalledStream(): Readable {
  return new PassThrough();
}
