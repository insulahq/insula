/**
 * Node-stream-typed view of `tar-stream`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `tar-stream@3.2.1` (a PATCH bump from 3.2.0) started shipping its own
 * `index.d.ts`. TypeScript prefers a package's bundled types over the
 * `@types/tar-stream` shim we had been compiling against, so the whole
 * codebase silently switched typings on a patch upgrade.
 *
 * The bundled declarations describe `tar-stream`'s real runtime substrate,
 * `streamx` — not Node's `stream`. streamx streams are duck-compatible with
 * Node streams at RUNTIME (that is the entire point of streamx, and every
 * one of our call sites has been exercising that compatibility in production
 * for months), but they are not *structurally assignable* to Node's
 * `WritableStream` / `pipeline()` parameter types:
 *
 *   - `on('data', cb)` types the payload as `unknown`, not `Buffer`
 *   - `Extract` is not accepted by `Readable.pipe()` or `stream.pipeline()`
 *   - a pack `entry` is not accepted as a `pipeline()` destination
 *
 * That produced 8 type errors across dr-restore, system-backup and
 * tenant-bundles with **no behavioural change whatsoever**.
 *
 * Rather than sprinkle 8 casts through business logic — where a future
 * reader would have to rediscover this each time, and where a genuine type
 * error could hide behind one — the unsoundness is quarantined here, named,
 * and explained once.
 *
 * WHEN TO DELETE THIS
 * -------------------
 * When `tar-stream`'s bundled declarations describe Node-compatible stream
 * types (upstream issue: the streamx types leak through a Node-facing API),
 * or when we migrate these paths off `tar-stream`. At that point drop this
 * module, re-import `tar-stream` directly, and delete `@types/tar-stream`
 * from backend devDependencies — it is already dead weight now that the
 * package ships its own.
 */

import type { Readable, Writable } from 'node:stream';
import * as tarStream from 'tar-stream';

/** Header fields we actually read. Mirrors `@types/tar-stream`'s Headers. */
export interface TarHeaders {
  readonly name: string;
  readonly size?: number;
  readonly mtime?: Date;
  readonly type?: string;
}

/**
 * A tar extractor, typed as the Node `Writable` it behaves as. Entry streams
 * are `Readable`, so `on('data', (c: Buffer) => …)` narrows correctly again.
 */
export interface TarExtract extends Writable {
  on(event: 'entry', cb: (headers: TarHeaders, stream: Readable, next: (err?: Error) => void) => void): this;
  on(event: 'finish', cb: () => void): this;
  on(event: 'error', cb: (err: Error) => void): this;
  on(event: string, cb: (...args: never[]) => void): this;
}

/**
 * A tar packer, typed as the Node `Readable` it behaves as.
 *
 * `entry()` keeps tar-stream's three call shapes: header-only (returns the
 * entry `Writable` to pipe into), header+body (returns it already finished),
 * and either of those with a completion callback. `destroy()` is inherited
 * from `Readable` — redeclaring it as `void` conflicts with Readable's
 * `this`-returning signature.
 */
export interface TarPack extends Readable {
  entry(headers: TarHeaders, callback?: (err?: Error | null) => void): Writable;
  entry(headers: TarHeaders, buffer: Buffer | string, callback?: (err?: Error | null) => void): Writable;
  finalize(): void;
}

/**
 * Both casts below are the ONLY place this compatibility claim is made.
 * They are `unknown`-mediated deliberately: a direct assertion would fail,
 * which is precisely the mismatch being documented.
 */
export function extract(): TarExtract {
  return tarStream.extract() as unknown as TarExtract;
}

export function pack(): TarPack {
  return tarStream.pack() as unknown as TarPack;
}
