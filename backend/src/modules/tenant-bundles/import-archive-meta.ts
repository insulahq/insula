/**
 * Read a bundle archive's `meta.json` without buffering the archive (ADR-063).
 *
 * The preflight needs the component list and per-unit sizes BEFORE it can size
 * the import Job's staging volume or tell an operator what they are about to
 * import. The existing import path got these by `part.toBuffer()`-ing the whole
 * upload and holding every extracted entry as a second Buffer — which is why it
 * carries a 4 GiB cap and why platform-api would OOM well before reaching it.
 *
 * ★ `meta.json` is the FIRST entry the export writes (see
 * `streamEncryptedExport`), so reading it costs the first few KB of the stream
 * and nothing more. This reader stops at that entry and destroys the source.
 *
 * Supports the two tar formats. ZIP is refused: its central directory lives at
 * the END of the file, so "read the head" is not a thing a zip can do — and
 * both panels download tar by default, so this is a narrow exclusion rather
 * than a gap.
 */
import { createDecipheriv, pbkdf2 as pbkdf2Cb } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { extract as tarExtract } from 'tar-stream';

import {
  detectImportFormat,
  KEY_BYTES,
  IV_BYTES,
  PBKDF2_ITERATIONS,
  SALT_BYTES,
  type ImportFormat,
} from './data-export.js';

const pbkdf2 = promisify(pbkdf2Cb);

/**
 * Bytes we peek to detect the format. Must cover the longest magic
 * (`Salted__` + salt = 16) with room to spare; 64 is cheap and unambiguous.
 */
const PEEK_BYTES = 64;

/** `Salted__` (8) + salt — the OpenSSL `enc` envelope header. */
const OPENSSL_HEADER_BYTES = 8 + SALT_BYTES;

/**
 * Hard ceiling on the meta entry itself. A `meta.json` is a few KB; anything
 * claiming megabytes is malformed or an attempt to make the preflight itself
 * the memory problem the streaming reader exists to avoid.
 */
export const MAX_META_BYTES = 4 * 1024 * 1024;

/**
 * Ceiling on bytes consumed while hunting for `meta.json`.
 *
 * meta.json is the first entry, so this is normally a few KB. The cap exists so
 * an archive that never contains one — or that front-loads a huge entry — fails
 * fast instead of streaming the whole upload through the preflight.
 */
export const MAX_SCAN_BYTES = 32 * 1024 * 1024;

export interface ArchiveMetaResult {
  readonly format: ImportFormat;
  readonly meta: Record<string, unknown>;
}

export class ArchiveMetaError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ArchiveMetaError';
    this.code = code;
  }
}

/**
 * Read at least `n` bytes, then push the surplus back.
 *
 * ★ NOT `for await … break`. Breaking out of an async iterator calls the
 * stream's `return()`, which DESTROYS it — so the source was dead before the
 * rest of the archive could be piped onward, surfacing as a bare AbortError.
 * `readable`/`read()` plus `unshift()` leaves the stream intact and ordered.
 */
function readAtLeast(stream: Readable, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = (): void => {
      stream.off('readable', onReadable);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };
    const settle = (): void => { cleanup(); resolve(Buffer.concat(chunks)); };
    function onReadable(): void {
      let c: Buffer | null;
      while ((c = stream.read() as Buffer | null) !== null) {
        chunks.push(c);
        total += c.length;
        if (total >= n) { settle(); return; }
      }
    }
    // EOF before `n` bytes is not an error here — the caller decides whether a
    // short read is fatal (a truncated encryption header is; a tiny archive
    // shorter than the peek window is not).
    function onEnd(): void { settle(); }
    function onError(e: Error): void { cleanup(); reject(e); }
    // An already-ended stream emits no further 'end', so a naive listener
    // waits forever. Checked BEFORE subscribing.
    if (stream.readableEnded) { cleanup(); resolve(Buffer.alloc(0)); return; }
    stream.on('readable', onReadable);
    stream.on('end', onEnd);
    stream.on('error', onError);
    onReadable();
  });
}

/** Take `n` bytes off the front, leaving the remainder readable in order. */
async function takeExactly(stream: Readable, n: number): Promise<Buffer> {
  const all = await readAtLeast(stream, n);
  if (all.length > n && !stream.readableEnded) stream.unshift(all.subarray(n));
  return all.subarray(0, Math.min(n, all.length));
}

/**
 * Look at the first `n` bytes WITHOUT consuming them.
 *
 * Format detection must not eat the gzip magic — an earlier version used the
 * consuming read here and gunzip then reported "incorrect header check" on a
 * perfectly good archive.
 */
async function peekExactly(stream: Readable, n: number): Promise<Buffer> {
  const all = await readAtLeast(stream, n);
  if (all.length > 0 && !stream.readableEnded) stream.unshift(all);
  return all.subarray(0, Math.min(n, all.length));
}

/**
 * Build the decode pipeline for a detected format.
 *
 * The encrypted path derives the key from the SAME exported constants the
 * writer uses — see the note on those exports.
 */
async function decodedStream(
  format: ImportFormat,
  stream: Readable,
  passphrase: string | undefined,
): Promise<Readable> {
  if (format === 'zip') {
    throw new ArchiveMetaError(
      'ARCHIVE_FORMAT_UNSUPPORTED',
      'ZIP bundles cannot be inspected without reading the whole file (its index is at the end). Re-download the bundle as tar.gz and import that.',
    );
  }

  if (format === 'tar-plain') {
    const gunzip = createGunzip();
    stream.on('error', (e) => gunzip.destroy(e));
    return stream.pipe(gunzip);
  }

  // tar-encrypted: `Salted__` || salt(8) || AES-256-CBC(gzip(tar))
  if (!passphrase) {
    throw new ArchiveMetaError('PASSPHRASE_REQUIRED', 'This bundle is encrypted — a passphrase is required to inspect it.');
  }
  const header = await takeExactly(stream, OPENSSL_HEADER_BYTES);
  if (header.length < OPENSSL_HEADER_BYTES) {
    throw new ArchiveMetaError('ARCHIVE_TRUNCATED', 'Archive ended inside its encryption header.');
  }
  const salt = header.subarray(8, OPENSSL_HEADER_BYTES);
  const derived = await pbkdf2(Buffer.from(passphrase, 'utf8'), salt, PBKDF2_ITERATIONS, KEY_BYTES + IV_BYTES, 'sha256');
  const decipher = createDecipheriv(
    'aes-256-cbc',
    derived.subarray(0, KEY_BYTES),
    derived.subarray(KEY_BYTES, KEY_BYTES + IV_BYTES),
  );
  const gunzip = createGunzip();
  stream.on('error', (e) => decipher.destroy(e));
  decipher.on('error', (e) => gunzip.destroy(e));
  return stream.pipe(decipher).pipe(gunzip);
}

/** Pull exactly `n` bytes off a stream, leaving the remainder readable. */
async function readExactly(stream: Readable, n: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let got = 0;
  for await (const c of stream) {
    const buf = c as Buffer;
    chunks.push(buf);
    got += buf.length;
    if (got >= n) break;
  }
  const all = Buffer.concat(chunks);
  if (all.length > n) stream.unshift(all.subarray(n));
  return all.subarray(0, n);
}

/**
 * Read `meta.json` out of a bundle archive stream.
 *
 * Destroys the source as soon as the entry is parsed — the caller's stream is
 * not consumed further, so a multi-GB archive costs the first few KB.
 */
export async function readArchiveMeta(args: {
  readonly stream: Readable;
  readonly passphrase?: string;
}): Promise<ArchiveMetaResult> {
  const head = await peekExactly(args.stream, PEEK_BYTES);
  if (head.length === 0) throw new ArchiveMetaError('ARCHIVE_EMPTY', 'The uploaded archive is empty.');
  const rest = args.stream;

  let format: ImportFormat;
  try {
    format = detectImportFormat(head);
  } catch (err) {
    throw new ArchiveMetaError(
      'ARCHIVE_FORMAT_UNKNOWN',
      `Not a recognised bundle archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const decoded = await decodedStream(format, rest, args.passphrase);

  return await new Promise<ArchiveMetaResult>((resolve, reject) => {
    const tarX = tarExtract();
    let scanned = 0;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      // Stop pulling. Without this a 25 GB archive keeps streaming through the
      // preflight after the answer is already known.
      try { tarX.destroy(); } catch { /* already gone */ }
      try { decoded.destroy(); } catch { /* already gone */ }
      try { args.stream.destroy(); } catch { /* already gone */ }
      fn();
    };

    tarX.on('entry', (header, entryStream, next) => {
      const name = String(header.name ?? '').replace(/^\.\/+/, '');
      scanned += Number(header.size ?? 0);
      if (name !== 'meta.json') {
        if (scanned > MAX_SCAN_BYTES) {
          finish(() => reject(new ArchiveMetaError(
            'META_NOT_FOUND',
            'No meta.json near the start of the archive — this does not look like a platform bundle.',
          )));
          return;
        }
        entryStream.resume();
        next();
        return;
      }
      if (Number(header.size ?? 0) > MAX_META_BYTES) {
        finish(() => reject(new ArchiveMetaError('META_TOO_LARGE', 'meta.json is implausibly large; refusing to read it.')));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      entryStream.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_META_BYTES) {
          finish(() => reject(new ArchiveMetaError('META_TOO_LARGE', 'meta.json exceeded its size cap while reading.')));
          return;
        }
        chunks.push(c);
      });
      entryStream.on('end', () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (err) {
          finish(() => reject(new ArchiveMetaError(
            'META_INVALID_JSON',
            `meta.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          )));
          return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          finish(() => reject(new ArchiveMetaError('META_INVALID_JSON', 'meta.json is not a JSON object.')));
          return;
        }
        finish(() => resolve({ format, meta: parsed as Record<string, unknown> }));
      });
      entryStream.on('error', (e: Error) => finish(() => reject(e)));
    });

    tarX.on('finish', () => finish(() => reject(new ArchiveMetaError(
      'META_NOT_FOUND',
      'The archive contains no meta.json — it is not a platform bundle.',
    ))));
    // A wrong passphrase surfaces here: AES-CBC decrypts to noise, gunzip
    // rejects it. Say so rather than leaking "incorrect header check".
    tarX.on('error', (e: Error) => finish(() => reject(
      format === 'tar-encrypted'
        ? new ArchiveMetaError('PASSPHRASE_INVALID', 'Could not decrypt the archive — check the passphrase.')
        : e,
    )));
    decoded.on('error', (e: Error) => finish(() => reject(
      format === 'tar-encrypted'
        ? new ArchiveMetaError('PASSPHRASE_INVALID', 'Could not decrypt the archive — check the passphrase.')
        : new ArchiveMetaError('ARCHIVE_CORRUPT', `Archive could not be decompressed: ${e.message}`),
    )));

    decoded.pipe(tarX as unknown as NodeJS.WritableStream);
  });
}
